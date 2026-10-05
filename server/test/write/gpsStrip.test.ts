/**
 * The GPS-strip destructive channel (leaf 1.1.4b) against the REAL engine:
 * a GPS-bearing fixture is previewed (every GPS tag listed with its current
 * value), executed behind the typed phrase, proven stripped by an INDEPENDENT
 * exiftool read, and then undone through the journal — restoring the original
 * bytes exactly (sha256). Also proves the gates: wrong/missing phrase refused,
 * non-GPS tags rejected on the destructive path, RAW refused outright.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { GPS_CONFIRMATION_PHRASE, GpsStripService, GPS_WIPE_TAGS } from '../../src/services/gpsStrip.js';
import { matchesTagKey, WritePipelineError } from '../../src/services/writePipeline.js';
import { makePipeline, makeWriteFixture, readTagsOnce, writeGpsMetadata, type PipelineHarness, type WriteFixture } from './helpers.js';
import { PNG_1X1 } from '../helpers.js';

let fixture: WriteFixture;
let harness: PipelineHarness;
let strip: GpsStripService;

beforeAll(async () => {
  fixture = await makeWriteFixture('metadesk-gps-');
  harness = await makePipeline(fixture);
  strip = new GpsStripService({
    engine: harness.session,
    pipeline: harness.pipeline,
    dataDir: fixture.dataDir,
  });
}, 60_000);

afterAll(async () => {
  await harness?.shutdown();
  await fixture?.cleanup();
});

function sha256(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Every GPS-family key an independent all-tier read finds on the file. */
async function gpsKeys(filePath: string): Promise<string[]> {
  const doc = await readTagsOnce(filePath, []);
  return Object.keys(doc).filter((k) => /gps/i.test(k) && k !== 'SourceFile');
}

