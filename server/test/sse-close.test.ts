/**
 * SSE close ordering + the ONE frame writer (leaf 1.2).
 *
 * Three pins:
 *  - CLOSE: a real /api/events connection over a listening socket, reader
 *    never cancelled, must not hold app.close() open — the repo's only
 *    live-SSE close oracle (on the pre-1.2 bytes this hangs until timeout).
 *  - GOLDEN BYTES: writeSseFrame reproduces the legacy hub frame bytes AND
 *    the legacy execute-stream frame bytes for every SseEvent member, with
 *    the timestamp injected and the key order pinned (seq, timestamp, type,
 *    then payload keys).
 *  - CROSS-TRANSPORT: a real streamed execute and a hub connection on the
 *    same server emit the same frame shape from the same writer.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { InjectOptions, InjectPayload } from 'light-my-request';
import type { BatchOutcome, HealthInfo, SseEvent } from '@metadesk/shared';
import { loadConfig } from '../src/config.js';
import { buildServer, type BuildServerResult } from '../src/index.js';
import { writeSseFrame, type SsePayload } from '../src/routes/events.js';
import {
  makePipeline,
  makeWriteFixture,
  type PipelineHarness,
  type WriteFixture,
} from './write/helpers.js';
import { EXE_PATH } from './helpers.js';

/** Poll until the predicate holds or the timeout elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met before timeout');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface RawFrame {
  raw: string;
  type: string;
  data: Record<string, unknown>;
}

/** Read raw SSE frames off a fetch body until the predicate matches, then cancel. */
async function readFramesUntil(
  body: ReadableStream<Uint8Array>,
  timeoutMs: number,
  predicate: (frame: RawFrame) => boolean,
): Promise<RawFrame[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames: RawFrame[] = [];
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLine = raw.split('\n').find((line) => line.startsWith('data: '));
        if (dataLine === undefined) continue;
        const data = JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
        const frame: RawFrame = { raw, type: String(data['type']), data };
        frames.push(frame);
        if (predicate(frame)) return frames;
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) return frames;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return frames;
}

// ---- close pin -----------------------------------------------------------------

describe('SSE close ordering (live close oracle)', () => {
  let app: FastifyInstance;
  let hub: BuildServerResult['hub'];
  let baseUrl: string;
  let closed = false;

  beforeAll(async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'metadesk-sse-close-'));
    const server = await buildServer({
      config: {
        ...loadConfig(),
        dataDir,
        thumbsDir: path.join(dataDir, 'thumbs'),
        portfilePath: path.join(dataDir, 'portfile.json'),
      },
      token: 'sse-close-token',
      engine: null,
      health: {
        ok: false,
        version: '',
        readOnlyFallback: true,
        reason: 'sse close test fixture (engine-less)',
        executablePath: 'test',
        minimumVersion: '12.70',
      },
      sseHeartbeatMs: 60_000,
    });
    app = server.app;
    hub = server.hub;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (!closed) await app?.close();
  });

  it('closes promptly with an open /api/events reader that is never cancelled', async () => {
    const response = await fetch(`${baseUrl}/api/events?token=sse-close-token`, {
      headers: { origin: baseUrl },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    // The reader stays OPEN — the client never cancels; the server must be
    // the one to close. One suppressed read keeps the abandoned stream quiet.
    void reader?.read().catch(() => undefined);

    await waitFor(() => hub.connectionCount === 1);
    expect(hub.connectionCount).toBe(1);

    const startedAt = Date.now();
    await app.close();
    const closeMs = Date.now() - startedAt;
    expect(closeMs).toBeLessThan(5_000);
    expect(hub.connectionCount).toBe(0);
    closed = true;
  }, 20_000);
});

// ---- golden bytes ---------------------------------------------------------------

