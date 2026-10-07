// @vitest-environment jsdom
/**
 * Write-surface safety tests (jsdom, no live server): the Save Review gate,
 * empty-means-unchanged, the amber unlocked mode, the three-valued results,
 * the destructive gates through the shared modal (GPS + scrub, typed phrase),
 * the write-FIRING source contract, and the streaming execute consumer. Every
 * test stubs fetch — nothing here touches a real engine.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../App';
// Vite's ?raw loader has no type declaration for relative specifiers; the
// runtime value is the module source text.
// @ts-expect-error — TS2307: raw imports of relative paths are untyped
import appSource from '../App.tsx?raw';
// @ts-expect-error — TS2307: raw imports of relative paths are untyped
import editPanelSource from '../views/EditPanel.tsx?raw';
// @ts-expect-error — TS2307: raw imports of relative paths are untyped
import scrubWizardSource from '../views/ScrubWizard.tsx?raw';
// @ts-expect-error — TS2307: raw imports of relative paths are untyped
import batchPanelSource from '../views/BatchPanel.tsx?raw';
// @ts-expect-error — TS2307: raw imports of relative paths are untyped
import resultsReportSource from '../views/ResultsReport.tsx?raw';
// @ts-expect-error — TS2307: raw imports of relative paths are untyped
import historyViewSource from '../views/HistoryView.tsx?raw';
// @ts-expect-error — TS2307: raw imports of relative paths are untyped
import useWriteRunSource from './useWriteRun.tsx?raw';
// @ts-expect-error — TS2307: raw imports of relative paths are untyped
import clientSource from '../api/client.ts?raw';
import { SaveReviewModal, type PreviewGroup } from '../components/SaveReviewModal';
import { EditPanel } from '../views/EditPanel';
import { ResultsReport } from '../views/ResultsReport';
import { ScrubWizard } from '../views/ScrubWizard';
import { useUiStore } from '../state/store';
import { executeWrite } from '../api/client';
import type { DetectedPreview, WritePreview, WritePreviewFile } from './types';

const appSourceText: string = appSource as string;

// React 19: opt this environment into act() explicitly.
(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const HEALTH_READ_ONLY = {
  ok: true,
  version: '13.59',
  readOnlyFallback: false,
  executablePath: 'C:\\vendor\\exiftool.exe',
  minimumVersion: '12.15',
};

const HEALTH_UNLOCKED = { ...HEALTH_READ_ONLY, writeUnlocked: true, mode: 'write-unlocked' };

const METADATA = {
  filePath: 'C:\\photos\\a.jpg',
  depth: 'simple',
  readAt: '2026-10-05T10:00:00Z',
  kind: 'jpeg',
  simple: {
    title: 'Old title',
    keywords: ['family'],
    rating: 3,
    dateTaken: '2026-06-01T10:00:00Z',
    dateTakenRaw: '2026:06:01 10:00:00',
    copyright: '(c) Mike',
    creator: 'Mike',
    gps: { latitude: 41.2, longitude: -75.9 },
  },
  all: {},
  raw: [],
  warnings: [],
  errors: [],
};

const SCRUB_REPORT = {
  scrubId: 'sc_test',
  scope: 'ai-generation-metadata',
  createdAt: '2026-10-05T10:00:00Z',
  files: [
    {
      filePath: 'C:\\photos\\a.png',
      softwareMatches: ['stable diffusion'],
      tags: [
        { tag: 'PNG:Parameters', value: 'steps:20, sampler:euler', removable: true },
        {
          tag: 'PNG:prompt',
          value: '{"workflow": "comfy graph"}',
          removable: false,
          note: 'A ComfyUI "prompt" chunk. The engine cannot delete this chunk by name.',
        },
      ],
      c2paPresent: true,
      jumbfPresent: false,
      alphaChannel: true,
      possibleHiddenAlphaData: true,
      hiddenAlphaNote: 'This PNG has an alpha channel.',
    },
  ],
  affectedTags: [{ filePath: 'C:\\photos\\a.png', tag: 'PNG:Parameters', value: 'steps:20' }],
  cleanFilePaths: [],
  blockedFilePaths: [],
  requiresTypedConfirmation: true,
  confirmationPhrase: 'REMOVE AI METADATA',
};

/** A minimal-but-honest WritePreview fixture. */
function makePreview(overrides: Partial<WritePreview> = {}): WritePreview {
  return {
    previewId: 'pv_test',
    planId: 'pl_test',
    files: [
      {
        filePath: 'C:\\photos\\a.jpg',
        diffs: [
          { tag: 'XMP-dc:Title', before: 'Old title', after: 'New title', kind: 'change' },
        ],
        argv: ['-use', 'MWG', '-P', '-XMP-dc:Title=New title', 'C:\\photos\\a.jpg'],
        warnings: ['The file is marked read-only. Windows may refuse the write.'],
        noop: false,
      },
      {
        filePath: 'C:\\photos\\b.jpg',
        diffs: [{ tag: 'XMP-dc:Title', before: 'Same', after: 'Same', kind: 'unchanged' }],
        argv: ['-use', 'MWG', '-P', '-XMP-dc:Title=Same', 'C:\\photos\\b.jpg'],
        warnings: [],
        noop: true,
      },
    ],
    estimatedBytesRequired: 2048,
    blockers: [],
    createdAt: '2026-10-05T10:00:00Z',
    ...overrides,
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type FetchHandler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
type FetchStub = ReturnType<typeof vi.fn>;

function stubFetch(handler: FetchHandler): FetchStub {
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    return handler(url, init);
  });
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
  });
});

