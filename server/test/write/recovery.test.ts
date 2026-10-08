/**
 * Recovery: orphan temp scan + confirmed cleanup, _original-without-photo
 * restore, untracked-original adoption, interrupted-batch detection and
 * abandonment, and the journal-verified nuclear restore (byte-identical).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RecoveryError, RecoveryService } from '../../src/services/recovery.js';
import { sha256File } from '../../src/services/journal.js';
import { makePipeline, makeWriteFixture, type PipelineHarness, type WriteFixture } from './helpers.js';
import { PNG_1X1 } from '../helpers.js';

let fixture: WriteFixture;
let harness: PipelineHarness;
let recovery: RecoveryService;
const photosDir = () => fixture.pathOf('photos');

beforeAll(async () => {
  fixture = await makeWriteFixture('metadesk-recovery-');
  harness = await makePipeline(fixture);
  recovery = new RecoveryService({ dataDir: fixture.dataDir });
  await mkdir(photosDir(), { recursive: true });
}, 60_000);

afterAll(async () => {
  await harness?.shutdown();
  await fixture?.cleanup();
});

async function putPhoto(name: string, bytes: Buffer = PNG_1X1): Promise<string> {
  const full = path.join(photosDir(), name);
  await writeFile(full, bytes);
  return full;
}

/** Flip the case of every ASCII letter — the same folder on a case-insensitive volume. */
function caseSwapped(p: string): string {
  return p.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
}

describe('orphan temp files', () => {
  it('are found by the scan and deleted only with confirmation and no active writer', async () => {
    const photo = await putPhoto('orphan-target.png');
    const tmp = `${photo}_exiftool_tmp`;
    await writeFile(tmp, 'partial transaction debris');

    const report = await recovery.scan([photosDir()]);
    expect(report.clean).toBe(false);
    const folder = report.folders[0];
    expect(folder?.orphanTempFiles).toEqual([{ path: tmp, targetPath: photo }]);

    // No confirmation -> refused.
    await expect(
      recovery.fix({ action: 'delete-orphan-temp', path: tmp, confirm: false }),
    ).rejects.toMatchObject({ code: 'confirmation_required' });

    // Confirmed -> deleted; the photo itself is untouched.
    const result = await recovery.fix({ action: 'delete-orphan-temp', path: tmp, confirm: true });
    expect(result.message).toMatch(/Deleted the leftover temporary file/);
    await expect(readFile(tmp)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await sha256File(photo)).toBe(createHash('sha256').update(PNG_1X1).digest('hex'));

    // Only *_exiftool_tmp files may be deleted by this fix.
    await expect(
      recovery.fix({ action: 'delete-orphan-temp', path: photo, confirm: true }),
    ).rejects.toMatchObject({ code: 'unsafe' });
  });

  it('refuses cleanup while a writer holds the lock', async () => {
    const tmp = path.join(photosDir(), 'busy.png_exiftool_tmp');
    await writeFile(tmp, 'debris');
    const lock = harness.pipeline.singleWriterLock;
    // Acquire on a clean folder (acquire itself refuses folders holding
    // debris — that is the foreign-temp guard, tested separately).
    const cleanDir = fixture.pathOf('lock-check');
    await mkdir(cleanDir, { recursive: true });
    let handle: Awaited<ReturnType<typeof lock.acquire>> | null = null;
    try {
      handle = await lock.acquire([cleanDir], 'batch-busy');
      await expect(recovery.fix({ action: 'delete-orphan-temp', path: tmp, confirm: true })).rejects.toMatchObject({
        code: 'writer_active',
      });
    } finally {
      if (handle !== null) await handle.release();
      await rm(tmp, { force: true });
    }
  });
});