describe('GPS-strip destructive channel', () => {
  it('previews every GPS tag with its current value, then the phrase-gated strip proves GPS gone and undo restores the original bytes', async () => {
    const png = await fixture.put('gps-photo.png');
    await writeGpsMetadata(png);

    // The fixture genuinely carries GPS, read independently.
    const beforeKeys = await gpsKeys(png);
    expect(beforeKeys.length).toBeGreaterThanOrEqual(15);
    const bytesBefore = await readFile(png);
    // Fixture setup left a first-generation _original holding the PRISTINE
    // bytes; the strip keeps that first-generation backup (product behavior).
    expect((await stat(`${png}_original`)).isFile()).toBe(true);
    expect(sha256(await readFile(`${png}_original`))).toBe(sha256(PNG_1X1));

    // PREVIEW: the destructive channel lists every tag it will delete, with
    // current values, per file.
    const stripPreview = await strip.preview([png]);
    const filePreview = stripPreview.envelope.preview.files[0];
    expect(filePreview).toBeDefined();
    expect(filePreview?.noop).toBe(false);
    const deleteDiffs = (filePreview?.diffs ?? []).filter((d) => d.kind === 'delete');
    expect(deleteDiffs.length).toBeGreaterThanOrEqual(15);
    const deletedTags = new Set(deleteDiffs.map((d) => d.tag.toLowerCase()));
    expect(deletedTags).toContain('exif:gpslatitude');
    expect(deletedTags).toContain('exif:gpslatituderef');
    expect(deletedTags).toContain('exif:gpslongitude');
    expect(deletedTags).toContain('exif:gpsaltituderef');
    expect(deletedTags).toContain('exif:gpstimestamp');
    expect(deletedTags).toContain('exif:gpsmapdatum');
    expect(deletedTags).toContain('xmp-exif:gpslatitude');
    for (const diff of deleteDiffs) {
      expect(diff.before).toBeDefined();
      expect(diff.before?.length ?? 0).toBeGreaterThan(0);
      expect(diff.after).toBeUndefined();
    }

    // The mandatory pre-write export exists BEFORE execution and carries the
    // full values being destroyed.
    const exported = JSON.parse(await readFile(stripPreview.exportedValuesPath, 'utf8')) as {
      gpsStripId: string;
      scope: string;
      confirmationPhrase: string;
      deleteTags: string[];
      values: Array<{ filePath: string; tag: string; value: string }>;
    };
    expect(exported.gpsStripId).toBe(stripPreview.gpsStripId);
    expect(exported.scope).toBe('gps');
    expect(exported.confirmationPhrase).toBe(GPS_CONFIRMATION_PHRASE);
    expect(exported.deleteTags).toHaveLength(GPS_WIPE_TAGS.length);
    expect(exported.values.length).toBe(deleteDiffs.length);
    const lat = exported.values.find((v) => v.tag.toLowerCase() === 'exif:gpslatitude');
    expect(lat?.value).toMatch(/38/);

    // PHRASE GATE: a wrong phrase is refused by the server, and so is a
    // missing one. Nothing is written either way.
    const previewId = stripPreview.envelope.preview.previewId;
    await expect(
      harness.pipeline.execute(previewId, { destructive: { confirmationPhrase: 'remove gps data' } }),
    ).rejects.toMatchObject({ code: 'destructive_confirmation_required' });
    await expect(harness.pipeline.execute(previewId)).rejects.toMatchObject({
      code: 'destructive_confirmation_required',
    });
    expect(await gpsKeys(png)).toEqual(beforeKeys); // untouched

    // EXECUTE with the exact phrase.
    const result = await harness.pipeline.execute(previewId, {
      destructive: { confirmationPhrase: GPS_CONFIRMATION_PHRASE },
    });
    expect(result.outcome.files).toHaveLength(1);
    expect(result.outcome.files[0]?.status).toBe('updated');
    expect(result.outcome.files[0]?.verified).toBe(true);
    // Default backup mode: the backup record points at the first-generation
    // _original, hash-verified against what the run captured before writing.
    expect(result.outcome.files[0]?.backup).toBeDefined();
    expect(result.outcome.files[0]?.backup?.sha256).toBe(sha256(PNG_1X1));
    const batchId = result.outcome.batchId;

    // INDEPENDENT read (fresh exiftool process): no GPS key of any kind left.
    const afterKeys = await gpsKeys(png);
    expect(afterKeys).toEqual([]);

    // The first-generation _original was kept, not replaced, by the strip.
    expect(sha256(await readFile(`${png}_original`))).toBe(sha256(PNG_1X1));

    // UNDO through the ordinary journal (no phrase needed — restoring is not
    // destroying), then an independent read proves every value came back.
    const undo = await harness.pipeline.undoBatch(batchId);
    expect(undo.results).toHaveLength(1);
    expect(undo.results[0]?.outcome.files[0]?.status).toBe('updated');
    expect(undo.results[0]?.outcome.files[0]?.verified).toBe(true);

    const restoredDoc = await readTagsOnce(png, []);
    const restoredKeys = Object.keys(restoredDoc).filter(
      (k) => /gps/i.test(k) && k !== 'SourceFile',
    );
    expect(restoredKeys.sort()).toEqual(beforeKeys.sort());
    for (const value of exported.values) {
      // Match by group-family (the pipeline's own rule): EXIF-requested tags
      // may read back under GPS:/IFD0:, and a bare-name match alone would
      // collide with the XMP twin of the same GPS tag.
      const back = Object.entries(restoredDoc).find(([k]) => matchesTagKey(k, value.tag));
      expect(String(back?.[1])).toBe(value.value);
    }

    // Byte-identical restore: the undone file hashes exactly like the
    // pre-strip original (probed against the vendored engine: same tags
    // written back reproduce the same bytes for this layout).
    expect(sha256(await readFile(png))).toBe(sha256(bytesBefore));
  });

  it('refuses a non-GPS tag and a group delete through the destructive channel', async () => {
    const png = await fixture.put('gps-guard.png');
    await writeGpsMetadata(png);
    const destructiveSpec = {
      scope: 'gps' as const,
      confirmationPhrase: GPS_CONFIRMATION_PHRASE,
      allowedDeleteTags: GPS_WIPE_TAGS,
    };
    // A non-GPS delete is not on the strip's whitelist.
    await expect(
      harness.pipeline.preview({
        files: [png],
        edits: [{ tag: 'PNG:Comment', op: 'delete' }],
        destructive: destructiveSpec,
      }),
    ).rejects.toMatchObject({ code: 'validation' });
    // A group delete is not a valid tag name anywhere in this app.
    await expect(
      harness.pipeline.preview({
        files: [png],
        edits: [{ tag: 'GPS:all', op: 'delete' }],
        destructive: destructiveSpec,
      }),
    ).rejects.toMatchObject({ code: 'validation' });
    // And a destructive preview built around the WRONG whitelist (e.g. the
    // scrub's tag set posing as GPS) rejects the stranger tag too.
    await expect(
      harness.pipeline.preview({
        files: [png],
        edits: [{ tag: 'EXIF:GPSLatitude', op: 'delete' }],
        destructive: {
          scope: 'ai-generation-metadata',
          confirmationPhrase: 'REMOVE AI METADATA',
          allowedDeleteTags: ['PNG:Parameters'],
        },
      }),
    ).rejects.toMatchObject({ code: 'validation' });
    expect(await gpsKeys(png).then((k) => k.length)).toBeGreaterThan(0); // untouched
  });

  it('refuses RAW files outright', async () => {
    const raw = await fixture.put('gps-shot.nef');
    await writeFile(raw, PNG_1X1); // content irrelevant; the extension is the contract
    await expect(strip.preview([raw])).rejects.toMatchObject({ code: 'validation' });
    // Nothing was previewed, so nothing can be executed, and the file is untouched.
    expect(await stat(raw).then((s) => s.size)).toBe(PNG_1X1.length);
  });

  it('executes honestly on files with no GPS at all (noop preview, unchanged result)', async () => {
    const clean = await fixture.put('gps-clean.png');
    const stripPreview = await strip.preview([clean]);
    expect(stripPreview.envelope.preview.files[0]?.noop).toBe(true);
    expect(stripPreview.envelope.preview.files[0]?.diffs).toEqual([]);
    const result = await harness.pipeline.execute(stripPreview.envelope.preview.previewId, {
      destructive: { confirmationPhrase: GPS_CONFIRMATION_PHRASE },
    });
    expect(result.outcome.files[0]?.status).toBe('unchanged');
    expect(result.outcome.files[0]?.verified).toBeUndefined();
  });

  it('keeps the whitelist free of group deletes and unknown tags', () => {
    for (const tag of GPS_WIPE_TAGS) {
      expect(tag.toLowerCase()).toMatch(/^exif:gps|^xmp-exif:gps/);
      expect(tag.toLowerCase()).not.toContain('all');
    }
  });

  it('produces a WritePipelineError subclass with a stable phrase constant', () => {
    expect(GPS_CONFIRMATION_PHRASE).toBe('REMOVE GPS DATA');
    expect(new WritePipelineError('validation', 'x')).toBeInstanceOf(Error);
  });
});
