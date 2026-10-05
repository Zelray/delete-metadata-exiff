/**
 * Recovery service (data-safety requirement #9): find the debris a dead
 * process or power cut leaves behind, and offer guided, explicitly confirmed
 * fixes. Nothing here runs without `confirm: true` on the fix action.
 *
 * What can be lying around after a crash:
 *  - `*_exiftool_tmp`    — the engine's transaction temp. A leftover one makes
 *                          every future write to that photo fail with
 *                          "Temporary file already exists" until it is
 *                          deleted (only ever after confirming no writer is
 *                          active).
 *  - `_original` without its photo — the rename-to-backup landed but the
 *                          tmp-rename never did. The backup IS the photo;
 *                          restoring it is a rename back.
 *  - untracked `_original` — a backup MetaDesk did not journal (an outside
 *                          tool wrote here, or the journal was lost). Surfaced
 *                          as a warning; the user can adopt it into the
 *                          journal or leave it.
 *  - interrupted batches — journal intents with no completion records. The
 *                          files are reconciled against disk; the batch is
 *                          marked abandoned once the user has seen it.
 *
 * The nuclear option — copying `_original` over the live file (reverting
 * EVERYTHING since first contact, not just the last batch) — is a guided fix
 * gated behind `confirm`, and every copy is verified by the journal's sha256
 * before and after.
 */
import { copyFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  Journal,
  sha256File,
  newRecordId,
  type BatchEndRecord,
  type IntentRecord,
  type ResultRecord,
} from './journal.js';
import { isPidAlive, WriteLock } from './lock.js';

export class RecoveryError extends Error {
  readonly code: 'confirmation_required' | 'not_found' | 'unsafe' | 'writer_active' | 'bad_request';
  readonly details: Record<string, unknown>;

  constructor(
    code: 'confirmation_required' | 'not_found' | 'unsafe' | 'writer_active' | 'bad_request',
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'RecoveryError';
    this.code = code;
    this.details = details;
  }
}

export interface OrphanTempFile {
  path: string;
  /** The photo the temp file was mid-transaction on. */
  targetPath: string;
}

export interface OriginalPair {
  backupPath: string;
  photoPath: string;
  /** sha256 from the journal when this backup is tracked; else null. */
  trackedSha256: string | null;
}

export interface FolderRecoveryReport {
  folder: string;
  orphanTempFiles: OrphanTempFile[];
  /** The backup exists but the photo itself is gone. */
  originalsWithoutPhoto: OriginalPair[];
  /** Both exist, but MetaDesk never journaled this backup. */
  untrackedOriginals: OriginalPair[];
}

export interface JournalRecoveryReport {
  interruptedBatches: Array<{
    batchId: string;
    startedAt: string | null;
    pendingFiles: string[];
    markedAbandoned: boolean;
  }>;
}

export interface RecoveryScanReport {
  scannedAt: string;
  folders: FolderRecoveryReport[];
  journal: JournalRecoveryReport;
  /** True when everything is clean (no fixes pending anywhere). */
  clean: boolean;
}

export type FixAction =
  | { action: 'delete-orphan-temp'; path: string; confirm: boolean }
  | { action: 'restore-original'; backupPath: string; confirm: boolean }
  | { action: 'adopt-original'; backupPath: string; photoPath: string; confirm: boolean }
  | { action: 'mark-batch-abandoned'; batchId: string; confirm: boolean }
  | { action: 'restore-originals-for-batch'; batchId: string; confirm: boolean };

export interface FixResult {
  action: string;
  /** What concretely happened, in plain English. */
  message: string;
  details: Record<string, unknown>;
}

export interface RecoveryServiceOptions {
  dataDir: string;
  journal?: Journal;
  lock?: WriteLock;
}

const TMP_SUFFIX = '_exiftool_tmp';
const BACKUP_SUFFIX = '_original';

export class RecoveryService {
  readonly journal: Journal;
  private readonly lock: WriteLock;

  constructor(options: RecoveryServiceOptions) {
    this.journal = options.journal ?? new Journal({ dataDir: options.dataDir });
    this.lock = options.lock ?? new WriteLock({ lockDir: this.journal.journalDir });
  }

  // ---- scanning -------------------------------------------------------------

