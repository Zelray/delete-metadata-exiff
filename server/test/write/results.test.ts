/**
 * Three-valued results: summary parsing from the engine's exact wording
 * (verified against the vendored source's printf formats), manifest
 * classification for a mixed batch, plain-English failure explanations, and
 * the retry-list policy.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyFiles,
  explainFailure,
  parseSummary,
  retryList,
  summarizeConsistency,
} from '../../src/services/results.js';
import { normalizeExifPath } from '../../src/services/exifPath.js';

describe('parseSummary', () => {
  it('parses the engine summary line set (padded counts, stdout or stderr)', () => {
    const text = [
      '    1 directories scanned',
      '    2 image files created',
      '    3 image files updated',
      '    4 image files unchanged',
      '    5 image files copied',
      "    6 files weren't updated due to errors",
      "    7 files weren't created due to errors",
      '    8 files could not be read',
      '    9 files failed condition',
    ].join('\r\n');
    const counts = parseSummary(text);
    expect(counts).toEqual({
      directoriesScanned: 1,
      filesFailedCondition: 9,
      imageFilesCreated: 2,
      imageFilesUpdated: 3,
      imageFilesUnchanged: 4,
      imageFilesCopied: 5,
      notUpdatedDueToErrors: 6,
      notCreatedDueToErrors: 7,
      filesCouldNotBeRead: 8,
    });
  });

  it('returns all zeros for output without a summary block', () => {
    expect(parseSummary('nothing happened at all')).toEqual(
      parseSummary(''),
    );
  });
});

describe('classifyFiles', () => {
  const requested = ['C:\\pics\\a.png', 'C:\\pics\\b.png', 'C:\\pics\\c.png', 'C:\\pics\\d.png'];

  it('classifies a mixed batch from manifests (forward slashes, case-insensitive)', () => {
    const classified = classifyFiles(requested, {
      errors: ['C:/pics/d.png'],
      unchanged: ['c:\\PICS\\B.png'],
      updated: ['C:/pics/a.png'],
    });
    expect(classified).toEqual([
      { filePath: requested[0], status: 'updated', fallback: false },
      { filePath: requested[1], status: 'unchanged', fallback: false },
      { filePath: requested[2], status: 'failed', fallback: true },
      { filePath: requested[3], status: 'failed', fallback: false },
    ]);
  });

  it('treats an empty manifest set as "nothing happened" for every file', () => {
    const classified = classifyFiles(requested, { errors: [], unchanged: [], updated: [] });
    expect(classified.every((c) => c.status === 'failed' && c.fallback)).toBe(true);
  });

  it('counts created (-o scratch) files as updated', () => {
    const classified = classifyFiles(['C:\\x\\s.png'], {
      errors: [],
      unchanged: [],
      updated: [],
      created: ['C:/x/s.png'],
    });
    expect(classified[0]?.status).toBe('updated');
  });
});

describe('summarizeConsistency', () => {
  it('reports honest noise when manifests and summary disagree', () => {
    const notes = summarizeConsistency(parseSummary('    2 image files updated'), {
      errors: [],
      unchanged: [],
      updated: ['C:/x/a.png'],
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/2 updated file\(s\) but listed 1/);
  });

  it('is silent when everything agrees', () => {
    const notes = summarizeConsistency(parseSummary('    1 image files updated'), {
      errors: [],
      unchanged: [],
      updated: ['C:/x/a.png'],
    });
    expect(notes).toEqual([]);
  });
});

describe('explainFailure', () => {
  it('explains a locked file (rename failure) with a concrete fix', () => {
    const e = explainFailure('Error renaming C:/pics/a.png');
    expect(e.code).toBe('file-locked');
    expect(e.suggestedFix).toMatch(/Close photo viewers|pause OneDrive/i);
  });

  it('explains permission errors, missing files, unsupported tags, disk full, orphan temps', () => {
    expect(explainFailure('Error: Permission denied - C:/x.png').code).toBe('permission-denied');
    expect(explainFailure('Error: File not found - C:/x.png').code).toBe('file-missing');
    expect(explainFailure("Warning: Tag 'PNG:Prompt' is not defined").code).toBe('unsupported-tag');
    expect(explainFailure('Error: No space left on device').code).toBe('disk-full');
    expect(explainFailure('Error: Temporary file already exists - C:/x.png').code).toBe(
      'temporary-file-exists',
    );
  });

  it('never throws on unrecognized messages (unknown-error fallback)', () => {
    const e = explainFailure('something completely unexplained happened');
    expect(e.code).toBe('unknown-error');
    expect(e.title.length).toBeGreaterThan(0);
  });
});

describe('retryList', () => {
  it('includes write/preflight/verify failures and excludes backup-verification failures', () => {
    const retry = retryList([
      { filePath: 'a', status: 'updated' },
      { filePath: 'b', status: 'unchanged' },
      { filePath: 'c', status: 'failed', stage: 'write' },
      { filePath: 'd', status: 'failed', stage: 'backup' },
      { filePath: 'e', status: 'failed', stage: 'verify' },
    ]);
    expect(retry).toEqual(['c', 'e']);
  });
});

describe('normalizeExifPath', () => {
  it('folds backslashes to forward slashes', () => {
    expect(normalizeExifPath('C:\\pics\\a.png')).toBe('c:/pics/a.png');
  });

  it('lowers ASCII case', () => {
    expect(normalizeExifPath('C:/PICS/A.PNG')).toBe('c:/pics/a.png');
  });

  it('normalizes a UNC spelling to a leading double slash', () => {
    expect(normalizeExifPath('\\\\srv\\share\\X.JPG')).toBe('//srv/share/x.jpg');
  });

  it('keys the \\\\?\\ device form as a key, not a usable path', () => {
    // The key mangles the extended-length prefix on purpose: this value is
    // for map lookups only — never a path handed to the fs or the engine.
    expect(normalizeExifPath('\\\\?\\C:\\pics\\a.PNG')).toBe('//?/c:/pics/a.png');
  });

  it('passes CJK filenames through unchanged beyond case and slashes', () => {
    expect(normalizeExifPath('C:\\照片\\照片.PNG')).toBe('c:/照片/照片.png');
  });

  it('is idempotent', () => {
    const once = normalizeExifPath('C:\\PICS\\照片.PNG');
    expect(normalizeExifPath(once)).toBe(once);
  });

  it('does not over-normalize (no Unicode NFC, no trimming, no short-name resolution)', () => {
    const nfdName = 'cafe\u0301'; // NFD spelling of "café" — stays decomposed
    expect(normalizeExifPath(`C:\\pics\\${nfdName}.PNG`)).toBe(`c:/pics/${nfdName}.png`);
    expect(normalizeExifPath('  C:/pics/a.PNG  ')).toBe('  c:/pics/a.png  ');
    expect(normalizeExifPath('C:\\PICS\\RUNNER~1.PNG')).toBe('c:/pics/runner~1.png');
  });
});
