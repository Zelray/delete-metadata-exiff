/**
 * The write pipeline — the only code path in MetaDesk that is ever allowed to
 * modify a user's photos (data-safety requirements #3, #4, #6, #7, #8, #13,
 * #14, #16, #18, #19).
 *
 * Two phases, always in this order:
 *
 *  PREVIEW  (`preview`): reads the current values of every affected tag,
 *  SIMULATES the write onto scratch copies (`-o` into a temp dir — the
 *  originals are never touched), diffs old -> new per tag per file, and
 *  freezes the exact argv the execute phase will run (`commandPreview`).
 *  There is no true exiftool dry-run for writes; the `-o` scratch write is
 *  the documented-equivalent pattern. The engine's own `-diff` pass runs as
 *  a second opinion.
 *
 *  EXECUTE  (`execute`): runs in DEFAULT BACKUP MODE (no overwrite flag can
 *  exist — engine/engineArgs structurally rejects `-overwrite_original*`),
 *  with `-P` to preserve filesystem times and `-use MWG` for the human-facing
 *  field set, in chunks of N files. Per-file truth comes from `-efile`
 *  manifests plus summary counts — never from the exit code. Every file whose
 *  write succeeded gets its `_original` verified (exists + size + sha256,
 *  matched against the hash captured BEFORE the write) BEFORE it may be
 *  marked `updated`, and then the written tags are RE-READ from disk and
 *  compared against the preview. Only then is success claimed.
 *
 * Failure handling is per file: a locked or permission-denied file fails with
 * its engine message preserved, and the batch continues.
 *
 * Destructive flows (GPS strip, AI scrub) ride the same machinery with two
 * extra gates: a typed confirmation phrase and a mandatory pre-write export
 * of the values being destroyed, both re-checked at execute time.
 *
 * Undo is per-step metadata undo computed from the journal's before-values.
 * Because each file's before-values differ, an undo fans out into one
 * preview+execute per distinct reverse-edit set; each fan is a full-safety
 * batch of its own. Undoing the same batch twice is refused.
 */
import { mkdir, rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import type {
  BackupRecord,
  BatchOutcome,
  ScrubScope,
  TagDiff,
  TagEdit,
  WriteOutcome,
  WritePreview,
  WritePreviewFile,
} from '@metadesk/shared';
import {
  assertNoOverwriteArgs,
  buildJsonReadArgs,
  buildWriteArgs,
  isValidTagShape,
  toValueSlot,
} from '../engine/argBuilder.js';
import { assertArgsSafe } from '../engine/engineArgs.js';
import type { ExifToolSession } from '../engine/exiftoolSession.js';
import { newRecordId, sha256File, Journal, type BatchStartRecord } from './journal.js';
import { findForeignTempFiles, WriteLock } from './lock.js';
import { normalizeExifPath } from './exifPath.js';
import {
  classifyFiles,
  parseSummary,
  readManifest,
  retryList,
  summarizeConsistency,
} from './results.js';
import { assertSafePath } from './pathGuard.js';

/** Files per execution chunk. */
export const DEFAULT_CHUNK_SIZE = 200;
/** Files per metadata read round trip. */
const READ_BATCH = 100;
/** Previews expire after this long; the journal remains the durable record. */
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const MAX_STORED_PREVIEWS = 50;
/** Upper bound for one batch; the UI paginates above this. */
export const MAX_BATCH_FILES = 5000;

/** Common flags for every real write: MWG for human-facing fields, -P times. */
const COMMON_WRITE_FLAGS: readonly string[] = Object.freeze(['-use', 'MWG', '-P']);

export type WritePipelineErrorCode =
  | 'preview_required'
  | 'preview_expired'
  | 'read_only_mode'
  | 'write_locked'
  | 'destructive_confirmation_required'
  | 'validation'
  | 'undo_unavailable'
  | 'batch_too_large'
  | 'already_undone';

export class WritePipelineError extends Error {
  readonly code: WritePipelineErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: WritePipelineErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'WritePipelineError';
    this.code = code;
    this.details = details;
  }
}

/** Extra gates for a destructive flow (GPS strip, AI scrub). */
export interface DestructiveSpec {
  scope: ScrubScope;
  /** The exact phrase the user must type; re-checked at execute time. */
  confirmationPhrase: string;
  /**
   * The caller's COMPILE-TIME whitelist of tags this destructive flow may
   * delete. Destructive edits are bare deletes only, validated against this
   * list at preview AND execute time — the curated human-fields whitelist
   * does not cover non-human tags (PNG:Comment, EXIF:UserComment...), but
   * free-form tag entry stays impossible: only names in this list pass.
   */
  allowedDeleteTags: readonly string[];
  /** Path of the mandatory pre-write export (set by the scrub flow). */
  exportPath?: string;
}

/**
 * Additive per-file outcome fields for a file a CANCELLED batch never
 * attempted. The shared `WriteOutcomeStatus` stays three-valued (frozen
 * contract), so the fourth honest state is carried by these flags:
 * `status: 'unchanged'` is literally true — nothing on disk changed — and
 * `notAttempted` makes "the batch never touched this file" explicit instead
 * of implied.
 */
export interface NotAttemptedOutcomeFields {
  notAttempted: true;
  notAttemptedReason: string;
}

export type WriteOutcomeWithNotAttempted = WriteOutcome & NotAttemptedOutcomeFields;

/**
 * Additive batch-level fields present ONLY on cancelled batches (the shared
 * `BatchOutcome` shape is frozen; these are additive optional members of the
 * JSON payload). `unchanged` in the counts includes the not-attempted files so
 * `updated + unchanged + failed === files.length` keeps holding.
 */
export interface CancelledBatchOutcomeFields {
  cancelled: true;
  cancelledAt: string;
  notAttempted: number;
  /** The unprocessed files — a retry preview covers exactly these. */
  notAttemptedFilePaths: string[];
}

export type CancelledBatchOutcome = BatchOutcome & CancelledBatchOutcomeFields;

