// @vitest-environment jsdom
/**
 * SseBridge live-event routing (issue #23): `mode-changed` is a DECLARED
 * SseEvent union member and gets its typed case arm — the store follows the
 * server's word and health re-validates. CHARACTERIZATION coverage: the old
 * default-arm cast behaved identically, so these tests pin behavior that
 * must not change (not red-first by design).
 *
 * The events bridge is fed through a REAL SSE stream on a stubbed global
 * fetch (the transport seam the other UI tests use) — the internal API
 * client is never mocked (the internalMockFiles ratchet rule), so the real
 * subscribeEvents/readSse parsing runs too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SseEvent } from '@metadesk/shared';
import { SseBridge } from './SseBridge';
import { useUiStore } from '../state/store';

// React 19: opt this environment into act() explicitly.
(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const encoder = new TextEncoder();

function frame(event: SseEvent): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

function modeChanged(writeUnlocked: boolean): SseEvent {
  return {
    // The real subscribeEvents drops non-increasing seqs as replays — every
    // frame needs its own increasing seq.
    seq: nextSeq++,
    timestamp: new Date().toISOString(),
    type: 'mode-changed',
    writeUnlocked,
    mode: writeUnlocked ? 'write-unlocked' : 'read-only',
  };
}

let nextSeq = 1;

describe('SseBridge', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
  let fetchStub: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    stream = null;
    useUiStore.setState({ writeUnlocked: false });
    // One SSE response per test, held open; the test pushes frames into it.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
      },
    });
    fetchStub = vi.fn(
      async () => new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );
    vi.stubGlobal('fetch', fetchStub);

    container = document.createElement('div');
    document.body.appendChild(container);
    const queryClient = new QueryClient();
    root = createRoot(container);
    act(() => {
      root?.render(createElement(QueryClientProvider, { client: queryClient }, createElement(SseBridge)));
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    vi.unstubAllGlobals();
  });

  it('a mode-changed event unlocks writing in the store (typed arm, not a cast)', async () => {
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalled());
    stream?.enqueue(frame(modeChanged(true)));
    await vi.waitFor(() => expect(useUiStore.getState().writeUnlocked).toBe(true));
  });

  it('a second mode-changed event re-locks writing (the server is the word)', async () => {
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalled());
    stream?.enqueue(frame(modeChanged(true)));
    await vi.waitFor(() => expect(useUiStore.getState().writeUnlocked).toBe(true));
    stream?.enqueue(frame(modeChanged(false)));
    await vi.waitFor(() => expect(useUiStore.getState().writeUnlocked).toBe(false));
  });

  it('an event with no case arm is ignored, never fatal', async () => {
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalled());
    const heartbeat: SseEvent = {
      seq: nextSeq++,
      timestamp: new Date().toISOString(),
      type: 'heartbeat',
    };
    stream?.enqueue(frame(heartbeat));
    // The stream stays ordered: the unlock AFTER the heartbeat proves the
    // unknown-to-a-case event was consumed without breaking anything.
    stream?.enqueue(frame(modeChanged(true)));
    await vi.waitFor(() => expect(useUiStore.getState().writeUnlocked).toBe(true));
  });
});