describe('writeSseFrame — golden bytes', () => {
  const TS = '2026-01-02T03:04:05.678Z';

  afterEach(() => {
    vi.useRealTimers();
  });

  /** One payload per SseEvent member, shaped exactly as the emit sites send it. */
  function memberPayloads(): Record<SseEvent['type'], SsePayload> {
    const health: HealthInfo = {
      ok: true,
      version: '12.99',
      readOnlyFallback: false,
      executablePath: 'test',
      minimumVersion: '12.70',
    };
    const outcome: BatchOutcome = {
      batchId: 'wb_golden',
      startedAt: TS,
      finishedAt: TS,
      files: [{ filePath: 'C:\\photos\\a.png', status: 'updated', warnings: [], errors: [], verified: true }],
      updated: 1,
      unchanged: 0,
      failed: 0,
      allVerified: true,
      retryFilePaths: [],
    };
    return {
      hello: { type: 'hello', health },
      heartbeat: { type: 'heartbeat' },
      'scan-progress': { type: 'scan-progress', scanId: 'scan_1', filesScanned: 3, currentDirectory: 'C:\\photos' },
      'scan-complete': { type: 'scan-complete', scanId: 'scan_1', totalFiles: 12, warningCount: 0 },
      'metadata-ready': { type: 'metadata-ready', filePath: 'C:\\photos\\a.png', depth: 'simple' },
      'thumbnail-ready': { type: 'thumbnail-ready', filePath: 'C:\\photos\\a.png', url: '/api/thumbnails/a.jpg' },
      'write-progress': { type: 'write-progress', batchId: 'wb_golden', index: 1, total: 2, phase: 'write' },
      'batch-complete': { type: 'batch-complete', batchId: 'wb_golden', outcome, commandPreview: ['-use', 'MWG'] },
      health: { type: 'health', health },
      'folder-changed': {
        type: 'folder-changed',
        folder: 'C:\\photos',
        changes: [{ type: 'change', path: 'C:\\photos\\a.png' }],
        truncated: false,
      },
      'mode-changed': { type: 'mode-changed', writeUnlocked: true, mode: 'write-unlocked' },
      'write-error': { type: 'write-error', code: 'read_only_mode', message: 'Writing is locked. Nothing was written.' },
      'batch-cancelled': {
        type: 'batch-cancelled',
        batchId: 'wb_golden',
        cancelledAt: TS,
        notAttemptedFilePaths: ['C:\\photos\\b.png'],
      },
    };
  }

  /** The pre-1.2 hub emitter (routes/events.ts sendTo), reproduced verbatim. */
  function legacyHubFrame(seq: number, payload: SsePayload): string {
    const frame = { seq, timestamp: TS, ...payload };
    return `event: ${payload.type}\ndata: ${JSON.stringify(frame)}\n\n`;
  }

  /** The pre-1.2 execute-stream emitter (routes/writes.ts send), reproduced verbatim. */
  function legacyExecuteFrame(seq: number, type: string, rest: Record<string, unknown>): string {
    const frame = { seq, timestamp: TS, type, ...rest };
    return `event: ${type}\ndata: ${JSON.stringify(frame)}\n\n`;
  }

  it('reproduces the exact legacy bytes for every SseEvent member', () => {
    vi.useFakeTimers({ now: new Date(TS), toFake: ['Date'] });
    const payloads = memberPayloads();

    // A hardcoded golden for the simplest member — independent of the legacy
    // reconstruction helpers above.
    const captured: string[] = [];
    writeSseFrame({ write: (chunk: string) => void captured.push(chunk) }, 1, { type: 'heartbeat' });
    expect(captured).toEqual([
      'event: heartbeat\ndata: {"seq":1,"timestamp":"2026-01-02T03:04:05.678Z","type":"heartbeat"}\n\n',
    ]);

    for (const payload of Object.values(payloads)) {
      const sink: string[] = [];
      writeSseFrame({ write: (chunk: string) => void sink.push(chunk) }, 7, payload);
      const frame = sink.join('');
      // Byte-equivalent with BOTH legacy emitters (they were byte-identical).
      expect(frame).toBe(legacyHubFrame(7, payload));
      const { type: frameType, ...rest } = payload;
      expect(frame).toBe(legacyExecuteFrame(7, frameType, rest));

      // Key-order loop: seq, timestamp, type, then the payload keys in order.
      const keys = Object.keys(JSON.parse(frame.slice(frame.indexOf('data: ') + 'data: '.length)) as object);
      expect(keys).toEqual(['seq', 'timestamp', 'type', ...Object.keys(payload).filter((k) => k !== 'type')]);
    }
  });
});

// ---- cross-transport parity -------------------------------------------------------

