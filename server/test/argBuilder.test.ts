/**
 * Unit tests for the argument builder and the engine boundary: golden argv
 * arrays, whitelist enforcement, value-slot discipline, and the structural
 * impossibility of -overwrite_original*.
 */
import { describe, expect, it } from 'vitest';
import {
  ArgBuildError,
  ALLOWED_WRITE_TAGS,
  buildJsonReadArgs,
  buildListxArgs,
  buildReadArgs,
  buildVersionArgs,
  buildWriteArgs,
  isValidTagShape,
  toValueSlot,
  validateWritableTag,
} from '../src/engine/argBuilder.js';
import {
  UnsafeArgumentError,
  assertArgSafe,
  assertArgsSafe,
  isOverwriteFlag,
} from '../src/engine/engineArgs.js';

const ABS = (name: string) => `C:\\photos\\${name}`;

describe('value slot discipline', () => {
  it('accepts ordinary text, unicode, quotes and percent signs', () => {
    expect(toValueSlot('hello world')).toBe('hello world');
    expect(toValueSlot('照片 ☕ café')).toBe('照片 ☕ café');
    expect(toValueSlot('a"b\'c')).toBe('a"b\'c');
    expect(toValueSlot('50%#off=1')).toBe('50%#off=1');
    expect(toValueSlot('#hashtag-like value')).toBe('#hashtag-like value');
    expect(toValueSlot('=not grammar=')).toBe('=not grammar=');
  });

  it('rejects empty values (empty means leave unchanged, never delete)', () => {
    expect(() => toValueSlot('')).toThrowError(ArgBuildError);
  });

  it('rejects embedded newlines and NUL at the boundary', () => {
    expect(() => toValueSlot('line1\nline2')).toThrowError(/line break/);
    expect(() => toValueSlot('line1\rline2')).toThrowError(/line break/);
    expect(() => toValueSlot('a\0b')).toThrowError(/line break/);
  });

  it('rejects values that begin with -', () => {
    expect(() => toValueSlot('-All=')).toThrowError(/start with/);
  });
});

describe('tag validation', () => {
  it('accepts group-qualified names including hyphenated groups', () => {
    expect(isValidTagShape('XMP-dc:Description')).toBe(true);
    expect(isValidTagShape('IPTC:By-line')).toBe(true);
    expect(isValidTagShape('EXIF:DateTimeOriginal')).toBe(true);
  });

  it('rejects wildcards, operators, whitespace and the All group', () => {
    expect(isValidTagShape('*')).toBe(false);
    expect(isValidTagShape('EXIF:All')).toBe(false);
    expect(isValidTagShape('All')).toBe(false);
    expect(isValidTagShape('EXIF:CreateDate+=1')).toBe(false);
    expect(isValidTagShape('EXIF:Create Date')).toBe(false);
    expect(isValidTagShape('')).toBe(false);
  });

  it('enforces the compile-time write whitelist', () => {
    expect(() => validateWritableTag('EXIF:All')).toThrowError(/not a valid tag name/);
    expect(() => validateWritableTag('FileName')).toThrowError(/not in the editable field set/);
    expect(() => validateWritableTag('PDF-update:all')).toThrowError(/not a valid tag name/);
    expect(() => validateWritableTag('IPTC:Keywords')).not.toThrow();
    expect(ALLOWED_WRITE_TAGS.has('XMP-dc:Subject')).toBe(true);
  });
});

describe('buildWriteArgs golden argv', () => {
  it('emits one -TAG=VALUE argument per set op, file paths last', () => {
    const argv = buildWriteArgs([ABS('a.png'), ABS('b.png')], [
      { tag: 'PNG:Parameters', op: 'set', value: 'test prompt' },
      { tag: 'XMP-dc:Description', op: 'set', value: 'hello world' },
    ]);
    expect(argv).toEqual([
      '-PNG:Parameters=test prompt',
      '-XMP-dc:Description=hello world',
      'C:\\photos\\a.png',
      'C:\\photos\\b.png',
    ]);
  });

  it('emits += and -= only for explicit list operations', () => {
    const argv = buildWriteArgs([ABS('a.png')], [
      { tag: 'IPTC:Keywords', op: 'append', value: 'sunset' },
      { tag: 'IPTC:Keywords', op: 'remove', value: 'old' },
    ]);
    expect(argv).toEqual(['-IPTC:Keywords+=sunset', '-IPTC:Keywords-=old', 'C:\\photos\\a.png']);
  });

  it('emits a bare -TAG= only for an explicit delete op with no value', () => {
    const argv = buildWriteArgs([ABS('a.png')], [{ tag: 'XMP-dc:Subject', op: 'delete' }]);
    expect(argv).toEqual(['-XMP-dc:Subject=', 'C:\\photos\\a.png']);
  });

  it('refuses a delete op that carries a value', () => {
    expect(() =>
      buildWriteArgs([ABS('a.png')], [{ tag: 'XMP-dc:Subject', op: 'delete', value: 'x' }]),
    ).toThrowError(/takes no value/);
  });

  it('refuses an empty set value instead of translating it into a delete', () => {
    expect(() =>
      buildWriteArgs([ABS('a.png')], [{ tag: 'PNG:Parameters', op: 'set', value: '' }]),
    ).toThrowError(/leave the tag unchanged|needs a value/i);
  });

  it('refuses non-whitelisted and option-shaped tags', () => {
    expect(() => buildWriteArgs([ABS('a.png')], [{ tag: 'All', op: 'delete' }])).toThrowError(
      ArgBuildError,
    );
    expect(() =>
      buildWriteArgs([ABS('a.png')], [{ tag: 'FileName', op: 'set', value: 'renamed.png' }]),
    ).toThrowError(/not in the editable field set/);
  });

  it('refuses relative file paths', () => {
    expect(() =>
      buildWriteArgs(['relative.png'], [{ tag: 'PNG:Parameters', op: 'set', value: 'x' }]),
    ).toThrowError(/absolute/);
  });

  it('produces argv that the engine boundary accepts', () => {
    const argv = buildWriteArgs([ABS('a.png')], [
      { tag: 'PNG:Parameters', op: 'set', value: 'prompt with spaces' },
    ]);
    expect(() => assertArgsSafe(argv)).not.toThrow();
  });
});