describe('_original without its photo', () => {
  it('is restored by rename-back, journal-verified when tracked', async () => {
    const backupPath = path.join(photosDir(), 'lost.png_original');
    await writeFile(backupPath, PNG_1X1);

    // First scan: untracked (no journal record yet).
    let report = await recovery.scan([photosDir()]);
    let pair = report.folders[0]?.originalsWithoutPhoto[0];
    expect(pair?.backupPath).toBe(backupPath);

    // Restore refused without confirmation.
    await expect(
      recovery.fix({ action: 'restore-original', backupPath, confirm: false }),
    ).rejects.toMatchObject({ code: 'confirmation_required' });

    const result = await recovery.fix({ action: 'restore-original', backupPath, confirm: true });
    expect(result.message).toMatch(/Renamed|renaming its backup back/i);
    expect(await sha256File(path.join(photosDir(), 'lost.png'))).toBe(
      createHash('sha256').update(PNG_1X1).digest('hex'),
    );
    report = await recovery.scan([photosDir()]);
    pair = report.folders[0]?.originalsWithoutPhoto.find((p) => p.backupPath === backupPath);
    expect(pair).toBeUndefined();
  });

  it('refuses to restore when the photo already exists (nuclear territory)', async () => {
    const photo = await putPhoto('alive.png');
    await writeFile(`${photo}_original`, PNG_1X1);
    await expect(
      recovery.fix({ action: 'restore-original', backupPath: `${photo}_original`, confirm: true }),
    ).rejects.toMatchObject({ code: 'unsafe' });
    await rm(`${photo}_original`, { force: true });
  });

  it('refuses to restore from a backup whose bytes no longer match the journal', async () => {
    // Track a backup through the journal, then tamper with it.
    const photoPath = await putPhoto('tampered.png');
    const backupPath = `${photoPath}_original`;
    await writeFile(backupPath, PNG_1X1);
    await recovery.fix({
      action: 'adopt-original',
      backupPath,
      photoPath,
      confirm: true,
    });
    await rm(photoPath, { force: true });
    await writeFile(backupPath, Buffer.from('not the original bytes at all'));
    await expect(
      recovery.fix({ action: 'restore-original', backupPath, confirm: true }),
    ).rejects.toMatchObject({ code: 'unsafe' });
    await rm(backupPath, { force: true });
  });
});

describe('untracked originals', () => {
  it('are surfaced and adopted into the journal', async () => {
    const photo = await putPhoto('adopted.png');
    const backupPath = `${photo}_original`;
    await writeFile(backupPath, PNG_1X1);

    const report = await recovery.scan([photosDir()]);
    const untracked = report.folders[0]?.untrackedOriginals.find((p) => p.backupPath === backupPath);
    expect(untracked).toBeDefined();

    await expect(
      recovery.fix({ action: 'adopt-original', backupPath, photoPath: photo, confirm: false }),
    ).rejects.toMatchObject({ code: 'confirmation_required' });

    await recovery.fix({ action: 'adopt-original', backupPath, photoPath: photo, confirm: true });
    const after = await recovery.scan([photosDir()]);
    expect(after.folders[0]?.untrackedOriginals.find((p) => p.backupPath === backupPath)).toBeUndefined();
  });
});

describe('interrupted batches', () => {
  it('are detected and marked abandoned by a confirmed fix', async () => {
    await harness.pipeline.journal.recordBatchStart({
      batchId: 'wb_interrupted',
      mode: 'edit',
      description: 'killed mid-batch',
      files: [path.join(photosDir(), 'x.png')],
      argv: [],
      edits: [{ tag: 'XMP-dc:Title', op: 'set', value: 'x' }],
    });
    await harness.pipeline.journal.recordIntent({
      batchId: 'wb_interrupted',
      filePath: path.join(photosDir(), 'x.png'),
      edits: [{ tag: 'XMP-dc:Title', op: 'set', value: 'x' }],
      before: {},
      expectedAfter: {},
      diffs: [],
    });

    const report = await recovery.scanJournal();
    const interrupted = report.interruptedBatches.find((b) => b.batchId === 'wb_interrupted');
    expect(interrupted?.pendingFiles).toEqual([path.join(photosDir(), 'x.png')]);

    await expect(
      recovery.fix({ action: 'mark-batch-abandoned', batchId: 'wb_interrupted', confirm: false }),
    ).rejects.toMatchObject({ code: 'confirmation_required' });
    await recovery.fix({ action: 'mark-batch-abandoned', batchId: 'wb_interrupted', confirm: true });

    const after = await recovery.scanJournal();
    const still = after.interruptedBatches.find((b) => b.batchId === 'wb_interrupted');
    expect(still?.markedAbandoned).toBe(true);
  });
});

