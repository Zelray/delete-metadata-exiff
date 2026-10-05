/**
 * Client-side types for the write surfaces, transcribed from the SERVER's
 * actual response shapes (routes/writes.ts, routes/recovery.ts,
 * services/writePipeline.ts, services/scrub.ts, services/journal.ts) — the
 * API bible, not guessed. Where the frozen `@metadesk/shared` already carries
 * the type (TagEdit, WritePreview, BatchOutcome...), it is re-used directly.
 */
import type {
  BackupRecord,
  BatchOutcome,
  ScrubScope,
  WriteOutcome,
  WritePreview,
} from '@metadesk/shared';

// ---- session mode -----------------------------------------------------------

export type WriteMode = 'read-only' | 'write-unlocked';

export interface SessionModeResult {
  mode: WriteMode;
  writeUnlocked: boolean;
  unlockedAt?: string;
  commandPreview: string[];
  note?: string;
}

/** /api/health carries the additive writeUnlocked + mode fields (wave 3). */
export interface HealthWithWrite {
  ok: boolean;
  version: string;
  readOnlyFallback: boolean;
  reason?: string;
  executablePath: string;
  minimumVersion: string;
  writeUnlocked?: boolean;
  mode?: WriteMode;
}

// ---- write preview / execute --------------------------------------------------

/** POST /api/write/preview response. */
export interface WritePreviewResponse {
  preview: WritePreview;
  /** The exact argv of the first execution chunk. */
  commandPreview: string[];
  diffNotes: string[];
  writeUnlocked: boolean;
}

/**
 * One SSE frame streamed on POST /api/write/execute {stream:true}. The server
 * sends `write-progress` chunks, then one `batch-complete` — or a single
 * `write-error`. A cancelled batch adds one additive `batch-cancelled` frame
 * before its `batch-complete` (clients ignore unknown frame types).
 */
export interface ExecuteStreamFrame {
  seq: number;
  timestamp: string;
  type: 'write-progress' | 'batch-complete' | 'write-error' | 'batch-cancelled';
  batchId?: string;
  /** 'intent' | 'write' | 'verify' | 'done' — chunk-level progress. */
  phase?: string;
  filePath?: string;
  index?: number;
  total?: number;
  outcome?: BatchOutcome;
  commandPreview?: string[];
  code?: string;
  message?: string;
  /** batch-cancelled only: when the cancel flag was honored. */
  cancelledAt?: string;
  /** batch-cancelled only: the files the batch never attempted. */
  notAttemptedFilePaths?: string[];
}

/**
 * Additive cancel fields the server adds to a BatchOutcome ONLY when the batch
 * was cancelled between chunks (the shared BatchOutcome shape is frozen). A
 * not-attempted file keeps a three-valued `status: 'unchanged'` — literally
 * true, nothing changed on disk — with `notAttempted: true` carrying the
 * fourth honest state explicitly.
 */
export interface WriteOutcomeNotAttempted extends WriteOutcome {
  notAttempted: true;
  notAttemptedReason: string;
}

export interface BatchOutcomeWithCancel extends BatchOutcome {
  cancelled?: true;
  cancelledAt?: string;
  /** Count of files the batch never attempted (also counted in `unchanged`). */
  notAttempted?: number;
  /** The unprocessed files — a retry preview covers exactly these. */
  notAttemptedFilePaths?: string[];
}

/** POST /api/write/execute (non-stream) and the batch-complete frame payload. */
export interface WriteExecuteResponse {
  outcome: BatchOutcome;
  /** The exact argv of the first executed chunk. */
  commandPreview: string[];
  consistencyNotes: string[];
  writeUnlocked?: boolean;
}

// ---- undo / history -----------------------------------------------------------

/** POST /api/write/undo (step 1, no confirm): the reverse-write diff. */
export interface UndoPreviewResponse {
  requiresConfirmation: true;
  undoPreview: WritePreview;
  commandPreview: string[];
}

/** POST /api/write/undo {confirm:true}: the executed undo batch(es). */
export interface UndoResultResponse {
  undone: true;
  batches: Array<{ batchId: string; outcome: BatchOutcome; commandPreview: string[] }>;
  commandPreview: string[];
}

/** One backup with its just-verified chip state (server verifies per request). */
export interface HistoryBackupRow {
  filePath: string;
  backup: BackupRecord;
  verified: boolean;
}

/** GET /api/write/history — journal BatchHistory plus per-file backup rows. */
export interface HistoryBatch {
  batchId: string;
  startedAt: string | null;
  finishedAt: string | null;
  mode: string;
  description: string;
  interrupted: boolean;
  updated: number;
  unchanged: number;
  failed: number;
  outcomes: WriteOutcome[];
  undoable: boolean;
  backups: HistoryBackupRow[];
  /** Additive (leaf 1.1.4b): present on destructive flows — the strip/scrub id. */
  scrubId?: string;
  /** Additive: path of the mandatory pre-write sidecar export, when one ran. */
  exportedValuesPath?: string;
}