async function flush(turns = 3): Promise<void> {
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

// ---- fixtures for the detected (scan-projection) gate ---------------------------

/** A DetectedPreview built the way the scrub wizard builds it. */
function makeDetected(overrides: Partial<DetectedPreview> = {}): DetectedPreview {
  return {
    detectionId: 'sc_test',
    files: [
      {
        filePath: 'C:\\photos\\a.png',
        diffs: [{ tag: 'PNG:Parameters', before: 'steps:20, sampler:euler', kind: 'delete' }],
        warnings: ['This PNG has an alpha channel.'],
        noop: false,
      },
    ],
    blockers: [],
    ...overrides,
  };
}

/** A previewed group carrying `count` files (for chunk-math assertions). */
function makeMultiFilePreviewGroup(count: number): PreviewGroup {
  return {
    label: `${count} files`,
    evidence: 'previewed',
    preview: makePreview({
      files: Array.from({ length: count }, (_, index) => ({
        filePath: `C:\\photos\\f${index}.jpg`,
        diffs: [],
        argv: [],
        warnings: [],
        noop: true,
      })),
    }),
    commandPreview: [],
  };
}

function makeMultiFileDetectedGroup(count: number): PreviewGroup {
  return {
    label: `${count} files`,
    evidence: 'detected',
    detected: makeDetected({
      files: Array.from({ length: count }, (_, index) => ({
        filePath: `C:\\photos\\f${index}.png`,
        diffs: [{ tag: 'PNG:Parameters', before: 'steps:20', kind: 'delete' as const }],
        warnings: [],
        noop: false,
      })),
    }),
  };
}

// ---- SaveReviewModal -----------------------------------------------------------

describe('SaveReviewModal', () => {
  const baseProps = (groups: PreviewGroup[]) => ({
    open: true,
    title: 'Save review',
    groups,
    onConfirm: () => undefined,
    onCancel: () => undefined,
  });

  it('renders per-tag old → new diffs, the backup statement, and the noop truth', () => {
    const group: PreviewGroup = {
      label: '2 files',
      evidence: 'previewed',
      preview: makePreview(),
      commandPreview: ['-use', 'MWG', '-P'],
    };
    const { root, container } = renderWithProviders(<SaveReviewModal {...baseProps([group])} />);
    const text = bodyText();
    expect(text).toContain('a.jpg');
    expect(text).toContain('1 will change');
    expect(text).toContain('1 no change needed');
    expect(text).toContain('Backup first:');
    expect(text).toContain('filename_original');
    expect(text).toContain('Command preview');
    // Diffs are behind per-file disclosure — expand the changing file.
    const toggle = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('a.jpg'),
    );
    expect(toggle).toBeDefined();
    act(() => {
      toggle?.click();
    });
    const expanded = bodyText();
    expect(expanded).toContain('XMP-dc:Title');
    expect(expanded).toContain('Old title');
    expect(expanded).toContain('New title');
    expect(expanded).toContain('The file is marked read-only');
    void unmount(root, container);
  });

  it('disables execute while blockers stand, and enables when they are gone', () => {
    const blocked: PreviewGroup = {
      label: 'blocked',
      evidence: 'previewed',
      preview: makePreview({ blockers: ['The folder is not writable: C:\\photos'] }),
      commandPreview: [],
    };
    const { root, container } = renderWithProviders(<SaveReviewModal {...baseProps([blocked])} />);
    expect(bodyText()).toContain('Blocked');
    const disabled = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Write 1 file'),
    );
    expect(disabled).toBeDefined();
    expect(disabled?.disabled).toBe(true);

    // Remove the blocker: the same review becomes writable.
    const clear: PreviewGroup = { ...blocked, preview: makePreview() };
    act(() => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <SaveReviewModal {...baseProps([clear])} />
        </QueryClientProvider>,
      );
    });
    const enabled = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Write 1 file'),
    );
    expect(enabled).toBeDefined();
    expect(enabled?.disabled).toBe(false);
    void unmount(root, container);
  });
});

// ---- EditPanel: empty means unchanged --------------------------------------------