describe('nuclear restore (restore-originals-for-batch)', () => {
  it('reverts a real pipeline write byte-identically, verified by hash before and after', async () => {
    const photo = await putPhoto('nuclear.png');

    // A real write through the full pipeline (backup + journal).
    const env = await harness.pipeline.preview({
      files: [photo],
      edits: [{ tag: 'XMP-dc:Title', op: 'set', value: 'doomed edit' }],
    });
    const res = await harness.pipeline.execute(env.preview.previewId);
    expect(res.outcome.files[0]?.status).toBe('updated');
    expect(res.outcome.files[0]?.verified).toBe(true);
    const batchId = res.outcome.batchId;

    // The photo is genuinely changed on disk.
    expect(await sha256File(photo)).not.toBe(createHash('sha256').update(PNG_1X1).digest('hex'));

    await expect(
      recovery.fix({ action: 'restore-originals-for-batch', batchId, confirm: false }),
    ).rejects.toMatchObject({ code: 'confirmation_required' });

    const fix = await recovery.fix({ action: 'restore-originals-for-batch', batchId, confirm: true });
    expect(fix.message).toMatch(/EVERYTHING/);
    const details = fix.details as { restored: Array<{ sha256: string }> };
    expect(details.restored).toHaveLength(1);

    // Byte-identical to the original fixture, and clean of the edit.
    expect(await sha256File(photo)).toBe(createHash('sha256').update(PNG_1X1).digest('hex'));
  });
});

describe('case-swapped journal cross-check', () => {
  it('still matches journal-recorded backups when the scan spells the folder with different case', async () => {
    // The journal records the backup under photosDir()'s own spelling (a real
    // pipeline write); the scan below passes a case-flipped spelling of the
    // same folder. The two producers only agree because both sides fold to
    // the lowercase forward-slash key (recovery.ts trackedBackup map vs the
    // readdir scan) — the one load-bearing lowercase in the path family.
    const photo = await putPhoto('casing.png');
    const env = await harness.pipeline.preview({
      files: [photo],
      edits: [{ tag: 'XMP-dc:Title', op: 'set', value: 'casing witness' }],
    });
    const res = await harness.pipeline.execute(env.preview.previewId);
    expect(res.outcome.files[0]?.status).toBe('updated');

    // Remove the live photo so the backup surfaces as an original-without-
    // photo — the only report row that carries a trackedSha256 to observe.
    await rm(photo, { force: true });

    const report = await recovery.scan([caseSwapped(photosDir())]);
    const folder = report.folders[0];
    const pair = folder?.originalsWithoutPhoto.find(
      (p) => path.basename(p.backupPath) === 'casing.png_original',
    );
    expect(pair).toBeDefined();
    expect(pair?.trackedSha256).not.toBeNull();
    expect(folder?.untrackedOriginals).toEqual([]);
  });
});

describe('scan cleanliness', () => {
  it('reports clean when nothing is pending', async () => {
    const fresh = await makeWriteFixture('metadesk-recovery-clean-');
    try {
      const dir = fresh.pathOf('clean');
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'plain.png'), PNG_1X1);
      const service = new RecoveryService({ dataDir: fresh.dataDir });
      const report = await service.scan([dir]);
      expect(report.clean).toBe(true);
    } finally {
      await fresh.cleanup();
    }
  });
});

describe('recovery errors', () => {
  it('carry machine codes', () => {
    const error = new RecoveryError('unsafe', 'test');
    expect(error.code).toBe('unsafe');
    expect(error.name).toBe('RecoveryError');
  });

  it('refuses unknown actions', async () => {
    await expect(
      recovery.fix({ action: 'unknown', confirm: true } as unknown as Parameters<
        RecoveryService['fix']
      >[0]),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('refuses renaming across the restore path when the backup vanishes', async () => {
    await expect(
      recovery.fix({
        action: 'restore-original',
        backupPath: path.join(photosDir(), 'ghost.png_original'),
        confirm: true,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('renames nothing when the restore target dir is empty (rename is used, not copy)', async () => {
    // rename() moves the only copy; the backup must be gone afterwards.
    const backupPath = path.join(photosDir(), 'moved.png_original');
    await writeFile(backupPath, PNG_1X1);
    await recovery.fix({ action: 'restore-original', backupPath, confirm: true });
    await expect(rename(backupPath, path.join(photosDir(), 'never.png'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await rm(path.join(photosDir(), 'moved.png'), { force: true });
  });
});