export interface WriteHistoryResponse {
  batches: HistoryBatch[];
  writeUnlocked: boolean;
  mode: WriteMode;
  commandPreview: string[];
}

// ---- AI scrub -----------------------------------------------------------------

/** One tag finding inside a scrubbed file. */
export interface ScrubTagFinding {
  tag: string;
  value: string;
  /** true when the engine can delete this tag by name. */
  removable: boolean;
  note?: string;
}

/** Per-file detection result (services/scrub.ts ScrubFileFinding). */
export interface ScrubFileFinding {
  filePath: string;
  softwareMatches: string[];
  tags: ScrubTagFinding[];
  c2paPresent: boolean;
  jumbfPresent: boolean;
  alphaChannel: boolean;
  possibleHiddenAlphaData: boolean;
  hiddenAlphaNote?: string;
  blockedReason?: string;
}

/** POST /api/scrub/preview `report` — services/scrub.ts ScrubDetection. */
export interface ScrubDetection {
  scrubId: string;
  scope: ScrubScope;
  createdAt: string;
  files: ScrubFileFinding[];
  affectedTags: Array<{ filePath: string; tag: string; value: string }>;
  cleanFilePaths: string[];
  blockedFilePaths: Array<{ filePath: string; reason: string }>;
  requiresTypedConfirmation: true;
  confirmationPhrase: string;
}

export interface ScrubPreviewResponse {
  report: ScrubDetection;
  commandPreview: string[];
  note: string;
}

/** POST /api/scrub/execute response. */
export interface ScrubExecuteResponse {
  outcome: BatchOutcome;
  commandPreview: string[];
  consistencyNotes: string[];
  report: ScrubDetection;
  /** The mandatory pre-write sidecar export beside the journal. */
  exportedValuesPath: string;
  /** Detected-but-NOT-removed items, restated honestly. */
  notRemoved: Array<{ filePath: string; tag: string; reason: string }>;
}

// ---- GPS strip (destructive channel on the generic write routes, 1.1.4b) -----

/**
 * POST /api/write/preview {files, destructive:{scope:"gps"}} — the server
 * expands the delete list from its own curated GPS whitelist (the client never
 * sends tags), produces the mandatory pre-write sidecar export, and reports
 * the GPS-family tags it can NOT delete by name.
 */
export interface GpsStripPreviewResponse extends WritePreviewResponse {
  destructive: {
    scope: 'gps';
    requiresTypedConfirmation: true;
    /** The exact phrase the execute step must send back. */
    confirmationPhrase: string;
  };
  gpsStripId: string;
  /** Path of the sidecar export written before anything can be executed. */
  exportedValuesPath: string;
  notRemoved: Array<{ filePath: string; tag: string; reason: string }>;
}

/**
 * POST /api/write/execute {previewId, destructive:{confirmationPhrase}} — the
 * outcome of a phrase-gated GPS strip (or any destructive execute).
 */
export interface GpsStripExecuteResponse extends WriteExecuteResponse {
  outcome: BatchOutcomeWithCancel;
}

/** POST /api/write/cancel {batchId} — a cooperative, between-chunks cancel. */
export interface CancelWriteResponse {
  batchId: string;
  cancelRequested: true;
  /** What will (and will not) happen, verbatim for the UI. */
  note: string;
  commandPreview: string[];
}

// ---- recovery -----------------------------------------------------------------

export interface RecoveryOrphanTemp {
  path: string;
  targetPath: string;
}

export interface RecoveryOriginalPair {
  backupPath: string;
  photoPath: string;
  trackedSha256: string | null;
}

export interface FolderRecoveryReport {
  folder: string;
  orphanTempFiles: RecoveryOrphanTemp[];
  originalsWithoutPhoto: RecoveryOriginalPair[];
  untrackedOriginals: RecoveryOriginalPair[];
}

export interface RecoveryScanReport {
  scannedAt: string;
  folders: FolderRecoveryReport[];
  journal: {
    interruptedBatches: Array<{
      batchId: string;
      startedAt: string | null;
      pendingFiles: string[];
      markedAbandoned: boolean;
    }>;
  };
  clean: boolean;
  commandPreview: string[];
}

export type RecoveryFixAction =
  | { action: 'delete-orphan-temp'; path: string; confirm: boolean }
  | { action: 'restore-original'; backupPath: string; confirm: boolean }
  | { action: 'adopt-original'; backupPath: string; photoPath: string; confirm: boolean }
  | { action: 'mark-batch-abandoned'; batchId: string; confirm: boolean }
  | { action: 'restore-originals-for-batch'; batchId: string; confirm: boolean };

export interface RecoveryFixResult {
  action: string;
  message: string;
  details: Record<string, unknown>;
  commandPreview: string[];
}

/** Re-export so views can import the whole write vocabulary from one place. */
export type {
  BackupRecord,
  BatchOutcome,
  ScrubScope,
  TagDiff,
  TagEdit,
  WriteOutcome,
  WritePreview,
  WritePreviewFile,
} from '@metadesk/shared';
