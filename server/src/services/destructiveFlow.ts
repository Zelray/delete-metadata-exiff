/**
 * The destructive-flow leaf-kit (arch-v11 leaf 1.3) — the small, policy-free
 * machinery the two destructive flows (AI scrub, GPS strip) share. Named for
 * the CONTEXT.md glossary term "destructive flow".
 *
 * Pure kit: NO orchestration and NO policy live here. Everything the two
 * flows deliberately DISAGREE on stays per-flow in scrub.ts / gpsStrip.ts —
 * RAW posture (scrub blocks rows, strip refuses the selection), phrase-gate
 * timing, empty-selection behavior, export/preview choreography, and the
 * honesty-sweep sourcing (BUILD-NOTES arch-v11 §Leaf 1.3 "STAYS PER-FLOW").
 *
 * Three exports, each the single copy of something both flows need:
 *  1. RAW_EXTENSIONS — the RAW block list (one verbatim copy, previously
 *     duplicated in both services);
 *  2. readAllTierByPath — the one all-tier JSON read (`-j -G1 -a -struct`)
 *     returning the engine docs keyed by normalizeExifPath;
 *  3. writeDestructiveExport — the mandatory pre-write sidecar under
 *     journal/exports; the payload passes through untouched so each flow's
 *     key set stays byte-identical (no unified envelope, no key renames).
 */
import { buildJsonReadArgs } from '../engine/argBuilder.js';
import type { ExifToolSession } from '../engine/exiftoolSession.js';
import type { Journal } from './journal.js';
import { normalizeExifPath } from './exifPath.js';

/**
 * RAW extensions excluded from the destructive channel: RAW is limited to an
 * approved safe tag set in this version, so every destructive flow refuses it
 * (each with its own posture). Callers lowercase the extension before lookup.
 */
export const RAW_EXTENSIONS: ReadonlySet<string> = Object.freeze(
  new Set([
    'crw', 'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raf', 'orf',
    'rw2', 'raw', 'rwl', 'dcr', 'kdc', 'mrw', 'pef', 'srw', 'x3f', '3fr', 'fff', 'iiq', 'erf',
  ]),
);

/**
 * The existing all-tier read shape (`-j -G1 -a -struct` over one batch),
 * parsed into docs keyed by normalizeExifPath(SourceFile). ONE engine round
 * trip per call — the per-flow batch loops (50 files per read) stay with the
 * callers, so the timeout matches today's formula: 60s base + 500ms per file
 * in THIS call.
 */
export async function readAllTierByPath(
  engine: ExifToolSession,
  paths: readonly string[],
): Promise<Map<string, Record<string, unknown>>> {
  const result = await engine.run(buildJsonReadArgs(paths), {
    json: true,
    timeoutMs: 60_000 + paths.length * 500,
  });
  const byPath = new Map<string, Record<string, unknown>>();
  for (const doc of result.json as Array<Record<string, unknown>>) {
    const source = doc['SourceFile'];
    if (typeof source === 'string') byPath.set(normalizeExifPath(source), doc);
  }
  return byPath;
}

/**
 * The mandatory pre-write export of a destructive flow (data-safety req #14):
 * write `payload` verbatim to journal/exports/<flowId>.json and return the
 * path. The payload is deliberately opaque — each flow builds its own key set
 * (scrub: scrubId/values/notRemovable/hiddenDataWarnings from detection rows;
 * gps: gpsStripId/deleteTags/values from the preview's delete diffs) and this
 * helper never reshapes it.
 */
export function writeDestructiveExport(
  journal: Journal,
  flowId: string,
  payload: Record<string, unknown>,
): Promise<string> {
  return journal.writeScrubExport(flowId, payload);
}
