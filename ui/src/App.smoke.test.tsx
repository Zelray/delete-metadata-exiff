// @vitest-environment jsdom
/**
 * Render smoke test: the app shell mounts and shows the safety-critical
 * chrome (mode banner, browse home, command preview drawer) against a stubbed
 * API — no network, no real server required.
 */
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';

// React 19: opt this environment into act() explicitly.
(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const HEALTH = {
  ok: true,
  version: '13.59',
  readOnlyFallback: false,
  executablePath: 'C:\\vendor\\exiftool.exe',
  minimumVersion: '12.15',
};

beforeAll(() => {
  // jsdom lacks these browser APIs; the app degrades without them but the
  // stubs keep the smoke honest about what a real browser provides.
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

  const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    if (url.startsWith('/api/health')) return json(HEALTH);
    if (url.startsWith('/api/events')) return new Response(null, { status: 503 });
    return json({ code: 'not_found', message: 'Stub: no such route in the smoke test.' }, 404);
  });
  vi.stubGlobal('fetch', fetchStub);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function renderApp(): Root {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>,
    );
  });
  return root;
}

describe('App shell smoke', () => {
  it('mounts with mode banner, home view, and command preview drawer', async () => {
    const root = renderApp();
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const text = document.body.textContent ?? '';
    expect(text).toContain('MetaDesk');
    expect(text).toContain('Read-only');
    expect(text).toContain('Open a folder');
    expect(text).toContain('Command preview');
    expect(text).toContain('Include subfolders');
    // Nav stays honest: every tool is live in leaf 1.1.5, so no "soon" markers
    // remain — the write tools are real routes, not placeholders.
    expect(text).toContain('History');
    expect(text).toContain('AI scrub');
    expect(text).toContain('Batch apply');
    expect(text).not.toContain('soon');
    await act(async () => {
      root.unmount();
    });
  });
});
