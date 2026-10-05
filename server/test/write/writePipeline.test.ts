/**
 * The write pipeline against the REAL engine: hostile filenames end-to-end,
 * backup verification (including the second-edit case), forced re-read
 * mismatch, a locked file failing one file while the batch continues, the
 * three-valued mixed batch, preview noop/blockers, unlock and preview
 * requirements, chunking, and journal-backed undo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WritePipelineError } from '../../src/services/writePipeline.js';
import { holdFileOpen, makePipeline, makeWriteFixture, waitForMarker, writeSdMetadata, readTagsOnce, type PipelineHarness, type WriteFixture } from './helpers.js';
import { PNG_1X1 } from '../helpers.js';

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const readBytes = (filePath: string): Promise<Buffer> => readFile(filePath);

let fixture: WriteFixture;
let harness: PipelineHarness;

beforeAll(async () => {
  fixture = await makeWriteFixture('metadesk-pipeline-');
  harness = await makePipeline(fixture, { chunkSize: 3 });
}, 60_000);

afterAll(async () => {
  await harness?.shutdown();
  await fixture?.cleanup();
});

describe('hostile filenames end-to-end', () => {
  it('previews, executes, verifies, and backs up files named like exiftool grammar', async () => {
    const names = ['--All=', '-comment=x.jpg', '50%#off=.png', "a'b c.png", '照片 中文 (1).png', 'café ☕.png'];
    for (const name of names) await fixture.put(name);

    const files = names.map((n) => fixture.pathOf(n));
    const edits = [{ tag: 'XMP-dc:Description', op: 'set' as const, value: 'pipeline hostile probe' }];

    const envelope = await harness.pipeline.preview({ files, edits });
    expect(envelope.preview.blockers).toEqual([]);
    expect(envelope.preview.files).toHaveLength(names.length);
    for (const file of envelope.preview.files) {
      expect(file.argv.at(-1)).toBe(file.filePath);
    }
    for (const previewFile of envelope.preview.files) {
      if (previewFile.filePath.endsWith('.jpg')) {
        // The fixture bytes are PNG but the name says .jpg — the engine
        // refuses the edit in simulation and the preview says so.
        expect(previewFile.diffs.some((d) => d.kind === 'create')).toBe(false);
        expect(previewFile.warnings.join(' ')).toMatch(/could not apply this edit/i);
      } else {
        expect(previewFile.diffs.some((d) => d.kind === 'create' && d.after === 'pipeline hostile probe')).toBe(true);
      }
    }
    // commandPreview is the exact first-chunk argv: flags + edits + the
    // chunk's files (chunkSize 3 in this harness).
    expect(envelope.commandPreview[0]).toBe('-use');
    expect(envelope.commandPreview).toContain('MWG');
    expect(envelope.commandPreview.slice(-3)).toEqual([files[0], files[1], files[2]]);

    const { outcome, commandPreview } = await harness.pipeline.execute(envelope.preview.previewId);
    expect(commandPreview).toEqual(envelope.commandPreview);
    // Five of six update; the mislabeled .jpg fails honestly and lands on the
    // retry list.
    expect(outcome.updated).toBe(names.length - 1);
    expect(outcome.failed).toBe(1);
    const jpgOutcome = outcome.files.find((f) => f.filePath.endsWith('.jpg'));
    expect(jpgOutcome?.status).toBe('failed');
    expect(outcome.retryFilePaths).toEqual([jpgOutcome?.filePath]);
    for (const file of outcome.files) {
      if (file.filePath.endsWith('.jpg')) continue;
      expect(file.status).toBe('updated');
      expect(file.verified).toBe(true);
      expect(file.backup).toBeDefined();
      expect(file.backup?.sha256).toBe(sha256(PNG_1X1)); // pre-edit bytes
      expect(file.backup?.sizeBytes).toBe(PNG_1X1.length);
    }

    // Independent read-back through a fresh exiftool process.
    for (const filePath of files) {
      if (filePath.endsWith('.jpg')) continue;
      const tags = await readTagsOnce(filePath, ['XMP-dc:Description']);
      expect(tags['XMP-dc:Description']).toBe('pipeline hostile probe');
    }
  });
});

describe('backup verification', () => {
  it('keeps the first-generation backup on a second edit and verifies against the pre-write _original hash', async () => {
    const file = await fixture.put('second-edit.png');
    const first = [{ tag: 'XMP-dc:Title' as const, op: 'set' as const, value: 'First' }];

    const env1 = await harness.pipeline.preview({ files: [file], edits: first });
    const res1 = await harness.pipeline.execute(env1.preview.previewId);
    expect(res1.outcome.files[0]?.status).toBe('updated');
    expect(res1.outcome.files[0]?.verified).toBe(true);

    const second = [{ tag: 'XMP-dc:Title' as const, op: 'set' as const, value: 'Second' }];
    const env2 = await harness.pipeline.preview({ files: [file], edits: second });
    // The preview sees the pre-existing _original and warns about it.
    const previewFile = env2.preview.files[0];
    expect(previewFile?.warnings.join(' ')).toMatch(/backup from an earlier edit/i);
    const res2 = await harness.pipeline.execute(env2.preview.previewId);
    expect(res2.outcome.files[0]?.status).toBe('updated');
    expect(res2.outcome.files[0]?.verified).toBe(true);
    // The backup still holds the FIRST-generation bytes, not the mid-edit ones.
    expect(res2.outcome.files[0]?.backup?.sha256).toBe(sha256(PNG_1X1));

    const tags = await readTagsOnce(file, ['XMP-dc:Title']);
    expect(tags['XMP-dc:Title']).toBe('Second');
  });

  it('marks a file failed (stage backup) when re-read verification is forced to mismatch', async () => {
    const file = await fixture.put('forced-mismatch.png');
    const edits = [{ tag: 'XMP-dc:Title', op: 'set' as const, value: 'Verified?' }];
    const env = await harness.pipeline.preview({ files: [file], edits });
    const res = await harness.pipeline.execute(env.preview.previewId, {
      faultInjection: { failVerificationFor: [file] },
    });
    const outcome = res.outcome.files[0];
    expect(outcome?.status).toBe('failed');
    expect(outcome?.stage).toBe('verify');
    expect(outcome?.errors.join(' ')).toMatch(/does not match the preview/i);
    expect(res.outcome.retryFilePaths).toContain(file);
    expect(res.outcome.allVerified).toBe(false);
    // The file WAS written (backup exists) — the result is honest about that.
    await expect(readTagsOnce(file, ['XMP-dc:Title'])).resolves.toMatchObject({ 'XMP-dc:Title': 'Verified?' });
  });
});

describe('three-valued results from a mixed batch', () => {
  it('sorts updated / unchanged / failed from one batch and builds the retry list', async () => {
    const updatedFile = await fixture.put('mixed-updated.png');
    const unchangedFile = await fixture.put('mixed-unchanged.png');
    const missingFile = fixture.pathOf('does-not-exist.png');

    // Pre-write a Title on the first file only, then delete the Title across
    // all three: the first is updated, the second (no Title to delete) is
    // unchanged, the third (missing) fails.
    const pre = await harness.pipeline.preview({
      files: [updatedFile],
      edits: [{ tag: 'XMP-dc:Title', op: 'set', value: 'delete me' }],
    });
    await harness.pipeline.execute(pre.preview.previewId);

    const env = await harness.pipeline.preview({
      files: [updatedFile, unchangedFile, missingFile],
      edits: [{ tag: 'XMP-dc:Title', op: 'delete' }],
    });
    expect(env.preview.files.find((f) => f.filePath === unchangedFile)?.noop).toBe(true);

    const res = await harness.pipeline.execute(env.preview.previewId);
    expect(res.outcome.updated).toBe(1);
    expect(res.outcome.unchanged).toBe(1);
    expect(res.outcome.failed).toBe(1);
    const byFile = new Map(res.outcome.files.map((f) => [f.filePath, f]));
    expect(byFile.get(updatedFile)?.status).toBe('updated');
    expect(byFile.get(updatedFile)?.verified).toBe(true);
    expect(byFile.get(unchangedFile)?.status).toBe('unchanged');
    expect(byFile.get(missingFile)?.status).toBe('failed');
    expect(byFile.get(missingFile)?.errors.join(' ')).toMatch(/error|no result/i);
    expect(res.outcome.retryFilePaths).toEqual([missingFile]);
  });

  it('flags a no-value-change re-edit as noop in the preview; the engine rewrite still reports honestly', async () => {
    const file = await fixture.put('noop.png');
    // Pre-write the value so the re-edit changes no tag values.
    const pre = await harness.pipeline.preview({
      files: [file],
      edits: [{ tag: 'XMP-dc:Title', op: 'set', value: 'already the same' }],
    });
    await harness.pipeline.execute(pre.preview.previewId);

    const env = await harness.pipeline.preview({
      files: [file],
      edits: [{ tag: 'XMP-dc:Title', op: 'set', value: 'already the same' }],
    });
    // The preview says: no tag values will differ.
    expect(env.preview.files[0]?.noop).toBe(true);
    // The engine still physically rewrites (its own three-valued truth), so
    // the result says updated — with verification proving the values match.
    const res = await harness.pipeline.execute(env.preview.previewId);
    expect(res.outcome.files[0]?.status).toBe('updated');
    expect(res.outcome.files[0]?.verified).toBe(true);
  });
});

describe('locked file mid-batch', () => {
  it('fails the locked file, keeps its stderr, and finishes the rest of the batch', async () => {
    const lockedFile = await fixture.put('locked.png');
    const healthyFile = await fixture.put('healthy.png');
    const lock = await holdFileOpen(lockedFile, fixture.pathOf('lock.ready'));
    try {
      const ready = await waitForMarker(fixture.pathOf('lock.ready'), 25_000);
      expect(ready).toBe(true);

      const env = await harness.pipeline.preview({
        files: [lockedFile, healthyFile],
        edits: [{ tag: 'XMP-dc:Title', op: 'set', value: 'batch with a locked file' }],
      });
      const res = await harness.pipeline.execute(env.preview.previewId);
      const byFile = new Map(res.outcome.files.map((f) => [f.filePath, f]));
      expect(byFile.get(healthyFile)?.status).toBe('updated');
      expect(byFile.get(healthyFile)?.verified).toBe(true);
      const lockedOutcome = byFile.get(lockedFile);
      expect(lockedOutcome?.status).toBe('failed');
      expect(lockedOutcome?.errors.join(' ').length).toBeGreaterThan(0);
      expect(res.outcome.retryFilePaths).toEqual([lockedFile]);
    } finally {
      await lock.release();
    }
  }, 90_000);
});

describe('gates and errors', () => {
  it('refuses execute without a live preview', async () => {
    await expect(harness.pipeline.execute('pv_missing')).rejects.toMatchObject({
      code: 'preview_required',
    });
  });

  it('refuses execute while the session is read-only', async () => {
    const file = await fixture.put('readonly-gate.png');
    const lockedHarness = await makePipeline(fixture, { unlocked: false });
    try {
      const env = await lockedHarness.pipeline.preview({
        files: [file],
        edits: [{ tag: 'XMP-dc:Title', op: 'set', value: 'nope' }],
      });
      await expect(lockedHarness.pipeline.execute(env.preview.previewId)).rejects.toMatchObject({
        code: 'read_only_mode',
      });
      // The file is untouched.
      expect(sha256(await readBytes(file))).toBe(sha256(PNG_1X1));
    } finally {
      await lockedHarness.shutdown();
    }
  });

  it('flags foreign temp files as preview blockers', async () => {
    const dir = fixture.pathOf('blocked-dir');
    await mkdir(dir, { recursive: true });
    const blocked = path.join(dir, 'blocked.png');
    await writeFile(blocked, PNG_1X1);
    await writeFile(path.join(dir, 'blocked.png_exiftool_tmp'), 'debris');
    const env = await harness.pipeline.preview({
      files: [blocked],
      edits: [{ tag: 'XMP-dc:Title', op: 'set', value: 'x' }],
    });
    expect(env.preview.blockers.join(' ')).toMatch(/temporary write files/i);
    await rm(path.join(dir, 'blocked.png_exiftool_tmp'), { force: true });
  });

  it('rejects non-whitelisted tags and grammar injection through the builder', async () => {
    const file = await fixture.put('whitelist.png');
    await expect(
      harness.pipeline.preview({ files: [file], edits: [{ tag: 'PNG:all', op: 'delete' }] }),
    ).rejects.toMatchObject({ name: 'ArgBuildError' });
    await expect(
      harness.pipeline.preview({ files: [file], edits: [{ tag: 'XMP-dc:Title', op: 'set', value: '-All=' }] }),
    ).rejects.toMatchObject({ name: 'ArgBuildError' });
  });
});

describe('chunking', () => {
  it('executes a batch larger than the chunk size with per-chunk verification', async () => {
    const small = await makePipeline(fixture, { chunkSize: 2 });
    try {
      const files: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        files.push(await fixture.put(`chunk-${i}.png`));
      }
      const env = await small.pipeline.preview({
        files,
        edits: [{ tag: 'IPTC:ObjectName', op: 'set', value: `chunked ${Date.now()}` }],
      });
      const res = await small.pipeline.execute(env.preview.previewId);
      expect(res.outcome.files).toHaveLength(5);
      expect(res.outcome.updated).toBe(5);
      expect(res.outcome.allVerified).toBe(true);
    } finally {
      await small.shutdown();
    }
  });
});

describe('undo', () => {
  it('restores previous values through reverse writes and refuses a second undo', async () => {
    const file = await fixture.put('undo-target.png');
    // Seed an SD-style original value.
    await writeSdMetadata(file);

    const edits = [{ tag: 'PNG:Description', op: 'set' as const, value: 'edited description' }];
    const env = await harness.pipeline.preview({ files: [file], edits });
    const res = await harness.pipeline.execute(env.preview.previewId);
    expect(res.outcome.files[0]?.status).toBe('updated');
    const batchId = res.outcome.batchId;

    // Two-step undo: preview, then confirm.
    const undoEnvelope = await harness.pipeline.prepareUndo(batchId);
    expect(undoEnvelope.preview.files[0]?.diffs[0]).toMatchObject({
      tag: 'PNG:Description',
      before: 'edited description',
    });
    const undone = await harness.pipeline.undoBatch(batchId);
    expect(undone.results.length).toBeGreaterThan(0);
    const undoOutcome = undone.results[0]?.outcome;
    expect(undoOutcome?.files[0]?.status).toBe('updated');
    expect(undoOutcome?.files[0]?.verified).toBe(true);

    const after = await readTagsOnce(file, ['PNG:Description']);
    expect(after['PNG:Description']).toBe('a cozy cabin in the woods, generated art');

    await expect(harness.pipeline.undoBatch(batchId)).rejects.toMatchObject({ code: 'already_undone' });
  });
});

describe('preview immutability of the originals', () => {
  it('leaves every file byte-identical after preview alone', async () => {
    const files: string[] = [];
    for (const name of ['immutable-1.png', 'immutable-2.png']) {
      files.push(await fixture.put(name));
    }
    const before = await Promise.all(
      files.map(async (f) => sha256(await readBytes(f))),
    );
    await harness.pipeline.preview({
      files,
      edits: [{ tag: 'XMP-dc:Description', op: 'set', value: 'preview only' }],
    });
    const after = await Promise.all(
      files.map(async (f) => sha256(await readBytes(f))),
    );
    expect(after).toEqual(before);
  });
});

describe('destructive gates', () => {
  it('refuse to execute without the typed phrase and the pre-write export', async () => {
    const file = await fixture.put('destructive.png');
    const env = await harness.pipeline.preview({
      files: [file],
      edits: [{ tag: 'XMP-dc:Description', op: 'delete' }],
      destructive: {
        scope: 'ai-generation-metadata',
        confirmationPhrase: 'REMOVE AI METADATA',
        allowedDeleteTags: ['XMP-dc:Description'],
      },
    });
    await expect(harness.pipeline.execute(env.preview.previewId)).rejects.toMatchObject({
      code: 'destructive_confirmation_required',
    });
    await expect(
      harness.pipeline.execute(env.preview.previewId, { destructive: { confirmationPhrase: 'wrong' } }),
    ).rejects.toMatchObject({ code: 'destructive_confirmation_required' });

    // Right phrase, but no export attached yet: still refused.
    await expect(
      harness.pipeline.execute(env.preview.previewId, {
        destructive: { confirmationPhrase: 'REMOVE AI METADATA' },
      }),
    ).rejects.toMatchObject({ code: 'destructive_confirmation_required' });

    // With the export attached, the gate passes and the delete runs verified.
    const exportPath = fixture.pathOf('export.json');
    await writeFile(exportPath, JSON.stringify({ values: [] }), 'utf8');
    harness.pipeline.setDestructiveExport(env.preview.previewId, exportPath);
    const res = await harness.pipeline.execute(env.preview.previewId, {
      destructive: { confirmationPhrase: 'REMOVE AI METADATA' },
    });
    expect(res.outcome.files[0]?.status).toBe('unchanged'); // nothing to delete on this clean file
  });

  it('rejects non-delete edits and unlisted tags on the destructive path', async () => {
    const file = await fixture.put('destructive-shape.png');
    await expect(
      harness.pipeline.preview({
        files: [file],
        edits: [{ tag: 'XMP-dc:Description', op: 'set', value: 'x' }],
        destructive: {
          scope: 'ai-generation-metadata',
          confirmationPhrase: 'REMOVE AI METADATA',
          allowedDeleteTags: ['XMP-dc:Description'],
        },
      }),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      harness.pipeline.preview({
        files: [file],
        edits: [{ tag: 'EXIF:UserComment', op: 'delete' }],
        destructive: {
          scope: 'ai-generation-metadata',
          confirmationPhrase: 'REMOVE AI METADATA',
          allowedDeleteTags: ['XMP-dc:Description'],
        },
      }),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('rejects a destructive option on a non-destructive preview', async () => {
    const file = await fixture.put('nondestructive.png');
    const env = await harness.pipeline.preview({
      files: [file],
      edits: [{ tag: 'XMP-dc:Title', op: 'set', value: 'plain edit' }],
    });
    await expect(
      harness.pipeline.execute(env.preview.previewId, {
        destructive: { confirmationPhrase: 'REMOVE AI METADATA' },
      }),
    ).rejects.toMatchObject({ code: 'validation' });
  });
});

describe('WritePipelineError shape', () => {
  it('carries machine codes the routes can map', async () => {
    const error = new WritePipelineError('preview_required', 'test');
    expect(error.code).toBe('preview_required');
    expect(error.name).toBe('WritePipelineError');
  });
});
