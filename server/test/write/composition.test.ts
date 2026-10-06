/**
 * Write-subsystem composition pins (arch-v11 leaf 1.1): the guarantees the
 * lift exists to provide, checked over the fully wired buildServer.
 *
 *  - ONE Journal: a batch the routes execute is visible through
 *    server.write.journal and read back by the history route; recovery's
 *    scan and the diagnostics journal tail read the same records.
 *  - Engine-null degradation: every write surface answers 503.
 *  - Nullability invariant: pipeline/scrub/gpsStrip are null exactly when
 *    the engine is null.
 *  - Unlock flips the diagnostics bundle's context.txt to "write-unlocked".
 *  - mode-changed frames reach a real hub connection, both route-driven and
 *    fused (a direct write.unlock()/lock() with no route still emits).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { InjectOptions, InjectPayload } from 'light-my-request';
import { loadConfig } from '../../src/config.js';
import { buildServer, type BuildServerResult } from '../../src/index.js';
import { WriteSubsystem } from '../../src/writeSubsystem.js';
import {
  makePipeline,
  makeWriteFixture,
  type PipelineHarness,
  type WriteFixture,
} from './helpers.js';
import { EXE_PATH } from '../helpers.js';

const TOKEN = 'write-comp-token';

/** Health fixture for the engine server (no live handshake in tests). */
const FIXTURE_HEALTH = {
  ok: true,
  version: '12.99',
  readOnlyFallback: false,
  executablePath: 'test',
  minimumVersion: '12.70',
};

/** Health fixture for the engine-less server (ok:false boots no session). */
const BARE_HEALTH = {
  ok: false,
  version: '',
  readOnlyFallback: true,
  reason: 'fixture: the composition tests run without an engine',
  executablePath: EXE_PATH,
  minimumVersion: '12.70',
};

let fixture: WriteFixture;
let harness: PipelineHarness;
let server: BuildServerResult;
let app: FastifyInstance;
let baseUrl: string;
let bare: BuildServerResult;
let bareDataDir: string;

