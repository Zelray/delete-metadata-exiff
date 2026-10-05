/**
 * Field-model unit tests (node env, no DOM): the safety semantics of
 * empty-means-unchanged, explicit deletes, date formatting/shifting, and the
 * chunk math live here because they are the load-bearing logic two views share.
 */
import { describe, expect, it } from 'vitest';
import {
  buildTagEdits,
  chunkEstimate,
  emptyStagedEdits,
  formatDateForExif,
  isStagedEmpty,
  parseExifDate,
  shiftExifDate,
} from './fields';

describe('buildTagEdits — empty means unchanged', () => {
  it('produces NO edits for a fully empty form', () => {
    expect(buildTagEdits(emptyStagedEdits())).toEqual([]);
    expect(isStagedEmpty(emptyStagedEdits())).toBe(true);
  });

  it('whitespace-only input is still "unchanged"', () => {
    const staged = { ...emptyStagedEdits(), title: '   ' };
    expect(buildTagEdits(staged)).toEqual([]);
  });

  it('a title writes BOTH MWG partners (XMP + IPTC) as set ops', () => {
    const staged = { ...emptyStagedEdits(), title: 'Summer trip' };
    expect(buildTagEdits(staged)).toEqual([
      { tag: 'XMP-dc:Title', op: 'set', value: 'Summer trip' },
      { tag: 'IPTC:ObjectName', op: 'set', value: 'Summer trip' },
    ]);
  });

  it('copyright writes the full MWG trio', () => {
    const staged = { ...emptyStagedEdits(), copyright: '(c) Mike' };
    const tags = buildTagEdits(staged).map((e) => e.tag);
    expect(tags).toEqual(['XMP-dc:Rights', 'EXIF:Copyright', 'IPTC:CopyrightNotice']);
  });

  it('keywords become append/remove list ops, one per tag', () => {
    const staged = { ...emptyStagedEdits(), addKeywords: ['beach'], removeKeywords: ['draft'] };
    expect(buildTagEdits(staged)).toEqual([
      { tag: 'XMP-dc:Subject', op: 'append', value: 'beach' },
      { tag: 'IPTC:Keywords', op: 'append', value: 'beach' },
      { tag: 'XMP-dc:Subject', op: 'remove', value: 'draft' },
      { tag: 'IPTC:Keywords', op: 'remove', value: 'draft' },
    ]);
  });

  it('a staged value never coexists with an armed delete for the same field', () => {
    const staged = { ...emptyStagedEdits(), title: 'Keep', deletes: ['description' as const] };
    const edits = buildTagEdits(staged);
    expect(edits.filter((e) => e.op === 'delete').map((e) => e.tag)).toEqual([
      'XMP-dc:Description',
      'EXIF:ImageDescription',
    ]);
    expect(edits.filter((e) => e.op === 'set').length).toBe(2);
  });

  it('delete-armed keywords skip the wipe when adds/removes are staged (UI disables it)', () => {
    const staged = {
      ...emptyStagedEdits(),
      addKeywords: ['keep'],
      deletes: ['keywords' as const],
    };
    expect(buildTagEdits(staged)).toEqual([
      { tag: 'XMP-dc:Subject', op: 'append', value: 'keep' },
      { tag: 'IPTC:Keywords', op: 'append', value: 'keep' },
    ]);
  });
});

describe('dates and timezones', () => {
  it('formats datetime-local into the EXIF-stored form', () => {
    expect(formatDateForExif('2026-06-01T14:30', 'none')).toBe('2026:06:01 14:30:00');
    expect(formatDateForExif('2026-06-01T14:30', '+02:00')).toBe('2026:06:01 14:30:00+02:00');
  });

  it('shifts wall-clock time and carries the timezone decision', () => {
    expect(shiftExifDate('2026:06:01 14:30:00', { amount: 2, unit: 'hours' }, 'none')).toBe(
      '2026:06:01 16:30:00',
    );
    expect(shiftExifDate('2026:06:01 14:30:00', { amount: -90, unit: 'minutes' }, '+01:00')).toBe(
      '2026:06:01 13:00:00+01:00',
    );
    expect(shiftExifDate('2026:12:31 23:30:00', { amount: 1, unit: 'hours' }, 'none')).toBe(
      '2027:01:01 00:30:00',
    );
  });

  it('shifts preserve an existing offset only when asked', () => {
    const parsed = parseExifDate('2026:06:01 14:30:00-04:00');
    expect(parsed).not.toBeNull();
    expect(shiftExifDate('2026:06:01 14:30:00-04:00', { amount: 1, unit: 'days' }, 'none')).toBe(
      '2026:06:02 14:30:00',
    );
  });

  it('refuses garbage gracefully (null, never a crash)', () => {
    expect(shiftExifDate('not a date', { amount: 1, unit: 'days' }, 'none')).toBeNull();
    expect(parseExifDate('')).toBeNull();
  });
});

describe('chunk math', () => {
  it('matches the server chunk size for honest modal copy', () => {
    expect(chunkEstimate(0)).toBe(0);
    expect(chunkEstimate(1)).toBe(1);
    expect(chunkEstimate(200)).toBe(1);
    expect(chunkEstimate(201)).toBe(2);
    expect(chunkEstimate(1000)).toBe(5);
  });
});
