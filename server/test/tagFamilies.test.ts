/**
 * The ONE tag-family facts module (issue #22, arch-review Candidate 8):
 * the exif group-family table used to exist twice (writePipeline +
 * scrub's GROUP_TO_BASE) and matchesTagKey lived inside the pipeline,
 * forcing readback to import it back through a deliberate ESM cycle.
 * Pure unit tests — no engine.
 */
import { describe, expect, it } from 'vitest';
import { groupFamilyBase, matchesTagKey } from '../src/services/tagFamilies.js';

describe('matchesTagKey — the one family matcher', () => {
  it('accepts a written EXIF tag surfacing under IFD0 (the documented drift)', () => {
    expect(matchesTagKey('IFD0:Software', 'EXIF:Software')).toBe(true);
  });

  it('accepts every exif-family group (gps, exififd, subifd, interopifd)', () => {
    for (const group of ['EXIF', 'IFD0', 'ExifIFD', 'GPS', 'SubIFD', 'InteropIFD']) {
      expect(matchesTagKey(`${group}:Software`, 'EXIF:Software')).toBe(true);
    }
  });

  it('a group-less requested tag matches any group with the right bare name', () => {
    expect(matchesTagKey('XMP-dc:Title', 'Title')).toBe(true);
    expect(matchesTagKey('IPTC:Caption-Abstract', 'Caption-Abstract')).toBe(true);
  });

  it('rejects a different bare tag name even in an accepted group', () => {
    expect(matchesTagKey('IFD0:Make', 'EXIF:Software')).toBe(false);
  });

  it('rejects a group outside the family (XMP is not EXIF)', () => {
    expect(matchesTagKey('XMP-dc:Software', 'EXIF:Software')).toBe(false);
  });

  it('an unknown requested group accepts only itself (no invented families)', () => {
    expect(matchesTagKey('Custom:Thing', 'Custom:Thing')).toBe(true);
    expect(matchesTagKey('Other:Thing', 'Custom:Thing')).toBe(false);
  });

  it('is case-insensitive on both sides', () => {
    expect(matchesTagKey('ifd0:software', 'exif:Software')).toBe(true);
  });
});

describe('groupFamilyBase — DERIVED from the one family table (no second copy)', () => {
  it('maps every exif-family group to the exif base', () => {
    for (const group of ['exif', 'ifd0', 'exififd', 'gps', 'subifd', 'interopifd']) {
      expect(groupFamilyBase(group)).toBe('exif');
    }
  });

  it('maps singleton families to themselves', () => {
    expect(groupFamilyBase('png')).toBe('png');
    expect(groupFamilyBase('iptc')).toBe('iptc');
    expect(groupFamilyBase('xmp-dc')).toBe('xmp-dc');
    expect(groupFamilyBase('xmp-mwg-rs')).toBe('xmp-mwg-rs');
  });

  it('an unknown group is its own base (exact-match fallback)', () => {
    expect(groupFamilyBase('custom')).toBe('custom');
  });

  it('is case-insensitive', () => {
    expect(groupFamilyBase('IFD0')).toBe('exif');
  });
});
