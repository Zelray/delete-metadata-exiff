/**
 * Three-valued per-file outcomes (data-safety requirement #7).
 *
 * exiftool's process exit code is NEVER consulted. The truth lives in:
 *  - the console summary lines (printed to stdout, or stderr when -j is on):
 *      "    2 image files created"      (with -o scratch copies)
 *      "    1 image files updated"
 *      "    1 image files unchanged"
 *      "    1 image files copied"
 *      "    1 files weren't updated due to errors"
 *      "    1 files weren't created due to errors"
 *  - the -efile manifest files: -efile1 errors, -efile2 unchanged, -efile8
 *    updated, -efile16 created (verified against the vendored engine source:
 *    every write outcome lands in exactly one bucket, and a manifest file is
 *    simply absent when its bucket is empty).
 *
 * Files requested but present in NO manifest are failures by construction —
 * "nothing happened to this file" is surfaced honestly instead of being
 * folded into a green summary.
 */
import { readFile } from 'node:fs/promises';
import { normalizeExifPath } from './exifPath.js';

export interface SummaryCounts {
  directoriesScanned: number;
  filesFailedCondition: number;
  imageFilesCreated: number;
  imageFilesUpdated: number;
  imageFilesUnchanged: number;
  imageFilesCopied: number;
  notUpdatedDueToErrors: number;
  notCreatedDueToErrors: number;
  filesCouldNotBeRead: number;
}

const SUMMARY_PATTERNS: ReadonlyArray<[keyof SummaryCounts, RegExp]> = [
  ['directoriesScanned', /^\s*\d+\s+directories scanned\b/],
  ['filesFailedCondition', /^\s*\d+\s+files failed condition\b/],
  ['imageFilesCreated', /^\s*\d+\s+image files created\b/],
  ['imageFilesUpdated', /^\s*\d+\s+image files updated\b/],
  ['imageFilesUnchanged', /^\s*\d+\s+image files unchanged\b/],
  ['imageFilesCopied', /^\s*\d+\s+image files (?:copied|moved)\b/],
  ['notUpdatedDueToErrors', /^\s*\d+\s+files weren't updated due to errors\b/],
  ['notCreatedDueToErrors', /^\s*\d+\s+files weren't created due to errors\b/],
  ['filesCouldNotBeRead', /^\s*\d+\s+files could not be read\b/],
];

/** Parse the exiftool summary block from any mix of stdout and stderr text. */
export function parseSummary(output: string): SummaryCounts {
  const counts: SummaryCounts = {
    directoriesScanned: 0,
    filesFailedCondition: 0,
    imageFilesCreated: 0,
    imageFilesUpdated: 0,
    imageFilesUnchanged: 0,
    imageFilesCopied: 0,
    notUpdatedDueToErrors: 0,
    notCreatedDueToErrors: 0,
    filesCouldNotBeRead: 0,
  };
  for (const line of output.split(/\r?\n/)) {
    for (const [key, pattern] of SUMMARY_PATTERNS) {
      if (pattern.test(line)) {
        counts[key] = Number.parseInt(line.trim(), 10);
        break;
      }
    }
  }
  return counts;
}

/**
 * Read a -efile manifest. A missing file means an empty bucket (the engine
 * only creates the file when it has an entry to write).
 */
export async function readManifest(manifestPath: string): Promise<string[]> {
  try {
    const raw = await readFile(manifestPath, 'utf8');
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line !== '-');
  } catch {
    return [];
  }
}

export interface ManifestSet {
  errors: string[];
  unchanged: string[];
  updated: string[];
  created?: string[];
}

export interface FileClassification {
  filePath: string;
  status: 'updated' | 'unchanged' | 'failed';
  /** true when the file appeared in no manifest (classified by the fallback). */
  fallback: boolean;
}

/**
 * Classify every requested file from the manifests. Priority: an error beats
 * the other buckets (exiftool can both write a file and record a warning-level
 * error for it), then updated/created, then unchanged. A requested file in no
 * bucket at all is a `failed` fallback — surfaced, never silently green.
 */
export function classifyFiles(requested: readonly string[], manifests: ManifestSet): FileClassification[] {
  const errors = new Set(manifests.errors.map(normalizeExifPath));
  const unchanged = new Set(manifests.unchanged.map(normalizeExifPath));
  const updated = new Set(
    [...manifests.updated, ...(manifests.created ?? [])].map(normalizeExifPath),
  );

  return requested.map((filePath) => {
    const key = normalizeExifPath(filePath);
    if (errors.has(key)) return { filePath, status: 'failed' as const, fallback: false };
    if (updated.has(key)) return { filePath, status: 'updated' as const, fallback: false };
    if (unchanged.has(key)) return { filePath, status: 'unchanged' as const, fallback: false };
    return { filePath, status: 'failed' as const, fallback: true };
  });
}

/** Cross-check manifests against summary counts; mismatches are honest noise. */
export function summarizeConsistency(
  counts: SummaryCounts,
  manifests: ManifestSet,
): string[] {
  const notes: string[] = [];
  const sum = (list: string[]): number => list.length;
  if (counts.imageFilesUpdated !== sum(manifests.updated)) {
    notes.push(
      `The engine reported ${counts.imageFilesUpdated} updated file(s) but listed ${sum(manifests.updated)} in the updated manifest.`,
    );
  }
  if (counts.imageFilesUnchanged !== sum(manifests.unchanged)) {
    notes.push(
      `The engine reported ${counts.imageFilesUnchanged} unchanged file(s) but listed ${sum(manifests.unchanged)} in the unchanged manifest.`,
    );
  }
  if (
    counts.notUpdatedDueToErrors + counts.notCreatedDueToErrors !==
    sum(manifests.errors)
  ) {
    notes.push(
      `The engine reported ${counts.notUpdatedDueToErrors + counts.notCreatedDueToErrors} failed file(s) but listed ${sum(manifests.errors)} in the error manifest.`,
    );
  }
  return notes;
}

// ---- plain-English failure explanations -------------------------------------
// Issue #24: the SERVER copy of explainFailure/EXPLANATION_RULES was deleted
// (zero callers). The UI module ui/src/write/failures.ts is the ONE source of
// the wording — it is wired into the Results Report and speaks for both.

/** Stages at which a file can fail, for the retry-list policy. */
export type FailureStage = 'preflight' | 'backup' | 'write' | 'verify' | 'unknown';

/**
 * The retry list: failed files that are SAFE to run again. A file whose
 * backup verification failed WAS written, so it is deliberately NOT on the
 * auto-retry list — it needs a human decision (it is on the recovery path).
 */
export function retryList(
  outcomes: ReadonlyArray<{ filePath: string; status: string; stage?: FailureStage }>,
): string[] {
  return outcomes
    .filter(
      (o) =>
        o.status === 'failed' &&
        (o.stage === undefined || o.stage === 'write' || o.stage === 'preflight' || o.stage === 'verify' || o.stage === 'unknown'),
    )
    .map((o) => o.filePath);
}
