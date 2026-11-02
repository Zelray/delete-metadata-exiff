/**
 * The file-set module (issue #16, arch-review Candidate 2): ONE owner for
 * "which files am I operating on" — the case-insensitive name filter, the
 * scope derivation (explicit selection/filtered toggle, auto
 * selection-else-filtered, optional cap), and the one badge truth
 * (session-learned badges override scan-time warnings).
 */
import { describe, expect, it } from 'vitest';
import type { FileEntry } from '@metadesk/shared';
import type { FileBadges } from '../state/store';
import { fileSet, filterByName, hasCopyright, hasGps } from './fileSet';

function entry(name: string, warnings: string[] = []): FileEntry {
  return {
    path: `C:\\photos\\${name}`,
    name,
    extension: name.slice(name.lastIndexOf('.') + 1).toLowerCase(),
    sizeBytes: 100,
    modifiedAt: '2026-11-02T00:00:00Z',
    kind: 'png',
    warnings,
  };
}

const A = entry('a.png');
const BEE = entry('Bee.PNG');
const SEA = entry('sea.jpg', ['badge:gps-present']);
const DEE = entry('d.jpg', ['badge:copyright-present']);

describe('filterByName', () => {
  it('matches case-insensitively and keeps everything for a blank needle', () => {
    const entries = [A, BEE, SEA];
    expect(filterByName(entries, '  ').map((e) => e.path)).toEqual([A.path, BEE.path, SEA.path]);
    expect(filterByName(entries, 'bee').map((e) => e.name)).toEqual(['Bee.PNG']);
    expect(filterByName(entries, 'BEE').map((e) => e.name)).toEqual(['Bee.PNG']);
    expect(filterByName(entries, 'zzz')).toEqual([]);
  });
});

describe('badge truth (one source: session-learned overrides scan warning)', () => {
  const badges: Record<string, FileBadges> = {
    [A.path]: { hasGps: true, hasCopyright: false, aiGenerated: null }, // learned: overrides scan
  };

  it('prefers the session-learned badge when the file is known', () => {
    // A carries NO scan-time GPS warning, but the session learned it has GPS.
    expect(hasGps(A, badges)).toBe(true);
    expect(hasCopyright(A, badges)).toBe(false);
  });

  it('falls back to the scan-time warning when nothing was learned yet', () => {
    expect(hasGps(SEA, {})).toBe(true);
    expect(hasGps(BEE, {})).toBe(false);
    expect(hasCopyright(DEE, {})).toBe(true);
    expect(hasCopyright(BEE, {})).toBe(false);
  });

  it('a learned false overrides a scan-time warning (fresher knowledge wins)', () => {
    const stripped: Record<string, FileBadges> = {
      [SEA.path]: { hasGps: false, hasCopyright: false, aiGenerated: null },
    };
    expect(hasGps(SEA, stripped)).toBe(false);
  });
});

describe('fileSet scope derivation', () => {
  const entries = [A, BEE, SEA, DEE];

  it("mode 'selection' uses the selection as-is, even when empty (BatchPanel's toggle)", () => {
    const input = { entries, selectedPaths: [A.path], searchText: '' };
    expect(fileSet(input, { mode: 'selection' }).files).toEqual([A.path]);
    expect(fileSet(input, { mode: 'selection' }).base).toBe('selection');
    expect(fileSet({ ...input, selectedPaths: [] }, { mode: 'selection' }).files).toEqual([]);
  });

  it("mode 'filtered' uses the name-filtered folder paths", () => {
    const input = { entries, selectedPaths: [A.path], searchText: 'sea' };
    const result = fileSet(input, { mode: 'filtered' });
    expect(result.files).toEqual([SEA.path]);
    expect(result.base).toBe('filtered');
  });

  it("mode 'auto' is selection-else-filtered (ScrubWizard's implicit rule)", () => {
    const input = { entries, selectedPaths: [DEE.path], searchText: '' };
    expect(fileSet(input, { mode: 'auto' }).files).toEqual([DEE.path]);
    expect(fileSet({ ...input, selectedPaths: [] }, { mode: 'auto' }).files).toEqual([
      A.path,
      BEE.path,
      SEA.path,
      DEE.path,
    ]);
    expect(fileSet({ ...input, selectedPaths: [] }, { mode: 'auto' }).base).toBe('filtered');
  });

  it('caps AFTER measuring truncation (ScrubWizard compares the pre-cap base)', () => {
    const many = Array.from({ length: 5 }, (_, i) => entry(`f${i}.png`));
    const input = { entries: many, selectedPaths: [], searchText: '' };
    const result = fileSet(input, { mode: 'auto', cap: 3 });
    expect(result.files).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(fileSet(input, { mode: 'auto', cap: 5 }).truncated).toBe(false);
    // Exactly at the cap is not truncated (cap 5, five files); above it is.
    expect(fileSet(input, { mode: 'auto', cap: 4 }).truncated).toBe(true);
  });

  it('applies badge conditions with the one badge truth (BatchPanel chips)', () => {
    const input = { entries, selectedPaths: [], searchText: '' };
    const badges: Record<string, FileBadges> = {
      [A.path]: { hasGps: true, hasCopyright: false, aiGenerated: null }, // learned GPS, no scan warning
    };
    const gps = fileSet(input, { mode: 'filtered', badges, onlyWithGps: true });
    // The learned badge counts even without a scan warning; the scan warning counts when unlearned.
    expect(gps.files.sort()).toEqual([A.path, SEA.path].sort());

    const noCopyright = fileSet(input, { mode: 'filtered', badges, onlyMissingCopyright: true });
    expect(noCopyright.files).not.toContain(DEE.path);
    expect(noCopyright.files.sort()).toEqual([A.path, BEE.path, SEA.path].sort());
  });

  it('keeps unknown paths (path not in the scan) when conditions are set', () => {
    // BatchPanel's rule today: an entry the scan does not know is kept, not
    // silently dropped, because the conditions cannot be evaluated for it.
    const ghost = 'C:\\elsewhere\\ghost.png';
    const result = fileSet(
      { entries, selectedPaths: [ghost, DEE.path], searchText: '' },
      { mode: 'selection', onlyWithGps: true },
    );
    expect(result.files).toEqual([ghost]);
  });
});
