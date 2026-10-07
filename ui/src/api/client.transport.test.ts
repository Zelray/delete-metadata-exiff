// @vitest-environment jsdom
/**
 * The transport under client.ts's endpoints (arch-v11 leaf 1.6): six private
 * helpers — tokenValue, authHeaders, send, isEnvelope, failureOf, readSse —
 * now carry the plumbing the six special paths used to re-implement. These
 * pins cover the helper behavior the endpoint suites can only prove through
 * their own views: the network wrap's exact message, the envelope-vs-assembled
 * split in failureOf, the JSON-null hardening, both authHeaders branches, the
 * streamed init's header pair (and its missing signal key), and the SSE loop's
 * frame semantics — including the abandoned stream when a frame handler
 * throws. Every request is a stubbed fetch; no live server.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDiagnosticsBundle,
  executeWrite,
  getHealth,
  getThumbnail,
  MetaApiError,
  subscribeEvents,
  TransportError,
} from './client';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

const sseOf = (stream: ReadableStream<Uint8Array>): Response =>
  new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  });

type FetchHandler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function stubFetch(handler: FetchHandler): ReturnType<typeof vi.fn> {
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal('fetch', stub);
  return stub;
}

function setBootstrapToken(token: string): void {
  (window as unknown as Record<string, unknown>).__METADESK__ = {
    token,
    version: 'test',
    readOnlyDefault: true,
  };
}

/** The rejection, for tests that assert on the thrown error itself. */
async function errorOf(running: Promise<unknown>): Promise<unknown> {
  try {
    await running;
  } catch (cause) {
    return cause;
  }
  throw new Error('the call was expected to reject');
}

const settle = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__METADESK__;
  vi.unstubAllGlobals();
});

describe('send — the one fetch door', () => {
  it('a network failure is a TransportError(0) with the exact wrap message', async () => {
    stubFetch(async () => {
      throw new TypeError('boom');
    });
    const err = (await errorOf(getHealth())) as TransportError;
    expect(err).toBeInstanceOf(TransportError);
    expect(err.status).toBe(0);
    expect(err.message).toBe('Could not reach the MetaDesk server: TypeError: boom');
  });
});

describe('failureOf — envelope or assembled label', () => {
  it('an ApiError envelope becomes a MetaApiError carrying code/message/status', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ code: 'not_found', message: 'The session is locked.' }), {
          status: 409,
        }),
    );
    const err = (await errorOf(getHealth())) as MetaApiError;
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('not_found');
    expect(err.message).toBe('The session is locked.');
  });

  it('a non-JSON non-ok body becomes the ASSEMBLED label, character for character (failureOf callers)', async () => {
    stubFetch(() => new Response('<html>Bad Gateway</html>', { status: 502 }));
    const write = (await errorOf(executeWrite('pv_502', { stream: true }))) as TransportError;
    expect(write).toBeInstanceOf(TransportError);
    expect(write.status).toBe(502);
    expect(write.message).toBe('The write failed (HTTP 502).');
    const bundle = (await errorOf(createDiagnosticsBundle())) as TransportError;
    expect(bundle.message).toBe('The diagnostics bundle could not be created (HTTP 502).');
  });

  it('request(): a non-ok UNPARSEABLE body keeps its own unreadable message, byte-identical', async () => {
    // request() deliberately reads + parses BEFORE the ok-check, so the
    // unreadable-body message wins at either status — HEAD's exact order.
    stubFetch(() => new Response('<html>Bad Gateway</html>', { status: 502 }));
    const err = (await errorOf(getHealth())) as TransportError;
    expect(err).toBeInstanceOf(TransportError);
    expect(err.status).toBe(502);
    expect(err.message).toBe('The server sent a response the UI could not read (HTTP 502).');
  });

  it('a literal JSON null body takes the honest fallback, not a TypeError (the null guard)', async () => {
    // At HEAD only request() null-guarded; the execute and diagnostics paths
    // threw a raw TypeError on `null` — unification adopts request()'s guard.
    stubFetch(() => new Response('null', { status: 503 }));
    const write = (await errorOf(executeWrite('pv_null', { stream: true }))) as TransportError;
    expect(write).toBeInstanceOf(TransportError);
    expect(write.message).toBe('The write failed (HTTP 503).');
    const bundle = (await errorOf(createDiagnosticsBundle())) as TransportError;
    expect(bundle.message).toBe('The diagnostics bundle could not be created (HTTP 503).');
  });

  it('an OK response with an empty body resolves to undefined', async () => {
    stubFetch(() => new Response(null, { status: 200 }));
    await expect(getHealth()).resolves.toBeUndefined();
  });
});

describe('authHeaders — the one credentials door', () => {
  it('the token rides exactly when set, and request() sends it in the Headers container', async () => {
    setBootstrapToken('tok-123');
    let seen: RequestInit | undefined;
    stubFetch((_url, init) => {
      seen = init;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    await getHealth();
    expect(seen?.headers).toBeInstanceOf(Headers);
    const headers = new Headers(seen?.headers);
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('content-type')).toBeNull(); // no body → no Content-Type
    expect(headers.get('x-metadesk-token')).toBe('tok-123');
  });

  it('an empty bootstrap token sends NO token header, and a refused /api/events throws nothing (it still reports the disconnect)', async () => {
    setBootstrapToken('');
    let seen: RequestInit | undefined;
    stubFetch((url, init) => {
      seen = init;
      return url === '/api/events' ? new Response(null, { status: 503 }) : new Response('[]');
    });
    const onDisconnected = vi.fn();
    subscribeEvents(() => undefined, onDisconnected);
    await settle();
    const headers = new Headers(seen?.headers);
    expect(headers.get('accept')).toBe('text/event-stream');
    expect(headers.get('x-metadesk-token')).toBeNull();
    // The refusal is a SILENT return — no error surfaces — but the finally
    // still fires the honest disconnect notice the bridge's backoff feeds on.
    expect(onDisconnected).toHaveBeenCalledTimes(1);
  });

  it('getThumbnail sends token-ONLY headers and keeps its bespoke 404', async () => {
    setBootstrapToken('tok-123');
    let seen: RequestInit | undefined;
    stubFetch((_url, init) => {
      seen = init;
      return new Response('nope', { status: 404 });
    });
    const err = (await errorOf(getThumbnail('C:\\photos\\a.png'))) as MetaApiError;
    const headers = new Headers(seen?.headers);
    expect(headers.get('x-metadesk-token')).toBe('tok-123');
    expect(headers.get('accept')).toBeNull();
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.status).toBe(404);
    expect(err.message).toBe('This file has no embedded preview image.');
  });
});

