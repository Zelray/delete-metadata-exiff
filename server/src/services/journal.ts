/**
 * The JSONL write journal (app/data/journal/) — the product's memory of every
 * change to a user's photos, and the only path back from a mistake.
 *
 * Layout:
 *   <dataDir>/journal/batches/<batchId>.jsonl   one record per line, appended
 *                                               in order, flushed per line
 *   <dataDir>/journal/exports/<scrubId>.json    mandatory pre-write exports
 *                                               for destructive flows
 *   <dataDir>/journal/writer.lock               the single-writer lockfile
 *
 * Record order per batch (data-safety requirement #8, intent-before-execute):
 *   1. `batch-start`  — what is about to happen, before anything runs
 *   2. `intent`       — per file: edits, argv, captured BEFORE tag values,
 *                       before-hash of the file, per-tag diff kinds
 *   3. `result`       — per file: outcome, backup path/size/sha256, stderr,
 *                       re-read verification result
 *   4. `batch-end`    — summary; absent while a batch is in flight, which is
 *                       exactly how an interrupted batch is recognized
 *
 * Partial lines (power loss mid-append) are tolerated on read: they are
 * reported as corrupt-line counts, never crash the reader.
 *
 * Undo model (requirement #3 of the risk table): `_original` is a snapshot at
 * FIRST contact, not "last good state". Per-step metadata undo is therefore
 * computed from the journal's before-values ({@link Journal.computeUndo} —
 * reverse writes), while restoring `_original` itself is the explicitly
 * confirmed nuclear option that reverts everything since first contact.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, appendFile, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BackupRecord, BatchOutcome, TagDiff, TagEdit, WriteOutcome } from '@metadesk/shared';

export type JournalKind = 'batch-start' | 'intent' | 'result' | 'batch-end' | 'adopt';

/** The undo-relevant description of one file's intended write. */
export interface UndoPlanEntry {
  filePath: string;
  /** Reverse edits: restore the before-value, or delete what was created. */
  edits: TagEdit[];
  before: Record<string, string>;
}

export interface BatchStartRecord {
  kind: 'batch-start';
  id: string;
  batchId: string;
  timestamp: string;
  /** 'edit' | 'undo' | 'scrub' | 'adopt' */
  mode: string;
  /** Human-readable description of the batch. */
  description: string;
  /** File paths in batch order. */
  files: string[];
  /** The exact argv of the first execution chunk (the pinned commandPreview). */
  argv: string[];
  edits: TagEdit[];
  /** Present for destructive flows (GPS strip, AI scrub): the gates that were met. */
  destructive?: {
    scope: string;
    confirmationPhrase: string;
    exportPath: string;
  };
  /** Explicit timezone decision carried with date-shift edits (req #13). */
  timezone?: string;
  /** Original batch id, when this batch undoes another. */
  undoOfBatchId?: string;
  /** Scrub report id, when this batch is a metadata scrub. */
  scrubId?: string;
}

export interface IntentRecord {
  kind: 'intent';
  id: string;
  batchId: string;
  timestamp: string;
  filePath: string;
  edits: TagEdit[];
  /** The exact argv that will run for this file's chunk. */
  argv?: string[];
  /** Captured before-values of every affected tag (per-step undo source). */
  before: Record<string, string>;
  /** The previewed after-values; execution must reproduce these to verify. */
  expectedAfter: Record<string, string>;
  /** Per-tag diff kinds from the preview. */
  diffs: TagDiff[];
  /** sha256 of the file BEFORE this write (backup verification reference). */
  beforeSha256?: string;
  /** sha256 of a pre-existing `_original`, when this is a second-or-later edit. */
  preOriginalSha256?: string;
}

export interface ResultRecord {
  kind: 'result';
  id: string;
  batchId: string;
  timestamp: string;
  filePath: string;
  outcome: WriteOutcome;
}

export interface BatchEndRecord {
  kind: 'batch-end';
  id: string;
  batchId: string;
  timestamp: string;
  summary: Pick<BatchOutcome, 'updated' | 'unchanged' | 'failed' | 'allVerified'>;
  interrupted?: boolean;
  /** Set when a human marked an interrupted batch abandoned (recovery fix). */
  abandonedBy?: string;
}

