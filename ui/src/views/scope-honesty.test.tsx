// @vitest-environment jsdom
/**
 * Scope-honesty pins (arch-v11 leaf 1.9). P1: the scrub truncation banner
 * compares the name-FILTERED scope against MAX_SCRUB_FILES, so a filter that
 * narrows below the cap must NOT fire it (RED on pre-fix HEAD dcca836, which
 * compared the UNFILTERED scan length). P2: a 1001-file selection still warns,
 * and the banner's raw '1000' stays in its own element, separate from the
 * count line's '1,000' (GREEN on HEAD — guards the fix). P3: the six count
 * strings render with thousands separators (RED on pre-fix HEAD). P4: the
 * grid's sort option tells the truth — 'Modified (oldest first)' (RED on
 * pre-fix HEAD). Every request is a stubbed fetch — no live server, and no
 * write is ever fired (previews are the read-only diff).
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FolderScanResult } from '@metadesk/shared';
import { ScrubWizard } from './ScrubWizard';
import { BatchPanel } from './BatchPanel';
import { EditPanel } from './EditPanel';
import { FileGrid } from './FileGrid';
import { useUiStore, WRITE_RUN_IDLE } from '../state/store';

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
  // FileGrid hands each lazy thumbnail card to an IntersectionObserver; jsdom
  // has neither the observer nor layout, so a never-firing stand-in is enough.
  class IntersectionObserverStub {
    observe(): void {
      return undefined;
    }
    unobserve(): void {
      return undefined;
    }
    disconnect(): void {
      return undefined;
    }
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  (window as unknown as Record<string, unknown>).IntersectionObserver =
    IntersectionObserverStub as unknown as typeof IntersectionObserver;
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = '';
  // A test that fails before its final unmount would otherwise leave a live
  // view subscribed to the store; sweep the body so later reads stay clean.
  document.body.replaceChildren();
  useUiStore.setState({
    writeUnlocked: false,
    lastWrite: null,
    selectedPaths: [],
    scanResult: null,
    badges: {},
    nextCommand: null,
    commandHistory: [],
    writeRun: { ...WRITE_RUN_IDLE },
    searchText: '',
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

/** The innermost element containing the needle (parents precede descendants in
 * document order, so the LAST match is the element that owns the text). */
function deepest(needle: string): Element | undefined {
  const matches = Array.from(document.querySelectorAll('*')).filter((element) =>
    (element.textContent ?? '').includes(needle),
  );
  return matches.at(-1);
}

// ---- fixtures -----------------------------------------------------------------

/** The house scan-entry shape, named per clone so filters can narrow. */
function makeEntry(path: string): {
  path: string;
  name: string;
  kind: string;
  sizeBytes: number;
  modifiedAt: string;
  warnings: string[];
} {
  return {
    path,
    name: path.slice(path.lastIndexOf('\\') + 1),
    kind: 'png',
    sizeBytes: 324,
    modifiedAt: '2026-10-05T10:00:00Z',
    warnings: [],
  };
}

function scanOf(paths: string[]): FolderScanResult {
  return {
    scanId: 'scan-scope',
    folder: 'C:\\photos',
    recursive: true,
    totalFiles: paths.length,
    totalBytes: paths.length * 324,
    entries: paths.map(makeEntry),
    warnings: [],
    rejectedPaths: [],
    unreadableDirectories: [],
  } as unknown as FolderScanResult;
}