async function injectOn(
  target: FastifyInstance,
  url: string,
  options: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<{ statusCode: number; body: any }> {
  const injectOptions: InjectOptions = {
    url,
    method: options.method ?? 'GET',
    headers: { 'x-metadesk-token': TOKEN, host: '127.0.0.1' },
  };
  if (options.body !== undefined) injectOptions.payload = options.body as InjectPayload;
  const response = await target.inject(injectOptions);
  return { statusCode: response.statusCode, body: response.json() };
}

beforeAll(async () => {
  fixture = await makeWriteFixture('metadesk-write-comp-');
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
    health: FIXTURE_HEALTH,
    engine: harness.session,
  });
  app = server.app;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  bareDataDir = await mkdtemp(path.join(tmpdir(), 'metadesk-write-comp-bare-'));
  bare = await buildServer({
    config: {
      ...loadConfig(),
      dataDir: bareDataDir,
      thumbsDir: path.join(bareDataDir, 'thumbs'),
      portfilePath: path.join(bareDataDir, 'portfile.json'),
      executablePath: EXE_PATH,
    },
    token: TOKEN,
    health: BARE_HEALTH,
  });
  await bare.app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await bare?.app.close();
  await harness?.shutdown();
  await fixture?.cleanup();
  if (bareDataDir !== undefined) {
    await rm(bareDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ---- SSE reading (the pattern from test/read/sse.test.ts) ---------------------

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

/** Open one hub connection and hand the body to readEventsUntil. */
async function connectHub(): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(`${baseUrl}/api/events?token=${TOKEN}`, {
    headers: { origin: baseUrl },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  // Give the connection a moment to attach before the frame is published.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return response.body ?? new ReadableStream();
}

// ---- zip reading (the pattern from test/diagnostics/bundle.test.ts) -----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32Of(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    const byte = data[i] ?? 0;
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Independent minimal zip reader: central directory -> entry name -> bytes. */
function readZipEntries(zip: Buffer): Map<string, Buffer> {
  const eocdSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocd = zip.lastIndexOf(eocdSig);
  expect(eocd).toBeGreaterThan(0);
  const count = zip.readUInt16LE(eocd + 10);
  expect(zip.readUInt16LE(eocd + 8)).toBe(count);
  let ptr = zip.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    expect(zip.readUInt32LE(ptr)).toBe(0x02014b50);
    const nameLen = zip.readUInt16LE(ptr + 28);
    const extraLen = zip.readUInt16LE(ptr + 30);
    const commentLen = zip.readUInt16LE(ptr + 32);
    const localOffset = zip.readUInt32LE(ptr + 42);
    const name = zip.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    const localNameLen = zip.readUInt16LE(localOffset + 26);
    const localExtraLen = zip.readUInt16LE(localOffset + 28);
    const compressedSize = zip.readUInt32LE(ptr + 20);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = Buffer.from(zip.subarray(dataStart, dataStart + compressedSize));
    // The CRC is checked with the same reflected table algorithm the route uses.
    expect(crc32Of(data)).toBe(zip.readUInt32LE(ptr + 16) >>> 0);
    entries.set(name, data);
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function bundleEntriesOf(target: FastifyInstance): Promise<Map<string, Buffer>> {
  const injectOptions: InjectOptions = {
    url: '/api/diagnostics/bundle',
    method: 'GET',
    headers: { 'x-metadesk-token': TOKEN, host: '127.0.0.1' },
  };
  const response = await target.inject(injectOptions);
  expect(response.statusCode).toBe(200);
  return readZipEntries(response.rawPayload);
}

async function bundleEntryText(
  target: FastifyInstance,
  name: string,
): Promise<string> {
  const entries = await bundleEntriesOf(target);
  const data = entries.get(name);
  expect(data, name).toBeDefined();
  return data?.toString('utf8') ?? '';
}

// ---- the pins -------------------------------------------------------------------

describe('nullability invariant', () => {
  it('exposes pipeline, scrub and gpsStrip null exactly when the engine is null', () => {
    for (const wired of [server, bare]) {
      expect(wired.write.pipeline !== null).toBe(wired.engine !== null);
      expect(wired.write.scrub !== null).toBe(wired.engine !== null);
      expect(wired.write.gpsStrip !== null).toBe(wired.engine !== null);
    }
    expect(bare.write.pipeline).toBeNull();
    expect(bare.write.scrub).toBeNull();
    expect(bare.write.gpsStrip).toBeNull();
    expect(server.write.pipeline).not.toBeNull();
    expect(server.write.scrub).not.toBeNull();
    expect(server.write.gpsStrip).not.toBeNull();
  });

  it('carries healthFields() as the single definition of the health pair', () => {
    expect(bare.write.healthFields()).toEqual({ writeUnlocked: false, mode: 'read-only' });
    expect(bare.write.writeUnlocked).toBe(false);
    expect(bare.write.mode).toBe('read-only');
  });
});

// "ONE journal" is pinned by record FLOW, not instance identity: Journal is
// stateless path math (services/journal.ts), so two instances over the same
// dataDir are indistinguishable by design (BUILD-NOTES constraint 5). What
// these tests prove is that a record written through one surface is visible
// through every other surface that must share the journal.
describe('ONE journal through the routes', () => {
  it('lands an executed batch in the subsystem journal and reads it back through history', async () => {
    await injectOn(app, '/api/session/unlock', { method: 'POST', body: {} });
    const png = await fixture.put('comp-journal.png');
    const preview = await injectOn(app, '/api/write/preview', {
      method: 'POST',
      body: { files: [png], edits: [{ tag: 'XMP-dc:Title', op: 'set', value: 'one journal' }] },
    });
    expect(preview.statusCode).toBe(200);
    const executed = await injectOn(app, '/api/write/execute', {
      method: 'POST',
      body: { previewId: preview.body.preview.previewId },
    });
    expect(executed.statusCode).toBe(200);
    const batchId = executed.body.outcome.batchId as string;

    // The pipeline recorded into THE subsystem journal, not a private one.
    const ids = await server.write.journal.listBatchIds(100);
    expect(ids).toContain(batchId);

    // The history route reads that same journal through the subsystem.
    const history = await injectOn(app, '/api/write/history');
    expect(history.statusCode).toBe(200);
    expect(
      history.body.batches.some((b: { batchId: string }) => b.batchId === batchId),
    ).toBe(true);
  });

  it('shows a subsystem-seeded interrupted batch to the recovery scan (shared journal)', async () => {
    await server.write.journal.recordBatchStart({
      batchId: 'wb_comp_interrupted',
      mode: 'edit',
      description: 'composition seed: started but never finished',
      files: ['C:\\photos\\comp-seed.png'],
      argv: ['-use', 'MWG', '-P', '-XMP-dc:Title=seed', 'C:\\photos\\comp-seed.png'],
      edits: [{ tag: 'XMP-dc:Title', op: 'set', value: 'seed' }],
    });

    const scan = await injectOn(app, '/api/recovery/scan');
    expect(scan.statusCode).toBe(200);
    expect(
      scan.body.journal.interruptedBatches.some(
        (b: { batchId: string }) => b.batchId === 'wb_comp_interrupted',
      ),
    ).toBe(true);
  });

  it('sees subsystem journal records in the diagnostics journal tail', async () => {
    await bare.write.journal.recordBatchStart({
      batchId: 'wb_comp_tail',
      mode: 'edit',
      description: 'composition seed: expect this in the journal tail',
      files: [],
      argv: [],
      edits: [],
    });

    const tail = await bundleEntryText(bare.app, 'journal-tail.txt');
    expect(tail).toContain('MetaDesk write journal — tail');
    expect(tail).toContain('composition seed: expect this in the journal tail');
    expect(tail).toContain('wb_comp_tail');
  });
});

describe('engine-null degradation', () => {
  it('answers 503 engine_unavailable on every write surface', async () => {
    const surfaces: Array<[string, unknown]> = [
      [
        '/api/write/preview',
        { files: ['C:\\x.png'], edits: [{ tag: 'XMP-dc:Title', op: 'set', value: 'v' }] },
      ],
      ['/api/write/preview', { files: ['C:\\x.png'], destructive: { scope: 'gps' } }],
      ['/api/write/execute', { previewId: 'pv_nope' }],
      ['/api/write/cancel', { batchId: 'wb_nope' }],
      ['/api/write/undo', { batchId: 'wb_nope' }],
      ['/api/scrub/preview', { files: ['C:\\x.png'] }],
      ['/api/scrub/execute', { files: ['C:\\x.png'], confirm: 'REMOVE AI METADATA' }],
    ];
    for (const [url, body] of surfaces) {
      const res = await injectOn(bare.app, url, { method: 'POST', body });
      expect(res.statusCode, url).toBe(503);
      expect(res.body.code, url).toBe('engine_unavailable');
    }
  });
});

describe('unlock visibility in the diagnostics bundle', () => {
  it('flips context.txt from read-only to write-unlocked and back', async () => {
    await injectOn(bare.app, '/api/session/lock', { method: 'POST', body: {} });
    expect(await bundleEntryText(bare.app, 'context.txt')).toContain(
      'Write mode at bundle time: read-only',
    );

    const unlocked = await injectOn(bare.app, '/api/session/unlock', { method: 'POST', body: {} });
    expect(unlocked.statusCode).toBe(200);
    expect(await bundleEntryText(bare.app, 'context.txt')).toContain(
      'Write mode at bundle time: write-unlocked for this session',
    );

    await injectOn(bare.app, '/api/session/lock', { method: 'POST', body: {} });
    expect(await bundleEntryText(bare.app, 'context.txt')).toContain(
      'Write mode at bundle time: read-only',
    );
  });
});

describe('mode-changed frames on a real hub connection', () => {
  it('emits the frame when the unlock route flips the mode', async () => {
    await injectOn(app, '/api/session/lock', { method: 'POST', body: {} });
    const body = await connectHub();

    const flipped = await injectOn(app, '/api/session/unlock', { method: 'POST', body: {} });
    expect(flipped.statusCode).toBe(200);

    const events = await readEventsUntil(body, 8_000, (event) => event.type === 'mode-changed');
    const changed = events.find((e) => e.type === 'mode-changed');
    expect(changed).toBeDefined();
    expect(changed?.data['writeUnlocked']).toBe(true);
    expect(changed?.data['mode']).toBe('write-unlocked');
  }, 20_000);

  it('emits the fused announce even when the mode flips without the route', async () => {
    await server.write.lock();
    const body = await connectHub();

    const unlocked = server.write.unlock();
    expect(unlocked.writeUnlocked).toBe(true);

    const events = await readEventsUntil(body, 8_000, (event) => event.type === 'mode-changed');
    const changed = events.find((e) => e.type === 'mode-changed');
    expect(changed?.data['writeUnlocked']).toBe(true);

    // And the way back: a direct lock() announces the read-only mode too.
    const bodyAgain = await connectHub();
    const locked = server.write.lock();
    expect(locked.writeUnlocked).toBe(false);
    const eventsAgain = await readEventsUntil(bodyAgain, 8_000, (event) => event.type === 'mode-changed');
    expect(eventsAgain.find((e) => e.type === 'mode-changed')?.data['writeUnlocked']).toBe(false);
  }, 20_000);
});

describe('announce fusion is structural', () => {
  it('a bare subsystem cannot flip the mode without announcing it', () => {
    const announced: boolean[] = [];
    const subsystem = new WriteSubsystem({
      engine: null,
      dataDir: bareDataDir,
      announce: (writeUnlocked) => {
        announced.push(writeUnlocked);
      },
    });

    expect(announced).toEqual([]);
    expect(subsystem.unlock()).toMatchObject({ mode: 'write-unlocked', writeUnlocked: true });
    expect(announced).toEqual([true]);
    expect(subsystem.lock()).toMatchObject({ mode: 'read-only', writeUnlocked: false });
    expect(announced).toEqual([true, false]);
    expect(subsystem.healthFields()).toEqual({ writeUnlocked: false, mode: 'read-only' });
  });
});
