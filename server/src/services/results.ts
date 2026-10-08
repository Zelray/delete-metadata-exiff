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

export interface FailureExplanation {
  /** Machine-stable reason code for the UI. */
  code: string;
  /** One-line plain-English title. */
  title: string;
  /** What actually happened, in words a non-coder can act on. */
  explanation: string;
  /** The suggested fix. */
  suggestedFix: string;
}

interface ExplanationRule {
  code: string;
  pattern: RegExp;
  title: string;
  explanation: string;
  suggestedFix: string;
}

/**
 * In-band exiftool errors (stderr and JSON Error fields), mapped to plain
 * English. Ordered most-specific first.
 */
const EXPLANATION_RULES: readonly ExplanationRule[] = [
  {
    code: 'file-locked',
    // "Error renaming" in default backup mode is the rename-to-_original or
    // tmp-to-file step being blocked — on Windows overwhelmingly a lock.
    pattern: /error renaming|being used by another process|file in use|permission denied.*rename/i,
    title: 'The file is open in another program',
    explanation:
      'The write finished preparing the new version but could not swap it into place because another program is holding the file open.',
    suggestedFix:
      'Close photo viewers, editors, or pause OneDrive/Google Drive sync for this folder, then use Retry on the failed files.',
  },
  {
    code: 'permission-denied',
    pattern: /permission denied|access is denied|error opening file for (?:read|write|update)|not writable/i,
    title: 'Windows refused permission to change this file',
    explanation:
      'The file or its folder is marked read-only, or your user account does not have permission to change it.',
    suggestedFix:
      'Check the file is not marked read-only (right-click > Properties), and that the folder is not on write-protected media.',
  },
  {
    code: 'file-missing',
    pattern: /file not found|no such file|does not exist/i,
    title: 'The file could not be found',
    explanation:
      'The file was not at the expected location when the write ran. It may have been moved, renamed, or deleted.',
    suggestedFix:
      'Re-scan the folder in MetaDesk and confirm the file is still there, then retry.',
  },
  {
    code: 'unsupported-tag',
    pattern: /tag '.*' is not defined|not supported for this file|unknown file type|isn't writable|no writable tags/i,
    title: 'This kind of edit does not apply to this file',
    explanation:
      'The tag being written does not exist in this file format, so the engine skipped the edit.',
    suggestedFix:
      'Remove this file from the selection, or choose a field the format supports. Nothing was changed.',
  },
  {
    code: 'disk-full',
    pattern: /no space left|disk full|quota|0 bytes free/i,
    title: 'The disk ran out of space',
    explanation: 'There was not enough free space to write the new copy of the file.',
    suggestedFix: 'Free up space on the drive, then retry. Failed files were left unchanged.',
  },
  {
    code: 'temporary-file-exists',
    pattern: /temporary file already exists/i,
    title: 'A leftover temporary file is in the way',
    explanation:
      'An earlier write to this photo was interrupted and left a *_exiftool_tmp file behind. New writes refuse to continue until it is cleaned up.',
    suggestedFix: 'Open the Recovery screen, confirm the cleanup, then retry.',
  },
  {
    code: 'corrupt-file',
    pattern: /bad format|corrupt|invalid|format error|not a valid/i,
    title: 'The file could not be read as an image',
    explanation:
      'The file appears to be damaged or in a format the engine cannot parse, so the edit was refused.',
    suggestedFix:
      'Open the file in its normal app to confirm it still works. Exclude it from the batch if it is genuinely unreadable.',
  },
  {
    code: 'write-uncertain',
    pattern: /error/i,
    title: 'The engine reported a problem',
    explanation:
      'The write engine reported an error for this file. The file was left as found wherever possible.',
    suggestedFix: 'Read the engine message below, fix the cause, and use Retry.',
  },
];

/** Map an in-band error message to a plain-English explanation. */
export function explainFailure(message: string): FailureExplanation {
  for (const rule of EXPLANATION_RULES) {
    if (rule.pattern.test(message)) {
      return { code: rule.code, title: rule.title, explanation: rule.explanation, suggestedFix: rule.suggestedFix };
    }
  }
  return {
    code: 'unknown-error',
    title: 'The write did not succeed',
    explanation: 'The engine reported a problem that MetaDesk does not recognize.',
    suggestedFix: 'The engine message below may help. The file was left as found.',
  };
}

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