describe('cross-transport frame parity (execute stream + hub)', () => {
  let fixture: WriteFixture;
  let harness: PipelineHarness;
  let server: BuildServerResult;
  let app: FastifyInstance;
  let baseUrl: string;

  const TOKEN = 'sse-cross-token';

  async function inject(
    url: string,
    options: { method?: 'GET' | 'POST'; body?: unknown } = {},
  ): Promise<{ statusCode: number; body: any }> {
    const injectOptions: InjectOptions = {
      url,
      method: options.method ?? 'GET',
      headers: { 'x-metadesk-token': TOKEN, host: '127.0.0.1' },
    };
    if (options.body !== undefined) injectOptions.payload = options.body as InjectPayload;
    const response = await app.inject(injectOptions);
    return { statusCode: response.statusCode, body: response.json() };
  }

  beforeAll(async () => {
    fixture = await makeWriteFixture('metadesk-sse-cross-');
    harness = await makePipeline(fixture, { unlocked: false });
    server = await buildServer({
      config: {
        ...loadConfig(),
        dataDir: fixture.dataDir,
        thumbsDir: path.join(fixture.dataDir, 'thumbs'),
        portfilePath: path.join(fixture.dataDir, 'portfile.json'),
        executablePath: EXE_PATH,
      },
      token: TOKEN,
      health: {
        ok: true,
        version: '12.99',
        readOnlyFallback: false,
        executablePath: 'test',
        minimumVersion: '12.70',
      },
      engine: harness.session,
      writeChunkSize: 1,
      sseHeartbeatMs: 60_000,
    });
    app = server.app;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await harness?.shutdown();
    await fixture?.cleanup();
  });

  it('writes the streamed execute and the hub stream with the same frame shape', async () => {
    await inject('/api/session/unlock', { method: 'POST', body: {} });
    const png = await fixture.put('cross-transport.png');
    const preview = await inject('/api/write/preview', {
      method: 'POST',
      body: { files: [png], edits: [{ tag: 'XMP-dc:Title', op: 'set', value: 'cross transport' }] },
    });
    expect(preview.statusCode).toBe(200);

    // Hub transport: a real SSE connection on the same server. The hello
    // frame is written synchronously on attach.
    const hubResponse = await fetch(`${baseUrl}/api/events?token=${TOKEN}`, {
      headers: { origin: baseUrl },
    });
    expect(hubResponse.status).toBe(200);
    await waitFor(() => server.hub.connectionCount === 1);

    // Execute transport: a real streamed write through the pipeline.
    const response = await app.inject({
      url: '/api/write/execute',
      method: 'POST',
      headers: { 'x-metadesk-token': TOKEN, host: '127.0.0.1' },
      payload: { previewId: preview.body.preview.previewId, stream: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');

    // Byte prefix: the execute stream's FIRST frame is a write-progress
    // written by the shared writer (seq 1, then the injected timestamp).
    expect(response.body.startsWith('event: write-progress\ndata: {"seq":1,"timestamp":"')).toBe(true);
    const progressLine = response.body
      .split('\n')
      .find((line) => line.startsWith('data: ') && line.includes('write-progress'));
    expect(progressLine).toBeDefined();
    const progressFrame = JSON.parse((progressLine as string).slice('data: '.length)) as Record<string, unknown>;
    expect(Object.keys(progressFrame)).toEqual(['seq', 'timestamp', 'type', 'batchId', 'phase', 'index', 'total']);
    expect(progressFrame['seq']).toBe(1);
    expect(typeof progressFrame['timestamp']).toBe('string');

    // The hub carried its hello frame from the SAME writer: identical prefix
    // shape and key order (payload keys appended after type).
    const hubFrames = await readFramesUntil(hubResponse.body as ReadableStream<Uint8Array>, 10_000, (frame) =>
      frame.type === 'hello',
    );
    const hello = hubFrames.find((frame) => frame.type === 'hello');
    expect(hello).toBeDefined();
    expect((hello as RawFrame).raw.startsWith('event: hello\ndata: {"seq":1,"timestamp":"')).toBe(true);
    expect(Object.keys((hello as RawFrame).data)).toEqual(['seq', 'timestamp', 'type', 'health']);

    // The streamed execute ended with the completion frame carrying the argv.
    expect(response.body).toContain('event: batch-complete');
    const completeLine = response.body
      .split('\n')
      .find((line) => line.startsWith('data: ') && line.includes('batch-complete'));
    const completeFrame = JSON.parse((completeLine as string).slice('data: '.length)) as {
      batchId: string;
      outcome: { updated: number };
      commandPreview: string[];
    };
    expect(completeFrame.outcome.updated).toBe(1);
    expect(completeFrame.commandPreview[0]).toBe('-use');
  });
});
