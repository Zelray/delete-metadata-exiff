// @vitest-environment jsdom
/**
 * Graceful-cancel wiring (leaf 1.2.1, transferred from 1.1.4b): the Cancel
 * button appears ONLY while a {stream:true} batch is in flight, sits behind
 * the honest confirm ("already-written files keep their verified backups; the
 * rest will not be attempted"), calls the existing /api/write/cancel with the
 * live batch id, and the Results report renders the not-attempted state with
 * its own honest label. Every request is a stubbed fetch — no live server.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FolderScanResult } from '@metadesk/shared';
import { BatchPanel } from '../views/BatchPanel';
import { ResultsReport } from '../views/ResultsReport';
import { useUiStore, WRITE_RUN_IDLE } from '../state/store';
import { mergeOutcomes } from './useWriteRun';
import type { BatchOutcomeWithCancel, WriteOutcome } from './types';

// React 19: opt this environment into act() explicitly.
(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type FetchHandler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function stubFetch(handler: FetchHandler): ReturnType<typeof vi.fn> {
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal('fetch', stub);
  return stub;
}

beforeAll(() => {
  window.matchMedia =
    window.matchMedia ??
    ((_query: string) => ({
      matches: false,
      media: _query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = '';
  useUiStore.setState({
    writeUnlocked: false,
    lastWrite: null,
    selectedPaths: [],
    scanResult: null,
    badges: {},
    nextCommand: null,
    commandHistory: [],
    writeRun: { ...WRITE_RUN_IDLE },
  });
});

async function flush(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
}

function renderWithProviders(ui: React.ReactElement): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const root = createRoot(container);
  act(() => {
    root.render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  });
  return { root, container };
}

async function unmount(root: Root, container: HTMLDivElement): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

const bodyText = (): string => document.body.textContent ?? '';

function buttonWith(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((button) =>
    button.textContent?.includes(text),
  );
}

function setInput(selector: string, value: string): void {
  const input = document.querySelector(selector) as HTMLInputElement | null;
  if (input === null) throw new Error(`input not found: ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

// ---- fixtures -----------------------------------------------------------------

const SCAN_ENTRY = {
  path: 'C:\\photos\\a.png',
  name: 'a.png',
  kind: 'png',
  sizeBytes: 324,
  modifiedAt: '2026-10-05T10:00:00Z',
  warnings: [],
};

const SCAN_RESULT: FolderScanResult = {
  folder: 'C:\\photos',
  recursive: true,
  totalFiles: 1,
  totalBytes: 324,
  entries: [SCAN_ENTRY],
  warnings: [],
  rejectedPaths: [],
  unreadableDirectories: [],
} as unknown as FolderScanResult;

const PREVIEW_ENVELOPE = {
  preview: {
    previewId: 'pv_live',
    planId: 'pl_live',
    files: [
      {
        filePath: 'C:\\photos\\a.png',
        diffs: [
          { tag: 'XMP-dc:Title', after: 'Batch title', kind: 'create' },
        ],
        argv: ['-use', 'MWG', '-P', '-XMP-dc:Title=Batch title', 'C:\\photos\\a.png'],
        warnings: [],
        noop: false,
      },
    ],
    estimatedBytesRequired: 648,
    blockers: [],
    createdAt: '2026-10-05T10:00:00Z',
  },
  commandPreview: ['-use', 'MWG', '-P', '-XMP-dc:Title=Batch title', 'C:\\photos\\a.png'],
  diffNotes: [],
  writeUnlocked: true,
};

/**
 * An SSE response whose controller is handed to the test: deliver the first
 * frames immediately (so the runner learns the batch id), then HOLD the stream
 * open — the write is "in flight" — until the test releases more frames.
 */
function heldSseResponse(firstFrames: string[]): {
  response: Response;
  send: (frames: string[], close?: boolean) => void;
} {
  let send: ((frames: string[], close?: boolean) => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of firstFrames) controller.enqueue(new TextEncoder().encode(frame));
      send = (frames, close = false) => {
        for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
        if (close) controller.close();
      };
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    }),
    send: (frames, close) => send?.(frames, close),
  };
}

