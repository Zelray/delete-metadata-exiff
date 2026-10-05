/**
 * Write pipeline contract: plans, mandatory previews, three-valued outcomes,
 * the JSONL journal record, and scrub reports.
 */

/** A single intended tag edit. */
export interface TagEdit {
  /** Whitelisted, group-qualified tag key, e.g. "XMP-dc:Description". */
  tag: string;
  /**
   * The operation. `set` writes a value; `delete` removes the tag (an
   * explicit, separate user action — never implied by an empty value);
   * `append`/`remove` are list operations on list-type tags.
   */
  op: TagEditOperation;
  /**
   * The value for `set`/`append`/`remove`. This string occupies the VALUE
   * slot of exactly one `-TAG=VALUE` argument and nothing else. Required for
   * those ops, forbidden for `delete`.
   */
  value?: string;
}

export type TagEditOperation = 'set' | 'delete' | 'append' | 'remove';

/** The per-file edit set the user staged, before any preview exists. */
export interface WritePlan {
  planId: string;
  /** Absolute target file paths, deduplicated and sanitized. */
  filePaths: string[];
  /** Edits applied to every file in the batch. */
  edits: TagEdit[];
  /**
   * true when the user has unlocked writing for this session. The server
   * independently enforces its own unlock state; this field must agree.
   */
  writeUnlocked: boolean;
  createdAt: string;
}

/** One tag's before/after pair for one file. */
export interface TagDiff {
  tag: string;
  /** Value before the write; absent when the tag does not exist yet. */
  before?: string;
  /** Value after the write; absent for deletions. */
  after?: string;
  kind: TagDiffKind;
}

export type TagDiffKind = 'create' | 'change' | 'delete' | 'unchanged';

/**
 * The mandatory preview: exactly which tags change on which file, plus the
 * exact exiftool arguments that will be executed. No write happens without
 * one of these having been produced and approved.
 */
export interface WritePreview {
  previewId: string;
  planId: string;
  /** Per-file previews, in batch order. */
  files: WritePreviewFile[];
  /** Free bytes on the target volume, when determinable. */
  freeBytes?: number;
  /** Estimated new bytes required (edits + backups). */
  estimatedBytesRequired?: number;
  /** Blocking problems that prevent execution (locked folder, no space). */
  blockers: string[];
  createdAt: string;
}

export interface WritePreviewFile {
  filePath: string;
  /** Old -> new per tag. Empty when nothing would change. */
  diffs: TagDiff[];
  /** The exact argument list for this file (no shell string, ever). */
  argv: string[];
  /** Problems specific to this file. */
  warnings: string[];
  /** true when the preview concluded no change is needed. */
  noop: boolean;
}

/** Three-valued per-file outcome. Never derived from the exit code. */
export type WriteOutcomeStatus = 'updated' | 'unchanged' | 'failed';

export interface WriteOutcome {
  filePath: string;
  status: WriteOutcomeStatus;
  /** In-band exiftool warnings for this file (never swallowed). */
  warnings: string[];
  /** In-band exiftool errors for this file. */
  errors: string[];
  /** Backup record when the file was updated in default backup mode. */
  backup?: BackupRecord;
  /** Post-write re-read proof: tag values actually on disk after the write. */
  verified?: boolean;
  /** Failure stage, when status is `failed`. */
  stage?: WriteFailureStage;
}

export type WriteFailureStage =
  | 'preflight'
  | 'backup'
  | 'write'
  | 'verify'
  | 'unknown';

/** Backup bookkeeping recorded before success may be claimed. */
export interface BackupRecord {
  path: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

/** Batch-level result. */
export interface BatchOutcome {
  batchId: string;
  startedAt: string;
  finishedAt: string;
  files: WriteOutcome[];
  updated: number;
  unchanged: number;
  failed: number;
  /** true when every file reached `updated` with `verified` set. */
  allVerified: boolean;
  /** Retry list: failed files safe to run again after their cause is fixed. */
  retryFilePaths: string[];
}

/**
 * One JSONL journal record. The intent record is appended BEFORE execution;
 * the result record is appended after the write settles.
 */
export interface JournalEntry {
  /** ULID-ish unique id for this journal record. */
  id: string;
  /** The batch this record belongs to. */
  batchId: string;
  kind: JournalEntryKind;
  /** UTC ISO-8601. */
  timestamp: string;
  filePath: string;
  /** The edits intended for this file (intent and result records). */
  edits: TagEdit[];
  /** The exact argv used, when executed. */
  argv?: string[];
  backup?: BackupRecord;
  /** Tag values captured before the write (per-step metadata undo). */
  before?: Record<string, string>;
  outcome?: WriteOutcome;
}

export type JournalEntryKind = 'intent' | 'result' | 'batch-start' | 'batch-end';

/**
 * Metadata scrub report — the destructive strip flow's contract. GPS removal
 * and any group delete are classified destructive and must produce one of
 * these before executing.
 */
export interface ScrubReport {
  scrubId: string;
  /** What is being removed and from where. */
  scope: ScrubScope;
  filePaths: string[];
  /** Exact tags that will be deleted, discovered from the actual files. */
  affectedTags: Array<{ filePath: string; tag: string; value: string }>;
  /** Mandatory pre-write export of the values being destroyed. */
  exportedValuesPath?: string;
  /** RAW formats block bulk group deletes; this records the enforcement. */
  blockedFilePaths: Array<{ filePath: string; reason: string }>;
  requiresTypedConfirmation: boolean;
  confirmationPhrase: string;
  createdAt: string;
}

export type ScrubScope = 'gps' | 'ai-generation-metadata' | 'all-metadata' | 'custom';