export interface PreviewRequest {
  files: readonly string[];
  edits: readonly TagEdit[];
  /** 'edit' | 'undo' | 'scrub' — recorded in the journal. */
  mode?: string;
  description?: string;
  destructive?: { scope: ScrubScope; confirmationPhrase: string; allowedDeleteTags: readonly string[] };
  /**
   * Journal-sourced RESTORE spec (internal undo path only): allows `set`
   * restores of tags the destructive flow deleted, validated against the tags
   * of the ORIGINAL batch's own edit list. Routes never accept this from
   * callers — the only producer is `undoBatch`/`prepareUndo` reading the
   * journal, so no user-supplied tag can reach this path.
   */
  restore?: { allowedTags: readonly string[] };
  /** Explicit timezone decision for date-shift edits (requirement #13). */
  timezone?: string;
  undoOfBatchId?: string;
  scrubId?: string;
}

export interface PreviewEnvelope {
  preview: WritePreview;
  /** The exact argv of the first execution chunk. */
  commandPreview: string[];
  /** Plain-text notes from the engine's own `-diff` pass, when it produced any. */
  diffNotes: string[];
  writeUnlocked: boolean;
}

export interface WriteProgressEvent {
  batchId: string;
  phase: 'intent' | 'write' | 'verify' | 'done';
  filePath?: string;
  index: number;
  total: number;
}

export interface ExecuteOptions {
  onProgress?: (event: WriteProgressEvent) => void;
  /** Required (and re-checked) when the preview was marked destructive. */
  destructive?: { confirmationPhrase: string };
  /**
   * TEST SEAM ONLY, documented like the SSE heartbeat seam: forces the
   * post-write re-read comparison to fail for the listed files so the
   * verification path is exercisable without a corrupting harness.
   */
  faultInjection?: { failVerificationFor?: readonly string[] };
}

export interface ExecuteResult {
  outcome: BatchOutcome;
  /** The exact argv of the first executed chunk. */
  commandPreview: string[];
  /** Notes from manifest/summary cross-checking (honest noise, shown in UI). */
  consistencyNotes: string[];
}

interface StoredPreview {
  id: string;
  planId: string;
  createdAtMs: number;
  files: string[];
  edits: TagEdit[];
  chunks: string[][];
  editArgv: string[];
  commandPreview: string[];
  manifestDir: string;
  before: Map<string, Record<string, string>>;
  expectedAfter: Map<string, Record<string, string>>;
  diffs: Map<string, TagDiff[]>;
  beforeSha256: Map<string, string>;
  preOriginalSha256: Map<string, string>;
  fileWarnings: Map<string, string[]>;
  destructive: DestructiveSpec | null;
  /** Restore whitelist when this preview is a journal-sourced undo restore. */
  restoreTags: readonly string[] | null;
  mode: string;
  description: string;
  timezone?: string;
  undoOfBatchId?: string;
  scrubId?: string;
}

/**
 * Family-1 groups a written tag may legitimately appear under when read back.
 * Writing `EXIF:Software` surfaces as `IFD0:Software` in a `-G1` read, etc.
 */
const GROUP_FAMILY_ACCEPT: Readonly<Record<string, readonly string[]>> = Object.freeze({
  exif: Object.freeze(['exif', 'ifd0', 'exififd', 'gps', 'interopifd', 'subifd']),
  png: Object.freeze(['png']),
  iptc: Object.freeze(['iptc']),
  'xmp-dc': Object.freeze(['xmp-dc']),
  'xmp-xmp': Object.freeze(['xmp-xmp']),
  'xmp-photoshop': Object.freeze(['xmp-photoshop']),
  'xmp-mwg-rs': Object.freeze(['xmp-mwg-rs']),
});

