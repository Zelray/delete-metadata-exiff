// @vitest-environment jsdom
/**
 * The session-scoped write run (arch-v11 leaf 1.5): the flight state lives in
 * the store's TRANSIENT writeRun slice, so progress, cancel, the staged review
 * and the honest completion latch survive any navigation. These tests pin the
 * eight families the leaf contract names — survival across unmount, the
 * in-dialog cancel lifecycle, session single-flight, the nine-route host
 * partition, latch truth (failure never claims success), no cancel affordance
 * on the non-streamed arms, the persist exclusion, and the section's fidelity
 * guard. Every request is a stubbed fetch — no live server.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { useEffect } from 'react';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FolderScanResult } from '@metadesk/shared';
import App from '../App';
import { BatchPanel } from '../views/BatchPanel';
import { HistoryView } from '../views/HistoryView';
import { SaveReviewModal, type WriteRunFlight } from '../components/SaveReviewModal';
import { useUiStore, WRITE_RUN_IDLE } from '../state/store';
import { useWriteRunner, type WriteRunner, WriteRunModal } from './useWriteRun';
import { ROUTES, RUNNER_ROUTES } from '../lib/router';
import type {
  BatchOutcomeWithCancel,
  PreviewGroup,
  WritePreview,
  WriteRunConfig,
} from './types';

// React 19: opt this environment into act() explicitly.
(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const HEALTH_READ_ONLY = {
  ok: true,
  version: '13.59',
  readOnlyFallback: false,
  executablePath: 'C:\\vendor\\exiftool.exe',
  minimumVersion: '12.15',
};

const METADATA = {
  filePath: 'C:\\photos\\a.png',
  depth: 'simple',
  readAt: '2026-10-05T10:00:00Z',
  kind: 'png',
  simple: {
    title: 'Old title',
    keywords: ['family'],
    rating: 3,
    dateTaken: '2026-06-01T10:00:00Z',
    dateTakenRaw: '2026:06:01 10:00:00',
    copyright: '(c) Mike',
    creator: 'Mike',
  },
  all: {},
  raw: [],
  warnings: [],
  errors: [],
};

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

/** The app-shell stub: health + the events bridge, 404 for anything else. */
function stubShell(): void {
  stubFetch((url) => {
    if (url.startsWith('/api/health')) return json(HEALTH_READ_ONLY);
    if (url.startsWith('/api/events')) return new Response(null, { status: 503 });
    if (url.startsWith('/api/file/metadata')) return json(METADATA);
    if (url.startsWith('/api/write/history')) {
      return json({ batches: [], writeUnlocked: false, mode: 'read-only', commandPreview: [] });
    }
    return json({ code: 'not_found', message: 'unexpected' }, 404);
  });
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

/**
 * A harness that exposes the hook (for the guards the views only reach through
 * disabled buttons) while rendering the ONE modal exactly as a view would.
 */
function makeProbe(): { element: React.ReactElement; probe: { current: WriteRunner | null } } {
  const probe: { current: WriteRunner | null } = { current: null };
  function Probe() {
    const runner = useWriteRunner();
    useEffect(() => {
      probe.current = runner;
    });
    return <WriteRunModal />;
  }
  return { element: <Probe />, probe };
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
        diffs: [{ tag: 'XMP-dc:Title', after: 'Session title', kind: 'create' }],
        argv: ['-use', 'MWG', '-P', '-XMP-dc:Title=Session title', 'C:\\photos\\a.png'],
        warnings: [],
        noop: false,
      },
    ],
    estimatedBytesRequired: 648,
    blockers: [],
    createdAt: '2026-10-05T10:00:00Z',
  },
  commandPreview: ['-use', 'MWG', '-P', '-XMP-dc:Title=Session title', 'C:\\photos\\a.png'],
  diffNotes: [],
  writeUnlocked: true,
};

function makePreview(overrides: Partial<WritePreview> = {}): WritePreview {
  return {
    previewId: 'pv_test',
    planId: 'pl_test',
    files: [
      {
        filePath: 'C:\\photos\\a.jpg',
        diffs: [{ tag: 'XMP-dc:Title', before: 'Old', after: 'New', kind: 'change' }],
        argv: ['-use', 'MWG', '-P', '-XMP-dc:Title=New', 'C:\\photos\\a.jpg'],
        warnings: [],
        noop: false,
      },
    ],
    estimatedBytesRequired: 2048,
    blockers: [],
    createdAt: '2026-10-05T10:00:00Z',
    ...overrides,
  };
}