const progressFrame = (batchId: string): string =>
  `event: write-progress\ndata: ${JSON.stringify({
    seq: 1,
    timestamp: 't',
    type: 'write-progress',
    batchId,
    phase: 'write',
    index: 0,
    total: 1,
  })}\n\n`;

const completeFrame = (outcome: BatchOutcomeWithCancel): string =>
  `event: batch-complete\ndata: ${JSON.stringify({
    seq: 2,
    timestamp: 't',
    type: 'batch-complete',
    batchId: outcome.batchId,
    outcome,
    commandPreview: ['-use', 'MWG', '-P'],
  })}\n\n`;

const CANCELLED_OUTCOME: BatchOutcomeWithCancel = {
  batchId: 'wb_live',
  startedAt: '2026-10-05T10:00:00Z',
  finishedAt: '2026-10-05T10:00:03Z',
  files: [
    {
      filePath: 'C:\\photos\\a.png',
      status: 'updated',
      warnings: [],
      errors: [],
      verified: true,
    },
    {
      filePath: 'C:\\photos\\never-attempted.png',
      status: 'unchanged',
      warnings: [],
      errors: [],
      notAttempted: true,
      notAttemptedReason: 'The batch was cancelled before this file was attempted.',
    },
  ] as WriteOutcome[],
  updated: 1,
  unchanged: 1,
  failed: 0,
  allVerified: true,
  retryFilePaths: [],
  cancelled: true,
  cancelledAt: '2026-10-05T10:00:02Z',
  notAttempted: 1,
  notAttemptedFilePaths: ['C:\\photos\\never-attempted.png'],
};

// ---- BatchPanel: the Cancel button's full lifecycle -----------------------------

describe('BatchPanel graceful cancel', () => {
  it('offers Cancel only while the stream is in flight, behind the honest confirm, and calls /api/write/cancel', async () => {
    useUiStore.setState({ scanResult: SCAN_RESULT, selectedPaths: ['C:\\photos\\a.png'] });

    let sse: { response: Response; send: (frames: string[], close?: boolean) => void } | null = null;
    const cancelCalls: Array<{ url: string; body: unknown }> = [];
    const fetchStub = stubFetch((url, init) => {
      if (url.startsWith('/api/write/preview')) return json(PREVIEW_ENVELOPE);
      if (url.startsWith('/api/write/execute')) {
        sse = heldSseResponse([progressFrame('wb_live')]);
        return sse.response;
      }
      if (url.startsWith('/api/write/cancel')) {
        cancelCalls.push({ url, body: JSON.parse(String(init?.body)) });
        return json({
          batchId: 'wb_live',
          cancelRequested: true,
          note: 'Cancel requested. The file currently being written finishes safely with its full verification; the remaining files are not attempted.',
          commandPreview: [],
        });
      }
      return json({ code: 'not_found', message: 'unexpected' }, 404);
    });

    const { root, container } = renderWithProviders(<BatchPanel />);
    await flush();

    // Idle: no Cancel button anywhere.
    expect(buttonWith('Cancel this batch')).toBeUndefined();

    // Stage a title and build the preview.
    setInput('input[aria-label="Title"]', 'Batch title');
    await flush();
    await act(async () => {
      buttonWith('Preview batch')?.click();
    });
    await flush();

    // The mandatory gate opened; confirming starts the streamed write.
    expect(bodyText()).toContain('Batch review');
    await act(async () => {
      buttonWith('Write 1 file')?.click();
    });
    await flush(3);

    // In flight: the batch id arrived on a frame, so Cancel is now offered.
    const cancel = buttonWith('Cancel this batch');
    expect(cancel).toBeDefined();
    expect(fetchStub).not.toHaveBeenCalledWith('/api/write/cancel', expect.anything());

    // Behind a confirm that tells the truth about what cancel does.
    await act(async () => {
      cancel?.click();
    });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(bodyText()).toContain('Already-written files keep their verified backups');
    expect(bodyText()).toContain('the rest will not be attempted');

    await act(async () => {
      buttonWith('Request cancel')?.click();
    });
    await flush(2);

    expect(cancelCalls.length).toBe(1);
    expect((cancelCalls[0]?.body as { batchId?: string }).batchId).toBe('wb_live');
    expect(bodyText()).toContain('Cancel requested');

    // Release the stream: the cancelled batch completes with its honest
    // not-attempted rows, the flight ends, and Cancel disappears.
    await act(async () => {
      sse?.send([completeFrame(CANCELLED_OUTCOME)], true);
    });
    await flush(4);

    expect(buttonWith('Cancel this batch')).toBeUndefined();
    const lastWrite = useUiStore.getState().lastWrite;
    expect((lastWrite?.outcome as BatchOutcomeWithCancel).cancelled).toBe(true);
    void unmount(root, container);
  });
});