/** True when `actualKey` (a -G1 read key) can be the requested tag. */
export function matchesTagKey(actualKey: string, requestedTag: string): boolean {
  const colonIndex = requestedTag.indexOf(':');
  const reqGroup = (colonIndex > 0 ? requestedTag.slice(0, colonIndex) : '').toLowerCase();
  const reqName = (requestedTag.split(':').pop() ?? '').toLowerCase();
  const actualColon = actualKey.indexOf(':');
  const actualGroup = (actualColon > 0 ? actualKey.slice(0, actualColon) : '').toLowerCase();
  const actualName = (actualColon > 0 ? actualKey.slice(actualColon + 1) : actualKey).toLowerCase();
  if (actualName !== reqName) return false;
  if (reqGroup === '') return true;
  const accept = GROUP_FAMILY_ACCEPT[reqGroup] ?? Object.freeze([reqGroup]);
  return accept.includes(actualGroup);
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

export interface WritePipelineOptions {
  engine: ExifToolSession;
  /** Mutable app state dir (journal + scratch + write temp files). */
  dataDir: string;
  journal?: Journal;
  lock?: WriteLock;
  chunkSize?: number;
  /** Server-side write unlock state; execute refuses when this returns false. */
  isWriteUnlocked?: () => boolean;
  previewTtlMs?: number;
}

export class WritePipeline {
  private readonly engine: ExifToolSession;
  private readonly dataDir: string;
  readonly journal: Journal;
  private readonly lock: WriteLock;
  private readonly chunkSize: number;
  private readonly isWriteUnlocked: () => boolean;
  private readonly previewTtlMs: number;
  private readonly previews = new Map<string, StoredPreview>();
  /** Batch ids currently executing (cancel targets). */
  private readonly activeBatches = new Set<string>();
  /** Cooperative cancel requests, honored BETWEEN chunks only. */
  private readonly cancelFlags = new Set<string>();

  constructor(options: WritePipelineOptions) {
    this.engine = options.engine;
    this.dataDir = path.resolve(options.dataDir);
    this.journal = options.journal ?? new Journal({ dataDir: this.dataDir });
    this.lock = options.lock ?? new WriteLock({ lockDir: this.journal.journalDir });
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.isWriteUnlocked = options.isWriteUnlocked ?? (() => false);
    this.previewTtlMs = options.previewTtlMs ?? PREVIEW_TTL_MS;
  }

  get singleWriterLock(): WriteLock {
    return this.lock;
  }

  // ---- preview ------------------------------------------------------------

  /**
   * Phase 1: read current values, simulate onto scratch copies, diff, and
   * freeze the execute argv. Never touches the original files.
   */
  async preview(request: PreviewRequest): Promise<PreviewEnvelope> {
    const files = this.sanitizeFiles(request.files);
    if (files.length === 0) {
      throw new WritePipelineError('validation', 'A write preview needs at least one file.');
    }
    if (files.length > MAX_BATCH_FILES) {
      throw new WritePipelineError(
        'batch_too_large',
        `At most ${MAX_BATCH_FILES} files per batch. Split the selection.`,
      );
    }
    if (request.edits.length === 0) {
      throw new WritePipelineError('validation', 'A write preview needs at least one edit.');
    }

    // The whitelist/value grammar gate runs here, on the edit list, exactly as
    // it will run at execute time — same builder, same rejections. Destructive
    // flows use the bare-delete path with their own compile-time whitelist;
    // journal-sourced undo restores use the restore path (set + delete against
    // the original batch's own tag list).
    const editArgv =
      request.restore !== undefined
        ? buildDestructiveRestoreArgs(request.edits, request.restore.allowedTags)
        : request.destructive !== undefined
          ? buildDestructiveDeleteArgs(request.edits, request.destructive.allowedDeleteTags)
          : buildWriteArgs([files[0] as string], request.edits).slice(0, -1);
    const affectedTags = [...new Set(request.edits.map((e) => e.tag))];

    const previewId = newRecordId('pv');
    const planId = newRecordId('pl');

    // ---- preflight: folders, space, per-file warnings, hashes ---------------
    const folders = [...new Set(files.map((f) => path.dirname(f)))];
    const blockers: string[] = [];
    const fileWarnings = new Map<string, string[]>();
    const beforeSha256 = new Map<string, string>();
    const preOriginalSha256 = new Map<string, string>();
    let estimatedBytesRequired = 0;

    const foreignTmp = await findForeignTempFiles(folders);
    if (foreignTmp.length > 0) {
      blockers.push(
        `Leftover temporary write files are present (${foreignTmp.length}). Run the recovery scan before writing.`,
      );
    }

    let freeBytes: number | undefined;
    try {
      const fsStats = await statfs(path.parse(files[0] as string).root);
      freeBytes = Number(fsStats.bavail) * Number(fsStats.bsize);
    } catch {
      freeBytes = undefined;
    }

    for (const filePath of files) {
      const warnings: string[] = [];
      try {
        const info = await stat(filePath);
        if (!info.isFile()) {
          warnings.push('The path is not a regular file.');
          blockers.push(`"${path.basename(filePath)}" is not a regular file.`);
        } else {
          estimatedBytesRequired += info.size * 2; // new copy + first-generation backup
          if ((info.mode & 0o200) === 0) {
            warnings.push('The file is marked read-only. Windows may refuse the write.');
          }
        }
      } catch {
        warnings.push('The file was not found. It will fail if it is still missing at write time.');
      }
      try {
        const backupInfo = await stat(`${filePath}_original`);
        if (backupInfo.isFile()) {
          warnings.push(
            'A backup from an earlier edit already exists. MetaDesk keeps that first-generation backup; this write adds a journal restore point instead.',
          );
          preOriginalSha256.set(normalizeExifPath(filePath), await sha256File(`${filePath}_original`));
        }
      } catch {
        /* no prior backup: the common case */
      }
      try {
        beforeSha256.set(normalizeExifPath(filePath), await sha256File(filePath));
      } catch {
        /* a missing file surfaces as a per-file write failure */
      }
      if (warnings.length > 0) fileWarnings.set(filePath, warnings);
    }

    for (const folder of folders) {
      if (!(await WriteLock.folderIsWritable(folder))) {
        blockers.push(`The folder is not writable: ${folder}`);
      }
    }
    if (freeBytes !== undefined && estimatedBytesRequired > freeBytes) {
      blockers.push(
        `Not enough free space: about ${Math.ceil(estimatedBytesRequired / (1024 * 1024))} MB is needed, ${Math.floor(freeBytes / (1024 * 1024))} MB is free.`,
      );
    }

    // ---- read current values -------------------------------------------------
    const before = await this.readTagValues(files, affectedTags);

    // ---- simulate per collision-free chunk -----------------------------------
    const chunks = planChunks(files, this.chunkSize);
    const diffs = new Map<string, TagDiff[]>();
    const expectedAfter = new Map<string, Record<string, string>>();
    const scratchRoot = path.join(this.dataDir, 'scratch', previewId);
    const diffNotes: string[] = [];

    try {
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i] as string[];
        const scratchDir = path.join(scratchRoot, `chunk${i}`);
        await mkdir(scratchDir, { recursive: true });
        const sim = await this.simulateChunk(chunk, editArgv, scratchDir);

        // Attribute engine errors per file via the -efile1 manifest.
        const failedFiles = new Set(sim.errors.map(normalizeExifPath));
        for (const filePath of chunk) {
          if (failedFiles.has(normalizeExifPath(filePath))) {
            const warnings = fileWarnings.get(filePath) ?? [];
            warnings.push(
              `The engine could not apply this edit to this file in simulation${sim.errorText ? `: ${sim.errorText}` : '.'}`,
            );
            fileWarnings.set(filePath, warnings);
          }
        }

        // Diff original vs scratch per file.
        const scratchPaths = chunk.map((f) => path.join(scratchDir, path.basename(f)));
        const after = await this.readTagValues(scratchPaths, affectedTags);
        for (let j = 0; j < chunk.length; j += 1) {
          const filePath = chunk[j] as string;
          const scratchPath = scratchPaths[j] as string;
          const beforeValues = before.get(normalizeExifPath(filePath)) ?? {};
          const afterValues = after.get(normalizeExifPath(scratchPath)) ?? {};
          const fileDiffs: TagDiff[] = [];
          const simulated: Record<string, string> = {};
          for (const tag of affectedTags) {
            const beforeValue = beforeValues[tag];
            const afterValue = afterValues[tag];
            if (beforeValue === undefined && afterValue === undefined) continue;
            let kind: TagDiff['kind'];
            if (beforeValue === undefined) kind = 'create';
            else if (afterValue === undefined) kind = 'delete';
            else if (beforeValue === afterValue) kind = 'unchanged';
            else kind = 'change';
            fileDiffs.push({
              tag,
              ...(beforeValue !== undefined ? { before: beforeValue } : {}),
              ...(afterValue !== undefined ? { after: afterValue } : {}),
              kind,
            });
            if (afterValue !== undefined) simulated[tag] = afterValue;
          }
          diffs.set(filePath, fileDiffs);
          expectedAfter.set(filePath, simulated);
        }

        // The engine's own -diff pass as a second opinion (best effort).
        diffNotes.push(...(await this.runDiffPass(chunk, scratchDir)));
      }
    } finally {
      await rm(scratchRoot, { recursive: true, force: true }).catch(() => undefined);
    }

    // ---- freeze the exact execute argv ---------------------------------------
    const manifestDir = path.join(this.dataDir, 'write-tmp', previewId);
    const commandPreview = [
      ...COMMON_WRITE_FLAGS,
      ...editArgv,
      '-efile1',
      path.join(manifestDir, 'chunk0-err.txt'),
      '-efile2',
      path.join(manifestDir, 'chunk0-same.txt'),
      '-efile8',
      path.join(manifestDir, 'chunk0-upd.txt'),
      ...(chunks[0] as string[]),
    ];

    const previewFiles: WritePreviewFile[] = files.map((filePath) => {
      const fileDiffs = diffs.get(filePath) ?? [];
      return {
        filePath,
        diffs: fileDiffs,
        argv: [...COMMON_WRITE_FLAGS, ...editArgv, filePath],
        warnings: fileWarnings.get(filePath) ?? [],
        noop: fileDiffs.every((d) => d.kind === 'unchanged'),
      };
    });

    const preview: WritePreview = {
      previewId,
      planId,
      files: previewFiles,
      ...(freeBytes !== undefined ? { freeBytes } : {}),
      estimatedBytesRequired,
      blockers,
      createdAt: new Date().toISOString(),
    };

    this.store({
      id: previewId,
      planId,
      createdAtMs: Date.now(),
      files,
      edits: [...request.edits],
      chunks,
      editArgv,
      commandPreview,
      manifestDir,
      before,
      expectedAfter,
      diffs,
      beforeSha256,
      preOriginalSha256,
      fileWarnings,
      destructive: request.destructive
        ? {
            scope: request.destructive.scope,
            confirmationPhrase: request.destructive.confirmationPhrase,
            allowedDeleteTags: [...request.destructive.allowedDeleteTags],
          }
        : null,
      restoreTags: request.restore !== undefined ? [...request.restore.allowedTags] : null,
      mode: request.mode ?? 'edit',
      description: request.description ?? `Write ${request.edits.length} edit(s) to ${files.length} file(s)`,
      ...(request.timezone !== undefined ? { timezone: request.timezone } : {}),
      ...(request.undoOfBatchId !== undefined ? { undoOfBatchId: request.undoOfBatchId } : {}),
      ...(request.scrubId !== undefined ? { scrubId: request.scrubId } : {}),
    });

    return { preview, commandPreview, diffNotes, writeUnlocked: this.isWriteUnlocked() };
  }

  /** Attach the mandatory pre-write export to a destructive preview. */
  setDestructiveExport(previewId: string, exportPath: string): void {
    const stored = this.previews.get(previewId);
    if (stored === undefined || stored.destructive === null) {
      throw new WritePipelineError('preview_required', `Preview "${previewId}" is not a destructive flow.`);
    }
    stored.destructive = { ...stored.destructive, exportPath };
  }

  getPreview(previewId: string): StoredPreview | null {
    return this.previews.get(previewId) ?? null;
  }

  // ---- execute --------------------------------------------------------------

  /**
   * Phase 2: journal intent, then write in default backup mode with manifest
   * classification, backup verification, and re-read verification. Requires a
   * live preview id, an unlocked session, and the single-writer lock.
   */
  async execute(previewId: string, options: ExecuteOptions = {}): Promise<ExecuteResult> {
    const stored = this.previews.get(previewId);
    if (stored === undefined) {
      throw new WritePipelineError(
        'preview_required',
        'No live preview was found for this write. Preview the changes first; nothing was written.',
      );
    }

    if (!this.isWriteUnlocked()) {
      throw new WritePipelineError(
        'read_only_mode',
        'Writing is locked. MetaDesk starts read-only; unlock writing for this session first. Nothing was written.',
      );
    }

    if (stored.destructive !== null) {
      const confirmed = options.destructive?.confirmationPhrase;
      if (confirmed !== stored.destructive.confirmationPhrase) {
        throw new WritePipelineError(
          'destructive_confirmation_required',
          `This is a destructive operation. Type "${stored.destructive.confirmationPhrase}" to confirm. Nothing was written.`,
          { scope: stored.destructive.scope },
        );
      }
      // Defense in depth: re-validate every destructive edit at execute time.
      buildDestructiveDeleteArgs(stored.edits, stored.destructive.allowedDeleteTags);
      const exportPath = stored.destructive.exportPath;
      if (typeof exportPath !== 'string' || exportPath.length === 0) {
        throw new WritePipelineError(
          'destructive_confirmation_required',
          'The pre-write export of the values being removed has not been produced. Nothing was written.',
        );
      }
      try {
        const { readFile } = await import('node:fs/promises');
        await readFile(exportPath, 'utf8');
      } catch {
        throw new WritePipelineError(
          'destructive_confirmation_required',
          'The pre-write export file is missing; refusing to run a destructive write without it.',
          { exportPath },
        );
      }
    } else if (options.destructive !== undefined) {
      throw new WritePipelineError(
        'validation',
        'This preview is not a destructive flow; no confirmation is required (or accepted).',
      );
    }
    if (stored.restoreTags !== null) {
      // Defense in depth: re-validate the restore edits against the original
      // destructive batch's tag list at execute time, exactly as at preview.
      buildDestructiveRestoreArgs(stored.edits, stored.restoreTags);
    }

    const batchId = newRecordId('wb');
    const startedAt = new Date().toISOString();
    const folders = [...new Set(stored.files.map((f) => path.dirname(f)))];
    const release = await this.lock.acquire(folders, batchId).catch((error: unknown) => {
      throw new WritePipelineError('write_locked', error instanceof Error ? error.message : String(error), {
        reason: error instanceof Error ? (error as Error & { code?: string }).code ?? null : null,
      });
    });
    this.activeBatches.add(batchId);
    // A cancel request left over from an earlier batch with a colliding id
    // cannot exist (ids are unique), but clear defensively on entry.
    this.cancelFlags.delete(batchId);

    const outcomes: WriteOutcome[] = [];
    const total = stored.files.length;
    const onProgress = options.onProgress ?? (() => undefined);
    const affectedTags = [...new Set(stored.edits.map((e) => e.tag))];
    const consistencyNotes: string[] = [];

    try {
      await mkdir(stored.manifestDir, { recursive: true });
      await this.journal.recordBatchStart({
        batchId,
        mode: stored.mode,
        description: stored.description,
        files: [...stored.files],
        argv: stored.commandPreview,
        edits: stored.edits,
        ...(stored.destructive !== null
          ? {
              destructive: {
                scope: stored.destructive.scope,
                confirmationPhrase: stored.destructive.confirmationPhrase,
                exportPath: stored.destructive.exportPath as string,
              },
            }
          : {}),
        ...(stored.timezone !== undefined ? { timezone: stored.timezone } : {}),
        ...(stored.undoOfBatchId !== undefined ? { undoOfBatchId: stored.undoOfBatchId } : {}),
        ...(stored.scrubId !== undefined ? { scrubId: stored.scrubId } : {}),
      });

      for (const filePath of stored.files) {
        const key = normalizeExifPath(filePath);
        await this.journal.recordIntent({
          batchId,
          filePath,
          edits: stored.edits,
          before: stored.before.get(key) ?? {},
          expectedAfter: stored.expectedAfter.get(filePath) ?? {},
          diffs: stored.diffs.get(filePath) ?? [],
          ...(stored.beforeSha256.has(key) ? { beforeSha256: stored.beforeSha256.get(key) } : {}),
          ...(stored.preOriginalSha256.has(key)
            ? { preOriginalSha256: stored.preOriginalSha256.get(key) }
            : {}),
        });
      }
      onProgress({ batchId, phase: 'intent', index: 0, total });

      let cancelRequested = false;
      let cancelledAt: string | undefined;

      for (let i = 0; i < stored.chunks.length; i += 1) {
        // Cooperative cancel (POST /api/write/cancel): honored only BETWEEN
        // chunks. An in-flight chunk always finishes — exiftool is never
        // interrupted mid-file, so every written file keeps a full, verified
        // result and no file is ever left half-written by a cancel.
        if (this.cancelFlags.has(batchId)) {
          cancelRequested = true;
          cancelledAt = new Date().toISOString();
          break;
        }
        const chunk = stored.chunks[i] as string[];
        const mErr = path.join(stored.manifestDir, `chunk${i}-err.txt`);
        const mSame = path.join(stored.manifestDir, `chunk${i}-same.txt`);
        const mUpd = path.join(stored.manifestDir, `chunk${i}-upd.txt`);
        const argv = [
          ...COMMON_WRITE_FLAGS,
          ...stored.editArgv,
          '-efile1',
          mErr,
          '-efile2',
          mSame,
          '-efile8',
          mUpd,
          ...chunk,
        ];

        onProgress({ batchId, phase: 'write', index: i * this.chunkSize, total });
        const result = await this.engine.run(argv, { timeoutMs: 60_000 + chunk.length * 1_000 }).catch(
          (error: unknown): {
            stdout: string;
            stderr: string;
            json: unknown[];
            diagnostics: never[];
            executeNumber: number;
          } => {
            // Protocol-level failure (session died): every file in the chunk
            // fails honestly; nothing is assumed written.
            const message = error instanceof Error ? error.message : String(error);
            return { stdout: '', stderr: message, json: [], diagnostics: [], executeNumber: -1 };
          },
        );

        const summary = parseSummary(`${result.stdout}\n${result.stderr}`);
        const manifests = {
          errors: await readManifest(mErr),
          unchanged: await readManifest(mSame),
          updated: await readManifest(mUpd),
        };
        consistencyNotes.push(...summarizeConsistency(summary, manifests));
        const classified = classifyFiles(chunk, manifests);
        const statusByKey = new Map<string, 'updated' | 'unchanged' | 'failed'>();
        for (const c of classified) statusByKey.set(normalizeExifPath(c.filePath), c.status);

        // Backup verification BEFORE any success may be claimed (req #4).
        const updatedFiles = chunk.filter((f) => statusByKey.get(normalizeExifPath(f)) === 'updated');
        const backupOk = new Map<string, BackupRecord>();
        const backupProblem = new Map<string, string>();
        for (const filePath of updatedFiles) {
          const key = normalizeExifPath(filePath);
          const backupPath = `${filePath}_original`;
          const expectedHash =
            stored.preOriginalSha256.get(key) ?? stored.beforeSha256.get(key);
          try {
            const info = await stat(backupPath);
            const actualHash = await sha256File(backupPath);
            if (expectedHash === undefined) {
              backupProblem.set(filePath, 'No before-hash was captured for this file, so the backup cannot be verified.');
            } else if (actualHash !== expectedHash) {
              backupProblem.set(
                filePath,
                'The _original backup does not hold the pre-edit bytes this run captured, so the write cannot be treated as backed up.',
              );
            } else {
              backupOk.set(filePath, {
                path: backupPath,
                sizeBytes: info.size,
                sha256: actualHash,
                createdAt: new Date().toISOString(),
              });
            }
          } catch {
            backupProblem.set(filePath, 'The _original backup file is missing after the write; the write cannot be marked verified.');
          }
        }

        // Re-read verification: the written file must match the preview (req #6).
        const verifyTargets = updatedFiles.filter((f) => backupOk.has(f));
        const reread = await this.readTagValues(verifyTargets, affectedTags);
        const forcedFailures = new Set(
          (options.faultInjection?.failVerificationFor ?? []).map(normalizeExifPath),
        );

        for (const filePath of chunk) {
          const key = normalizeExifPath(filePath);
          const status = statusByKey.get(key) ?? 'failed';
          const fallback = !classified.some((c) => normalizeExifPath(c.filePath) === key);
          const warnings: string[] = [];
          const errors: string[] = [];
          let outcomeStatus: WriteOutcome['status'] = status;
          let stage: WriteOutcome['stage'] | undefined = status === 'failed' ? 'write' : undefined;
          let backup: BackupRecord | undefined;
          let verified: boolean | undefined;

          if (status === 'failed') {
            errors.push(
              fallback
                ? 'The engine reported no result for this file (it appears in none of the result manifests), so it is counted as failed.'
                : 'The engine reported an error for this file.',
            );
            if (result.stderr.length > 0) errors.push(result.stderr.trim());
          } else if (status === 'updated') {
            const record = backupOk.get(filePath);
            if (record !== undefined) {
              backup = record;
            } else {
              outcomeStatus = 'failed';
              stage = 'backup';
              errors.push(
                backupProblem.get(filePath) ?? 'The backup could not be verified, so this file is not marked as safely updated.',
              );
            }
          }

          if (outcomeStatus === 'updated') {
            if (forcedFailures.has(key)) {
              outcomeStatus = 'failed';
              stage = 'verify';
              errors.push(
                'Verification failed: the file after writing does not match the preview that was approved.',
              );
            } else {
              const expected = stored.expectedAfter.get(filePath) ?? {};
              const actual = reread.get(key) ?? {};
              const mismatch = this.compareExpected(expected, actual);
              if (mismatch.length > 0) {
                outcomeStatus = 'failed';
                stage = 'verify';
                errors.push(`After writing, the file does not show the previewed values (${mismatch.join('; ')}).`);
              } else {
                verified = true;
              }
            }
          }

          for (const diagnostic of result.diagnostics) {
            if (diagnostic.severity === 'warning' || diagnostic.severity === 'minor') {
              warnings.push(diagnostic.message);
            }
          }

          outcomes.push({
            filePath,
            status: outcomeStatus,
            warnings,
            errors,
            ...(backup !== undefined ? { backup } : {}),
            ...(verified !== undefined ? { verified } : {}),
            ...(stage !== undefined ? { stage } : {}),
          });
        }

        for (const outcome of outcomes.slice(outcomes.length - chunk.length)) {
          await this.journal.recordResult({ batchId, filePath: outcome.filePath, outcome });
        }
        onProgress({
          batchId,
          phase: 'verify',
          index: Math.min((i + 1) * this.chunkSize, total),
          total,
        });
      }

      // Cancelled batches: every unprocessed file gets an explicit, honest
      // not-attempted result (journal-recorded like any other outcome) — the
      // three-valued status stays intact via `status: 'unchanged'` (nothing on
      // disk changed) with the additive notAttempted flags carrying the state.
      if (cancelRequested) {
        const attempted = new Set(outcomes.map((o) => normalizeExifPath(o.filePath)));
        for (const filePath of stored.files) {
          if (attempted.has(normalizeExifPath(filePath))) continue;
          const outcome: WriteOutcomeWithNotAttempted = {
            filePath,
            status: 'unchanged',
            warnings: [],
            errors: [],
            notAttempted: true,
            notAttemptedReason:
              'The batch was cancelled before this file was attempted. Nothing was read from or written to it; preview again to include it.',
          };
          outcomes.push(outcome);
          await this.journal.recordResult({ batchId, filePath, outcome });
        }
      }

      const counts = {
        updated: outcomes.filter((o) => o.status === 'updated').length,
        unchanged: outcomes.filter((o) => o.status === 'unchanged').length,
        failed: outcomes.filter((o) => o.status === 'failed').length,
      };
      const allVerified =
        outcomes.length > 0 && outcomes.every((o) => o.status === 'updated' && o.verified === true);
      const notAttemptedFiles = cancelRequested
        ? outcomes
            .filter((o): o is WriteOutcomeWithNotAttempted => (o as WriteOutcomeWithNotAttempted).notAttempted === true)
            .map((o) => o.filePath)
        : [];
      const finishedAt = new Date().toISOString();
      const base: BatchOutcome = {
        batchId,
        startedAt,
        finishedAt,
        files: outcomes,
        ...counts,
        allVerified,
        retryFilePaths: retryList(outcomes),
      };
      let outcome = base;
      if (cancelRequested) {
        const cancelledOutcome: CancelledBatchOutcome = {
          ...base,
          cancelled: true,
          cancelledAt: cancelledAt as string,
          notAttempted: notAttemptedFiles.length,
          notAttemptedFilePaths: notAttemptedFiles,
        };
        outcome = cancelledOutcome;
      }
      await this.journal.recordBatchEnd({ batchId, summary: { ...counts, allVerified } });
      onProgress({ batchId, phase: 'done', index: total, total });

      this.previews.delete(previewId);
      return { outcome, commandPreview: stored.commandPreview, consistencyNotes };
    } finally {
      this.activeBatches.delete(batchId);
      this.cancelFlags.delete(batchId);
      await rm(stored.manifestDir, { recursive: true, force: true }).catch(() => undefined);
      await release.release();
    }
  }

  // ---- cancel ---------------------------------------------------------------

  /**
   * Request a cooperative cancel of a running batch. The flag is honored only
   * BETWEEN chunks: the in-flight chunk always finishes (exiftool is never
   * interrupted mid-file), already-written files keep their verified results,
   * and unprocessed files are reported as not attempted.
   */
  requestCancel(batchId: string): { requested: boolean; note: string } {
    if (!this.activeBatches.has(batchId)) {
      return {
        requested: false,
        note: 'No write batch with this id is running right now (it may already have finished, or the id is wrong). Nothing was cancelled and nothing was changed.',
      };
    }
    this.cancelFlags.add(batchId);
    return {
      requested: true,
      note: 'Cancel requested. The file currently being written finishes safely with its full verification; the remaining files are not attempted.',
    };
  }

  // ---- undo -----------------------------------------------------------------

  /**
   * Per-step metadata undo (reverse writes from journal before-values) for a
   * completed batch. Because each file's before-values differ, this fans out
   * into one full-safety preview+execute per distinct reverse-edit set.
   * Undoing the same batch twice is refused: the second undo would re-apply
   * the change.
   */
  async undoBatch(
    batchId: string,
    options: ExecuteOptions = {},
  ): Promise<{ results: ExecuteResult[]; previews: WritePreview[] }> {
    const { plan, start } = await this.prepareUndoPlan(batchId);
    const groups = groupByEditSet(plan);
    const results: ExecuteResult[] = [];
    const previews: WritePreview[] = [];
    for (const group of groups) {
      const envelope = await this.preview({
        files: group.map((p) => p.filePath),
        edits: group[0]?.edits ?? [],
        mode: 'undo',
        description: `Undo batch ${batchId}`,
        undoOfBatchId: batchId,
        ...(start?.destructive !== undefined ? { restore: { allowedTags: destructiveBatchTags(start) } } : {}),
      });
      previews.push(envelope.preview);
      results.push(await this.execute(envelope.preview.previewId, options));
    }
    return { results, previews };
  }

  /**
   * The preview-only half of undo (the "what will this restore?" step the UI
   * shows before the user confirms). Throws the same errors as `undoBatch`.
   */
  async prepareUndo(batchId: string): Promise<PreviewEnvelope> {
    const { plan, start } = await this.prepareUndoPlan(batchId);
    const groups = groupByEditSet(plan);
    const first = groups[0];
    if (first === undefined) {
      throw new WritePipelineError('undo_unavailable', 'The undo plan is empty.');
    }
    return this.preview({
      files: first.map((p) => p.filePath),
      edits: first[0]?.edits ?? [],
      mode: 'undo',
      description: `Undo batch ${batchId}`,
      undoOfBatchId: batchId,
      ...(start?.destructive !== undefined ? { restore: { allowedTags: destructiveBatchTags(start) } } : {}),
    });
  }

  private async prepareUndoPlan(batchId: string): Promise<{
    plan: Array<{ filePath: string; edits: TagEdit[] }>;
    start: BatchStartRecord | null;
  }> {
    const { records } = await this.journal.readBatch(batchId);
    if (records.length === 0) {
      throw new WritePipelineError('undo_unavailable', `No journal records exist for batch "${batchId}".`);
    }
    const alreadyUndone = await this.findUndoBatch(batchId);
    if (alreadyUndone !== null) {
      throw new WritePipelineError(
        'already_undone',
        'This batch has already been undone. Undoing it a second time would re-apply the change.',
        { undoBatchId: alreadyUndone },
      );
    }
    const plan = await this.journal.undoPlan(batchId);
    if (plan.length === 0) {
      throw new WritePipelineError(
        'undo_unavailable',
        'This batch has no files that can be undone (nothing was updated, or no before-values were recorded).',
      );
    }
    const start = records.find((r): r is BatchStartRecord => r.kind === 'batch-start') ?? null;
    // A destructive batch's reverse edits may restore tags OUTSIDE the curated
    // human-fields whitelist (GPS strips especially). They ride the
    // journal-sourced restore path: tags restricted to the original batch's
    // own validated edit list, values sourced from journal before-values.
    if (start?.destructive !== undefined) {
      const allowed = new Set(destructiveBatchTags(start).map((t) => t.toLowerCase()));
      const stray = plan
        .flatMap((entry) => entry.edits.map((edit) => edit.tag))
        .find((tag) => !allowed.has(tag.toLowerCase()));
      if (stray !== undefined) {
        throw new WritePipelineError(
          'undo_unavailable',
          `The journal for this destructive batch contains a record for "${stray}", which was not part of the batch's approved edit list. Undo is refused; run the recovery scan instead.`,
          { tag: stray },
        );
      }
    }
    return { plan, start };
  }

  /** Find a completed batch that undid the given batch, if any. */
  async findUndoBatch(batchId: string): Promise<string | null> {
    for (const candidate of await this.journal.listBatchIds(200)) {
      const { records } = await this.journal.readBatch(candidate);
      const start = records.find(
        (r): r is Extract<(typeof records)[number], { kind: 'batch-start' }> => r.kind === 'batch-start',
      );
      if (start?.mode === 'undo' && start.undoOfBatchId === batchId) {
        const end = records.find((r) => r.kind === 'batch-end');
        if (end !== undefined) return candidate;
      }
    }
    return null;
  }

  // ---- internals --------------------------------------------------------------

  private store(stored: StoredPreview): void {
    this.previews.set(stored.id, stored);
    const now = Date.now();
    for (const [id, preview] of this.previews) {
      if (preview.createdAtMs < now - this.previewTtlMs) this.previews.delete(id);
    }
    while (this.previews.size > MAX_STORED_PREVIEWS) {
      const oldest = [...this.previews.values()].sort((a, b) => a.createdAtMs - b.createdAtMs)[0];
      if (oldest === undefined) break;
      this.previews.delete(oldest.id);
    }
  }

  private sanitizeFiles(input: readonly string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of input) {
      const safe = assertSafePath(raw);
      const key = normalizeExifPath(safe);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(safe);
    }
    return out;
  }

  /**
   * Simulate one chunk onto scratch copies with `-o` (originals untouched).
   * Returns the -efile manifest contents for per-file attribution.
   */
  private async simulateChunk(
    chunk: readonly string[],
    editArgv: readonly string[],
    scratchDir: string,
  ): Promise<{ errors: string[]; unchanged: string[]; created: string[]; errorText: string }> {
    const mErr = path.join(scratchDir, 'sim-err.txt');
    const mSame = path.join(scratchDir, 'sim-same.txt');
    const mCreated = path.join(scratchDir, 'sim-created.txt');
    const argv = [
      ...COMMON_WRITE_FLAGS,
      ...editArgv,
      '-efile1',
      mErr,
      '-efile2',
      mSame,
      '-efile16',
      mCreated,
      '-o',
      scratchDir,
      ...chunk,
    ];
    const result = await this.engine.run(argv, { timeoutMs: 60_000 + chunk.length * 1_000 });
    const summary = parseSummary(result.stdout);
    const errorText =
      result.diagnostics
        .filter((d) => d.severity === 'error')
        .map((d) => d.message)
        .join('; ') || (summary.notUpdatedDueToErrors > 0 ? `${summary.notUpdatedDueToErrors} file(s) had errors` : '');
    return {
      errors: await readManifest(mErr),
      unchanged: await readManifest(mSame),
      created: await readManifest(mCreated),
      errorText,
    };
  }

  /** The engine's own `-diff` pass between originals and scratch copies. */
  private async runDiffPass(chunk: readonly string[], scratchDir: string): Promise<string[]> {
    try {
      const result = await this.engine.run(
        ['-a', '-G1', ...chunk, '-diff', path.join(scratchDir, '%f.%e'), '--system:all'],
        { timeoutMs: 60_000 },
      );
      return result.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .slice(0, 200);
    } catch {
      return [];
    }
  }

  /** Read the requested tags for a batch of paths, keyed by requested tag name. */
  private async readTagValues(
    paths: readonly string[],
    tags: readonly string[],
  ): Promise<Map<string, Record<string, string>>> {
    const out = new Map<string, Record<string, string>>();
    for (let offset = 0; offset < paths.length; offset += READ_BATCH) {
      const batch = paths.slice(offset, offset + READ_BATCH);
      const argv = buildJsonReadArgs(batch, { tags });
      const result = await this.engine.run(argv, {
        json: true,
        timeoutMs: 60_000 + batch.length * 500,
      });
      const byPath = new Map<string, Record<string, unknown>>();
      for (const doc of result.json as Array<Record<string, unknown>>) {
        const source = doc['SourceFile'];
        if (typeof source === 'string') byPath.set(normalizeExifPath(source), doc);
      }
      for (const requested of batch) {
        const doc = byPath.get(normalizeExifPath(requested));
        const values: Record<string, string> = {};
        if (doc !== undefined) {
          for (const tag of tags) {
            for (const [key, value] of Object.entries(doc)) {
              if (key === 'SourceFile') continue;
              if (!matchesTagKey(key, tag)) continue;
              const flattened = flattenValue(value);
              if (flattened !== undefined) {
                values[tag] = flattened;
                break;
              }
            }
          }
        }
        out.set(normalizeExifPath(requested), values);
      }
    }
    return out;
  }

  /**
   * Compare expected (previewed) values against a re-read. Returns a list of
   * human-readable mismatches; empty means verified.
   */
  private compareExpected(
    expected: Record<string, string>,
    actual: Record<string, string>,
  ): string[] {
    const mismatches: string[] = [];
    for (const [tag, expectedValue] of Object.entries(expected)) {
      const actualValue = actual[tag];
      if (actualValue === undefined) {
        mismatches.push(`${tag} is missing after the write (expected "${truncateValue(expectedValue)}")`);
      } else if (actualValue !== expectedValue) {
        mismatches.push(
          `${tag} reads back "${truncateValue(actualValue)}" but the preview showed "${truncateValue(expectedValue)}"`,
        );
      }
    }
    // Affected tags that should be gone must genuinely be gone.
    for (const [tag, actualValue] of Object.entries(actual)) {
      if (!(tag in expected) && actualValue.length > 0) {
        mismatches.push(`${tag} is present after the write but the preview removed it`);
      }
    }
    return mismatches;
  }
}

