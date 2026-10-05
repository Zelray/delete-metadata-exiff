/**
 * Integration tests against the REAL vendored exiftool.exe: protocol framing
 * (request -> -executeN -> {readyN}), JSON payload parsing, in-band error
 * surfacing, request serialization, and write + read-back on a real fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { access, stat } from 'node:fs/promises';
import { ExifToolSession, runOnce } from '../src/engine/exiftoolSession.js';
import { buildJsonReadArgs, buildWriteArgs } from '../src/engine/argBuilder.js';
import { EXE_PATH, exifPath, makeFixtureDir, type FixtureDir } from './helpers.js';

let fixture: FixtureDir;
let session: ExifToolSession;

beforeAll(async () => {
  fixture = await makeFixtureDir();
  await fixture.put('photo one.png');
  await fixture.put('photo two.png');
  session = new ExifToolSession({ executablePath: EXE_PATH, requestTimeoutMs: 30_000 });
  await session.start();
});

afterAll(async () => {
  await session.shutdown();
});

describe('session startup', () => {
  it('spawned the documented initial command line with charset before -@', () => {
    expect(session.initialArgs).toEqual([
      '-charset',
      'filename=UTF8',
      '-stay_open',
      'True',
      '-@',
      '-',
    ]);
    const charsetIndex = session.initialArgs.indexOf('-charset');
    const atIndex = session.initialArgs.indexOf('-@');
    expect(charsetIndex).toBeGreaterThanOrEqual(0);
    expect(atIndex).toBeGreaterThan(charsetIndex);
  });

  it('completed the warmup -ver handshake and parsed the version', () => {
    expect(session.warmupVersion).toMatch(/^\d+\.\d+$/);
    expect(Number.parseFloat(session.warmupVersion ?? '0')).toBeGreaterThanOrEqual(13);
    expect(session.isRunning).toBe(true);
  });
});

describe('protocol framing', () => {
  it('round-trips a JSON read and matches the {readyN} token', async () => {
    const target = fixture.pathOf('photo one.png');
    const result = await session.run(buildJsonReadArgs([target]), { json: true });
    expect(result.executeNumber).toBe(2); // 1 was the warmup
    expect(result.json).toHaveLength(1);
    const first = result.json[0] as Record<string, unknown>;
    expect(first['SourceFile']).toBe(exifPath(target));
    expect(result.diagnostics).toHaveLength(0);
  });

  it('numbers every request monotonically', async () => {
    const first = await session.run(['-ver']);
    const second = await session.run(['-ver']);
    expect(second.executeNumber).toBe(first.executeNumber + 1);
    expect(first.stdout.trim()).toMatch(/^\d+\.\d+$/);
  });

  it('splits multiple JSON documents for a multi-file request', async () => {
    const paths = [fixture.pathOf('photo one.png'), fixture.pathOf('photo two.png')];
    const result = await session.run(buildJsonReadArgs(paths), { json: true });
    const sources = result.json.map((o) => (o as Record<string, unknown>)['SourceFile']);
    expect(sources).toEqual(paths.map(exifPath));
  });

  it('serializes concurrent requests and returns each answer to its caller', async () => {
    const a = fixture.pathOf('photo one.png');
    const b = fixture.pathOf('photo two.png');
    const [ra, rb] = await Promise.all([
      session.run(buildJsonReadArgs([a]), { json: true }),
      session.run(buildJsonReadArgs([b]), { json: true }),
    ]);
    expect((ra.json[0] as Record<string, unknown>)['SourceFile']).toBe(exifPath(a));
    expect((rb.json[0] as Record<string, unknown>)['SourceFile']).toBe(exifPath(b));
    expect(rb.executeNumber).toBe(ra.executeNumber + 1);
  });

  it('surfaces in-band errors instead of throwing', async () => {
    const missing = fixture.pathOf('does not exist.png');
    const result = await session.run(buildJsonReadArgs([missing]), { json: true });
    const messages = [
      ...result.diagnostics.map((d) => d.message),
      ...result.json.map((o) => String((o as Record<string, unknown>)['Error'] ?? '')),
    ];
    const combined = messages.join(' ');
    expect(combined).toMatch(/not found|does not exist/i);
  });
});

describe('write and read-back on a real fixture', () => {
  it('writes PNG:Parameters in default backup mode and reads the value back', async () => {
    const target = fixture.pathOf('photo one.png');
    const argv = buildWriteArgs([target], [
      { tag: 'PNG:Parameters', op: 'set', value: 'test prompt' },
    ]);
    expect(argv.some((arg) => arg.toLowerCase().includes('overwrite'))).toBe(false);

    const writeResult = await session.run(argv);
    expect(writeResult.stdout).toMatch(/1 image files? updated/);

    // Default backup mode must have produced FILE_original next to the file.
    const backup = `${target}_original`;
    await access(backup);
    expect((await stat(backup)).size).toBeGreaterThan(0);

    const readBack = await session.run(buildJsonReadArgs([target]), { json: true });
    const payload = readBack.json[0] as Record<string, unknown>;
    expect(payload['PNG:Parameters']).toBe('test prompt');

    // And the write itself must not be reported as a failure anywhere.
    expect(writeResult.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
  });
});

describe('one-shot helper', () => {
  it('runs -ver to completion with a real exit code', async () => {
    const result = await runOnce(EXE_PATH, ['-ver'], { timeoutMs: 20_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(session.warmupVersion);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('reports a spawn failure as a rejected promise', async () => {
    await expect(
      runOnce('C:\\definitely\\not\\here\\exiftool.exe', ['-ver'], { timeoutMs: 10_000 }),
    ).rejects.toThrow(/failed to run|exiftool one-shot/i);
  });
});