describe('EditPanel', () => {
  it('starts with every field empty ("leave unchanged") and Save disabled', async () => {
    useUiStore.setState({ selectedPaths: ['C:\\photos\\a.jpg'] });
    const fetchStub = stubFetch((url) => {
      if (url.startsWith('/api/file/metadata')) return json(METADATA);
      return json({ code: 'not_found', message: 'unexpected' }, 404);
    });
    const { root, container } = renderWithProviders(<EditPanel />);
    await flush();
    // Placeholders are the empty-means-unchanged contract: every text field
    // says so, and the tray confirms nothing is staged.
    const placeholders = Array.from(document.querySelectorAll('input,textarea'))
      .map((element) => element.getAttribute('placeholder'))
      .filter((value) => value === 'Empty = leave unchanged');
    expect(placeholders.length).toBeGreaterThanOrEqual(3);
    expect(bodyText()).toContain('Nothing changed yet — an empty field means leave unchanged');

    const save = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Review & Save'),
    );
    expect(save?.disabled).toBe(true);
    expect(fetchStub).not.toHaveBeenCalledWith('/api/write/preview', expect.anything());
    void unmount(root, container);
  });

  it('typing a title produces set edits for both MWG partners in the preview call', async () => {
    useUiStore.setState({ selectedPaths: ['C:\\photos\\a.jpg'] });
    const calls: Array<{ url: string; body: unknown }> = [];
    stubFetch((url, init) => {
      if (url.startsWith('/api/file/metadata')) return json(METADATA);
      if (url.startsWith('/api/write/preview')) {
        calls.push({ url, body: JSON.parse(String(init?.body)) });
        const singleFile: WritePreviewFile = makePreview().files[0] as WritePreviewFile;
        return json({
          preview: makePreview({ files: [singleFile] }),
          commandPreview: ['-use', 'MWG'],
          diffNotes: [],
          writeUnlocked: false,
        });
      }
      return json({ code: 'not_found', message: 'unexpected' }, 404);
    });
    const { root, container } = renderWithProviders(<EditPanel />);
    await flush();

    const title = document.querySelector('input[aria-label="Title"]') as HTMLInputElement | null;
    expect(title).not.toBeNull();
    await act(async () => {
      title?.focus();
      title?.dispatchEvent(new Event('focus', { bubbles: false }));
      if (title !== null) {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        )?.set;
        setter?.call(title, 'New title');
        title.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await flush();

    const save = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Review & Save'),
    ) as HTMLButtonElement | undefined;
    expect(save?.disabled).toBe(false);
    await act(async () => {
      save?.click();
    });
    await flush();

    expect(calls.length).toBe(1);
    const body = calls[0]?.body as { files: string[]; edits: Array<{ tag: string; op: string; value: string }> };
    expect(body.files).toEqual(['C:\\photos\\a.jpg']);
    expect(body.edits).toEqual([
      { tag: 'XMP-dc:Title', op: 'set', value: 'New title' },
      { tag: 'IPTC:ObjectName', op: 'set', value: 'New title' },
    ]);
    // The mandatory gate opened.
    expect(bodyText()).toContain('Save review');
    void unmount(root, container);
  });
});

// ---- ModeBanner: amber when health says unlocked ----------------------------------

describe('ModeBanner / mode chrome', () => {
  it('flips to amber Write unlocked (with Lock) when health reports writeUnlocked', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/health')) return json(HEALTH_UNLOCKED);
      if (url.startsWith('/api/events')) return new Response(null, { status: 503 });
      return json({ code: 'not_found', message: 'unexpected' }, 404);
    });
    const { root, container } = renderWithProviders(<App />);
    await flush();
    const text = bodyText();
    expect(text).toContain('Write unlocked');
    expect(text).toContain('session only');
    // The amber frame is on: a fixed, pointer-events-none border overlay.
    const frame = document.querySelector('div.pointer-events-none.fixed.inset-0');
    expect(frame).not.toBeNull();
    expect(frame?.className).toContain('border-warning');
    expect(text).toContain('Lock');
    void unmount(root, container);
  });

  it('stays calm gray read-only (with Unlock) when the server is locked', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/health')) return json(HEALTH_READ_ONLY);
      if (url.startsWith('/api/events')) return new Response(null, { status: 503 });
      return json({ code: 'not_found', message: 'unexpected' }, 404);
    });
    const { root, container } = renderWithProviders(<App />);
    await flush();
    const text = bodyText();
    expect(text).toContain('Read-only');
    expect(text).toContain('Unlock');
    expect(text).not.toContain('Write unlocked');
    expect(document.querySelector('div.pointer-events-none.fixed.inset-0')).toBeNull();
    void unmount(root, container);
  });
});

// ---- ResultsReport: three-valued truth ---------------------------------------------

