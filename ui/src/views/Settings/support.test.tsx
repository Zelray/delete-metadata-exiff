// @vitest-environment jsdom
/**
 * Settings › Support (leaf 2.2.1): the diagnostics bundle action calls the
 * client, surfaces the path the server saved the bundle to, and renders the
 * honest copy — nothing "sent", no photo data, plain-English failure. Rendered
 * as the whole Settings surface so the mount point is under test too. Every
 * request is a stubbed fetch; no live server.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SettingsView } from '../SettingsView';

// React 19: opt this environment into act() explicitly.
(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const HEALTH = {
  ok: true,
  version: '13.59',
  readOnlyFallback: false,
  executablePath: 'C:\\app\\vendor\\exiftool\\exiftool.exe',
  minimumVersion: '13.0',
  writeUnlocked: false,
  mode: 'read-only',
};

const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]); // PK\x03\x04 marker bytes
const SAVED_PATH = 'C:\\app\\data\\diagnostics\\metadesk-diagnostics-20261005-120000.zip';

const bundleResponse = (status = 200): Response =>
  new Response(ZIP_BYTES, {
    status,
    headers:
      status === 200
        ? {
            'Content-Type': 'application/zip',
            'Content-Disposition': 'attachment; filename="metadesk-diagnostics-20261005-120000.zip"',
            'X-MetaDesk-Diagnostics-Path': SAVED_PATH,
          }
        : { 'Content-Type': 'application/json' },
  });

const errorResponse = (): Response =>
  new Response(
    JSON.stringify({ code: 'internal_error', message: 'The diagnostics bundle could not be built: disk full' }),
    { status: 500, headers: { 'Content-Type': 'application/json' } },
  );

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
  // jsdom has no object-URL implementation; the client hands back blob URLs.
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:metadesk-diagnostics'),
    revokeObjectURL: vi.fn(),
  });
  window.__METADESK__ = { token: 'ui-test-token', version: 'test', readOnlyDefault: true };
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  window.localStorage.clear();
  // Tests that end early must not leak their tree into the next assertion.
  document.body.replaceChildren();
});

async function flush(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
}

function renderSettings(): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const root = createRoot(container);
  act(() => {
    root.render(<QueryClientProvider client={queryClient}><SettingsView /></QueryClientProvider>);
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

describe('Settings Support card — diagnostics bundle', () => {
  it('calls the client with the token header, surfaces the saved path, and states the honest limits', async () => {
    const bundleCalls: Array<{ url: string; token: string | null }> = [];
    stubFetch((url, init) => {
      if (url === '/api/health') return new Response(JSON.stringify(HEALTH), { status: 200 });
      if (url === '/api/diagnostics/bundle') {
        const headers = new Headers(init?.headers);
        bundleCalls.push({ url, token: headers.get('x-metadesk-token') });
        return bundleResponse();
      }
      return new Response(JSON.stringify({ code: 'not_found', message: 'unexpected' }), { status: 404 });
    });

    const { root, container } = renderSettings();
    await flush();

    const support = document.querySelector('section[aria-label="Support"]');
    expect(support).not.toBeNull();

    await act(async () => {
      buttonWith('Create diagnostics bundle')?.click();
    });
    await flush();

    expect(bundleCalls).toEqual([{ url: '/api/diagnostics/bundle', token: 'ui-test-token' }]);

    const text = bodyText();
    expect(text).toContain('Diagnostics bundle created');
    expect(text).toContain(SAVED_PATH);
    expect(text).toContain('never the photos');
    expect(text).toContain('Nothing was sent anywhere');
    expect(text).toContain('The bundle stays on this computer until you choose to share it');
    // No false success, and the failure surface is absent on the happy path.
    expect(text).not.toContain('could not be built');

    // "Save a copy" hands the browser an anchor with the server's filename.
    const downloads: string[] = [];
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function mockClick(this: HTMLAnchorElement) {
        downloads.push(this.download);
      });
    await act(async () => {
      buttonWith('Save a copy')?.click();
    });
    clickSpy.mockRestore();
    expect(downloads).toEqual(['metadesk-diagnostics-20261005-120000.zip']);

    await unmount(root, container);
  });

  it('shows a plain-English failure instead of a success card when the server cannot build one', async () => {
    stubFetch((url) => {
      if (url === '/api/health') return new Response(JSON.stringify(HEALTH), { status: 200 });
      if (url === '/api/diagnostics/bundle') return errorResponse();
      return new Response('{}', { status: 404 });
    });

    const { root, container } = renderSettings();
    await flush();

    await act(async () => {
      buttonWith('Create diagnostics bundle')?.click();
    });
    await flush();

    const text = bodyText();
    expect(text).toContain('The diagnostics bundle could not be built: disk full');
    expect(text).not.toContain('Diagnostics bundle created');
    expect(text).not.toContain(SAVED_PATH);

    await unmount(root, container);
  });

  it('tells the truth when the path cannot be copied automatically', async () => {
    stubFetch((url) => {
      if (url === '/api/health') return new Response(JSON.stringify(HEALTH), { status: 200 });
      if (url === '/api/diagnostics/bundle') return bundleResponse();
      return new Response('{}', { status: 404 });
    });

    const { root, container } = renderSettings();
    await flush();

    await act(async () => {
      buttonWith('Create diagnostics bundle')?.click();
    });
    await flush();
    await act(async () => {
      buttonWith('Copy path')?.click();
    });
    await flush();

    // jsdom has no clipboard: the card must say so, not claim success.
    expect(bodyText()).toContain('Could not copy automatically — select the path and copy it by hand');

    await unmount(root, container);
  });
});
