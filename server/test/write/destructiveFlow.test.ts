/**
 * The destructive-flow leaf-kit (arch-v11 leaf 1.3): golden pins for the three
 * shared exports both destructive flows consume. Pure kit — no engine needed.
 *
 *  (a) RAW_EXTENSIONS — the exact RAW block list both flows refuse (frozen).
 *  (b) readAllTierByPath — normalizeExifPath keying, the -j -G1 -a -struct
 *      read-arg shape (argv array), and the timeout formula (60s + 500ms per
 *      file in the call).
 *  (c) writeDestructiveExport — BOTH flows' sidecar payloads pass through
 *      byte-identical and land under journal/exports (scrub detection-row
 *      values sourcing; gps gpsStripId + deleteTags + delete-diff values).
 *
 * The deliberate PER-FLOW disagreements (RAW posture, phrase timing,
 * empty-selection behavior, export/preview choreography, honesty-sweep
 * sourcing) stay pinned by scrub.test.ts / gpsStrip.test.ts / routes.test.ts —
 * this file pins only the shared kit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ExifToolSession } from '../../src/engine/exiftoolSession.js';
import {
  RAW_EXTENSIONS,
  readAllTierByPath,
  writeDestructiveExport,
} from '../../src/services/destructiveFlow.js';
import { Journal } from '../../src/services/journal.js';

/**
 * The exact RAW block list, pinned verbatim from the pre-leaf in-service
 * copies (scrub.ts / gpsStrip.ts carried byte-identical sets).
 */
const RAW_GOLDEN: readonly string[] = [
  'crw', 'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raf', 'orf',
  'rw2', 'raw', 'rwl', 'dcr', 'kdc', 'mrw', 'pef', 'srw', 'x3f', '3fr', 'fff', 'iiq', 'erf',
];

/** Records what the kit asked the engine to run. */
interface RecordedRun {
  args: readonly string[];
  opts: { json?: boolean; timeoutMs?: number };
}

function fakeEngine(json: Array<Record<string, unknown>>, runs: RecordedRun[]): ExifToolSession {
  const session = {
    run: async (args: readonly string[], opts: { json?: boolean; timeoutMs?: number } = {}) => {
      runs.push({ args, opts });
      return { executeNumber: 1, json, stdout: '', stderr: '', diagnostics: [] };
    },
  };
  return session as unknown as ExifToolSession;
}

describe('RAW_EXTENSIONS golden', () => {
  it('is exactly the shared RAW block list (verbatim from the pre-leaf copies), frozen', () => {
    expect(RAW_EXTENSIONS.size).toBe(RAW_GOLDEN.length);
    expect([...RAW_EXTENSIONS].sort()).toEqual([...RAW_GOLDEN].sort());
    expect(Object.isFrozen(RAW_EXTENSIONS)).toBe(true);
  });

  it('answers the lowercase, dot-less extension lookups both flows make — and nothing else', () => {
    for (const ext of RAW_GOLDEN) {
      expect(RAW_EXTENSIONS.has(ext)).toBe(true);
      expect(RAW_EXTENSIONS.has(ext.toUpperCase())).toBe(false); // callers lowercase first
      expect(RAW_EXTENSIONS.has(`.${ext}`)).toBe(false); // callers split on the last dot
    }
    // Ordinary image formats and sidecars are never blocked. 'dng' is
    // deliberately NOT here: it belongs to metadata.ts's separate
    // classification set, not to the destructive block list.
    for (const allowed of ['png', 'jpg', 'jpeg', 'tif', 'dng', 'xmp', '']) {
      expect(RAW_EXTENSIONS.has(allowed)).toBe(false);
    }
  });
});

