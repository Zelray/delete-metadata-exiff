/**
 * Diagnostics support bundle (leaf 2.2.1): the token gate, the zip response,
 * the bundle contents (journal tail from a seeded journal, engine version from
 * the fixture health + the seeded version cache), and the on-disk copy under
 * data/diagnostics.
 *
 * No live engine: the fixture health is passed to buildServer, so the route's
 * internal /api/health round trip returns the fixture instantly (in production
 * that same round trip is the live `exiftool -ver` handshake).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { InjectOptions } from 'light-my-request';
import { loadConfig } from '../../src/config.js';
import { buildServer, type BuildServerResult } from '../../src/index.js';
import { Journal } from '../../src/services/journal.js';

const TOKEN = 'diag-token-1';

let dataDir: string;
let server: BuildServerResult;
let app: FastifyInstance;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'metadesk-diagnostics-'));
  const journal = new Journal({ dataDir });
  // A seeded batch whose records must survive into the bundle's journal tail.
  await journal.recordBatchStart({
    batchId: 'wb_diag_seed',
    mode: 'edit',
    description: 'diagnostics-bundle-seed batch (expect this in the tail)',
    files: ['C:\\photos\\seed-photo.png'],
    argv: ['-use', 'MWG', '-P', '-XMP-dc:Title=seed title', 'C:\\photos\\seed-photo.png'],
    edits: [{ tag: 'XMP-dc:Title', op: 'set', value: 'seed title' }],
  });
  await journal.recordResult({
    batchId: 'wb_diag_seed',
    filePath: 'C:\\photos\\seed-photo.png',
    outcome: { filePath: 'C:\\photos\\seed-photo.png', status: 'updated', warnings: [], errors: [], verified: true },
  });
  await journal.recordBatchEnd({
    batchId: 'wb_diag_seed',
    summary: { updated: 1, unchanged: 0, failed: 0, allVerified: true },
  });
  // The version cache the startup handshake writes (a DIFFERENT version than
  // the fixture live health, so the bundle must show both sources separately).
  await writeFile(
    path.join(dataDir, 'engine-version.json'),
    JSON.stringify({
      version: '12.50',
      checkedAt: '2026-10-01T08:00:00.000Z',
      executablePath: 'C:\\old-install\\exiftool.exe',
    }),
    'utf8',
  );

  server = await buildServer({
    config: {
      ...loadConfig(),
      dataDir,
      thumbsDir: path.join(dataDir, 'thumbs'),
      portfilePath: path.join(dataDir, 'portfile.json'),
      executablePath: 'C:\\fixture\\exiftool.exe',
      serverVersion: '9.9.9-test',
    },
    token: TOKEN,
    // ok:false keeps a real exiftool session from starting (no spawn in tests).
    health: {
      ok: false,
      version: '13.99.5',
      readOnlyFallback: true,
      reason: 'fixture: the engine is not exercised in this test',
      executablePath: 'C:\\fixture\\exiftool.exe',
      minimumVersion: '13.0',
    },
  });
  app = server.app;
}, 30_000);

afterAll(async () => {
  await app?.close();
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
});

function injectGet(url: string, token: string | null): InjectOptions {
  const headers: Record<string, string> = { host: '127.0.0.1' };
  if (token !== null) headers['x-metadesk-token'] = token;
  return { url, method: 'GET', headers };
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
    const method = zip.readUInt16LE(ptr + 10);
    const crc = zip.readUInt32LE(ptr + 16);
    const compressedSize = zip.readUInt32LE(ptr + 20);
    const uncompressedSize = zip.readUInt32LE(ptr + 24);
    const nameLen = zip.readUInt16LE(ptr + 28);
    const extraLen = zip.readUInt16LE(ptr + 30);
    const commentLen = zip.readUInt16LE(ptr + 32);
    const localOffset = zip.readUInt32LE(ptr + 42);
    const name = zip.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');

    expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameLen = zip.readUInt16LE(localOffset + 26);
    const localExtraLen = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = Buffer.from(zip.subarray(dataStart, dataStart + compressedSize));
    expect(method).toBe(0); // stored, as documented
    expect(uncompressedSize).toBe(compressedSize);
    // The CRC is checked with the same reflected table algorithm the route uses.
    expect(crc32Of(data)).toBe(crc >>> 0);

    entries.set(name, data);
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

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

async function fetchBundle(): Promise<{
  response: Awaited<ReturnType<FastifyInstance['inject']>>;
  entries: Map<string, Buffer>;
}> {
  const response = await app.inject(injectGet('/api/diagnostics/bundle', TOKEN));
  expect(response.statusCode).toBe(200);
  return { response, entries: readZipEntries(response.rawPayload) };
}

describe('diagnostics bundle auth', () => {
  it('requires the per-launch token like every other /api route', async () => {
    const noToken = await app.inject(injectGet('/api/diagnostics/bundle', null));
    expect(noToken.statusCode).toBe(401);
    expect(noToken.json()).toMatchObject({ code: 'bad_request' });

    const wrongToken = await app.inject(injectGet('/api/diagnostics/bundle', 'not-the-token'));
    expect(wrongToken.statusCode).toBe(401);
  });
});

describe('diagnostics bundle response', () => {
  it('returns an application/zip attachment with the saved-path header', async () => {
    const { response } = await fetchBundle();
    expect(response.headers['content-type']).toBe('application/zip');
    expect(response.headers['content-disposition']).toMatch(
      /attachment; filename="metadesk-diagnostics-\d{8}-\d{6}\.zip"/,
    );
    const savedPath = response.headers['x-metadesk-diagnostics-path'];
    expect(typeof savedPath).toBe('string');
    expect(path.isAbsolute(savedPath as string)).toBe(true);
    expect(savedPath).toContain(path.join('diagnostics', ''));
  });

  it('contains the five documented text files, including README.txt', async () => {
    const { entries } = await fetchBundle();
    for (const name of ['README.txt', 'context.txt', 'engine.txt', 'versions.txt', 'journal-tail.txt']) {
      expect(entries.get(name), name).toBeDefined();
    }
    const readme = entries.get('README.txt')?.toString('utf8') ?? '';
    expect(readme).toContain('What this bundle is');
    expect(readme).toContain('not your photos');
    expect(readme).toContain('Nothing here was sent anywhere by MetaDesk');
  });

  it('carries the seeded journal tail content', async () => {
    const { entries } = await fetchBundle();
    const tail = entries.get('journal-tail.txt')?.toString('utf8') ?? '';
    expect(tail).toContain('MetaDesk write journal — tail');
    expect(tail).toContain('diagnostics-bundle-seed batch (expect this in the tail)');
    // Journal lines are JSON, so the stored path is backslash-escaped.
    expect(tail).toContain('C:\\\\photos\\\\seed-photo.png');
    expect(tail).toContain('"kind":"batch-end"');
    expect(tail).toContain('Kept: all');
  });

  it('reports the engine from BOTH the version cache and the live handshake', async () => {
    const { entries } = await fetchBundle();
    const engine = entries.get('engine.txt')?.toString('utf8') ?? '';
    expect(engine).toContain('MetaDesk engine (exiftool)');
    expect(engine).toContain('C:\\fixture\\exiftool.exe');
    // From the seeded engine-version.json (the startup record):
    expect(engine).toContain('version: 12.50');
    expect(engine).toContain('C:\\old-install\\exiftool.exe');
    // From the live handshake (the fixture health passed to buildServer):
    expect(engine).toContain('version: 13.99.5');
    expect(engine).toContain('why: fixture: the engine is not exercised in this test');
  });

  it('reports versions and context honestly', async () => {
    const { response, entries } = await fetchBundle();
    const versions = entries.get('versions.txt')?.toString('utf8') ?? '';
    expect(versions).toContain('App version (app\\package.json): 9.9.9-test');
    expect(versions).toContain('Node.js: ');
    expect(versions).toContain(`Platform: ${process.platform}`);

    const context = entries.get('context.txt')?.toString('utf8') ?? '';
    expect(context).toContain(`Data folder: ${dataDir}`);
    expect(context).toContain('Write mode at bundle time: read-only');
    expect(context).toContain('MetaDesk always STARTS read-only');
    expect(context).toContain(response.headers['x-metadesk-diagnostics-path'] as string);
  });

  it('also writes the same bytes under data/diagnostics', async () => {
    const { response } = await fetchBundle();
    const savedPath = response.headers['x-metadesk-diagnostics-path'] as string;
    const info = await stat(savedPath);
    expect(info.isFile()).toBe(true);
    expect(path.resolve(savedPath).startsWith(path.resolve(dataDir, 'diagnostics'))).toBe(true);
    await expect(readFile(savedPath)).resolves.toEqual(response.rawPayload);
  });
});

describe('journal tail truncation', () => {
  it('keeps the newest 200 whole records and says so', async () => {
    const journal = new Journal({ dataDir });
    await journal.recordBatchStart({
      batchId: 'wb_diag_long',
      mode: 'edit',
      description: 'long batch, older records must be dropped from the tail',
      files: [],
      argv: [],
      edits: [],
    });
    for (let i = 0; i < 210; i += 1) {
      await journal.recordIntent({
        batchId: 'wb_diag_long',
        filePath: `C:\\photos\\long-${String(i).padStart(3, '0')}.png`,
        edits: [{ tag: 'XMP-dc:Title', op: 'set', value: `t${i}` }],
        before: {},
        expectedAfter: { 'XMP-dc:Title': `t${i}` },
        diffs: [],
      });
    }

    const { entries } = await fetchBundle();
    const tail = entries.get('journal-tail.txt')?.toString('utf8') ?? '';
    expect(tail).toContain('Kept: the newest 200 lines; older lines were dropped');
    expect(tail).not.toContain('long-000.png');
    expect(tail).toContain('long-209.png');

    const keptLines = tail.split('\n').filter((line) => line.startsWith('{"kind":'));
    expect(keptLines).toHaveLength(200);
  }, 30_000);
});
