import { describe, expect, it } from 'vitest';
import { explainArg, hasCuratedExplanation } from './argvHelp';

describe('argv plain-English explanations', () => {
  it('explains the classic read invocation tokens', () => {
    for (const token of ['-j', '-G1', '-a', '-struct', '-n', '-r', '-ext', '-ver']) {
      expect(hasCuratedExplanation(token)).toBe(true);
      expect(explainArg(token)).not.toMatch(/exiftool option -j —/);
    }
  });

  it('falls back to a safe generic explanation for unknown options', () => {
    const text = explainArg('-someNewOption');
    expect(text).toContain('-someNewOption');
    expect(text).toContain('read-only validator');
  });

  it('recognizes absolute Windows and UNC paths', () => {
    expect(explainArg('C:\\Photos\\IMG_2041.jpg')).toContain('absolute path');
    expect(explainArg('\\\\NAS\\share\\a.jpg')).toContain('absolute path');
  });

  it('treats bare words as plain values', () => {
    expect(explainArg('IMG_2041.jpg')).toContain('plain value');
  });
});