function makeGroup(overrides: Partial<WritePreview> = {}): PreviewGroup[] {
  return [
    {
      label: '1 file',
      evidence: 'previewed',
      preview: makePreview(overrides),
      commandPreview: ['-use', 'MWG', '-P'],
    },
  ];
}

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

const PLAIN_OUTCOME: BatchOutcomeWithCancel = {
  batchId: 'wb_session',
  startedAt: '2026-10-05T10:00:00Z',
  finishedAt: '2026-10-05T10:00:03Z',
  files: [
    { filePath: 'C:\\photos\\a.png', status: 'updated', warnings: [], errors: [], verified: true },
  ],
  updated: 1,
  unchanged: 0,
  failed: 0,
  allVerified: true,
  retryFilePaths: [],
};

const CANCEL_NOTE =
  'Cancel requested. The file currently being written finishes safely with its full verification; the remaining files are not attempted.';

/**
 * Drive BatchPanel through the gate into a held streamed write, the way the
 * user reaches one: stage a title, build the preview, confirm.
 */
async function startHeldBatchWrite(heldFirstFrames: string[]): Promise<{
  send: (frames: string[], close?: boolean) => void;
  root: Root;
  container: HTMLDivElement;
}> {
  useUiStore.setState({ scanResult: SCAN_RESULT, selectedPaths: ['C:\\photos\\a.png'] });
  let sse: { response: Response; send: (frames: string[], close?: boolean) => void } | null = null;
  stubFetch((url) => {
    if (url.startsWith('/api/write/preview')) return json(PREVIEW_ENVELOPE);
    if (url.startsWith('/api/write/execute')) {
      sse = heldSseResponse(heldFirstFrames);
      return sse.response;
    }
    if (url.startsWith('/api/write/cancel')) {
      return json({ batchId: 'wb_live', cancelRequested: true, note: CANCEL_NOTE, commandPreview: [] });
    }
    return json({ code: 'not_found', message: 'unexpected' }, 404);
  });
  const { root, container } = renderWithProviders(<BatchPanel />);
  await flush();
  setInput('input[aria-label="Title"]', 'Session title');
  await flush();
  await act(async () => {
    buttonWith('Preview batch')?.click();
  });
  await flush();
  expect(bodyText()).toContain('Batch review');
  await act(async () => {
    buttonWith('Write 1 file')?.click();
  });
  await flush(3);
  const stream = sse as { send: (frames: string[], close?: boolean) => void } | null;
  if (stream === null) throw new Error('the streamed execute never fired');
  return { send: stream.send, root, container };
}

// ---- (a) survival ---------------------------------------------------------------

describe('the flight survives unmount', () => {
  it('a write in flight outlives its view: another view mounts with the busy gate under it, and release lands lastWrite', async () => {
    const { send, root, container } = await startHeldBatchWrite([progressFrame('wb_live')]);
    expect(useUiStore.getState().writeRun.busy).toBe(true);
    await unmount(root, container);
    expect(useUiStore.getState().writeRun.busy).toBe(true);

    // A DIFFERENT view mounts; the session's busy gate renders under it.
    stubShell();
    const second = renderWithProviders(<HistoryView />);
    await flush();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('aria-label')).toContain('Batch review');
    expect(dialog?.textContent).toContain('Working…');
    expect(dialog?.textContent).toContain('Writing — phase write');

    // Release: the run lands lastWrite and the gate is gone.
    await act(async () => {
      send([completeFrame(PLAIN_OUTCOME)], true);
    });
    await flush();
    expect(useUiStore.getState().lastWrite?.outcome.batchId).toBe('wb_session');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await unmount(second.root, second.container);
  });
});

// ---- (b) the in-dialog cancel lifecycle -----------------------------------------