describe('buildReadArgs', () => {
  it('defaults to the -j -G1 -a -struct inspection payload', () => {
    expect(buildJsonReadArgs([ABS('a.png')])).toEqual([
      '-j',
      '-G1',
      '-a',
      '-struct',
      'C:\\photos\\a.png',
    ]);
  });

  it('supports extension filters, recursion and fast tiers', () => {
    const argv = buildReadArgs([ABS('dir')], {
      json: false,
      groupNames: false,
      duplicates: false,
      struct: false,
      recursive: true,
      extensions: ['jpg', 'png'],
      fast: 3,
    });
    expect(argv).toEqual(['-r', '-fast3', '-ext', 'jpg', '-ext', 'png', 'C:\\photos\\dir']);
  });

  it('rejects malformed extensions and relative paths', () => {
    expect(() => buildReadArgs([ABS('a.png')], { extensions: ['-All'] })).toThrowError(
      ArgBuildError,
    );
    expect(() => buildReadArgs(['a.png'])).toThrowError(/absolute/);
    expect(() => buildReadArgs([])).toThrowError(/at least one file/);
  });
});

describe('one-shot builders', () => {
  it('buildVersionArgs and buildListxArgs are fixed', () => {
    expect(buildVersionArgs()).toEqual(['-ver']);
    expect(buildListxArgs()).toEqual(['-listx', '-f']);
  });
});

describe('overwrite flags are structurally impossible', () => {
  it('the OverwriteFlag type accepts nothing and the runtime scan rejects spellings', () => {
    expect(isOverwriteFlag('-overwrite_original')).toBe(true);
    expect(isOverwriteFlag('-overwrite_original_in_place')).toBe(true);
    expect(isOverwriteFlag('-OVERWRITE_original!')).toBe(true);
    expect(isOverwriteFlag('--overwrite_original')).toBe(true);
    expect(isOverwriteFlag('-j')).toBe(false);
    expect(isOverwriteFlag('-PNG:Parameters=overwrite_original')).toBe(false);
  });

  it('rejects an overwrite flag wherever it appears in the argv', () => {
    expect(() => assertArgSafe('-overwrite_original')).toThrowError(UnsafeArgumentError);
    expect(() => assertArgSafe('-overwrite_original_in_place')).toThrowError(
      /overwrite-original-forbidden/,
    );
  });
});

describe('engine argument boundary', () => {
  it('rejects arguments that would break argfile framing', () => {
    expect(() => assertArgSafe('a\nb')).toThrowError(/embedded-newline/);
    expect(() => assertArgSafe('')).toThrowError(/empty-argument/);
    expect(() => assertArgSafe('#comment-like')).toThrowError(/leading-hash/);
    expect(() => assertArgSafe('--')).toThrowError(/double-dash-hangs-stay-open/);
    expect(() => assertArgSafe('-')).toThrowError(/bare-dash/);
    expect(() => assertArgsSafe(['-j', 'C:\\photos\\a.png'])).not.toThrow();
  });

  it('rejects option-shaped tokens that are neither known options nor tag grammar', () => {
    // Tag grammar is broad on purpose (catalog tags must pass through), but
    // tokens with characters outside that grammar are refused here rather
    // than being silently reinterpreted by exiftool.
    expect(() => assertArgSafe('-two words')).toThrowError(/unrecognized-option-shaped-argument/);
    expect(() => assertArgSafe('-semi;colon')).toThrowError(/unrecognized-option-shaped-argument/);
    expect(() => assertArgSafe('-common_args')).not.toThrow(); // known option
    expect(() => assertArgSafe('-PNG:Parameters=x')).not.toThrow(); // tag grammar
  });
});