  /** Scan target folders for write debris. Non-recursive, like a write batch. */
  async scanFolders(folders: readonly string[]): Promise<FolderRecoveryReport[]> {
    const trackedBackups = await this.collectTrackedBackups();
    const reports: FolderRecoveryReport[] = [];

    for (const folder of folders) {
      const orphanTempFiles: OrphanTempFile[] = [];
      const originalsWithoutPhoto: OriginalPair[] = [];
      const untrackedOriginals: OriginalPair[] = [];

      let names: string[];
      try {
        names = await readdirSafe(folder);
      } catch {
        reports.push({
          folder,
          orphanTempFiles,
          originalsWithoutPhoto,
          untrackedOriginals,
        });
        continue;
      }

      const nameSet = new Set(names);
      for (const name of names) {
        if (name.endsWith(TMP_SUFFIX)) {
          orphanTempFiles.push({
            path: path.join(folder, name),
            targetPath: path.join(folder, name.slice(0, -TMP_SUFFIX.length)),
          });
          continue;
        }
        if (name.endsWith(BACKUP_SUFFIX)) {
          const photoName = name.slice(0, -BACKUP_SUFFIX.length);
          const backupPath = path.join(folder, name);
          const photoPath = path.join(folder, photoName);
          const pair: OriginalPair = {
            backupPath,
            photoPath,
            trackedSha256: trackedBackups.get(normalize(backupPath)) ?? null,
          };
          if (!nameSet.has(photoName)) {
            originalsWithoutPhoto.push(pair);
          } else if (pair.trackedSha256 === null) {
            untrackedOriginals.push(pair);
          }
        }
      }

      reports.push({ folder, orphanTempFiles, originalsWithoutPhoto, untrackedOriginals });
    }
    return reports;
  }

  /** Interrupted batches: intents without completion outcomes (req #9). */
  async scanJournal(): Promise<JournalRecoveryReport> {
    return {
      interruptedBatches: await this.journal.findInterruptedBatches(),
    };
  }

  async scan(folders: readonly string[]): Promise<RecoveryScanReport> {
    const [foldersReport, journal] = await Promise.all([this.scanFolders(folders), this.scanJournal()]);
    const clean =
      journal.interruptedBatches.length === 0 &&
      foldersReport.every(
        (f) =>
          f.orphanTempFiles.length === 0 &&
          f.originalsWithoutPhoto.length === 0 &&
          f.untrackedOriginals.length === 0,
      );
    return {
      scannedAt: new Date().toISOString(),
      folders: foldersReport,
      journal,
      clean,
    };
  }

  // ---- fixes ------------------------------------------------------------------