describe('the in-dialog cancel lifecycle', () => {
  it('offers no cancel before the batch id frame, then the full honest confirm inside the dialog, POSTs the batchId, and shows the requested note', async () => {
    const { send, root, container } = await startHeldBatchWrite([]);
    const dialog = () => document.querySelector('[role="dialog"]');
    expect(dialog()).not.toBeNull();

    // Before the first frame there is no cancel target: progress may show,
    // the affordance may not.
    expect(dialog()?.textContent).toContain('Writing — phase starting');
    expect(dialog()?.textContent).not.toContain('Cancel this batch');

    // The batch id lands on a frame; the affordance appears INSIDE the dialog.
    await act(async () => {
      send([progressFrame('wb_live')]);
    });
    await flush();
    const cancel = Array.from(dialog()?.querySelectorAll('button') ?? []).find((button) =>
      button.textContent?.includes('Cancel this batch'),
    );
    expect(cancel).toBeDefined();
    expect(cancel?.closest('[role="dialog"]')).not.toBeNull();

    // Behind the FULL shared paragraph — the in-flight-file first sentence
    // included (it is the promise a cancel makes).
    await act(async () => {
      cancel?.click();
    });
    const confirmText = dialog()?.textContent ?? '';
    expect(confirmText).toContain(
      'The file being written right now finishes safely with its full backup and verification.',
    );
    expect(confirmText).toContain(
      'Already-written files keep their verified backups; the rest will not be attempted, and the Results report lists every one of them honestly.',
    );

    const cancelCalls: Array<{ url: string; body: unknown }> = [];
    vi.mocked(fetch).mockImplementationOnce(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/write/cancel')) {
        cancelCalls.push({ url, body: JSON.parse(String(init?.body)) });
        return json({ batchId: 'wb_live', cancelRequested: true, note: CANCEL_NOTE, commandPreview: [] });
      }
      return json({ code: 'not_found', message: 'unexpected' }, 404);
    });
    await act(async () => {
      buttonWith('Request cancel')?.click();
    });
    await flush(2);
    expect(cancelCalls.length).toBe(1);
    expect((cancelCalls[0]?.body as { batchId?: string }).batchId).toBe('wb_live');
    expect(dialog()?.textContent).toContain('Cancel requested');

    // Completion ends the flight and the section with it.
    await act(async () => {
      send([completeFrame(PLAIN_OUTCOME)], true);
    });
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await unmount(root, container);
  });

  it('reports an honest refusal when the batch already finished (404)', async () => {
    const { send, root, container } = await startHeldBatchWrite([progressFrame('wb_live')]);
    const dialog = () => document.querySelector('[role="dialog"]');
    vi.mocked(fetch).mockImplementationOnce(async () =>
      json(
        {
          code: 'not_found',
          message:
            'No write batch with this id is running right now (it may already have finished, or the id is wrong). Nothing was cancelled and nothing was changed.',
        },
        404,
      ),
    );
    await act(async () => {
      Array.from(dialog()?.querySelectorAll('button') ?? [])
        .find((button) => button.textContent?.includes('Cancel this batch'))
        ?.click();
    });
    await act(async () => {
      buttonWith('Request cancel')?.click();
    });
    await flush(2);
    expect(dialog()?.textContent).toContain('Cancel was not accepted:');
    expect(dialog()?.textContent).toContain('Nothing was cancelled and nothing was changed.');
    await act(async () => {
      send([completeFrame(PLAIN_OUTCOME)], true);
    });
    await flush();
    await unmount(root, container);
  });
});

// ---- (c) session single-flight ---------------------------------------------------

