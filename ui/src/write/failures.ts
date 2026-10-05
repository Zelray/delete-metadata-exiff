/**
 * Plain-English failure explanations for the Results Report — a faithful port
 * of the server's services/results.ts EXPLANATION_RULES (the UI cannot import
 * server modules; the wording must stay verbatim so both surfaces speak with
 * one voice). Ordered most-specific first, exactly like the server list.
 */
import type { WriteOutcome } from './types';

export interface FailureExplanation {
  /** Machine-stable reason code. */
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
      return {
        code: rule.code,
        title: rule.title,
        explanation: rule.explanation,
        suggestedFix: rule.suggestedFix,
      };
    }
  }
  return {
    code: 'unknown-error',
    title: 'The write did not succeed',
    explanation: 'The engine reported a problem that MetaDesk does not recognize.',
    suggestedFix: 'The engine message below may help. The file was left as found.',
  };
}

/**
 * The retry policy, mirroring the server's retryList(): failed files that are
 * SAFE to run again. A file whose backup verification failed WAS written, so
 * it is deliberately excluded — it needs the recovery path, not a blind retry.
 */
export function retryableFilePaths(outcomes: readonly WriteOutcome[]): string[] {
  return outcomes
    .filter(
      (o) =>
        o.status === 'failed' &&
        (o.stage === undefined || o.stage === 'write' || o.stage === 'preflight' || o.stage === 'verify' || o.stage === 'unknown'),
    )
    .map((o) => o.filePath);
}