const nPaths = (prefix: string, count: number): string[] =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}.png`);

const FIRST_BATCH_PATH = 'C:\\photos\\batch-0.png';
const THOUSAND_TWENTY_FOUR = nPaths('C:\\photos\\batch-', 1024);

/** The read-only preview envelope (one diff row; the GROUP LABEL carries the
 * 1024 count — it comes from the view, not from the envelope). */
function previewEnvelope(): unknown {
  return {
    preview: {
      previewId: 'pv_scope',
      planId: 'pl_scope',
      files: [
        {
          filePath: FIRST_BATCH_PATH,
          diffs: [{ tag: 'XMP-dc:Title', after: 'Session title', kind: 'create' }],
          argv: ['-use', 'MWG', '-P', '-XMP-dc:Title=Session title', FIRST_BATCH_PATH],
          warnings: [],
          noop: false,
        },
      ],
      estimatedBytesRequired: 648,
      blockers: [],
      createdAt: '2026-10-05T10:00:00Z',
    },
    commandPreview: ['-use', 'MWG', '-P', '-XMP-dc:Title=Session title', FIRST_BATCH_PATH],
    diffNotes: [],
    writeUnlocked: true,
  };
}

function stubPreviews(): void {
  stubFetch((url) => {
    if (url.startsWith('/api/write/preview')) return json(previewEnvelope());
    return json({ code: 'not_found', message: 'unexpected' }, 404);
  });
}

// ---- P1: the truncation banner respects the name filter ------------------------

describe('P1 — the truncation banner respects the name filter (RED on pre-fix HEAD)', () => {
  it('a 1500-file scan filtered below the cap does NOT fire the truncation banner', async () => {
    useUiStore.setState({
      scanResult: scanOf([
        ...nPaths('C:\\photos\\match-', 500),
        ...nPaths('C:\\photos\\other-', 1000),
      ]),
      searchText: 'match',
    });
    const { root, container } = renderWithProviders(<ScrubWizard />);
    await flush();
    const text = bodyText();
    // The wizard rendered the detect step against the narrowed scope…
    expect(text).toContain('Scans 500 files');
    expect(text).toContain('Scan for AI metadata');
    // …and the honest cap banner stays silent: the slice applies to the
    // FILTERED list, so the flag must compare the filtered length, not the
    // unfiltered scan length.
    expect(text).not.toContain('at most 1000 files per pass');
    await unmount(root, container);
  });
});

// ---- P2: a real over-cap selection still warns ----------------------------------

describe('P2 — a real over-cap selection still warns (GREEN on HEAD; guards the fix)', () => {
  it('1001 selected files fire the banner with the raw cap and the count line with the separator', async () => {
    useUiStore.setState({ selectedPaths: nPaths('C:\\photos\\sel-', 1001) });
    const { root, container } = renderWithProviders(<ScrubWizard />);
    await flush();
    // The banner renders the RAW cap number inside its own element…
    const banner = deepest('at most 1000 files per pass');
    expect(banner).toBeDefined();
    // …while the count line renders the sliced scope through toLocaleString.
    const countLine = deepest('Scans 1,000 files');
    expect(countLine).toBeDefined();
    expect(banner).not.toBe(countLine);
    expect(banner?.textContent).not.toContain('1,000');
    expect(countLine?.textContent).not.toContain('at most');
    await unmount(root, container);
  });
});

// ---- P3: the six count strings render with thousands separators ------------------

describe('P3 — the six count strings render with thousands separators (RED on pre-fix HEAD)', () => {
  it('BatchPanel renders the radios, badge, promise line, and selection-arm group label with separators', async () => {
    stubPreviews();
    useUiStore.setState({
      scanResult: scanOf(THOUSAND_TWENTY_FOUR),
      selectedPaths: THOUSAND_TWENTY_FOUR,
    });
    const { root, container } = renderWithProviders(<BatchPanel />);
    await flush();
    const text = bodyText();
    expect(text).toContain('Current selection (1,024)');
    // Already formatted at HEAD — pinned so the radio pair stays consistent.
    expect(text).toContain('All filtered files (1,024)');
    expect(text).toContain('1,024 selected');
    // The promise line renders as soon as work is staged — no write involved.
    setInput('input[aria-label="Title"]', 'Session title');
    await flush();
    expect(bodyText()).toContain('1,024 files will be previewed.');
    // The group label travels through the read-only preview into the gate.
    await act(async () => {
      buttonWith('Preview batch')?.click();
    });
    await flush();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('1,024 selected file(s)');
    await unmount(root, container);
  });

  it('BatchPanel renders the filtered-arm group label with a separator', async () => {
    stubPreviews();
    useUiStore.setState({
      scanResult: scanOf(THOUSAND_TWENTY_FOUR),
      selectedPaths: THOUSAND_TWENTY_FOUR,
    });
    const { root, container } = renderWithProviders(<BatchPanel />);
    await flush();
    const radios = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[name="scope"]'),
    );
    expect(radios).toHaveLength(2);
    const filteredRadio = radios[1];
    expect(filteredRadio).toBeDefined();
    await act(async () => {
      filteredRadio?.click();
    });
    await flush();
    setInput('input[aria-label="Title"]', 'Session title');
    await flush();
    await act(async () => {
      buttonWith('Preview batch')?.click();
    });
    await flush();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('1,024 filtered file(s)');
    await unmount(root, container);
  });

  it('EditPanel renders the selection badge and the review group label with separators', async () => {
    stubPreviews();
    useUiStore.setState({ selectedPaths: THOUSAND_TWENTY_FOUR });
    const { root, container } = renderWithProviders(<EditPanel />);
    await flush();
    expect(bodyText()).toContain('1,024 files selected');
    setInput('input[aria-label="Title"]', 'Session title');
    await flush();
    await act(async () => {
      buttonWith('Review & Save')?.click();
    });
    await flush();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    // The review label — HEAD's raw count rendered '1024 files'.
    expect(dialog?.textContent).toContain('1,024 files');
    expect(dialog?.textContent).not.toContain('1024 files');
    await unmount(root, container);
  });
});

// ---- P4: the grid sort option tells the truth ------------------------------------

describe('P4 — the grid sort option tells the truth (RED on pre-fix HEAD)', () => {
  it('the toolbar offers Modified (oldest first), not Date (oldest first)', async () => {
    useUiStore.setState({
      scanRequest: { folder: 'C:\\photos', recursive: true },
      scanResult: scanOf(nPaths('C:\\photos\\grid-', 2)),
    });
    const { root, container } = renderWithProviders(
      <FileGrid onOpenDetail={() => undefined} />,
    );
    await flush();
    const sortSelect = document.querySelector('select[aria-label="Sort files"]');
    expect(sortSelect).not.toBeNull();
    const options = Array.from(sortSelect?.querySelectorAll('option') ?? []).map(
      (option) => option.textContent,
    );
    expect(options).toContain('Modified (oldest first)');
    expect(options).not.toContain('Date (oldest first)');
    await unmount(root, container);
  });
});