describe('session single-flight', () => {
  it('review() no-ops while busy, the busy confirm fires nothing, and every view disables its write button', async () => {
    const { send, root, container } = await startHeldBatchWrite([progressFrame('wb_live')]);
    stubShell();

    // The guard itself: a second review while busy does not replace the staged one.
    const { element, probe } = makeProbe();
    const probeRender = renderWithProviders(element);
    await flush();
    probe.current?.review(makeGroup({ previewId: 'pv_second' }), {
      kind: 'edits',
      title: 'Second review must not open',
      edits: [{ tag: 'XMP-dc:Title', op: 'set', value: 'x' }],
    });
    await flush();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-label')).toContain('Batch review');
    expect(dialog?.textContent).not.toContain('Second review must not open');

    // The busy confirm cannot fire a second execute.
    const executeCalls = vi.mocked(fetch).mock.calls.filter(([input]) =>
      String(input).startsWith('/api/write/execute'),
    );
    const working = Array.from(dialog?.querySelectorAll('button') ?? []).find((button) =>
      button.textContent?.includes('Working…'),
    );
    expect(working?.disabled).toBe(true);
    await act(async () => {
      working?.click();
    });
    await flush(2);
    expect(
      vi.mocked(fetch).mock.calls.filter(([input]) => String(input).startsWith('/api/write/execute')).length,
    ).toBe(executeCalls.length);

    // And the OTHER view's own write button is disabled session-wide.
    const third = renderWithProviders(<BatchPanel />);
    await flush();
    expect(buttonWith('Preview batch')?.disabled).toBe(true);

    // The guard releases when the flight ends.
    await act(async () => {
      send([completeFrame(PLAIN_OUTCOME)], true);
    });
    await flush();
    expect(useUiStore.getState().writeRun.busy).toBe(false);
    probe.current?.review(makeGroup({ previewId: 'pv_third' }), {
      kind: 'edits',
      title: 'Third review opens',
      edits: [{ tag: 'XMP-dc:Title', op: 'set', value: 'x' }],
    });
    await flush();
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toContain(
      'Third review opens',
    );
    await unmount(probeRender.root, probeRender.container);
    await unmount(third.root, third.container);
    await unmount(root, container);
  });
});

// ---- (d) the nine-route host partition -------------------------------------------

describe('the host partition across all nine routes', () => {
  it('renders exactly zero-or-one gate dialog on every route (host on non-runner routes, the view mount on runner routes)', async () => {
    stubShell();
    useUiStore.setState({
      scanResult: SCAN_RESULT,
      selectedPaths: ['C:\\photos\\a.png'],
      lastWrite: {
        label: 'Partition probe',
        edits: [],
        outcome: PLAIN_OUTCOME,
        commandPreview: [],
        consistencyNotes: [],
        at: '2026-10-05T10:00:03Z',
      },
      writeRun: {
        ...WRITE_RUN_IDLE,
        groups: makeGroup(),
        config: { kind: 'edits', title: 'Partition probe', edits: [{ tag: 'XMP-dc:Title', op: 'set', value: 'x' }] },
      },
    });
    const { root, container } = renderWithProviders(<App />);
    await flush();

    // The router-derived predicate: the five runner routes, no more, no fewer.
    expect([...RUNNER_ROUTES].sort()).toEqual(['/batch', '/edit', '/history', '/results', '/scrub']);

    // With a review staged: exactly ONE gate dialog on EVERY route — the view
    // mount on the five runner routes, the shell host on the other four.
    for (const route of ROUTES) {
      await act(async () => {
        window.location.hash = `#${route}`;
      });
      await flush(2);
      const dialogs = document.querySelectorAll('[role="dialog"]');
      expect(dialogs.length, `route ${route}`).toBeLessThanOrEqual(1);
      expect(dialogs.length, `route ${route}`).toBe(1);
      expect(dialogs[0]?.getAttribute('aria-label')).toBe('Partition probe');
    }

    // Idle: zero gate dialogs anywhere.
    await act(async () => {
      useUiStore.setState({ writeRun: { ...WRITE_RUN_IDLE } });
    });
    for (const route of ROUTES) {
      await act(async () => {
        window.location.hash = `#${route}`;
      });
      await flush(2);
      expect(document.querySelectorAll('[role="dialog"]').length, `route ${route}`).toBe(0);
    }
    await unmount(root, container);
  });
});

// ---- (e) latch truth -------------------------------------------------------------

/**
 * The latch lives in the SHELL, so these tests drive the write inside the real
 * App (BatchPanel under AppShell), starting from #/batch.
 */