// ---- ResultsReport: the not-attempted state is its own honest row ---------------

describe('ResultsReport not-attempted rendering', () => {
  it('names the cancelled batch and labels never-attempted files distinctly', async () => {
    useUiStore.setState({
      lastWrite: {
        label: 'Batch review — 2 files',
        edits: [{ tag: 'XMP-dc:Title', op: 'set', value: 'Batch title' }],
        outcome: CANCELLED_OUTCOME,
        commandPreview: ['-use', 'MWG', '-P'],
        consistencyNotes: [],
        at: '2026-10-05T10:00:03Z',
      },
    });
    const { root, container } = renderWithProviders(<ResultsReport />);
    await flush();

    const text = bodyText();
    expect(text).toContain('You cancelled this batch');
    expect(text).toContain('never attempted');
    expect(text).toContain('kept their verified backups');
    expect(text).toContain('not attempted — batch cancelled');

    // The not-attempted row expands to its plain-English reason.
    const row = buttonWith('never-attempted.png');
    await act(async () => {
      row?.click();
    });
    expect(bodyText()).toContain('This file was never attempted');
    expect(bodyText()).toContain('The batch was cancelled before this file was attempted.');
    void unmount(root, container);
  });

  it('renders ordinary writes with no cancel chrome at all', async () => {
    useUiStore.setState({
      lastWrite: {
        label: 'Batch review — 1 file',
        edits: [{ tag: 'XMP-dc:Title', op: 'set', value: 'Batch title' }],
        outcome: {
          batchId: 'wb_plain',
          startedAt: '2026-10-05T10:00:00Z',
          finishedAt: '2026-10-05T10:00:01Z',
          files: [
            { filePath: 'C:\\photos\\a.png', status: 'updated', warnings: [], errors: [], verified: true },
          ],
          updated: 1,
          unchanged: 0,
          failed: 0,
          allVerified: true,
          retryFilePaths: [],
        },
        commandPreview: ['-use', 'MWG', '-P'],
        consistencyNotes: [],
        at: '2026-10-05T10:00:01Z',
      },
    });
    const { root, container } = renderWithProviders(<ResultsReport />);
    await flush();
    expect(bodyText()).not.toContain('You cancelled this batch');
    expect(bodyText()).not.toContain('not attempted — batch cancelled');
    void unmount(root, container);
  });
});

// ---- mergeOutcomes: additive cancel fields survive the merge --------------------

describe('mergeOutcomes cancel merge', () => {
  it('carries cancelled/notAttempted across groups and drops them when nothing was cancelled', () => {
    const plain = {
      batchId: 'wb_a',
      startedAt: '2026-10-05T10:00:00Z',
      finishedAt: '2026-10-05T10:00:01Z',
      files: [{ filePath: 'C:\\a.png', status: 'updated', warnings: [], errors: [], verified: true } as WriteOutcome],
      updated: 1,
      unchanged: 0,
      failed: 0,
      allVerified: true,
      retryFilePaths: [],
    };
    const mergedPlain = mergeOutcomes([plain]);
    expect((mergedPlain as BatchOutcomeWithCancel).cancelled).toBeUndefined();

    const mergedCancel = mergeOutcomes([plain, CANCELLED_OUTCOME]);
    const asCancel = mergedCancel as BatchOutcomeWithCancel;
    expect(asCancel.cancelled).toBe(true);
    expect(asCancel.cancelledAt).toBe(CANCELLED_OUTCOME.cancelledAt);
    expect(asCancel.notAttempted).toBe(1);
    expect(asCancel.notAttemptedFilePaths).toEqual(['C:\\photos\\never-attempted.png']);
    expect(asCancel.updated).toBe(2);
  });
});
