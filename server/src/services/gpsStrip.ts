/**
 * The GPS-strip destructive channel (leaf 1.1.4b) — "Remove GPS data" rides
 * the ORDINARY write pipeline (same preview, same default-mode backups, same
 * journal, same re-read verification) behind the same destructive gates as the
 * AI scrub (data-safety requirement #14: GPS removal is a destructive class):
 *
 *  - a CURATED whitelist of specific, engine-writable GPS tags (below); NO
 *    group deletes — `-gps:all=` is forbidden in this version;
 *  - a server-side typed-confirmation gate (REMOVE GPS DATA) re-checked at
 *    execute time by the pipeline;
 *  - a MANDATORY pre-write export of the full current GPS values per file to
 *    the journal sidecar store, written before the preview can be executed;
 *  - RAW files are refused outright;
 *  - undo works through the ordinary journal (writePipeline routes the reverse
 *    edits of a destructive batch through the restore builder).
 *
 * The whitelist was enumerated from the vendored engine's own `-listx` database
 * (ExifTool 13.59): every entry below carries `writable='true'` in the EXIF GPS
 * group or the XMP-exif group. Tags that exist but are not writable by name
 * (composite derivations like GPSPosition/GPSDateTime) are deliberately NOT
 * listed — they disappear with their source tags, which the post-strip
 * independent read verifies. Anything GPS-family the engine cannot delete by
 * name (e.g. QuickTime Keys:GPSCoordinates in video containers) is surfaced in
 * the preview's `notRemoved` honesty list instead of being silently skipped.
 */
import type { ScrubScope, TagDiff, TagEdit } from '@metadesk/shared';
import { buildJsonReadArgs } from '../engine/argBuilder.js';
import type { ExifToolSession } from '../engine/exiftoolSession.js';
import { newRecordId } from './journal.js';
import { matchesTagKey, WritePipelineError, type PreviewEnvelope } from './writePipeline.js';

/** The phrase the user must type to run a GPS strip. Stable and documented. */
export const GPS_CONFIRMATION_PHRASE = 'REMOVE GPS DATA';

/**
 * Specific GPS tags this flow may delete, verified writable against the
 * engine's `-listx` catalog (see module note). Group-qualified, bare deletes
 * only. The four Ref tags are separate EXIF records — deleting the coordinate
 * alone would leave the hemisphere/bearing reference behind, so each Ref is
 * its own entry. XMP-exif carries the same GPS vocabulary as its own group and
 * is wiped alongside the EXIF originals; XMP stores the latitude/longitude
 * reference inside the coordinate value, so it has no Ref tags.
 */