describe('executeWrite streamed init', () => {
  it('carries the SSE header pair, NO signal key, and the pre-stringified body — one fetch', async () => {
    setBootstrapToken('tok-123');
    let seenUrl = '';
    let seen: RequestInit | undefined;
    const stub = stubFetch((url, init) => {
      seenUrl = url;
      seen = init;
      return sseOf(new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }));
    });
    // An empty stream ends without a completion report — the honest failure.
    const err = (await errorOf(executeWrite('pv_x', { stream: true }))) as TransportError;
    expect(err.message).toBe(
      'The write stream ended without a completion report. Check History for what actually happened.',
    );
    expect(stub).toHaveBeenCalledTimes(1);
    expect(seenUrl).toBe('/api/write/execute');
    expect(seen?.method).toBe('POST');
    const headers = new Headers(seen?.headers);
    expect(headers.get('accept')).toBe('text/event-stream');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-metadesk-token')).toBe('tok-123');
    expect('signal' in (seen ?? {})).toBe(false);
    expect(String(seen?.body)).toContain('"stream":true');
  });
});

describe('readSse — the shared frame loop', () => {
  it('tolerates CRLF lines, joins a frame split across chunks, and skips data-less/invalid frames', async () => {
    const frames: string[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // CRLF line endings INSIDE the frame; the literal '\n\n' boundary.
        controller.enqueue(
          enc(
            'event: write-progress\r\ndata: {"seq":1,"type":"write-progress","phase":"write","index":0,"total":2}\r\n\n\n',
          ),
        );
        controller.enqueue(enc('data: not-json\n\nevent: heartbeat\n\n'));
        controller.enqueue(
          enc('event: write-progress\ndata: {"seq":2,"type":"write-progress","phase":"verify","index":1,"total":2}'),
        ); // split mid-frame…
        controller.enqueue(enc('\n\n')); // …completed by the next chunk
        controller.close();
      },
    });
    stubFetch(() => sseOf(stream));
    const err = (await errorOf(
      executeWrite('pv_frames', { stream: true, onFrame: (frame) => frames.push(String(frame.type)) }),
    )) as TransportError;
    expect(frames).toEqual(['write-progress', 'write-progress']);
    expect(err.message).toBe(
      'The write stream ended without a completion report. Check History for what actually happened.',
    );
  });

  it('a write-error frame throws MetaApiError(500) AND abandons the stream (cancel never runs)', async () => {
    let cancels = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          enc(
            'event: write-progress\ndata: {"seq":1,"type":"write-progress","phase":"write","index":0,"total":1}\n\n',
          ),
        );
        controller.enqueue(
          enc(
            'event: write-error\ndata: {"seq":2,"type":"write-error","code":"read_only_mode","message":"Writing is locked. Nothing was written."}\n\n',
          ),
        );
        // Held open on purpose: the throw must abandon it, not drain it.
      },
      cancel() {
        cancels += 1;
      },
    });
    stubFetch(() => sseOf(stream));
    const err = (await errorOf(executeWrite('pv_err', { stream: true }))) as MetaApiError;
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.status).toBe(500);
    expect(String(err.code)).toBe('read_only_mode');
    expect(err.message).toBe('Writing is locked. Nothing was written.');
    expect(cancels).toBe(0);
  });
});

describe('subscribeEvents', () => {
  it('unsubscribe suppresses onDisconnected even when the stream still ends', async () => {
    let closeStream: () => void = () => undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        closeStream = () => controller.close();
      },
    });
    stubFetch(() => sseOf(stream));
    const onDisconnected = vi.fn();
    const unsubscribe = subscribeEvents(() => undefined, onDisconnected);
    await settle();
    unsubscribe();
    closeStream();
    await settle();
    expect(onDisconnected).not.toHaveBeenCalled();
  });

  it('drops a duplicate seq, tolerates a gap, and reports a clean stream end', async () => {
    const seen: number[] = [];
    const frame = (seq: number, type: string): string =>
      `event: ${type}\ndata: ${JSON.stringify({ seq, type })}\n\n`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc(frame(1, 'hello')));
        controller.enqueue(enc(frame(2, 'health')));
        controller.enqueue(enc(frame(2, 'health'))); // duplicate — dropped
        controller.enqueue(enc(frame(4, 'folder-changed'))); // gap tolerated
        controller.close();
      },
    });
    stubFetch(() => sseOf(stream));
    const onDisconnected = vi.fn();
    subscribeEvents((event) => seen.push((event as unknown as { seq: number }).seq), onDisconnected);
    await settle(20);
    expect(seen).toEqual([1, 2, 4]);
    expect(onDisconnected).toHaveBeenCalled();
  });
});
