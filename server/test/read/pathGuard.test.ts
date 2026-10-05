/**
 * Path guard unit tests: the data-safety #11 boundary. Hostile-but-legal
 * names (--All=, %, #, CJK, emoji) must PASS (absolute argv addressing is the
 * safety mechanism, not name refusal); relative paths, traversal, wildcards,
 * control characters, stream colons and Win32 quirk names must FAIL with
 * human messages.
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { PathRejectedError, assertSafePath, inspectPath, probeReadable } from '../../src/services/pathGuard.js';

describe('pathGuard accepts', () => {
  it('ordinary absolute windows paths', () => {
    expect(inspectPath('C:\\photos\\img.jpg')).toEqual({ ok: true, path: 'C:\\photos\\img.jpg' });
    expect(inspectPath('C:/photos/img.jpg').ok).toBe(true);
    expect(inspectPath('d:\\').ok).toBe(true); // drive root
  });

  it('UNC paths by shape', () => {
    const result = inspectPath('\\\\server\\share\\photo.jpg');
    expect(result.ok).toBe(true);
  });

  it('hostile-but-legal file names (absolute addressing makes them safe)', () => {
    for (const name of ['--All=', '-comment=x.jpg', '50%#off=.png', "a'b c.png", '照片 中文 (1).png', 'café ☕.png']) {
      const result = inspectPath(`C:\\fixture\\${name}`);
      expect(result.ok, name).toBe(true);
    }
  });
});

describe('pathGuard rejects', () => {
  const rejects = (input: unknown, reason: string) => {
    const result = inspectPath(input);
    expect(result.ok, JSON.stringify(input)).toBe(false);
    if (!result.ok) expect(result.reason, JSON.stringify(input)).toBe(reason);
  };

  it('empty and non-string input', () => {
    rejects('', 'empty');
    rejects(undefined, 'not-a-string');
    rejects(42, 'not-a-string');
  });

  it('relative paths (exiftool could read them as options/tags)', () => {
    rejects('photos', 'not-absolute');
    rejects('./photos', 'not-absolute');
    rejects('--All=', 'not-absolute');
    rejects('C:photos', 'not-absolute'); // drive-relative
  });

  it('traversal segments', () => {
    rejects('C:\\photos\\..\\windows\\system32', 'traversal');
    rejects('..', 'not-absolute');
  });

  it('wildcards anywhere (glob grammar, unproducible on NTFS)', () => {
    rejects('C:\\photos\\*.jpg', 'wildcard');
    rejects('C:\\photos\\img?.jpg', 'wildcard');
  });

  it('control characters including embedded newlines', () => {
    rejects('C:\\photos\\a\nb.png', 'control-characters');
    rejects('C:\\photos\\a\tb.png', 'control-characters');
  });

  it('double quotes (illegal on NTFS)', () => {
    rejects('C:\\photos\\a"b.png', 'double-quote');
  });

  it('NTFS alternate-data-stream colons', () => {
    rejects('C:\\photos\\file.jpg:hidden', 'stream-colon');
  });

  it('Win32 quirk names (trailing space or dot)', () => {
    rejects('C:\\photos\\trailing dot.', 'trailing-space-or-dot');
    rejects('C:\\photos\\trailing space ', 'trailing-space-or-dot');
  });

  it('paths longer than 240 characters with a human message', () => {
    const long = `C:\\${'a'.repeat(250)}.png`;
    const result = inspectPath(long);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/240 characters/);
  });

  it('leading option-like characters on the whole path', () => {
    rejects('%SystemRoot%\\temp', 'not-absolute'); // relative AND %-prefixed
  });

  it('throws PathRejectedError with the typed code from assertSafePath', () => {
    try {
      assertSafePath('relative\\path');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PathRejectedError);
      expect((error as PathRejectedError).code).toBe('path_rejected');
      expect((error as PathRejectedError).reason).toBe('not-absolute');
      expect((error as Error).message).toMatch(/absolute/);
    }
  });
});

describe('probeReadable', () => {
  it('throws a human-readable error for a missing target', async () => {
    await expect(probeReadable('C:\\definitely\\not\\here\\at\\all.txt')).rejects.toThrow(
      /could not be read/,
    );
  });

  it('succeeds for an existing file', async () => {
    await expect(probeReadable(fileURLToPath(import.meta.url))).resolves.toBeUndefined();
  });
});