  async fix(actionSpec: FixAction): Promise<FixResult> {
    if (actionSpec.confirm !== true) {
      throw new RecoveryError(
        'confirmation_required',
        'Recovery fixes change or delete files on disk. They run only with explicit confirmation ({"confirm": true}).',
      );
    }
    switch (actionSpec.action) {
      case 'delete-orphan-temp':
        return this.deleteOrphanTemp(actionSpec.path);
      case 'restore-original':
        return this.restoreOriginal(actionSpec.backupPath);
      case 'adopt-original':
        return this.adoptOriginal(actionSpec.backupPath, actionSpec.photoPath);
      case 'mark-batch-abandoned':
        return this.markBatchAbandoned(actionSpec.batchId);
      case 'restore-originals-for-batch':
        return this.restoreOriginalsForBatch(actionSpec.batchId);
      default: {
        const exhaustive: never = actionSpec;
        throw new RecoveryError('bad_request', `Unknown recovery action: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  /**
   * Delete an orphan engine temp file — ONLY after checking no writer is
   * active (lock not held in this process, no live lockfile on disk).
   */
  private async deleteOrphanTemp(targetPath: string): Promise<FixResult> {
    if (!targetPath.endsWith(TMP_SUFFIX)) {
      throw new RecoveryError('unsafe', 'Only *_exiftool_tmp files can be deleted by this fix.', {
        path: targetPath,
      });
    }
    await assertNoActiveWriter(this.lock);
    try {
      const info = await stat(targetPath);
      if (!info.isFile()) {
        throw new RecoveryError('unsafe', 'That path is not a regular file.', { path: targetPath });
      }
    } catch (error) {
      if (error instanceof RecoveryError) throw error;
      throw new RecoveryError('not_found', `The temp file does not exist: ${targetPath}`, {
        path: targetPath,
      });
    }
    await unlink(targetPath);
    return {
      action: 'delete-orphan-temp',
      message:
        'Deleted the leftover temporary file. Writes to this photo will work again. The photo itself was never touched by this cleanup.',
      details: { path: targetPath },
    };
  }

  /**
   * Restore a photo from its `_original` when the photo itself is missing:
   * the backup is renamed back into place. When the journal tracks this
   * backup, the restore is verified against the recorded hash first.
   */
  private async restoreOriginal(backupPath: string): Promise<FixResult> {
    if (!backupPath.endsWith(BACKUP_SUFFIX)) {
      throw new RecoveryError('unsafe', 'Only *_original backup files can be restored by this fix.', {
        backupPath,
      });
    }
    const photoPath = backupPath.slice(0, -BACKUP_SUFFIX.length);
    try {
      await stat(photoPath);
      throw new RecoveryError(
        'unsafe',
        'The photo already exists next to this backup. Restoring would overwrite it — that is the nuclear restore, a separate confirmed action.',
        { photoPath },
      );
    } catch (error) {
      if (error instanceof RecoveryError) throw error;
      /* photo missing: exactly the case this fix exists for */
    }
    await assertNoActiveWriter(this.lock);

    const tracked = await this.findTrackedBackupHash(backupPath);
    let actualHash: string | null = null;
    try {
      actualHash = await sha256File(backupPath);
    } catch {
      throw new RecoveryError('not_found', `The backup file is missing or unreadable: ${backupPath}`, {
        backupPath,
      });
    }
    if (tracked !== null && tracked !== actualHash) {
      throw new RecoveryError(
        'unsafe',
        'The backup file does not match the hash recorded in the journal when it was created. It may be damaged or replaced; MetaDesk refuses to restore from it.',
        { backupPath, trackedSha256: tracked, actualSha256: actualHash },
      );
    }

    await rename(backupPath, photoPath);
    return {
      action: 'restore-original',
      message:
        'Restored the photo by renaming its backup back into place. This is the only surviving copy of the photo, so verify it opens before deleting anything.',
      details: { photoPath, backupPath, sha256: actualHash, journalVerified: tracked !== null },
    };
  }

  /** Adopt an untracked `_original` into the journal as a known backup. */
  private async adoptOriginal(backupPath: string, photoPath: string): Promise<FixResult> {
    if (!backupPath.endsWith(BACKUP_SUFFIX)) {
      throw new RecoveryError('unsafe', 'Only *_original files can be adopted.', { backupPath });
    }
    if (path.dirname(backupPath) !== path.dirname(photoPath)) {
      throw new RecoveryError('bad_request', 'The backup and the photo must be in the same folder.');
    }
    try {
      await stat(photoPath);
    } catch {
      throw new RecoveryError('not_found', `The photo is missing: ${photoPath}`, { photoPath });
    }
    const sha256 = await sha256File(backupPath).catch(() => {
      throw new RecoveryError('not_found', `The backup file is missing or unreadable: ${backupPath}`, {
        backupPath,
      });
    });
    const sizeBytes = (await stat(backupPath)).size;
    const batchId = newRecordId('ad');
    await this.journal.recordAdopt({
      batchId,
      filePath: photoPath,
      backup: { path: backupPath, sizeBytes, sha256, createdAt: new Date().toISOString() },
      note: 'Adopted by the recovery scan: an _original that MetaDesk did not journal was found next to this photo.',
    });
    return {
      action: 'adopt-original',
      message:
        'Recorded the existing backup in the MetaDesk journal. Undo and backup verification now know about it.',
      details: { backupPath, photoPath, sha256, batchId },
    };
  }

  /** Mark an interrupted batch abandoned after the user has seen it. */
  private async markBatchAbandoned(batchId: string): Promise<FixResult> {
    const { records } = await this.journal.readBatch(batchId);
    if (records.length === 0) {
      throw new RecoveryError('not_found', `No journal records exist for batch "${batchId}".`);
    }
    const existingEnd = records.find((r): r is BatchEndRecord => r.kind === 'batch-end');
    if (existingEnd !== undefined && existingEnd.interrupted !== true) {
      throw new RecoveryError('unsafe', 'That batch completed normally; there is nothing to mark abandoned.');
    }
    const intents = records.filter((r): r is IntentRecord => r.kind === 'intent');
    const results = records.filter((r): r is ResultRecord => r.kind === 'result');
    const pending = intents.filter((i) => !results.some((r) => r.filePath === i.filePath));
    await this.journal.recordBatchEnd({
      batchId,
      summary: {
        updated: results.filter((r) => r.outcome.status === 'updated').length,
        unchanged: results.filter((r) => r.outcome.status === 'unchanged').length,
        failed: pending.length,
        allVerified: false,
      },
      interrupted: true,
      abandonedBy: 'user-confirmed recovery fix',
    });
    return {
      action: 'mark-batch-abandoned',
      message:
        'Marked the interrupted batch as abandoned. Its history stays readable; it will no longer appear as pending recovery.',
      details: { batchId, pendingFiles: pending.map((p) => p.filePath) },
    };
  }

  /**
   * NUCLEAR RESTORE: copy every journaled `_original` from a batch over its
   * live file. This reverts EVERYTHING since the photo's first contact with
   * MetaDesk — not just the last batch. Each copy is verified against the
   * journal hash before it is made and re-verified after.
   */
  private async restoreOriginalsForBatch(batchId: string): Promise<FixResult> {
    await assertNoActiveWriter(this.lock);
    const { records } = await this.journal.readBatch(batchId);
    if (records.length === 0) {
      throw new RecoveryError('not_found', `No journal records exist for batch "${batchId}".`);
    }
    const results = records.filter((r): r is ResultRecord => r.kind === 'result');
    const withBackup = results.filter((r) => r.outcome.backup !== undefined);
    if (withBackup.length === 0) {
      throw new RecoveryError(
        'unsafe',
        'None of the files in this batch has a journal-verified backup to restore from.',
      );
    }

    const restored: Array<{ photoPath: string; backupPath: string; sha256: string }> = [];
    const skipped: Array<{ photoPath: string; reason: string }> = [];
    for (const record of withBackup) {
      const backup = record.outcome.backup;
      if (backup === undefined) continue;
      let actualHash: string;
      try {
        actualHash = await sha256File(backup.path);
      } catch {
        skipped.push({ photoPath: record.filePath, reason: 'The backup file is missing or unreadable.' });
        continue;
      }
      if (actualHash !== backup.sha256) {
        skipped.push({
          photoPath: record.filePath,
          reason: 'The backup no longer matches its recorded hash; refusing to restore from it.',
        });
        continue;
      }
      try {
        await copyFile(backup.path, record.filePath);
        const afterHash = await sha256File(record.filePath);
        if (afterHash !== backup.sha256) {
          skipped.push({
            photoPath: record.filePath,
            reason: 'The restored copy failed its post-restore hash verification.',
          });
          continue;
        }
        restored.push({ photoPath: record.filePath, backupPath: backup.path, sha256: afterHash });
      } catch (error) {
        skipped.push({
          photoPath: record.filePath,
          reason: `The copy failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    return {
      action: 'restore-originals-for-batch',
      message:
        'Nuclear restore complete: files were reverted from their first-contact backups. This reverts EVERYTHING since those backups were made, not just the last batch.',
      details: { batchId, restored, skipped, revertedEverything: true },
    };
  }

  // ---- helpers ------------------------------------------------------------

  private async collectTrackedBackups(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const batchId of await this.journal.listBatchIds(200)) {
      const { records } = await this.journal.readBatch(batchId);
      for (const record of records) {
        if (record.kind === 'result' && record.outcome.backup !== undefined) {
          map.set(normalize(record.outcome.backup.path), record.outcome.backup.sha256);
        } else if (record.kind === 'adopt') {
          map.set(normalize(record.backup.path), record.backup.sha256);
        }
      }
    }
    return map;
  }

  private async findTrackedBackupHash(backupPath: string): Promise<string | null> {
    const map = await this.collectTrackedBackups();
    return map.get(normalize(backupPath)) ?? null;
  }
}

async function assertNoActiveWriter(lock: WriteLock): Promise<void> {
  if (lock.held) {
    throw new RecoveryError(
      'writer_active',
      'A write batch is running right now; recovery cleanup must wait until it finishes.',
    );
  }
  const lockfile = await lock.readLockfile();
  if (lockfile !== null) {
    if (lockfile.pid !== process.pid && isPidAlive(lockfile.pid)) {
      throw new RecoveryError(
        'writer_active',
        'Another MetaDesk writer process is active; recovery cleanup must wait until it finishes.',
        { pid: lockfile.pid },
      );
    }
  }
}

async function readdirSafe(folder: string): Promise<string[]> {
  try {
    return await readdir(folder);
  } catch {
    return [];
  }
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}
