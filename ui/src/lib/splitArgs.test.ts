import { describe, expect, it } from 'vitest';
import { splitArgs } from './splitArgs';

describe('splitArgs', () => {
  it('splits on whitespace and drops empties', () => {
    expect(splitArgs('  -j   -G1  C:\\Photos  ')).toEqual(['-j', '-G1', 'C:\\Photos']);
  });

  it('keeps quoted spaces together (double quotes)', () => {
    expect(splitArgs('-j "C:\\My Photos\\holiday 2026"')).toEqual([
      '-j',
      'C:\\My Photos\\holiday 2026',
    ]);
  });

  it('keeps quoted spaces together (single quotes)', () => {
    expect(splitArgs("'-j' -a 'two words'")).toEqual(['-j', '-a', 'two words']);
  });

  it('handles empty quoted tokens', () => {
    expect(splitArgs('a "" b')).toEqual(['a', '', 'b']);
  });

  it('never invents shell operators — tokens pass through verbatim', () => {
    expect(splitArgs('-x|=rm -rf -TAG=del --All=')).toEqual(['-x|=rm', '-rf', '-TAG=del', '--All=']);
  });

  it('returns empty for blank input', () => {
    expect(splitArgs('')).toEqual([]);
    expect(splitArgs('   \t ')).toEqual([]);
  });
});