function truncateValue(value: string): string {
  return value.length > 60 ? `${value.slice(0, 57)}...` : value;
}

/**
 * The destructive-flow argument builder: bare deletes ONLY
 * (`-GROUP:Tag=`), one per tag, validated against the caller's compile-time
 * whitelist. Reuses the engine gates (shape, overwrite rejection, argv
 * safety) so nothing here can become grammar or an option.
 */
export function buildDestructiveDeleteArgs(
  edits: readonly TagEdit[],
  allowedDeleteTags: readonly string[],
): string[] {
  if (edits.length === 0) {
    throw new WritePipelineError('validation', 'A destructive flow needs at least one tag to remove.');
  }
  const allowed = new Set(allowedDeleteTags.map((t) => t.toLowerCase()));
  const argv: string[] = [];
  for (const edit of edits) {
    if (edit.op !== 'delete') {
      throw new WritePipelineError(
        'validation',
        'Destructive flows may only delete tags; nothing else is accepted on this path.',
        { tag: edit.tag, op: edit.op },
      );
    }
    if (!isValidTagShape(edit.tag) || edit.tag.split(':').pop()?.toLowerCase() === 'all') {
      throw new WritePipelineError('validation', `"${edit.tag}" is not a valid tag name.`, {
        tag: edit.tag,
      });
    }
    if (!allowed.has(edit.tag.toLowerCase())) {
      throw new WritePipelineError(
        'validation',
        `"${edit.tag}" is not in this destructive flow's approved tag list.`,
        { tag: edit.tag },
      );
    }
    argv.push(`-${edit.tag}=`);
  }
  assertNoOverwriteArgs(argv);
  assertArgsSafe(argv);
  return argv;
}