describe('ResultsReport', () => {
  it('renders updated / unchanged / failed as three separate states with retry', async () => {
    useUiStore.setState({
      lastWrite: {
        label: 'Batch review — 4 files',
        edits: [{ tag: 'XMP-dc:Title', op: 'set', value: 'New title' }],
        outcome: {
          batchId: 'wb_test',
          startedAt: '2026-10-05T10:00:00Z',
          finishedAt: '2026-10-05T10:00:05Z',
          files: [
            {
              filePath: 'C:\\photos\\a.jpg',
              status: 'updated',
              warnings: [],
              errors: [],
              verified: true,
              backup: {
                path: 'C:\\photos\\a.jpg_original',
                sizeBytes: 123,
                sha256: 'a'.repeat(64),
                createdAt: '2026-10-05T10:00:01Z',
              },
            },
            { filePath: 'C:\\photos\\b.jpg', status: 'updated', warnings: [], errors: [], verified: true },
            { filePath: 'C:\\photos\\c.jpg', status: 'unchanged', warnings: [], errors: [] },
            {
              filePath: 'C:\\photos\\d.jpg',
              status: 'failed',
              warnings: [],
              errors: ['Error renaming temporary file: being used by another process.'],
              stage: 'write',
            },
          ],
          updated: 2,
          unchanged: 1,
          failed: 1,
          allVerified: true,
          retryFilePaths: ['C:\\photos\\d.jpg'],
        },
        commandPreview: ['-use', 'MWG'],
        consistencyNotes: [],
        at: '2026-10-05T10:00:05Z',
      },
    });
    const { root, container } = renderWithProviders(<ResultsReport />);
    await flush();
    const text = bodyText();
    expect(text).toContain('Updated');
    expect(text).toContain('Unchanged — nothing happened');
    expect(text).toContain('Needs attention');
    expect(text).toContain('Retry failed (1)');
    // The one-count-per-state sanity check: '2' updated, '1' unchanged, '1' failed.
    const cards = document.querySelectorAll('[aria-label="Outcome counts"] > div');
    expect(cards.length).toBe(3);

    // Expand the failed row: plain-English explanation + the verbatim stderr.
    const row = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('d.jpg'),
    );
    await act(async () => {
      row?.click();
    });
    const expanded = bodyText();
    expect(expanded).toContain('The file is open in another program');
    expect(expanded).toContain('pause OneDrive');
    expect(expanded).toContain('Error renaming temporary file');
    void unmount(root, container);
  });
});

// ---- ScrubWizard: the typed-phrase gate lives in the shared modal ---------------

