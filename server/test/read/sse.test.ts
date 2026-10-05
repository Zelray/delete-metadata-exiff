/**
 * SSE smoke tests over a real listening socket: hello + heartbeat frames,
 * the folder-changed event when the watched folder changes, and the
 * auth/origin gates on the event stream.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../src/config.js';
import { buildServer, type BuildServerResult } from '../../src/index.js';
import { PNG_1X1 } from '../helpers.js';
import { makeReadFixture, type ReadFixture } from './fixtures.js';

let fixture: ReadFixture;
let server: BuildServerResult;
let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  fixture = await makeReadFixture('metadesk-sse-');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'metadesk-sse-data-'));
  server = await buildServer({
    config: {
      ...loadConfig(),
      dataDir,
      thumbsDir: path.join(dataDir, 'thumbs'),
      portfilePath: path.join(dataDir, 'portfile.json'),
    },
    token: 'sse-token',
    sseHeartbeatMs: 400,
  });
  app = server.app;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
}, 90_000);

afterAll(async () => {
  await app.close();
});

interface ReceivedEvent {
  type: string;
  seq: number;
  data: Record<string, unknown>;
}

/** Read SSE frames off a fetch body until a predicate matches or we time out. */
async function readEventsUntil(
  body: ReadableStream<Uint8Array>,
  timeoutMs: number,
  predicate: (event: ReceivedEvent) => boolean,
): Promise<ReceivedEvent[]> {
  const received: ReceivedEvent[] = [];
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;

  return await new Promise((resolve, reject) => {
    const finish = () => {
      reader
        .cancel()
        .catch(() => undefined)
        .finally(() => resolve(received));
    };
    const tick = async (): Promise<void> => {
      while (true) {
        const newlineIndex = buffer.indexOf('\n\n');
        if (newlineIndex < 0) break;
        const frame = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 2);
        const dataLine = frame
          .split('\n')
          .find((line) => line.startsWith('data: '));
        if (dataLine === undefined) continue;
        try {
          const data = JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
          const event: ReceivedEvent = {
            type: String(data['type']),
            seq: Number(data['seq']),
            data,
          };
          received.push(event);
          if (predicate(event)) {
            finish();
            return;
          }
        } catch {
          /* partial frame; keep reading */
        }
      }
      if (Date.now() > deadline) {
        finish();
        return;
      }
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish();
          return;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        await tick();
      } catch (error) {
        reject(error);
      }
    };
    void tick();
  });
}

describe('SSE stream', () => {
  it('requires the token (query param accepted)', async () => {
    const noToken = await fetch(`${baseUrl}/api/events`);
    expect(noToken.status).toBe(401);
    const wrongToken = await fetch(`${baseUrl}/api/events?token=nope`);
    expect(wrongToken.status).toBe(401);
  });

  it('rejects cross-origin event streams', async () => {
    const response = await fetch(`${baseUrl}/api/events?token=sse-token`, {
      headers: { origin: 'http://evil.example' },
    });
    expect(response.status).toBe(403);
  });

  it('sends hello immediately and heartbeats on the configured cadence', async () => {
    // A scan arms the watcher for the fixture folder (scan-session lifecycle).
    const scan = await app.inject({
      method: 'POST',
      url: '/api/files/scan',
      headers: { host: baseUrl.replace('http://', ''), 'x-metadesk-token': 'sse-token' },
      payload: { folder: fixture.dir, recursive: false },
    });
    expect(scan.statusCode).toBe(200);

    const response = await fetch(`${baseUrl}/api/events?token=sse-token`, {
      headers: { origin: baseUrl },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toContain('no-cache');

    const events = await readEventsUntil(response.body ?? new ReadableStream(), 8_000, (event) =>
      event.type === 'heartbeat' && event.seq >= 3,
    );
    const hello = events.find((e) => e.type === 'hello');
    expect(hello).toBeDefined();
    expect(hello?.seq).toBe(1);
    expect((hello?.data['health'] as Record<string, unknown>)?.ok).toBe(true);
    const heartbeats = events.filter((e) => e.type === 'heartbeat');
    expect(heartbeats.length).toBeGreaterThanOrEqual(2);
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1)); // gap-free
  }, 20_000);

  it('emits folder-changed when a watched file is added', async () => {
    const response = await fetch(`${baseUrl}/api/events?token=sse-token`, {
      headers: { origin: baseUrl },
    });
    expect(response.status).toBe(200);

    // Give the SSE connection a moment to attach, then drop a new file in.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await writeFile(path.join(fixture.dir, 'added-later.png'), PNG_1X1);

    const events = await readEventsUntil(
      response.body ?? new ReadableStream(),
      10_000,
      (event) => event.type === 'folder-changed',
    );
    const changed = events.find((e) => e.type === 'folder-changed');
    expect(changed).toBeDefined();
    expect(changed?.data['folder']).toBe(fixture.dir);
    const changes = changed?.data['changes'] as Array<{ type: string; path: string }>;
    expect(changes.some((c) => c.path.endsWith('added-later.png'))).toBe(true);
  }, 20_000);
});
