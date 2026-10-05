/**
 * Graceful batch cancel (leaf 1.1.4b) against the REAL engine: a multi-chunk
 * batch is cancelled at a chunk boundary; already-written files keep their
 * verified results, unprocessed files carry the explicit not-attempted state,
 * the journal stays reconciled (every intent has a result, batch-end present),
 * and a retry preview covers exactly the unprocessed files. Also proves a
 * cancel can never interrupt exiftool mid-file: a single-chunk batch always
 * completes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { WritePipeline } from '../../src/services/writePipeline.js';
import {
  makePipeline,
  makeWriteFixture,
  type PipelineHarness,
  type WriteFixture,
} from './helpers.js';

let fixture: WriteFixture;
let harness: PipelineHarness;

const EDIT = [{ tag: 'XMP-dc:Title', op: 'set' as const, value: 'cancel drill' }];

beforeAll(async () => {
  fixture = await makeWriteFixture('metadesk-cancel-');
  // One file per chunk so the drill can cancel after chunk 0 deterministically.
  harness = await makePipeline(fixture, { chunkSize: 1 });
}, 60_000);

afterAll(async () => {
  await harness?.shutdown();
  await fixture?.cleanup();
});

const sha256 = (raw: Buffer): string => createHash('sha256').update(raw).digest('hex');

async function readBatchRecords(pipeline: WritePipeline, batchId: string) {
  const { records } = await pipeline.journal.readBatch(batchId);
  return records;
}

describe('graceful batch cancel', () => {
  it('cancels after the first chunk: written files stay verified, the rest are not attempted, journal reconciled', async () => {
    const paths = [
      await fixture.put('cancel-a.png'),
      await fixture.put('cancel-b.png'),
      await fixture.put('cancel-c.png'),
    ];
    const hashesBefore = new Map<string, string>();
    for (const p of paths) hashesBefore.set(p, sha256(await readFile(p)));

    const envelope = await harness.pipeline.preview({ files: paths, edits: EDIT });
    const previewId = envelope.preview.previewId;

    let cancelBatchId: string | null = null;
    const result = await harness.pipeline.execute(previewId, {
      onProgress: (event) => {
        // After chunk 0's verification completes (index 1 of 3), cancel.
        if (event.phase === 'verify' && event.index >= 1) {
          const verdict = harness.pipeline.requestCancel(event.batchId);
          expect(verdict.requested).toBe(true);
          cancelBatchId = event.batchId;
        }
      },
    });

    expect(cancelBatchId).toBe(result.outcome.batchId);
    const outcome = result.outcome as typeof result.outcome & {
      cancelled?: boolean;
      cancelledAt?: string;
      notAttempted?: number;
      notAttemptedFilePaths?: string[];
    };

    // The cancel is reported at batch level with the additive fields.
    expect(outcome.cancelled).toBe(true);
    expect(typeof outcome.cancelledAt).toBe('string');
    expect(outcome.notAttempted).toBe(2);
    expect(outcome.notAttemptedFilePaths).toEqual([paths[1], paths[2]]);

    // Chunk 0's file is fully updated and verified; the rest are explicitly
    // not attempted (status stays three-valued; the flags carry the state).
    const byPath = new Map(result.outcome.files.map((f) => [f.filePath, f]));
    expect(byPath.get(paths[0] as string)?.status).toBe('updated');
    expect(byPath.get(paths[0] as string)?.verified).toBe(true);
    for (const skipped of [paths[1], paths[2]]) {
      const file = byPath.get(skipped as string);
      expect(file?.status).toBe('unchanged');
      expect((file as { notAttempted?: boolean }).notAttempted).toBe(true);
      expect((file as { notAttemptedReason?: string }).notAttemptedReason ?? '').toMatch(
        /cancel/i,
      );
      expect(file?.errors).toEqual([]);
      // Genuinely untouched on disk.
      expect(sha256(await readFile(skipped as string))).toBe(hashesBefore.get(skipped as string));
    }

    // Counts keep the invariant updated+unchanged+failed === files.length; the
    // not-attempted files are counted under 'unchanged' (nothing changed).
    expect(result.outcome.updated).toBe(1);
    expect(result.outcome.unchanged).toBe(2);
    expect(result.outcome.failed).toBe(0);
    expect(result.outcome.allVerified).toBe(false);

    // Journal reconciled: every intent has exactly one result, batch-end present.
    const records = await readBatchRecords(harness.pipeline, result.outcome.batchId);
    const intents = records.filter((r) => r.kind === 'intent');
    const results = records.filter((r) => r.kind === 'result');
    expect(intents).toHaveLength(3);
    expect(results).toHaveLength(3);
    const end = records.find((r) => r.kind === 'batch-end');
    expect(end).toBeDefined();

    // History view: finished (not interrupted), honest per-file outcomes.
    const history = await harness.pipeline.journal.batchHistory(result.outcome.batchId);
    expect(history?.interrupted).toBe(false);
    expect(history?.updated).toBe(1);
    expect(history?.unchanged).toBe(2);

    // A retry preview covers ONLY the unprocessed files.
    const retry = await harness.pipeline.preview({
      files: outcome.notAttemptedFilePaths as string[],
      edits: EDIT,
    });
    expect(retry.preview.files.map((f) => f.filePath)).toEqual([paths[1], paths[2]]);
  });

  it('never interrupts an in-flight chunk: a single-file batch always completes', async () => {
    const solo = await fixture.put('cancel-solo.png');
    const envelope = await harness.pipeline.preview({ files: [solo], edits: EDIT });
    const result = await harness.pipeline.execute(envelope.preview.previewId, {
      onProgress: (event) => {
        // Cancel the moment the chunk is in flight ('write' fires just before
        // the engine round trip starts) — the chunk still runs to completion,
        // because the flag is only ever honored at the NEXT chunk boundary.
        if (event.phase === 'write') harness.pipeline.requestCancel(event.batchId);
      },
    });
    const outcome = result.outcome as typeof result.outcome & { cancelled?: boolean };
    expect(outcome.cancelled).toBeUndefined();
    expect(result.outcome.files).toHaveLength(1);
    expect(result.outcome.files[0]?.status).toBe('updated');
    expect(result.outcome.files[0]?.verified).toBe(true);
  });

  it('refuses to cancel an unknown or already-finished batch id', async () => {
    expect(harness.pipeline.requestCancel('wb_does_not_exist').requested).toBe(false);
    const solo = await fixture.put('cancel-done.png');
    const envelope = await harness.pipeline.preview({ files: [solo], edits: EDIT });
    const result = await harness.pipeline.execute(envelope.preview.previewId);
    // After completion the batch is no longer a cancel target.
    expect(harness.pipeline.requestCancel(result.outcome.batchId).requested).toBe(false);
  });
});