describe('readAllTierByPath', () => {
  it('keys the docs by normalizeExifPath(SourceFile) and hands back the doc objects', async () => {
    const runs: RecordedRun[] = [];
    const winPath = 'C:\\Photos\\IMG_0001.PNG';
    const doc = { SourceFile: winPath, 'PNG:Parameters': 'Steps: 20' };
    const byPath = await readAllTierByPath(fakeEngine([doc], runs), [winPath]);

    expect([...byPath.keys()]).toEqual(['c:/photos/img_0001.png']); // backslashes + case folded
    expect(byPath.get('c:/photos/img_0001.png')).toBe(doc); // the doc object, not a copy
    // The map carries ONLY normalized keys: a caller looks its own path up
    // through normalizeExifPath, exactly as scrub.ts does.
    expect(byPath.get(winPath)).toBeUndefined();
  });

  it('drops docs without a string SourceFile (nothing to key them by)', async () => {
    const keyed = { SourceFile: 'C:\\p\\a.png', 'EXIF:Software': 'x' };
    const byPath = await readAllTierByPath(
      fakeEngine([{ 'EXIF:Software': 'orphan' }, { SourceFile: 42 }, keyed], []),
      ['C:\\p\\a.png'],
    );
    expect([...byPath.keys()]).toEqual(['c:/p/a.png']);
    expect(byPath.get('c:/p/a.png')).toBe(keyed);
  });

  it('runs ONE all-tier JSON read per call: -j -G1 -a -struct + the paths, 60s + 500ms per file', async () => {
    const runs: RecordedRun[] = [];
    const paths = ['C:\\p\\a.png', 'C:\\p\\b.png', 'C:\\p\\c.png'];
    await readAllTierByPath(fakeEngine([{ SourceFile: 'C:\\p\\a.png' }], runs), paths);

    expect(runs).toHaveLength(1); // chunking is caller-owned (the per-flow 50-file batch loops)
    const run = runs[0];
    expect(run).toBeDefined();
    expect(Array.isArray(run?.args)).toBe(true); // argv array, never a shell string
    expect(run?.args.slice(0, 4)).toEqual(['-j', '-G1', '-a', '-struct']);
    expect(run?.args.slice(4)).toEqual(paths);
    expect(run?.opts.json).toBe(true);
    expect(run?.opts.timeoutMs).toBe(60_000 + paths.length * 500);
    expect(run?.opts.timeoutMs).toBe(61_500);
  });

  it('scales the timeout with exactly the batch it was handed (the per-flow 50-file batches)', async () => {
    const runs: RecordedRun[] = [];
    const fifty = Array.from({ length: 50 }, (_, i) => `C:\\p\\f${i}.png`);
    await readAllTierByPath(fakeEngine([], runs), fifty);
    expect(runs[0]?.opts.timeoutMs).toBe(85_000);

    await readAllTierByPath(fakeEngine([], runs), ['C:\\p\\only.png']);
    expect(runs[1]?.opts.timeoutMs).toBe(60_500);
  });
});

describe('writeDestructiveExport', () => {
  let root: string;
  let journal: Journal;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'metadesk-destructiveflow-'));
    journal = new Journal({ dataDir: root });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it('writes the SCRUB payload verbatim (detection-row values sourcing) under journal/exports and returns its path', async () => {
    const scrubId = 'sc_kit_scrub';
    const values = [
      { filePath: 'C:\\p\\a.png', tag: 'PNG:Parameters', value: 'Steps: 20, Sampler: Euler a' },
      // A non-string detection value arrives as its raw JSON.stringify form.
      { filePath: 'C:\\p\\a.png', tag: 'PNG:Comment', value: '{"seed":42,"sampler":"Euler a"}' },
    ];
    const payload: Record<string, unknown> = {
      scrubId,
      scope: 'ai-generation-metadata',
      exportedAt: '2026-10-06T00:00:00.000Z',
      confirmationPhrase: 'REMOVE AI METADATA',
      values,
      notRemovable: [{ filePath: 'C:\\p\\a.png', tag: 'PNG:Prompt', note: 'cannot delete by name' }],
      hiddenDataWarnings: [
        { filePath: 'C:\\p\\a.png', possibleHiddenAlphaData: true, c2paPresent: false, jumbfPresent: false },
      ],
    };

    const exportPath = await writeDestructiveExport(journal, scrubId, payload);
    expect(exportPath).toBe(path.join(journal.exportsDir, `${scrubId}.json`));

    const raw = await readFile(exportPath, 'utf8');
    expect(raw).toBe(`${JSON.stringify(payload, null, 2)}\n`); // byte-identical, no envelope
    const written = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(written)).toEqual([
      'scrubId',
      'scope',
      'exportedAt',
      'confirmationPhrase',
      'values',
      'notRemovable',
      'hiddenDataWarnings',
    ]);
    expect(written['values']).toEqual(values);
    expect(written['notRemovable']).toEqual(payload['notRemovable']);
    expect(written['hiddenDataWarnings']).toEqual(payload['hiddenDataWarnings']);
  });

  it('writes the GPS payload verbatim (gpsStripId + deleteTags + delete-diff values) under journal/exports and returns its path', async () => {
    const gpsStripId = 'gs_kit_gps';
    const values = [
      { filePath: 'C:\\p\\g.png', tag: 'EXIF:GPSLatitude', value: '38.521' },
      { filePath: 'C:\\p\\g.png', tag: 'XMP-exif:GPSLatitude', value: '38.521' },
    ];
    const payload: Record<string, unknown> = {
      gpsStripId,
      scope: 'gps',
      exportedAt: '2026-10-06T00:00:00.000Z',
      confirmationPhrase: 'REMOVE GPS DATA',
      deleteTags: ['EXIF:GPSLatitude', 'EXIF:GPSLongitude', 'XMP-exif:GPSLatitude'],
      values,
    };

    const exportPath = await writeDestructiveExport(journal, gpsStripId, payload);
    expect(exportPath).toBe(path.join(journal.exportsDir, `${gpsStripId}.json`));

    const raw = await readFile(exportPath, 'utf8');
    expect(raw).toBe(`${JSON.stringify(payload, null, 2)}\n`);
    const written = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(written)).toEqual([
      'gpsStripId',
      'scope',
      'exportedAt',
      'confirmationPhrase',
      'deleteTags',
      'values',
    ]);
    expect(written['gpsStripId']).toBe(gpsStripId);
    expect(written['deleteTags']).toEqual(payload['deleteTags']);
    expect(written['values']).toEqual(values);
  });
});
