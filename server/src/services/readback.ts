/**
 * The metadata re-read used by write verification (and the preview reads).
 *
 * Extracted from the write pipeline so verification can know not just WHAT
 * the re-read returned but WHETHER it returned anything at all (issue #3).
 * The persistent engine never throws for in-band per-file problems, and an
 * empty/unparseable read simply resolves with zero documents — so a plain
 * path->values map cannot distinguish "the tag is genuinely absent" from
 * "the read never reached the file". This module keeps three signals side
 * by side:
 *
 *  - `values`     — path -> tag values, the exact map the pipeline has always
 *                   consumed. Every requested path gets an entry (an empty
 *                   object when the read produced nothing for it), so the
 *                   callers' `?? {}` lookups keep working unchanged.
 *  - `readPaths`  — the paths for which the engine actually returned a
 *                   document carrying a SourceFile: the proof that the read
 *                   reached the file.
 *  - `readErrors` — path -> the engine's in-band error message for that file.
 *
 * KEY CONTRACT (the pipeline matches re-read entries against files through
 * normalizeExifPath — the one canonicalizer used everywhere an
 * exiftool-reported path meets a server-side path): every key in all three
 * structures is `normalizeExifPath(...)` output. Callers look a file up by
 * running its own path through normalizeExifPath first.
 */
import { buildJsonReadArgs } from '../engine/argBuilder.js';
import type { ExifToolSession } from '../engine/exiftoolSession.js';
import { normalizeExifPath } from './exifPath.js';
// Deliberate ESM cycle: writePipeline imports this module for readTagValues,
// and this import pulls matchesTagKey back from it. Both are function
// declarations referenced only at call time, so the cycle resolves safely.
import { matchesTagKey } from './writePipeline.js';

/** Files per metadata read round trip. */
const READ_BATCH = 100;

/** One read's three signals: the values, whether the read reached each file, and per-file errors. */
export interface TagReadback {
  /** Path -> requested-tag values, keyed by normalizeExifPath (every requested path gets an entry). */
  values: Map<string, Record<string, string>>;
  /** Normalized paths whose read actually returned a document with data (no in-band error). */
  readPaths: Set<string>;
  /** Normalized path -> the engine's in-band error message for that file. */
  readErrors: Map<string, string>;
}

/** Flatten an exiftool JSON value to the string form the UI previews. */
function flattenValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value.map((item) => flattenValue(item) ?? '').filter((p) => p.length > 0);
    return parts.length > 0 ? parts.join(', ') : undefined;
  }
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return undefined;
}

/**
 * Read the requested tags for a batch of paths, batched READ_BATCH files at
 * a time through the same `-j -G1 -a -struct` JSON round trip the pipeline
 * has always used (timeout 60s + 500ms per file in the call).
 *
 * A THROWING read still rejects raw — protocol failure is a different,
 * adjacent concern this module deliberately does not swallow.
 */
export async function readTagValues(
  engine: ExifToolSession,
  paths: readonly string[],
  tags: readonly string[],
): Promise<TagReadback> {
  const values = new Map<string, Record<string, string>>();
  const readPaths = new Set<string>();
  const readErrors = new Map<string, string>();
  for (let offset = 0; offset < paths.length; offset += READ_BATCH) {
    const batch = paths.slice(offset, offset + READ_BATCH);
    const argv = buildJsonReadArgs(batch, { tags });
    const result = await engine.run(argv, {
      json: true,
      timeoutMs: 60_000 + batch.length * 500,
    });

    // Index the returned documents by normalized path. A document carrying a
    // SourceFile is the engine's proof the read reached that file.
    const byPath = new Map<string, Record<string, unknown>>();
    for (const doc of result.json as Array<Record<string, unknown>>) {
      const source = doc['SourceFile'];
      if (typeof source === 'string') byPath.set(normalizeExifPath(source), doc);
    }

    // Keep the engine's in-band per-file errors — but ONLY under exiftool's
    // own reserved diagnostic keys: bare 'Error'/'Warning', optionally
    // 'ExifTool:'-prefixed. Tag names can legitimately end in Error (every
    // healthy GPS photo reads back GPS:GPSHPositioningError = "1.5 m"), and
    // the shared extractor flags ANY such key as an error diagnostic — it
    // cannot tell a tag from a diagnostic, but this consumer can, because
    // exiftool's reserved pseudo-keys cannot be confused with family-grouped
    // tag names. Trusting anything else marks healthy files as read errors
    // (the gpsStrip undo false failure). The key is read from the document
    // itself: the session's diagnostics channel drops it at the boundary,
    // and the documents are where it survives.
    for (const [docKey, doc] of byPath) {
      for (const [key, value] of Object.entries(doc)) {
        if (!/^(exiftool:)?(error|warning)$/i.test(key)) continue;
        if (typeof value !== 'string' || value.length === 0) continue;
        const seen = readErrors.get(docKey);
        readErrors.set(docKey, seen === undefined ? value : `${seen}; ${value}`);
      }
    }

    // A path with an in-band error is NOT a read that reached the file, even
    // when the engine echoed its SourceFile inside the error document — the
    // error is the read's answer for that file.
    for (const docKey of byPath.keys()) {
      if (!readErrors.has(docKey)) readPaths.add(docKey);
    }

    // Build the values map exactly as the pipeline's consumers expect: one
    // entry per requested path (empty when the read produced no document for
    // it), each requested tag matched against the document's -G1 keys.
    for (const requested of batch) {
      const key = normalizeExifPath(requested);
      const doc = byPath.get(key);
      const fileValues: Record<string, string> = {};
      if (doc !== undefined) {
        for (const tag of tags) {
          for (const [docKey, value] of Object.entries(doc)) {
            if (docKey === 'SourceFile') continue;
            if (!matchesTagKey(docKey, tag)) continue;
            const flattened = flattenValue(value);
            if (flattened !== undefined) {
              fileValues[tag] = flattened;
              break;
            }
          }
        }
      }
      values.set(key, fileValues);
    }
  }
  return { values, readPaths, readErrors };
}