async function startHeldWriteInApp(firstFrames: string[]): Promise<{
  send: (frames: string[], close?: boolean) => void;
  root: Root;
  container: HTMLDivElement;
}> {
  window.location.hash = '#/batch';
  useUiStore.setState({ scanResult: SCAN_RESULT, selectedPaths: ['C:\\photos\\a.png'] });
  let sse: { response: Response; send: (frames: string[], close?: boolean) => void } | null = null;
  stubFetch((url) => {
    if (url.startsWith('/api/health')) return json(HEALTH_READ_ONLY);
    if (url.startsWith('/api/events')) return new Response(null, { status: 503 });
    if (url.startsWith('/api/file/metadata')) return json(METADATA);
    if (url.startsWith('/api/write/history')) {
      return json({ batches: [], writeUnlocked: true, mode: 'write-unlocked', commandPreview: [] });
    }
    if (url.startsWith('/api/write/preview')) return json(PREVIEW_ENVELOPE);
    if (url.startsWith('/api/write/execute')) {
      sse = heldSseResponse(firstFrames);
      return sse.response;
    }
    return json({ code: 'not_found', message: 'unexpected' }, 404);
  });
  const { root, container } = renderWithProviders(<App />);
  await flush();
  setInput('input[aria-label="Title"]', 'Session title');
  await flush();
  await act(async () => {
    buttonWith('Preview batch')?.click();
  });
  await flush();
  await act(async () => {
    buttonWith('Write 1 file')?.click();
  });
  await flush(3);
  const stream = sse as { send: (frames: string[], close?: boolean) => void } | null;
  if (stream === null) throw new Error('the streamed execute never fired');
  return { send: stream.send, root, container };
}

describe('the completion latch', () => {
  it('success away from the origin route: no yank, the latch offers the report, the click lands on Results and clears', async () => {
    const { send, root, container } = await startHeldWriteInApp([progressFrame('wb_live')]);
    await act(async () => {
      window.location.hash = '#/history';
    });
    await flush();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      send([completeFrame(PLAIN_OUTCOME)], true);
    });
    await flush();
    // No yank: the hash is untouched, the latch tells the truth instead.
    expect(window.location.hash).toBe('#/history');
    expect(useUiStore.getState().writeRun.completion).toBe('done');
    expect(bodyText()).toContain('Write finished');
    const viewReport = buttonWith('View report');
    expect(viewReport).toBeDefined();
    await act(async () => {
      viewReport?.click();
    });
    await flush();
    expect(window.location.hash).toBe('#/results');
    expect(useUiStore.getState().writeRun.completion).toBeNull();
    expect(bodyText()).not.toContain('View report');
    await unmount(root, container);
  });

  it('failure away: the latch says failed and NEVER renders success copy; the honest note waits below the still-open gate', async () => {
    const writeError =
      'event: write-error\ndata: {"seq":2,"timestamp":"t","type":"write-error","code":"internal_error","message":"The engine failed mid-batch."}\n\n';
    const { send, root, container } = await startHeldWriteInApp([progressFrame('wb_live')]);
    await act(async () => {
      window.location.hash = '#/history';
    });
    await flush();
    await act(async () => {
      send([writeError], true);
    });
    await flush();
    expect(window.location.hash).toBe('#/history');
    expect(useUiStore.getState().writeRun.completion).toBe('failed');
    expect(bodyText()).not.toContain('Write finished');

    // The failed edits-arm run leaves the gate open (the host renders it here);
    // the latch note stays below it until the review is closed.
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(bodyText()).not.toContain('check History for what actually happened');
    const cancel = Array.from(dialog?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Cancel',
    );
    await act(async () => {
      cancel?.click();
    });
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(bodyText()).toContain('The write ran into a problem — check History for what actually happened.');
    expect(bodyText()).not.toContain('Write finished');
    await unmount(root, container);
  });
});

// ---- (f) no cancel affordance on the non-streamed arms ---------------------------