export const GPS_WIPE_TAGS: readonly string[] = Object.freeze([
  // EXIF GPS group (family-1 group name `GPS`), all writable per -listx.
  'EXIF:GPSVersionID',
  'EXIF:GPSLatitudeRef',
  'EXIF:GPSLatitude',
  'EXIF:GPSLongitudeRef',
  'EXIF:GPSLongitude',
  'EXIF:GPSAltitudeRef',
  'EXIF:GPSAltitude',
  'EXIF:GPSTimeStamp',
  'EXIF:GPSDateStamp',
  'EXIF:GPSSatellites',
  'EXIF:GPSStatus',
  'EXIF:GPSMeasureMode',
  'EXIF:GPSDOP',
  'EXIF:GPSSpeedRef',
  'EXIF:GPSSpeed',
  'EXIF:GPSTrackRef',
  'EXIF:GPSTrack',
  'EXIF:GPSImgDirectionRef',
  'EXIF:GPSImgDirection',
  'EXIF:GPSMapDatum',
  'EXIF:GPSDestLatitudeRef',
  'EXIF:GPSDestLatitude',
  'EXIF:GPSDestLongitudeRef',
  'EXIF:GPSDestLongitude',
  'EXIF:GPSDestBearingRef',
  'EXIF:GPSDestBearing',
  'EXIF:GPSDestDistanceRef',
  'EXIF:GPSDestDistance',
  'EXIF:GPSProcessingMethod',
  'EXIF:GPSAreaInformation',
  'EXIF:GPSDifferential',
  'EXIF:GPSHPositioningError',
  // XMP-exif group equivalents, all writable per -listx (GPSDateTime is the
  // XMP name of the EXIF GPSTimeStamp/DateStamp pair).
  'XMP-exif:GPSVersionID',
  'XMP-exif:GPSLatitude',
  'XMP-exif:GPSLongitude',
  'XMP-exif:GPSAltitude',
  'XMP-exif:GPSAltitudeRef',
  'XMP-exif:GPSDateTime',
  'XMP-exif:GPSMapDatum',
  'XMP-exif:GPSSatellites',
  'XMP-exif:GPSStatus',
  'XMP-exif:GPSMeasureMode',
  'XMP-exif:GPSDOP',
  'XMP-exif:GPSSpeedRef',
  'XMP-exif:GPSSpeed',
  'XMP-exif:GPSTrackRef',
  'XMP-exif:GPSTrack',
  'XMP-exif:GPSImgDirectionRef',
  'XMP-exif:GPSImgDirection',
  'XMP-exif:GPSDestLatitude',
  'XMP-exif:GPSDestLongitude',
  'XMP-exif:GPSDestBearingRef',
  'XMP-exif:GPSDestBearing',
  'XMP-exif:GPSDestDistanceRef',
  'XMP-exif:GPSDestDistance',
  'XMP-exif:GPSProcessingMethod',
  'XMP-exif:GPSAreaInformation',
  'XMP-exif:GPSDifferential',
  'XMP-exif:GPSHPositioningError',
]);

/** The whole whitelist as the delete-edit list the pipeline validates against. */
export function buildGpsDeleteEdits(): TagEdit[] {
  return GPS_WIPE_TAGS.map((tag) => ({ tag, op: 'delete' as const }));
}

/**
 * RAW extensions excluded from the destructive channel (same block list as the
 * AI scrub: RAW is limited to an approved safe tag set in this version).
 */
const RAW_EXTENSIONS: ReadonlySet<string> = new Set([
  'crw', 'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raf', 'orf',
  'rw2', 'raw', 'rwl', 'dcr', 'kdc', 'mrw', 'pef', 'srw', 'x3f', '3fr', 'fff', 'iiq', 'erf',
]);

/**
 * Refuse RAW files outright: the strip promises "every GPS tag" per selection,
 * and a silently-skipped file would leave GPS behind while the UI claims a
 * strip. A hard refusal forces a conscious selection instead.
 */
export function assertNoRawFiles(files: readonly string[]): void {
  const blocked: string[] = [];
  for (const filePath of files) {
    const extension = (filePath.split('.').pop() ?? '').toLowerCase();
    if (RAW_EXTENSIONS.has(extension)) blocked.push(filePath);
  }
  if (blocked.length > 0) {
    throw new WritePipelineError(
      'validation',
      'RAW files are limited to an approved safe tag set in this version, so the GPS strip refuses them entirely. Remove the RAW files from the selection; nothing was previewed or written.',
      { blockedFilePaths: blocked },
    );
  }
}

export interface GpsNotRemovedRow {
  filePath: string;
  tag: string;
  reason: string;
}

export interface GpsStripPreview {
  envelope: PreviewEnvelope;
  gpsStripId: string;
  /** Path of the mandatory pre-write export (already attached to the preview). */
  exportedValuesPath: string;
  /** GPS-family tags present but NOT deletable by name, per file. */
  notRemoved: GpsNotRemovedRow[];
}

export interface GpsStripServiceOptions {
  engine: ExifToolSession;
  pipeline: import('./writePipeline.js').WritePipeline;
  dataDir: string;
}

const SWEEP_BATCH = 50;

export class GpsStripService {
  private readonly engine: ExifToolSession;
  private readonly pipeline: import('./writePipeline.js').WritePipeline;