/** `adopt` records an untracked `_original` the user chose to keep (recovery). */
export interface AdoptRecord {
  kind: 'adopt';
  id: string;
  batchId: string;
  timestamp: string;
  filePath: string;
  backup: BackupRecord;
  note?: string;
}

export type JournalRecord =
  | BatchStartRecord
  | IntentRecord
  | ResultRecord
  | BatchEndRecord
  | AdoptRecord;

export interface BatchHistory {
  batchId: string;
  startedAt: string | null;
  finishedAt: string | null;
  mode: string;
  description: string;
  /** true when the batch never wrote a batch-end record (or was marked abandoned). */
  interrupted: boolean;
  updated: number;
  unchanged: number;
  failed: number;
  /** Per-file outcomes from result records, in intent order. */
  outcomes: WriteOutcome[];
  /** Undo availability: true when reverse edits exist for at least one file. */
  undoable: boolean;
}

export interface BackupVerification {
  verified: boolean;
  /** sha256 actually read from disk, when the backup exists. */
  actualSha256?: string;
  actualSizeBytes?: number;
  /** Human-readable reason when not verified. */
  reason?: string;
}

export interface JournalOptions {
  dataDir: string;
}

let recordCounter = 0;

/** Monotonic, collision-free record id (ULID-ish, human-sortable). */
export function newRecordId(prefix: string): string {
  recordCounter = (recordCounter + 1) % 1_000_000;
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 0x7fffffff).toString(36);
  return `${prefix}_${t}${recordCounter.toString(36).padStart(4, '0')}${r}`;
}

export class Journal {
  readonly journalDir: string;
  readonly batchesDir: string;
  readonly exportsDir: string;

  constructor(options: JournalOptions) {
    this.journalDir = path.resolve(options.dataDir, 'journal');
    this.batchesDir = path.join(this.journalDir, 'batches');
    this.exportsDir = path.join(this.journalDir, 'exports');
  }

  batchPath(batchId: string): string {
    // batch ids are generated here; the guard is for defense in depth
    if (/[\\/]/.test(batchId) || batchId.length === 0 || batchId.length > 128) {
      throw new Error('Invalid batch id.');
    }
    return path.join(this.batchesDir, `${batchId}.jsonl`);
  }

  private async append(batchId: string, record: JournalRecord): Promise<void> {
    await mkdir(this.batchesDir, { recursive: true });
    const line = `${JSON.stringify(record)}\n`;
    // O_APPEND single-line writes: the journal survives power loss to the
    // last completed record.
    await appendFile(this.batchPath(batchId), line, 'utf8');
  }

  recordBatchStart(record: Omit<BatchStartRecord, 'kind' | 'id' | 'timestamp'>): Promise<void> {
    return this.append(record.batchId, {
      kind: 'batch-start',
      id: newRecordId('bs'),
      timestamp: new Date().toISOString(),
      ...record,
    });
  }

  recordIntent(record: Omit<IntentRecord, 'kind' | 'id' | 'timestamp'>): Promise<void> {
    return this.append(record.batchId, {
      kind: 'intent',
      id: newRecordId('in'),
      timestamp: new Date().toISOString(),
      ...record,
    });
  }

  recordResult(record: Omit<ResultRecord, 'kind' | 'id' | 'timestamp'>): Promise<void> {
    return this.append(record.batchId, {
      kind: 'result',
      id: newRecordId('rs'),
      timestamp: new Date().toISOString(),
      ...record,
    });
  }

  recordBatchEnd(record: Omit<BatchEndRecord, 'kind' | 'id' | 'timestamp'>): Promise<void> {
    return this.append(record.batchId, {
      kind: 'batch-end',
      id: newRecordId('be'),
      timestamp: new Date().toISOString(),
      ...record,
    });
  }

