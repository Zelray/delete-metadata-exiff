// @vitest-environment jsdom
/**
 * Home's two drop lanes (leaf 2.1.2).
 *
 *   * desktop shell — a `metadesk://dropped-paths` event carries REAL absolute
 *     paths from the Rust shell; the drop fills the path box and scans it;
 *   * browser dev seam — with no `window.__TAURI__` the HTML5 drop handler is
 *     untouched and tells the truth (browsers hide absolute paths), and the
 *     paste-path box still scans exactly as it always did.
 *
 * No Tauri, no server: `window.__TAURI__` is stubbed by hand and every request
 * is a stubbed fetch.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FolderScanResult } from '@metadesk/shared';
import { Home } from './Home';

// React 19: opt this environment into act() explicitly.
(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const DROPPED_FOLDER = 'C:\\Users\\you\\Pictures\\2026-06';

const SCAN_RESULT: FolderScanResult = {
  scanId: 'scan-stub',
  folder: DROPPED_FOLDER,
  recursive: true,
  entries: [],
  totalFiles: 0,
  totalBytes: 0,
  unreadableDirectories: [],
  rejectedPaths: [],
  warnings: [],
};

interface ScanCall {
  folder: string;
  recursive: boolean;
  extensions?: string[];
}

const windowWithTauri = window as unknown as Record<string, unknown>;
const windowWithMeta = window as unknown as Record<string, unknown>;

type DropHandler = (event: { payload?: unknown }) => void;
type ListenFn = (event: string, handler: DropHandler) => Promise<() => void>;

/** Pretend the page is running inside the desktop shell. */
function stubShell(): { emit: (payload: unknown) => void; unlisten: ReturnType<typeof vi.fn> } {
  // `handler` is reassigned when Home subscribes, so hand back a function that
  // reads the CURRENT one (a copy of the variable would stay the no-op).
  let handler: DropHandler = () => undefined;
  const unlisten = vi.fn();
  windowWithTauri.__TAURI__ = {
    event: {
      listen: ((_event: string, received: DropHandler) => {
        handler = received;
        return Promise.resolve(unlisten);
      }) as ListenFn,
    },
  };
  return {
    emit: (payload: unknown) => handler({ payload }),
    unlisten,
  };
}

function installFetchStub(scanCalls: ScanCall[]): void {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/files/scan') {
      scanCalls.push(JSON.parse(String(init?.body)) as ScanCall);
      return json(SCAN_RESULT);
    }
    return json({ code: 'not_found', message: 'Stub: unexpected route.' }, 404);
  });
  vi.stubGlobal('fetch', stub);
}

async function flush(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
}

function renderHome(): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Home />
      </QueryClientProvider>,
    );
  });
  return { root, container };
}

async function unmount(root: Root, container: HTMLDivElement): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

function folderInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Absolute folder path"]');
  if (input === null) throw new Error('the folder path input is not rendered');
  return input;
}

function scanButton(): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes('Scan'),
  );
  if (button === undefined) throw new Error('the Scan button is not rendered');
  return button;
}

const bodyText = (): string => document.body.textContent ?? '';

beforeAll(() => {
  windowWithMeta.__METADESK__ = { token: 'ui-test-token', version: 'test', readOnlyDefault: true };
});

beforeEach(() => {
  delete windowWithTauri.__TAURI__;
  window.localStorage.clear();
  document.body.replaceChildren();
});

afterEach(() => {
  delete windowWithTauri.__TAURI__;
  vi.unstubAllGlobals();
});

afterAll(() => {
  delete windowWithMeta.__METADESK__;
});

describe('Home — desktop-shell drop lane', () => {
  it('a shell drop fills the path box with the absolute path and scans it', async () => {
    const scanCalls: ScanCall[] = [];
    installFetchStub(scanCalls);
    const shell = stubShell();

    const { root, container } = renderHome();
    await flush();

    // The shell puts a folder first when a drop mixes folders and files; the
    // UI takes the first path it is handed.
    await act(async () => {
      shell.emit([DROPPED_FOLDER, 'C:\\Users\\you\\Desktop\\stray-file.jpg']);
    });
    await flush();

    expect(folderInput().value).toBe(DROPPED_FOLDER);
    expect(scanCalls).toEqual([
      { folder: DROPPED_FOLDER, recursive: true, excludeEngineArtifacts: true },
    ]);
    expect(bodyText()).toContain('Preflight');

    await unmount(root, container);
  });

  it('a shell drop dismisses the browser paste-pattern notice and honours the toggles on screen', async () => {
    const scanCalls: ScanCall[] = [];
    installFetchStub(scanCalls);
    const shell = stubShell();

    const { root, container } = renderHome();
    await flush();

    // First a browser-style drop shows the honest notice…
    const dropZone = document.querySelector('div[aria-label="Drag-and-drop zone"]');
    expect(dropZone).not.toBeNull();
    await act(async () => {
      dropZone?.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(bodyText()).toContain('About that drop');

    // …then the shell hands over the real path and the notice is gone.
    await act(async () => {
      shell.emit([DROPPED_FOLDER]);
    });
    await flush();

    expect(bodyText()).not.toContain('About that drop');
    expect(folderInput().value).toBe(DROPPED_FOLDER);
    expect(scanCalls).toHaveLength(1);

    await unmount(root, container);
  });

  it('a shell payload that is not a list of paths changes nothing', async () => {
    const scanCalls: ScanCall[] = [];
    installFetchStub(scanCalls);
    const shell = stubShell();

    const { root, container } = renderHome();
    await flush();

    await act(async () => {
      shell.emit({ folder: DROPPED_FOLDER });
      shell.emit([]);
    });
    await flush();

    expect(folderInput().value).toBe('');
    expect(scanCalls).toEqual([]);

    await unmount(root, container);
  });
});

describe('Home — browser lane (no window.__TAURI__)', () => {
  it('the paste-path input still scans exactly as it always did', async () => {
    const scanCalls: ScanCall[] = [];
    installFetchStub(scanCalls);

    const { root, container } = renderHome();
    await flush();

    const input = folderInput();
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      setValue?.call(input, DROPPED_FOLDER);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    await act(async () => {
      scanButton().click();
    });
    await flush();

    expect(scanCalls).toEqual([
      { folder: DROPPED_FOLDER, recursive: true, excludeEngineArtifacts: true },
    ]);
    expect(bodyText()).toContain('Preflight');

    await unmount(root, container);
  });

  it('the HTML5 dev-seam drop handler is intact and tells the browser truth', async () => {
    const scanCalls: ScanCall[] = [];
    installFetchStub(scanCalls);

    const { root, container } = renderHome();
    await flush();

    const dropZone = document.querySelector('div[aria-label="Drag-and-drop zone"]');
    expect(dropZone).not.toBeNull();
    // The hint must reflect reality on both sides: drops work in the desktop
    // app, and a browser cannot hand over an absolute path.
    expect(dropZone?.textContent).toContain('desktop app');
    expect(dropZone?.textContent).toContain('browsers hide');

    await act(async () => {
      dropZone?.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(bodyText()).toContain('About that drop');
    expect(bodyText()).toContain('browsers only hand over the file name');
    expect(bodyText()).toContain('Copy pattern');
    // A browser drop never scans anything.
    expect(scanCalls).toEqual([]);
    expect(folderInput().value).toBe('');

    await unmount(root, container);
  });
});