describe('ScrubWizard', () => {
  it('detect and findings stay honest, then the modal gate refuses until REMOVE AI METADATA is typed exactly', async () => {
    useUiStore.setState({ selectedPaths: ['C:\\photos\\a.png'] });
    const calls: Array<{ url: string; body: unknown; raw: string }> = [];
    stubFetch((url, init) => {
      if (url.startsWith('/api/scrub/preview')) {
        return json({ report: SCRUB_REPORT, commandPreview: [], note: 'read-only scan' });
      }
      if (url.startsWith('/api/scrub/execute')) {
        calls.push({ url, body: JSON.parse(String(init?.body)), raw: String(init?.body) });
        return json({
          outcome: {
            batchId: 'wb_scrub',
            startedAt: '2026-10-05T10:00:00Z',
            finishedAt: '2026-10-05T10:00:05Z',
            files: [
              {
                filePath: 'C:\\photos\\a.png',
                status: 'updated',
                warnings: [],
                errors: [],
                verified: true,
              },
            ],
            updated: 1,
            unchanged: 0,
            failed: 0,
            allVerified: true,
            retryFilePaths: [],
          },
          commandPreview: [],
          consistencyNotes: [],
          report: SCRUB_REPORT,
          exportedValuesPath: 'C:\\data\\journal\\exports\\sc_test.json',
          notRemoved: [
            {
              filePath: 'C:\\photos\\a.png',
              tag: 'PNG:prompt',
              reason: 'A ComfyUI "prompt" chunk. The engine cannot delete this chunk by name.',
            },
          ],
        });
      }
      if (url.startsWith('/api/health')) return json(HEALTH_READ_ONLY);
      if (url.startsWith('/api/events')) return new Response(null, { status: 503 });
      return json({ code: 'not_found', message: 'unexpected' }, 404);
    });
    const { root, container } = renderWithProviders(<ScrubWizard />);
    await flush();

    // Step 1 → run detection (unchanged surface).
    const scan = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Scan for AI metadata'),
    );
    expect(scan).toBeDefined();
    await act(async () => {
      scan?.click();
    });
    await flush();

    // Step 2: findings honesty — removable, cannot-remove, hidden alpha (unchanged).
    const findings = bodyText();
    expect(findings).toContain('CANNOT be removed');
    expect(findings).toContain('PNG:Parameters');
    expect(findings).toContain('PNG:prompt');
    expect(findings).toContain('cannot scrub pixels');

    // 'Continue to confirm (N)' keeps its copy and opens the SHARED gate.
    const next = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Continue to confirm (1)'),
    );
    await act(async () => {
      next?.click();
    });
    await flush();

    // The gate is the Save Review modal now: detection-grade header (the wipe
    // re-detects, so no exact-change claim), no argv, no chunk note.
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement | null;
    expect(dialog).not.toBeNull();
    const dialogText = dialog?.textContent ?? '';
    expect(dialogText).toContain('REMOVE AI METADATA');
    expect(dialogText).not.toContain('exact change MetaDesk will make');
    expect(dialogText).toContain('re-scans every file');
    expect(dialogText).not.toContain('Exact command');
    expect(dialogText).not.toContain('progress streams per chunk');
    // The wizard's own confirm step is gone.
    expect(document.querySelector('#scrub-phrase')).toBeNull();

    const phraseInput = document.querySelector('#destructive-phrase') as HTMLInputElement | null;
    expect(phraseInput).not.toBeNull();
    const setPhrase = (value: string): void => {
      if (phraseInput === null) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
        ?.set;
      act(() => {
        setter?.call(phraseInput, value);
        phraseInput.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    const execute = () =>
      Array.from(document.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Remove AI metadata from 1 file'),
      ) as HTMLButtonElement | undefined;
    expect(execute()?.disabled).toBe(true);

    setPhrase('remove ai metadata'); // wrong case — refused
    expect(execute()?.disabled).toBe(true);
    setPhrase('DELETE EVERYTHING'); // wrong phrase — refused
    expect(execute()?.disabled).toBe(true);
    setPhrase('REMOVE AI METADATA'); // exact — enabled
    expect(execute()?.disabled).toBe(false);

    await act(async () => {
      execute()?.click();
    });
    await flush();

    // The scrub execute body is EXACTLY {files, confirm} — the TYPED phrase,
    // never the synthetic scrubId.
    expect(calls.length).toBe(1);
    expect(calls[0]?.body).toEqual({
      files: ['C:\\photos\\a.png'],
      confirm: 'REMOVE AI METADATA',
    });
    expect(calls[0]?.raw).not.toContain('sc_test');
    // lastWrite carries the scrub label + recordEdits + the execute's extras.
    const lastWrite = useUiStore.getState().lastWrite;
    expect(lastWrite?.label).toBe('AI-metadata scrub — 1 file(s)');
    expect(lastWrite?.edits).toEqual([{ tag: 'PNG:Parameters', op: 'delete' }]);
    expect(lastWrite?.scrub?.exportedValuesPath).toBe('C:\\data\\journal\\exports\\sc_test.json');
    // onRecorded ran: the file still carries the unremovable PNG:prompt chunk
    // (it is in notRemoved), so its AI badge honestly STAYS flagged.
    expect(useUiStore.getState().badges['C:\\photos\\a.png']?.aiGenerated).toBe(true);
    // The runner navigated to Results.
    expect(window.location.hash).toBe('#/results');
    void unmount(root, container);
  });
});

// ---- GPS strip through the runner: non-streamed, server-minted phrase -----------

describe('GPS strip through the Save Review modal', () => {
  const GPS_PREVIEW = {
    preview: makePreview({
      previewId: 'pv_gps',
      planId: 'pl_gps',
      files: [
        {
          filePath: 'C:\\photos\\a.jpg',
          diffs: [{ tag: 'GPS:GPSLatitude', before: '37 deg 48\' N', kind: 'delete' }],
          argv: ['-GPS:all=', 'C:\\photos\\a.jpg'],
          warnings: [],
          noop: false,
        },
      ],
    }),
    commandPreview: ['-GPS:all=', 'C:\\photos\\a.jpg'],
    diffNotes: [],
    writeUnlocked: true,
    destructive: {
      scope: 'gps',
      requiresTypedConfirmation: true,
      // NOT the dead client constant — proves the gate binds the server phrase.
      confirmationPhrase: 'ERASE LOCATION NOW',
    },
    gpsStripId: 'gs_test',
    exportedValuesPath: 'C:\\data\\journal\\exports\\gs_test.json',
    notRemoved: [{ filePath: 'C:\\photos\\a.jpg', tag: 'GPS:GPSMapDatum', reason: 'Cannot delete by name.' }],
  };

  function stubGpsFlow(executeResponse: () => Response): {
    calls: Array<{ url: string; body: unknown; raw: string }>;
  } {
    const calls: Array<{ url: string; body: unknown; raw: string }> = [];
    stubFetch((url, init) => {
      if (url.startsWith('/api/file/metadata')) return json(METADATA);
      if (url.startsWith('/api/write/preview')) {
        return json(GPS_PREVIEW);
      }
      if (url.startsWith('/api/write/execute')) {
        calls.push({ url, body: JSON.parse(String(init?.body)), raw: String(init?.body) });
        return executeResponse();
      }
      return json({ code: 'not_found', message: 'unexpected' }, 404);
    });
    return { calls };
  }

  async function openGate(): Promise<void> {
    const button = Array.from(document.querySelectorAll('button')).find((element) =>
      element.textContent?.includes('Remove GPS from selection…'),
    );
    expect(button).toBeDefined();
    await act(async () => {
      button?.click();
    });
    await flush();
    // The title doubles as the lastWrite label — HEAD's exact pluralization.
    const dialog = document.querySelector('[role="dialog"][aria-label^="Remove GPS — 1 file"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('aria-label')).toBe('Remove GPS — 1 file');
  }

  function typePhrase(value: string): void {
    const phraseInput = document.querySelector('#destructive-phrase') as HTMLInputElement | null;
    if (phraseInput === null) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(phraseInput, value);
      phraseInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function confirmButton(): HTMLButtonElement | undefined {
    return Array.from(document.querySelectorAll('button')).find((element) =>
      element.textContent?.includes('Strip GPS data now'),
    ) as HTMLButtonElement | undefined;
  }

  it('sends {previewId, destructive} with the TYPED phrase and NEVER streams', async () => {
    useUiStore.setState({ selectedPaths: ['C:\\photos\\a.jpg'] });
    const { calls } = stubGpsFlow(() =>
      json({
        outcome: {
          batchId: 'wb_gps',
          startedAt: '2026-10-05T10:00:00Z',
          finishedAt: '2026-10-05T10:00:02Z',
          files: [
            { filePath: 'C:\\photos\\a.jpg', status: 'updated', warnings: [], errors: [], verified: true },
          ],
          updated: 1,
          unchanged: 0,
          failed: 0,
          allVerified: true,
          retryFilePaths: [],
        },
        commandPreview: ['-GPS:all=', 'C:\\photos\\a.jpg'],
        consistencyNotes: ['Engine cross-check note: none.'],
        writeUnlocked: true,
      }),
    );
    const { root, container } = renderWithProviders(<EditPanel />);
    await flush();
    await openGate();

    // The gate shows the SERVER-MINTED phrase, the not-removed honesty rows,
    // and the backup statement — the richer gate.
    const dialogText = document.querySelector('[role="dialog"]')?.textContent ?? '';
    expect(dialogText).toContain('ERASE LOCATION NOW');
    expect(dialogText).not.toContain('REMOVE GPS DATA');
    expect(dialogText).toContain('GPS:GPSMapDatum');
    expect(dialogText).toContain('Backup first:');
    expect(confirmButton()?.disabled).toBe(true);

    typePhrase('erase location now'); // wrong case — refused
    expect(confirmButton()?.disabled).toBe(true);
    typePhrase('REMOVE GPS DATA'); // the dead client constant — refused
    expect(confirmButton()?.disabled).toBe(true);
    typePhrase('ERASE LOCATION NOW'); // exact — enabled
    expect(confirmButton()?.disabled).toBe(false);
    await act(async () => {
      confirmButton()?.click();
    });
    await flush();

    // Wire pin: {previewId, destructive:{confirmationPhrase}} — typed phrase,
    // NO "stream":true (the consistencyNotes channel must survive).
    expect(calls.length).toBe(1);
    expect(calls[0]?.body).toEqual({
      previewId: 'pv_gps',
      destructive: { confirmationPhrase: 'ERASE LOCATION NOW' },
    });
    expect(calls[0]?.raw).not.toContain('"stream"');
    // lastWrite: HEAD parity — label, empty edits (inert Retry quirk kept),
    // consistencyNotes from the plain response, extras from the PREVIEW.
    const lastWrite = useUiStore.getState().lastWrite;
    expect(lastWrite?.label).toBe('Remove GPS — 1 file');
    expect(lastWrite?.edits).toEqual([]);
    expect(lastWrite?.consistencyNotes).toEqual(['Engine cross-check note: none.']);
    expect(lastWrite?.scrub).toEqual({
      exportedValuesPath: 'C:\\data\\journal\\exports\\gs_test.json',
      notRemoved: GPS_PREVIEW.notRemoved,
    });
    void unmount(root, container);
  });

  it('renders a 403 refusal INSIDE the still-open dialog and a retry re-POSTs the same preview', async () => {
    useUiStore.setState({ selectedPaths: ['C:\\photos\\a.jpg'] });
    const { calls } = stubGpsFlow(() =>
      json(
        {
          code: 'unsafe_tag',
          message: 'The confirmation phrase did not match. Nothing was written.',
        },
        403,
      ),
    );
    const { root, container } = renderWithProviders(<EditPanel />);
    await flush();
    await openGate();

    typePhrase('ERASE LOCATION NOW');
    await act(async () => {
      confirmButton()?.click();
    });
    await flush();

    // jsdom cannot see occlusion — assert the refusal lives INSIDE the
    // role=dialog subtree, with the groups still intact (retype-and-retry).
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('This was refused — nothing was changed.');
    expect(dialog?.textContent).toContain('The confirmation phrase did not match. Nothing was written.');
    expect(dialog?.textContent).toContain('GPS tags to delete');

    // Retype-and-retry re-POSTs the SAME previewId.
    typePhrase('ERASE LOCATION NOW');
    await act(async () => {
      confirmButton()?.click();
    });
    await flush();
    expect(calls.length).toBe(2);
    expect(calls[1]?.body).toEqual({
      previewId: 'pv_gps',
      destructive: { confirmationPhrase: 'ERASE LOCATION NOW' },
    });
    void unmount(root, container);
  });
});

// ---- gate fidelity: chunk-note + header + argv BY MECHANISM ----------------------

describe('SaveReviewModal gate fidelity', () => {
  it('shows the streaming chunk note only when streamed is set (and never on a detected gate)', async () => {
    const streamed = renderWithProviders(
      <SaveReviewModal
        {...{
          open: true,
          title: 'Batch review',
          groups: [makeMultiFilePreviewGroup(201)],
          streamed: true,
          onConfirm: () => undefined,
          onCancel: () => undefined,
        }}
      />,
    );
    expect(bodyText()).toContain('progress streams per chunk');
    await unmount(streamed.root, streamed.container);

    const unstreamed = renderWithProviders(
      <SaveReviewModal
        {...{
          open: true,
          title: 'Batch review',
          groups: [makeMultiFilePreviewGroup(201)],
          onConfirm: () => undefined,
          onCancel: () => undefined,
        }}
      />,
    );
    expect(bodyText()).not.toContain('progress streams per chunk');
    await unmount(unstreamed.root, unstreamed.container);

    // A detected gate never claims streaming — even at two chunks.
    const detected = renderWithProviders(
      <SaveReviewModal
        {...{
          open: true,
          title: 'AI-metadata scrub — 201 file(s)',
          groups: [makeMultiFileDetectedGroup(201)],
          onConfirm: () => undefined,
          onCancel: () => undefined,
        }}
      />,
    );
    const text = bodyText();
    expect(text).toContain('re-scans every file');
    expect(text).not.toContain('progress streams per chunk');
    expect(text).not.toContain('exact change MetaDesk will make');
    await unmount(detected.root, detected.container);
  });

  it('suppresses the argv blocks on detected groups and keeps them on previewed ones', async () => {
    const previewed = renderWithProviders(
      <SaveReviewModal
        {...{
          open: true,
          title: 'Save review',
          groups: [
            {
              label: '2 files',
              evidence: 'previewed',
              preview: makePreview(),
              commandPreview: ['-use', 'MWG', '-P'],
            },
          ],
          onConfirm: () => undefined,
          onCancel: () => undefined,
        }}
      />,
    );
    const previewedText = bodyText();
    expect(previewedText).toContain('Command preview');
    expect(previewedText).toContain('exact change MetaDesk will make');
    // The per-file argv block lives behind the disclosure — expand it.
    const expand = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('a.jpg'),
    );
    act(() => {
      expand?.click();
    });
    expect(bodyText()).toContain('Exact command');
    await unmount(previewed.root, previewed.container);

    const detectedGroup: PreviewGroup = {
      label: 'AI metadata to remove',
      evidence: 'detected',
      detected: makeDetected(),
    };
    const detected = renderWithProviders(
      <SaveReviewModal
        {...{
          open: true,
          title: 'AI-metadata scrub — 1 file(s)',
          groups: [detectedGroup],
          onConfirm: () => undefined,
          onCancel: () => undefined,
        }}
      />,
    );
    // Expand the one file row so the per-file section would render if allowed.
    const toggle = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('a.png'),
    );
    act(() => {
      toggle?.click();
    });
    const detectedText = bodyText();
    expect(detectedText).toContain('PNG:Parameters');
    expect(detectedText).toContain('steps:20, sampler:euler');
    expect(detectedText).not.toContain('Exact command');
    expect(detectedText).not.toContain('Command preview');
    await unmount(detected.root, detected.container);
  });

  it('renders the bounded cannot-remove rows at the consent moment', () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({
      filePath: `C:\\photos\\f${index}.png`,
      tag: 'PNG:prompt',
      reason: 'A ComfyUI "prompt" chunk.',
    }));
    const group: PreviewGroup = {
      label: 'AI metadata to remove',
      evidence: 'detected',
      detected: makeDetected(),
    };
    const { root, container } = renderWithProviders(
      <SaveReviewModal
        {...{ open: true, title: 'AI-metadata scrub — 1 file(s)', groups: [group], cannotRemove: rows, onConfirm: () => undefined, onCancel: () => undefined }}
      />,
    );
    const text = bodyText();
    expect(text).toContain('10 detected items can NOT be removed');
    expect(text).toContain('f0.png');
    expect(text).toContain('… and 2 more — full list in Results.');
    void unmount(root, container);
  });
});