  recordAdopt(record: Omit<AdoptRecord, 'kind' | 'id' | 'timestamp'>): Promise<void> {
    return this.append(record.batchId, {
      kind: 'adopt',
      id: newRecordId('ad'),
      timestamp: new Date().toISOString(),
      ...record,
    });
  }

  /** Read every parseable record of one batch; corrupt lines are counted. */
  async readBatch(
    batchId: string,
  ): Promise<{ records: JournalRecord[]; corruptLines: number }> {
    let raw: string;
    try {
      raw = await readFile(this.batchPath(batchId), 'utf8');
    } catch {
      return { records: [], corruptLines: 0 };
    }
    const records: JournalRecord[] = [];
    let corruptLines = 0;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = JSON.parse(trimmed) as JournalRecord;
        if (typeof parsed === 'object' && parsed !== null && 'kind' in parsed) {
          records.push(parsed);
        } else {
          corruptLines += 1;
        }
      } catch {
        corruptLines += 1;
      }
    }
    return { records, corruptLines };
  }

  /** All batch ids on disk, newest first by the batch-start timestamp. */
  async listBatchIds(limit = 100): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.batchesDir);
    } catch {
      return [];
    }
    const batches = await Promise.all(
      names
        .filter((n) => n.endsWith('.jsonl'))
        .map(async (n) => {
          const batchId = n.slice(0, -'.jsonl'.length);
          const { records } = await this.readBatch(batchId);
          const start = records.find((r): r is BatchStartRecord => r.kind === 'batch-start');
          return { batchId, startedAt: start?.timestamp ?? '' };
        }),
    );
    return batches
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit)
      .map((b) => b.batchId);
  }

  /** Build the History view for one batch. */
  async batchHistory(batchId: string): Promise<BatchHistory | null> {
    const { records } = await this.readBatch(batchId);
    if (records.length === 0) return null;
    const start = records.find((r): r is BatchStartRecord => r.kind === 'batch-start') ?? null;
    const end = records.find((r): r is BatchEndRecord => r.kind === 'batch-end') ?? null;
    const intents = records.filter((r): r is IntentRecord => r.kind === 'intent');
    const results = records.filter((r): r is ResultRecord => r.kind === 'result');

    const outcomes: WriteOutcome[] = intents.map((intent) => {
      const result = results.find((r) => r.filePath === intent.filePath);
      return (
        result?.outcome ?? {
          filePath: intent.filePath,
          status: 'failed',
          warnings: [],
          errors: ['no completion record was written for this file (the batch was interrupted)'],
          stage: 'unknown',
        }
      );
    });

    const counts = {
      updated: outcomes.filter((o) => o.status === 'updated').length,
      unchanged: outcomes.filter((o) => o.status === 'unchanged').length,
      failed: outcomes.filter((o) => o.status === 'failed').length,
    };

    return {
      batchId,
      startedAt: start?.timestamp ?? null,
      finishedAt: end?.timestamp ?? null,
      mode: start?.mode ?? 'unknown',
      description: start?.description ?? '',
      interrupted: end === null || end.interrupted === true,
      ...counts,
      outcomes,
      undoable: this.computeUndo(intents, results).length > 0,
    };
  }

  /** Most recent batch that has a batch-end record (one-click undo target). */
  async latestCompletedBatchId(mode?: string): Promise<string | null> {
    for (const batchId of await this.listBatchIds(200)) {
      const { records } = await this.readBatch(batchId);
      const end = records.find((r): r is BatchEndRecord => r.kind === 'batch-end');
      if (end === undefined || end.interrupted === true) continue;
      if (mode !== undefined) {
        const start = records.find((r): r is BatchStartRecord => r.kind === 'batch-start');
        if (start?.mode !== mode) continue;
      }
      return batchId;
    }
    return null;
  }

  /**
   * Batches that started but never finished, plus the files still awaiting a
   * completion record. This is the interrupted-write detection the recovery
   * scanner and the startup check are built on.
   */
  async findInterruptedBatches(): Promise<
    Array<{ batchId: string; startedAt: string | null; pendingFiles: string[]; markedAbandoned: boolean }>
  > {
    const result: Array<{
      batchId: string;
      startedAt: string | null;
      pendingFiles: string[];
      markedAbandoned: boolean;
    }> = [];
    for (const batchId of await this.listBatchIds(200)) {
      const { records } = await this.readBatch(batchId);
      const start = records.find((r): r is BatchStartRecord => r.kind === 'batch-start');
      if (start === undefined) continue;
      const end = records.find((r): r is BatchEndRecord => r.kind === 'batch-end');
      const intents = records.filter((r): r is IntentRecord => r.kind === 'intent');
      const results = records.filter((r): r is ResultRecord => r.kind === 'result');
      const pending = intents
        .filter((i) => !results.some((r) => r.filePath === i.filePath))
        .map((i) => i.filePath);
      const incomplete = end === undefined || pending.length > 0;
      if (incomplete) {
        result.push({
          batchId,
          startedAt: start.timestamp,
          pendingFiles: pending,
          markedAbandoned: end?.interrupted === true,
        });
      }
    }
    return result;
  }

  /**
   * Reverse writes for one batch, computed from intent before-values (never
   * from `_original`, which is a first-contact snapshot). Only files whose
   * outcome was `updated` produce undo entries; tags whose previewed diff was
   * `unchanged` are skipped.
   */
  computeUndo(intents: IntentRecord[], results: ResultRecord[]): UndoPlanEntry[] {
    const plan: UndoPlanEntry[] = [];
    for (const intent of intents) {
      const result = results.find((r) => r.filePath === intent.filePath);
      if (result === undefined || result.outcome.status !== 'updated') continue;
      const edits: TagEdit[] = [];
      for (const diff of intent.diffs) {
        if (diff.kind === 'unchanged') continue;
        const hadBefore = Object.prototype.hasOwnProperty.call(intent.before, diff.tag);
        edits.push(
          hadBefore
            ? { tag: diff.tag, op: 'set', value: intent.before[diff.tag] as string }
            : { tag: diff.tag, op: 'delete' },
        );
      }
      if (edits.length > 0) {
        plan.push({ filePath: intent.filePath, edits, before: intent.before });
      }
    }
    return plan;
  }

  /** Convenience wrapper: undo plan for a stored batch. */
  async undoPlan(batchId: string): Promise<UndoPlanEntry[]> {
    const { records } = await this.readBatch(batchId);
    return this.computeUndo(
      records.filter((r): r is IntentRecord => r.kind === 'intent'),
      records.filter((r): r is ResultRecord => r.kind === 'result'),
    );
  }

  /**
   * Verify a backup record against the file actually on disk: existence,
   * size, and sha256 (data-safety requirement #4). Powers the Verified chips
   * in History.
   */
  async verifyBackup(record: BackupRecord): Promise<BackupVerification> {
    let actualSha256: string;
    let actualSizeBytes: number | undefined;
    try {
      actualSha256 = await sha256File(record.path);
      actualSizeBytes = (await stat(record.path)).size;
    } catch {
      return { verified: false, reason: `The backup file "${record.path}" is missing or unreadable.` };
    }
    if (actualSha256 !== record.sha256) {
      return {
        verified: false,
        actualSha256,
        actualSizeBytes,
        reason: 'The backup file no longer matches the hash recorded when it was created.',
      };
    }
    if (actualSizeBytes !== undefined && actualSizeBytes !== record.sizeBytes) {
      return {
        verified: false,
        actualSha256,
        actualSizeBytes,
        reason: 'The backup file size no longer matches the size recorded when it was created.',
      };
    }
    return { verified: true, actualSha256, actualSizeBytes };
  }

  /** Write the mandatory pre-write export for a destructive flow (req #14). */
  async writeScrubExport(
    scrubId: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    await mkdir(this.exportsDir, { recursive: true });
    if (/[\\/]/.test(scrubId) || scrubId.length === 0) {
      throw new Error('Invalid scrub id.');
    }
    const exportPath = path.join(this.exportsDir, `${scrubId}.json`);
    await writeFile(exportPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return exportPath;
  }
}

/** sha256 of a file, streamed (backups can be large). */
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
