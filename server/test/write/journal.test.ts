/**
 * Journal round-trip: intent-before-execute record order, per-file outcomes,
 * interrupted-batch detection, undo plan computation from before-values, and
 * backup hash verification (the Verified chip source).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Journal, sha256File, type IntentRecord } from '../../src/services/journal.js';
import { PNG_1X1 } from '../helpers.js';

let root: string;
let journal: Journal;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'metadesk-journal-'));
  journal = new Journal({ dataDir: root });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

async function seedBatch(batchId: string): Promise<void> {
  await journal.recordBatchStart({
    batchId,
    mode: 'edit',
    description: 'test batch',
    files: ['C:\\p\\a.png', 'C:\\p\\b.png'],
    argv: ['-XMP-dc:Title=X', 'C:\\p\\a.png', 'C:\\p\\b.png'],
    edits: [{ tag: 'XMP-dc:Title', op: 'set', value: 'X' }],
  });
  const intentA: Omit<IntentRecord, 'kind' | 'id' | 'timestamp'> = {
    batchId,
    filePath: 'C:\\p\\a.png',
    edits: [{ tag: 'XMP-dc:Title', op: 'set', value: 'X' }],
    before: { 'XMP-dc:Title': 'Old A' },
    expectedAfter: { 'XMP-dc:Title': 'X' },
    diffs: [{ tag: 'XMP-dc:Title', before: 'Old A', after: 'X', kind: 'change' }],
  };
  const intentB: Omit<IntentRecord, 'kind' | 'id' | 'timestamp'> = {
    batchId,
    filePath: 'C:\\p\\b.png',
    edits: [{ tag: 'XMP-dc:Title', op: 'set', value: 'X' }],
    before: {},
    expectedAfter: { 'XMP-dc:Title': 'X' },
    diffs: [{ tag: 'XMP-dc:Title', after: 'X', kind: 'create' }],
  };
  await journal.recordIntent(intentA);
  await journal.recordIntent(intentB);
  await journal.recordResult({
    batchId,
    filePath: 'C:\\p\\a.png',
    outcome: {
      filePath: 'C:\\p\\a.png',
      status: 'updated',
      warnings: [],
      errors: [],
      backup: {
        path: 'C:\\p\\a.png_original',
        sizeBytes: PNG_1X1.length,
        sha256: createHash('sha256').update(PNG_1X1).digest('hex'),
        createdAt: new Date().toISOString(),
      },
      verified: true,
    },
  });
}

describe('record round-trip', () => {
  it('writes and reads back records in order (intent before result)', async () => {
    await seedBatch('wb_test1');
    const { records, corruptLines } = await journal.readBatch('wb_test1');
    expect(corruptLines).toBe(0);
    expect(records.map((r) => r.kind)).toEqual(['batch-start', 'intent', 'intent', 'result']);
    const intent = records[1] as IntentRecord;
    expect(intent.before['XMP-dc:Title']).toBe('Old A');
  });

  it('counts corrupt (torn) lines instead of crashing', async () => {
    const batchId = 'wb_torn';
    await seedBatch(batchId);
    const { appendFile } = await import('node:fs/promises');
    await appendFile(journal.batchPath(batchId), '{"kind":"result","half wr', 'utf8');
    const { records, corruptLines } = await journal.readBatch(batchId);
    expect(corruptLines).toBe(1);
    expect(records.filter((r) => r.kind === 'batch-start')).toHaveLength(1);
  });
});

describe('history and interruption', () => {
  it('builds a history view with counts and interrupt flag', async () => {
    const history = await journal.batchHistory('wb_test1');
    expect(history).not.toBeNull();
    expect(history?.mode).toBe('edit');
    expect(history?.updated).toBe(1);
    expect(history?.unchanged).toBe(0);
    expect(history?.failed).toBe(1); // b.png has intent but no result
    expect(history?.interrupted).toBe(true);
    expect(history?.outcomes[1]?.status).toBe('failed');
    expect(history?.outcomes[1]?.errors[0]).toMatch(/interrupted/i);
  });

  it('findInterruptedBatches reports pending files; a completed batch is not pending', async () => {
    const interrupted = await journal.findInterruptedBatches();
    expect(interrupted.map((b) => b.batchId)).toContain('wb_test1');
    expect(interrupted.find((b) => b.batchId === 'wb_test1')?.pendingFiles).toEqual(['C:\\p\\b.png']);

    await journal.recordResult({
      batchId: 'wb_test1',
      filePath: 'C:\\p\\b.png',
      outcome: { filePath: 'C:\\p\\b.png', status: 'unchanged', warnings: [], errors: [] },
    });
    await journal.recordBatchEnd({
      batchId: 'wb_test1',
      summary: { updated: 1, unchanged: 1, failed: 0, allVerified: false },
    });
    const after = await journal.findInterruptedBatches();
    expect(after.map((b) => b.batchId)).not.toContain('wb_test1');
  });

  it('lists batches newest-first', async () => {
    // Ensure a later batch-start timestamp (same-ms seeds would tie).
    await new Promise((resolve) => setTimeout(resolve, 5));
    await seedBatch('wb_older');
    const ids = await journal.listBatchIds(10);
    // The later-seeded batch is newer, so it sorts first.
    expect(ids.indexOf('wb_older')).toBeLessThan(ids.indexOf('wb_test1'));
  });
});

describe('undo plan', () => {
  it('computes reverse edits from before-values, skipping unchanged diffs', async () => {
    await journal.recordBatchStart({
      batchId: 'wb_undo',
      mode: 'edit',
      description: 'undo source',
      files: ['C:\\p\\u1.png', 'C:\\p\\u2.png', 'C:\\p\\u3.png'],
      argv: [],
      edits: [{ tag: 'XMP-dc:Title', op: 'set', value: 'New' }],
    });
    await journal.recordIntent({
      batchId: 'wb_undo',
      filePath: 'C:\\p\\u1.png',
      edits: [{ tag: 'XMP-dc:Title', op: 'set', value: 'New' }],
      before: { 'XMP-dc:Title': 'Keep me' },
      expectedAfter: { 'XMP-dc:Title': 'New' },
      diffs: [{ tag: 'XMP-dc:Title', before: 'Keep me', after: 'New', kind: 'change' }],
    });
    await journal.recordIntent({
      batchId: 'wb_undo',
      filePath: 'C:\\p\\u2.png',
      edits: [{ tag: 'XMP-dc:Title', op: 'set', value: 'New' }],
      before: {},
      expectedAfter: { 'XMP-dc:Title': 'New' },
      diffs: [{ tag: 'XMP-dc:Title', after: 'New', kind: 'create' }],
    });
    await journal.recordIntent({
      batchId: 'wb_undo',
      filePath: 'C:\\p\\u3.png',
      edits: [{ tag: 'XMP-dc:Title', op: 'set', value: 'New' }],
      before: { 'XMP-dc:Title': 'Same' },
      expectedAfter: { 'XMP-dc:Title': 'Same' },
      diffs: [{ tag: 'XMP-dc:Title', before: 'Same', after: 'Same', kind: 'unchanged' }],
    });
    for (const [filePath, status] of [
      ['C:\\p\\u1.png', 'updated'],
      ['C:\\p\\u2.png', 'updated'],
      ['C:\\p\\u3.png', 'unchanged'],
    ] as const) {
      await journal.recordResult({
        batchId: 'wb_undo',
        filePath,
        outcome: { filePath, status, warnings: [], errors: [] },
      });
    }
    await journal.recordBatchEnd({
      batchId: 'wb_undo',
      summary: { updated: 2, unchanged: 1, failed: 0, allVerified: false },
    });

    const plan = await journal.undoPlan('wb_undo');
    expect(plan).toHaveLength(2);
    expect(plan[0]?.edits).toEqual([{ tag: 'XMP-dc:Title', op: 'set', value: 'Keep me' }]);
    // Created tag -> the undo deletes it.
    expect(plan[1]?.edits).toEqual([{ tag: 'XMP-dc:Title', op: 'delete' }]);
  });
});

describe('backup verification (Verified chips)', () => {
  it('verifies a real file by size+sha256 and fails a tampered one', async () => {
    const backupPath = path.join(root, 'a.png_original');
    await writeFile(backupPath, PNG_1X1);
    const good = await journal.verifyBackup({
      path: backupPath,
      sizeBytes: PNG_1X1.length,
      sha256: await sha256File(backupPath),
      createdAt: new Date().toISOString(),
    });
    expect(good.verified).toBe(true);

    const tampered = await journal.verifyBackup({
      path: backupPath,
      sizeBytes: PNG_1X1.length,
      sha256: '0'.repeat(64),
      createdAt: new Date().toISOString(),
    });
    expect(tampered.verified).toBe(false);
    expect(tampered.reason).toMatch(/hash/i);

    const missing = await journal.verifyBackup({
      path: path.join(root, 'missing_original'),
      sizeBytes: 1,
      sha256: '1'.repeat(64),
      createdAt: new Date().toISOString(),
    });
    expect(missing.verified).toBe(false);
    expect(missing.reason).toMatch(/missing or unreadable/i);
  });
});

describe('scrub export', () => {
  it('writes the mandatory pre-write export beside the journal', async () => {
    const exportPath = await journal.writeScrubExport('sc_test1', { values: [1, 2, 3] });
    expect(exportPath).toContain(path.join('journal', 'exports', 'sc_test1.json'));
    const { readFile } = await import('node:fs/promises');
    const parsed = JSON.parse(await readFile(exportPath, 'utf8')) as { values: number[] };
    expect(parsed.values).toEqual([1, 2, 3]);
  });

  it('rejects scrub ids that could escape the exports dir', async () => {
    await expect(journal.writeScrubExport('..\\evil', {})).rejects.toThrow(/Invalid scrub id/);
    expect(() => journal.batchPath('..\\evil')).toThrow(/Invalid batch id/);
  });
});