// ---- the source contract: the runner is the only place a write fires -------------

describe('write-firing source contract', () => {
  const viewSources: Array<[string, string]> = [
    ['EditPanel.tsx', editPanelSource as string],
    ['ScrubWizard.tsx', scrubWizardSource as string],
    ['BatchPanel.tsx', batchPanelSource as string],
    ['ResultsReport.tsx', resultsReportSource as string],
    ['HistoryView.tsx', historyViewSource as string],
  ];
  const FIRING_CALLS = ['executeWrite', 'scrubExecute', 'confirmUndo'];

  it('no view file fires a write or fetches a write endpoint', () => {
    for (const [name, source] of viewSources) {
      for (const call of FIRING_CALLS) {
        expect(source, `${name} must not contain ${call}`).not.toContain(call);
      }
      expect(source, `${name} must not fetch a write endpoint`).not.toMatch(
        /fetch\(\s*[`'"]\/api\/(write|scrub\/execute)/,
      );
    }
  });

  it('useWriteRun.tsx contains every write-firing call, and the dead GPS execute is gone everywhere', () => {
    const runnerSource = useWriteRunSource as string;
    for (const call of FIRING_CALLS) {
      expect(runnerSource, `the runner must own ${call}`).toContain(call);
    }
    // executeGpsStrip died as an orphan — nowhere, including client.ts.
    const clientSourceText = clientSource as string;
    expect(clientSourceText).not.toContain('executeGpsStrip');
    for (const [, source] of viewSources) {
      expect(source).not.toContain('executeGpsStrip');
    }
  });
});

// ---- App wiring: no stubs anywhere ----------------------------------------------------

describe('App write wiring', () => {
  it('App.tsx no longer imports WriteStubs (it was deleted)', () => {
    expect(appSourceText).not.toContain('views/WriteStubs');
  });

  it('renders the real Edit panel on #/edit — no stub text anywhere in the shell', async () => {
    window.location.hash = '#/edit';
    stubFetch((url) => {
      if (url.startsWith('/api/health')) return json(HEALTH_READ_ONLY);
      if (url.startsWith('/api/events')) return new Response(null, { status: 503 });
      return json({ code: 'not_found', message: 'unexpected' }, 404);
    });
    const { root, container } = renderWithProviders(<App />);
    await flush();
    const text = bodyText();
    expect(text).toContain('Nothing is selected');
    expect(text).not.toContain('arrives with write mode');
    expect(text).not.toContain('Scheduled:');
    void unmount(root, container);
  });
});

// ---- executeWrite {stream:true} consumer ------------------------------------------------

describe('executeWrite streaming', () => {
  function sseResponse(frames: string[]): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(new TextEncoder().encode(frame));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    });
  }

  it('consumes progress frames and resolves with the batch-complete payload', async () => {
    const outcome = {
      batchId: 'wb_1',
      startedAt: '2026-10-05T10:00:00Z',
      finishedAt: '2026-10-05T10:00:02Z',
      files: [{ filePath: 'C:\\photos\\a.jpg', status: 'updated', warnings: [], errors: [], verified: true }],
      updated: 1,
      unchanged: 0,
      failed: 0,
      allVerified: true,
      retryFilePaths: [],
    };
    stubFetch((_url, init) => {
      expect(String(init?.body)).toContain('"stream":true');
      return sseResponse([
        'event: write-progress\ndata: {"seq":1,"timestamp":"t","type":"write-progress","phase":"write","index":0,"total":1}\n\n',
        'event: write-progress\ndata: {"seq":2,"timestamp":"t","type":"write-progress","phase":"verify","index":1,"total":1}\n\n',
        `event: batch-complete\ndata: ${JSON.stringify({
          seq: 3,
          timestamp: 't',
          type: 'batch-complete',
          batchId: 'wb_1',
          outcome,
          commandPreview: ['-use', 'MWG', '-P'],
        })}\n\n`,
      ]);
    });

    const frames: string[] = [];
    const result = await executeWrite('pv_test', {
      stream: true,
      onFrame: (frame) => frames.push(frame.type),
    });
    expect(frames).toEqual(['write-progress', 'write-progress', 'batch-complete']);
    expect(result.outcome.batchId).toBe('wb_1');
    expect(result.outcome.updated).toBe(1);
    expect(result.commandPreview).toEqual(['-use', 'MWG', '-P']);
  });

  it('turns a write-error frame into a thrown error carrying the message', async () => {
    stubFetch(() =>
      sseResponse([
        'event: write-error\ndata: {"seq":1,"timestamp":"t","type":"write-error","code":"read_only_mode","message":"Writing is locked. Nothing was written."}\n\n',
      ]),
    );
    await expect(executeWrite('pv_test', { stream: true })).rejects.toThrow(
      'Writing is locked. Nothing was written.',
    );
  });
});
