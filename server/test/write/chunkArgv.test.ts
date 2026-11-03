/**
 * The ONE chunk invocation seam (issue #20, arch-review Candidate 3):
 * buildChunkArgv owns the flags + edit args + -efile manifest wiring + files
 * layout that preview freezes, execute runs, and simulation extends with its
 * scratch difference. Pure unit tests — no engine, no real files; the
 * real-engine behavior net (hostile names, backups, verification, chunking,
 * undo) lives in writePipeline.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { buildChunkArgv } from '../../src/services/writePipeline.js';

describe('buildChunkArgv — the one chunk invocation', () => {
  it('spells the execute-mode argv: flags, edits, -efile1/2/8 wiring, files last, no -o', () => {
    const { argv, manifests } = buildChunkArgv({
      editArgv: ['-XMP-dc:Description=probe'],
      files: ['C:\\img\\a.png', 'C:\\img\\b.png'],
      manifestDir: 'C:\\data\\write-tmp\\pv1',
      manifestStem: 'chunk0',
      thirdBucket: 8,
      scratchOutputDir: null,
    });
    expect(argv).toEqual([
      '-use',
      'MWG',
      '-P',
      '-XMP-dc:Description=probe',
      '-efile1',
      'C:\\data\\write-tmp\\pv1\\chunk0-err.txt',
      '-efile2',
      'C:\\data\\write-tmp\\pv1\\chunk0-same.txt',
      '-efile8',
      'C:\\data\\write-tmp\\pv1\\chunk0-upd.txt',
      'C:\\img\\a.png',
      'C:\\img\\b.png',
    ]);
    // The manifests come back WITH the argv: the caller reads them again
    // after the run, and the wiring/naming contract stays in one place.
    expect(manifests).toEqual({
      errors: 'C:\\data\\write-tmp\\pv1\\chunk0-err.txt',
      unchanged: 'C:\\data\\write-tmp\\pv1\\chunk0-same.txt',
      third: 'C:\\data\\write-tmp\\pv1\\chunk0-upd.txt',
    });
  });

  it('spells the simulate-mode argv: -efile16 created bucket + the scratch -o redirect before the files', () => {
    const { argv, manifests } = buildChunkArgv({
      editArgv: ['-XMP:Title=sim'],
      files: ['C:\\img\\a.png'],
      manifestDir: 'C:\\data\\scratch\\pv1\\chunk0',
      manifestStem: 'sim',
      thirdBucket: 16,
      scratchOutputDir: 'C:\\data\\scratch\\pv1\\chunk0',
    });
    expect(argv).toEqual([
      '-use',
      'MWG',
      '-P',
      '-XMP:Title=sim',
      '-efile1',
      'C:\\data\\scratch\\pv1\\chunk0\\sim-err.txt',
      '-efile2',
      'C:\\data\\scratch\\pv1\\chunk0\\sim-same.txt',
      '-efile16',
      'C:\\data\\scratch\\pv1\\chunk0\\sim-created.txt',
      '-o',
      'C:\\data\\scratch\\pv1\\chunk0',
      'C:\\img\\a.png',
    ]);
    expect(manifests.third).toBe('C:\\data\\scratch\\pv1\\chunk0\\sim-created.txt');
  });

  it('derives all three manifest names from the stem, so every chunk writes its own', () => {
    const { manifests } = buildChunkArgv({
      editArgv: [],
      files: [],
      manifestDir: 'C:\\m',
      manifestStem: 'chunk3',
      thirdBucket: 8,
      scratchOutputDir: null,
    });
    expect(manifests.errors).toContain('chunk3-err.txt');
    expect(manifests.unchanged).toContain('chunk3-same.txt');
    expect(manifests.third).toContain('chunk3-upd.txt');
  });
});
