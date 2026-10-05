/**
 * The hostile-filename suite: names that look like exiftool grammar must pass
 * through as literal data. Argv-level assertions cover every case; functional
 * assertions (real read/write + read-back, no side effects) cover every name
 * NTFS will actually allow. `"` and control characters (newlines) are illegal
 * in Windows filenames, so those stay argv-only by construction.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { ExifToolSession } from '../src/engine/exiftoolSession.js';
import { buildJsonReadArgs, buildWriteArgs, ArgBuildError } from '../src/engine/argBuilder.js';
import { assertArgsSafe } from '../src/engine/engineArgs.js';
import { EXE_PATH, exifPath, HOSTILE_NAMES, makeFixtureDir, PNG_1X1, type FixtureDir } from './helpers.js';

let session: ExifToolSession;
let fixture: FixtureDir;

beforeAll(async () => {
  fixture = await makeFixtureDir();
  session = new ExifToolSession({ executablePath: EXE_PATH, requestTimeoutMs: 30_000 });
  await session.start();
});

afterAll(async () => {
  await session.shutdown();
});

describe('argv-level safety', () => {
  it('passes every hostile name as one literal argv element, with no separator', () => {
    // The embedded-newline name cannot travel at all (it would split into two
    // argfile lines); it is covered by its own rejection test below.
    for (const hostile of HOSTILE_NAMES.filter((h) => !/newline/.test(h.label))) {
      const absolute = fixture.pathOf(hostile.name);
      const argv = buildJsonReadArgs([absolute]);
      expect(argv.at(-1)).toBe(absolute);
      expect(argv).not.toContain('--');
      expect(argv.filter((arg) => arg === absolute)).toHaveLength(1);
      expect(() => assertArgsSafe(argv)).not.toThrow();
    }
  });

  it('never lets a name starting with - become an option (absolute paths only)', () => {
    const absolute = fixture.pathOf('--All=');
    const argv = buildJsonReadArgs([absolute]);
    const pathArg = argv.at(-1);
    expect(pathArg).toBe(absolute);
    expect(pathArg?.startsWith('C:\\') || pathArg?.startsWith('/')).toBe(true);
  });

  it('rejects a path with an embedded newline at the builder boundary', () => {
    const newlinePath = fixture.pathOf('a\nb.png');
    expect(() => buildJsonReadArgs([newlinePath])).toThrowError(ArgBuildError);
    expect(() =>
      buildWriteArgs([newlinePath], [{ tag: 'PNG:Parameters', op: 'set', value: 'x' }]),
    ).toThrowError(ArgBuildError);
  });

  it('rejects a value that would masquerade as an argument', () => {
    expect(() =>
      buildWriteArgs([fixture.pathOf('a.png')], [
        { tag: 'PNG:Parameters', op: 'set', value: '-All=' },
      ]),
    ).toThrowError(ArgBuildError);
  });
});

describe('functional safety against the real engine', () => {
  for (const hostile of HOSTILE_NAMES.filter((h) => h.creatable)) {
    it(`reads back the file named "${hostile.name}" (${hostile.label}) without side effects`, async () => {
      const absolute = await fixture.put(hostile.name);
      const before = await stat(absolute);
      const hashBefore = createHash('sha256').update(PNG_1X1).digest('hex');

      const result = await session.run(buildJsonReadArgs([absolute]), { json: true });
      const payload = result.json[0] as Record<string, unknown> | undefined;
      expect(payload).toBeDefined();
      expect(payload?.['SourceFile']).toBe(exifPath(absolute));

      const errors = [
        ...result.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message),
        ...result.json.map((o) => String((o as Record<string, unknown>)['Error'] ?? '')),
      ].filter((m) => m.length > 0 && !/invalid png/i.test(m));
      expect(errors).toEqual([]);

      const after = await stat(absolute);
      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(createHash('sha256').update(PNG_1X1).digest('hex')).toBe(hashBefore);
    });
  }

  it('writes and reads back a file literally named --All= (the injection case)', async () => {
    const absolute = await fixture.put('--All=');
    const argv = buildWriteArgs([absolute], [
      { tag: 'PNG:Parameters', op: 'set', value: 'injection probe' },
    ]);
    expect(argv).toEqual(['-PNG:Parameters=injection probe', absolute]);

    const writeResult = await session.run(argv);
    expect(writeResult.stdout).toMatch(/1 image files? updated/);

    // Default backup mode created the _original copy beside the hostile file.
    await expect(stat(`${absolute}_original`)).resolves.toBeTruthy();

    const readBack = await session.run(buildJsonReadArgs([absolute]), { json: true });
    expect((readBack.json[0] as Record<string, unknown>)['PNG:Parameters']).toBe(
      'injection probe',
    );
  });
});