  constructor(options: GpsStripServiceOptions) {
    this.engine = options.engine;
    this.pipeline = options.pipeline;
  }

  /**
   * Build the destructive GPS-strip preview: whitelist delete list, the
   * mandatory pre-write sidecar export (from the preview's own captured
   * before-values, so what is exported is exactly what the diffs show), and
   * the honesty sweep for GPS-family tags outside the whitelist. Read-only.
   */
  async preview(files: readonly string[]): Promise<GpsStripPreview> {
    assertNoRawFiles(files);
    const gpsStripId = newRecordId('gs');
    const envelope = await this.pipeline.preview({
      files,
      edits: buildGpsDeleteEdits(),
      mode: 'gps-strip',
      description: `GPS strip: remove ${GPS_WIPE_TAGS.length} GPS tag type(s) from ${files.length} file(s)`,
      destructive: {
        scope: 'gps',
        confirmationPhrase: GPS_CONFIRMATION_PHRASE,
        allowedDeleteTags: GPS_WIPE_TAGS,
      },
      scrubId: gpsStripId,
    });

    // Mandatory pre-write export (req #14): the full current values of every
    // tag the strip will delete, per file, from the preview's captured reads —
    // after the wipe, this sidecar and the journal's before-values are the
    // only copies of the coordinates.
    const values: Array<{ filePath: string; tag: string; value: string }> = [];
    for (const file of envelope.preview.files) {
      for (const diff of file.diffs as TagDiff[]) {
        if (diff.before !== undefined) {
          values.push({ filePath: file.filePath, tag: diff.tag, value: diff.before });
        }
      }
    }
    const exportPath = await this.pipeline.journal.writeScrubExport(gpsStripId, {
      gpsStripId,
      scope: 'gps' satisfies ScrubScope,
      exportedAt: new Date().toISOString(),
      confirmationPhrase: GPS_CONFIRMATION_PHRASE,
      deleteTags: [...GPS_WIPE_TAGS],
      values,
    });
    this.pipeline.setDestructiveExport(envelope.preview.previewId, exportPath);

    const notRemoved = await this.sweepUnremovable(files);

    return { envelope, gpsStripId, exportedValuesPath: exportPath, notRemoved };
  }

  // ---- internals ----------------------------------------------------------------

  /**
   * One all-tier read per batch: any GPS-family tag the whitelist will NOT
   * delete (the engine cannot remove it by name in this version) comes back as
   * an honest not-removed row. Composite derivations (GPSPosition,
   * GPSLatitude summaries...) are skipped — they are computed values that
   * disappear with their source tags, which the post-write re-read proves.
   */
  private async sweepUnremovable(files: readonly string[]): Promise<GpsNotRemovedRow[]> {
    const rows: GpsNotRemovedRow[] = [];
    for (let offset = 0; offset < files.length; offset += SWEEP_BATCH) {
      const batch = files.slice(offset, offset + SWEEP_BATCH);
      let docs: Array<Record<string, unknown>>;
      try {
        const result = await this.engine.run(buildJsonReadArgs(batch), {
          json: true,
          timeoutMs: 60_000 + batch.length * 500,
        });
        docs = result.json as Array<Record<string, unknown>>;
      } catch {
        return rows; // best effort honesty sweep; never blocks the strip
      }
      for (const doc of docs) {
        const source = doc['SourceFile'];
        if (typeof source !== 'string') continue;
        for (const key of Object.keys(doc)) {
          if (key === 'SourceFile' || !/gps/i.test(key)) continue;
          if (/^composite:/i.test(key)) continue;
          const covered = GPS_WIPE_TAGS.some((tag) => matchesTagKey(key, tag));
          if (!covered) {
            rows.push({
              filePath: source,
              tag: key,
              reason:
                'This GPS tag exists in the file but the engine cannot delete it by name in this version (only a whole-group delete could, which this version refuses). It will still be there after the strip.',
            });
          }
        }
      }
    }
    return rows;
  }
}