describe('non-streamed arms get no in-dialog flight affordances', () => {
  /**
   * Open a review for ONE arm, confirm it against a fetch that never resolves,
   * and assert the busy gate shows neither a cancel affordance nor progress
   * lines — the section renders nothing the arm cannot honestly claim.
   */
  async function expectNoFlightAffordance(
    config: WriteRunConfig,
    confirmLabel: string,
    typePhrase?: string,
  ): Promise<void> {
    const pending = new Promise<Response>(() => undefined);
    const heldBodies: string[] = [];
    stubFetch((url, init) => {
      if (
        url.startsWith('/api/write/execute') ||
        url.startsWith('/api/write/undo') ||
        url.startsWith('/api/scrub/execute')
      ) {
        heldBodies.push(String(init?.body));
        return pending;
      }
      return json({ code: 'not_found', message: 'unexpected' }, 404);
    });
    const { element, probe } = makeProbe();
    const { root, container } = renderWithProviders(element);
    await flush();
    probe.current?.review(makeGroup(), config);
    await flush();
    if (typePhrase !== undefined) setInput('#destructive-phrase', typePhrase);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    await act(async () => {
      Array.from(dialog?.querySelectorAll('button') ?? [])
        .find((button) => button.textContent?.includes(confirmLabel))
        ?.click();
    });
    await flush(3);
    // The arm fired exactly one NON-streamed call — nothing that could carry a
    // batch id, so the section must not promise one.
    expect(heldBodies.length).toBe(1);
    expect(heldBodies[0]).not.toContain('"stream":true');
    expect(useUiStore.getState().writeRun.busy).toBe(true);
    const busyDialog = document.querySelector('[role="dialog"]');
    expect(busyDialog?.textContent).toContain('Working…');
    expect(busyDialog?.textContent).not.toContain('Cancel this batch');
    expect(busyDialog?.textContent).not.toContain('Writing — phase');
    expect(busyDialog?.querySelector('[role="status"]')).toBeNull();
    await unmount(root, container);
  }

  it('the undo arm', async () => {
    await expectNoFlightAffordance(
      { kind: 'undo', undoBatchId: 'wb_undo', title: 'Undo hold' },
      'Write 1 file',
    );
  });

  it('the preview (GPS) arm', async () => {
    await expectNoFlightAffordance(
      { kind: 'preview', title: 'Remove GPS — hold', destructive: { confirmationPhrase: 'ERASE LOCATION NOW' } },
      'Remove metadata from 1 file',
      'ERASE LOCATION NOW',
    );
  });

  it('the scrub arm', async () => {
    await expectNoFlightAffordance(
      {
        kind: 'scrub',
        title: 'AI-metadata scrub — hold',
        files: ['C:\\photos\\a.jpg'],
        destructive: { confirmationPhrase: 'REMOVE AI METADATA' },
        recordEdits: [],
        onRecorded: () => undefined,
      },
      'Remove metadata from 1 file',
      'REMOVE AI METADATA',
    );
  });
});

// ---- (g) the persist exclusion ----------------------------------------------------

describe('writeRun never persists', () => {
  it('the partialize output carries no flight state, even mid-write', async () => {
    useUiStore.setState({
      writeRun: {
        ...WRITE_RUN_IDLE,
        busy: true,
        activeBatchId: 'wb_live',
        progress: { phase: 'write', index: 1, total: 2 },
        groups: makeGroup(),
      },
    });
    useUiStore.getState().pushRecent('C:\\photos');
    await flush(2);
    const persisted = JSON.parse(window.localStorage.getItem('metadesk-ui') ?? '{}') as {
      state?: Record<string, unknown>;
    };
    expect(Object.keys(persisted.state ?? {}).sort()).toEqual([
      'consoleHistory',
      'density',
      'recents',
      'theme',
    ]);
    expect('writeRun' in (persisted.state ?? {})).toBe(false);
  });
});

// ---- (h) the busy section's fidelity guard ----------------------------------------

describe('the in-dialog flight section fidelity', () => {
  const flight: WriteRunFlight = {
    progress: { phase: 'write', index: 3, total: 10 },
    cancelOfferable: true,
    cancelState: null,
    onRequestCancel: () => undefined,
  };

  it('renders progress and the cancel while busy, and never claims chunk-streaming', async () => {
    const busyRun = renderWithProviders(
      <SaveReviewModal
        open
        title="Fidelity probe"
        groups={makeGroup()}
        streamed
        busy
        flight={flight}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    const section = document.querySelector('[role="dialog"] [role="status"]');
    expect(section).not.toBeNull();
    const text = section?.textContent ?? '';
    expect(text).toContain('Writing — phase write');
    expect(text).toContain('3 of 10 files processed.');
    expect(text).toContain('Cancel this batch');
    // The chunk-streaming sentence belongs to the PRE-write gate note, never
    // to the busy section.
    expect(text.toLowerCase()).not.toContain('chunk');
    expect(text.toLowerCase()).not.toContain('stream');
    await unmount(busyRun.root, busyRun.container);
  });

  it('renders nothing when not busy, even with flight data present', async () => {
    const idleRun = renderWithProviders(
      <SaveReviewModal
        open
        title="Fidelity probe"
        groups={makeGroup()}
        streamed
        busy={false}
        flight={flight}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(document.querySelector('[role="dialog"] [role="status"]')).toBeNull();
    expect(bodyText()).not.toContain('Cancel this batch');
    await unmount(idleRun.root, idleRun.container);
  });
});