/**
 * The journal-sourced RESTORE builder for undoing a destructive batch: `set`
 * restores (`-GROUP:Tag=value`, values straight from journal before-values)
 * plus bare deletes for anything the batch created. Every tag must appear in
 * the ORIGINAL batch's own edit list, so the restore path can never write a
 * tag the destructive flow was not approved for. Routes never accept this
 * shape from callers — only `undoBatch`/`prepareUndo` produce it, from the
 * journal.
 */
export function buildDestructiveRestoreArgs(
  edits: readonly TagEdit[],
  allowedTags: readonly string[],
): string[] {
  if (edits.length === 0) {
    throw new WritePipelineError('validation', 'A restore needs at least one edit.');
  }
  const allowed = new Set(allowedTags.map((t) => t.toLowerCase()));
  const argv: string[] = [];
  for (const edit of edits) {
    if (!isValidTagShape(edit.tag)) {
      throw new WritePipelineError('validation', `"${edit.tag}" is not a valid tag name.`, {
        tag: edit.tag,
      });
    }
    if (!allowed.has(edit.tag.toLowerCase())) {
      throw new WritePipelineError(
        'validation',
        `"${edit.tag}" was not part of the original batch's approved edit list, so it cannot be restored.`,
        { tag: edit.tag },
      );
    }
    if (edit.op === 'delete') {
      if (edit.value !== undefined && edit.value.length > 0) {
        throw new WritePipelineError('validation', 'A delete edit takes no value.', { tag: edit.tag });
      }
      argv.push(`-${edit.tag}=`);
    } else if (edit.op === 'set') {
      const value = edit.value ?? '';
      if (value.length === 0) {
        throw new WritePipelineError(
          'validation',
          `"${edit.tag}" needs a before-value to restore; the journal record is incomplete.`,
          { tag: edit.tag },
        );
      }
      argv.push(`-${edit.tag}=${toValueSlot(value)}`);
    } else {
      throw new WritePipelineError(
        'validation',
        'Restores may only set or delete tags.',
        { tag: edit.tag, op: edit.op },
      );
    }
  }
  assertNoOverwriteArgs(argv);
  assertArgsSafe(argv);
  return argv;
}

/** The approved tag list of a destructive batch, from its batch-start record. */
function destructiveBatchTags(start: BatchStartRecord): string[] {
  return [...new Set(start.edits.map((edit) => edit.tag))];
}

/**
 * Split files into chunks of at most `size`, never placing two files with the
 * same basename in one chunk (the engine keys scratch copies and `-diff` FMT
 * pairing by basename).
 */
export function planChunks(files: readonly string[], size: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  const basenames = new Set<string>();
  for (const filePath of files) {
    const base = path.basename(filePath).toLowerCase();
    if (current.length >= size || basenames.has(base)) {
      chunks.push(current);
      current = [];
      basenames.clear();
    }
    current.push(filePath);
    basenames.add(base);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

interface UndoPlanEntryLike {
  filePath: string;
  edits: TagEdit[];
}

/** Group undo entries by their reverse-edit set (JSON-keyed). */
function groupByEditSet(plan: readonly UndoPlanEntryLike[]): UndoPlanEntryLike[][] {
  const groups = new Map<string, UndoPlanEntryLike[]>();
  for (const entry of plan) {
    const key = JSON.stringify(entry.edits);
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [entry]);
    else list.push(entry);
  }
  return [...groups.values()];
}
