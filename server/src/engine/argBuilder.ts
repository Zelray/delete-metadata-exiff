/**
 * The argument builder — the only module allowed to turn intents into
 * exiftool arguments, and the place the GUI's safety rules are enforced in
 * code rather than in documentation.
 *
 * Invariants, all enforced here:
 *
 *  1. Output is ALWAYS an argv array. There is no function in this module
 *     that produces a command string, and every spawn in the engine passes
 *     `shell: false`.
 *  2. User text can only ever occupy the VALUE slot of exactly one
 *     `-TAG=VALUE` argument. It reaches this module through
 *     {@link toValueSlot}, which validates it; nothing else accepts free text.
 *  3. Tag names come from a whitelist: the curated field table (compile-time)
 *     or, for reads, the `-listx` catalog. Free-form tag entry is impossible.
 *  4. `-TAG=` (delete) is emitted ONLY for an explicit `delete` op with no
 *     value. An empty value for a `set` op is rejected, never interpreted as
 *     a deletion — "empty means leave unchanged" is structural.
 *  5. `-overwrite_original` and `-overwrite_original_in_place` are
 *     structurally impossible: a `never` type no API can accept, plus a
 *     runtime scan of every produced argv, plus the engineArgs boundary.
 *  6. Values with embedded newlines (argfile line-splitting injection) or a
 *     leading `-` (grammar injection) are rejected at this boundary.
 *  7. File arguments are always ABSOLUTE paths. An absolute path can never be
 *     mistaken for an option (it starts with a drive letter), which is how a
 *     file literally named `--All=` is addressed safely. Verified against the
 *     vendored engine: a `--` end-of-options separator is accepted in one-shot
 *     mode but HANGS the -stay_open protocol (the command never executes and
 *     no `{readyN}` is emitted), so this builder never emits `--`.
 */
import path from 'node:path';
import type { TagCatalog, TagWriteIntent, CuratedFieldKey } from '@metadesk/shared';
import { assertArgsSafe, isOverwriteFlag } from './engineArgs.js';

/** A user string that has passed value validation. Branded so that only
 *  {@link toValueSlot} can produce one. */
declare const valueSlotBrand: unique symbol;
export type ValueSlot = string & { readonly [valueSlotBrand]: true };

/** Vetting arguments produced by this module (never hand-written arrays). */
declare const writeArgvBrand: unique symbol;
export type WriteArgv = readonly string[] & { readonly [writeArgvBrand]: true };

declare const readArgvBrand: unique symbol;
export type ReadArgv = readonly string[] & { readonly [readArgvBrand]: true };

/** The type of a forbidden overwrite flag: nothing can construct one. */
export type OverwriteFlag = never;

/** Maximum length for a single tag value. */
export const MAX_VALUE_LENGTH = 8192;

/**
 * Validate and brand a user-supplied value for the VALUE slot of one
 * `-TAG=VALUE` argument. This is the ONLY doorway for user text into argv.
 */
export function toValueSlot(input: string): ValueSlot {
  if (typeof input !== 'string') {
    throw new ArgBuildError('value-not-a-string', 'A tag value must be a string.');
  }
  if (input.length === 0) {
    throw new ArgBuildError(
      'empty-value',
      'An empty value would delete the tag. Leave the field blank to leave the tag unchanged, or use the explicit delete action.',
    );
  }
  if (/[\r\n\0]/.test(input)) {
    throw new ArgBuildError(
      'newline-in-value',
      'Tag values cannot contain line breaks. Remove the line break, or split the text into separate fields.',
    );
  }
  if (input.startsWith('-')) {
    throw new ArgBuildError(
      'leading-dash-in-value',
      'A value cannot start with "-": exiftool would read it as a command option.',
    );
  }
  if (input.length > MAX_VALUE_LENGTH) {
    throw new ArgBuildError(
      'value-too-long',
      `Tag values are limited to ${MAX_VALUE_LENGTH} characters.`,
    );
  }
  return input as ValueSlot;
}

export class ArgBuildError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ArgBuildError';
    this.code = code;
  }
}

/**
 * The compile-time write whitelist: group-qualified tags the GUI may write in
 * v1, all MWG-consistent for human-facing fields. Everything else — group
 * deletes, `-All=`, pseudo-tags like FileName, RAW block deletes — is outside
 * the whitelist and therefore unreachable.
 */
export const ALLOWED_WRITE_TAGS: ReadonlySet<string> = new Set([
  'XMP-dc:Title',
  'XMP-dc:Description',
  'XMP-dc:Creator',
  'XMP-dc:Rights',
  'XMP-dc:Subject',
  'XMP-mwg-rs:Rating',
  'EXIF:ImageDescription',
  'EXIF:Artist',
  'EXIF:Copyright',
  'EXIF:DateTimeOriginal',
  'EXIF:CreateDate',
  'EXIF:ModifyDate',
  'IPTC:ObjectName',
  'IPTC:Keywords',
  'IPTC:CopyrightNotice',
  'IPTC:By-line',
  'PNG:Description',
  'PNG:Parameters',
  'PNG:Author',
  'PNG:Copyright',
  'XMP-photoshop:Credit',
  'XMP-xmp:Rating',
]);

/** Curated UI field -> whitelist tags (MWG-consistent ordering). */
export const CURATED_FIELDS: Readonly<Record<CuratedFieldKey, readonly string[]>> = {
  title: ['XMP-dc:Title', 'IPTC:ObjectName'],
  description: ['XMP-dc:Description', 'EXIF:ImageDescription'],
  keywords: ['XMP-dc:Subject', 'IPTC:Keywords'],
  rating: ['XMP-xmp:Rating'],
  dateTaken: ['EXIF:DateTimeOriginal', 'EXIF:CreateDate', 'EXIF:ModifyDate'],
  gpsLatitude: ['EXIF:GPSLatitude'],
  gpsLongitude: ['EXIF:GPSLongitude'],
  copyright: ['XMP-dc:Rights', 'EXIF:Copyright', 'IPTC:CopyrightNotice'],
  creator: ['XMP-dc:Creator', 'EXIF:Artist', 'IPTC:By-line'],
};

/** Hyphens are legal inside tag and group names (XMP-dc, By-line, mwg-rs). */
const TAG_SHAPE_RE = /^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*(?::[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*)*$/;

/** Grammatical shape check for a group-qualified tag name. */
export function isValidTagShape(tag: string): boolean {
  if (tag.length === 0 || tag.length > 128) return false;
  if (!TAG_SHAPE_RE.test(tag)) return false;
  // Wildcards, operators and the 'All' group are write grammar, not names.
  if (/[?*[\]<>!=+^]/.test(tag)) return false;
  const last = tag.split(':').pop() ?? '';
  if (last.toLowerCase() === 'all') return false;
  return true;
}

/** Validate a tag for WRITING: shape + compile-time whitelist membership. */
export function validateWritableTag(tag: string): string {
  if (!isValidTagShape(tag)) {
    throw new ArgBuildError('bad-tag-shape', `"${tag}" is not a valid tag name.`);
  }
  if (!ALLOWED_WRITE_TAGS.has(tag)) {
    throw new ArgBuildError(
      'tag-not-whitelisted',
      `"${tag}" is not in the editable field set. Tag deletes of whole groups and free-form tags are not available.`,
    );
  }
  return tag;
}

/**
 * Validate a tag for READING: shape, and — when a catalog is loaded —
 * membership in the `-listx` database. Reads are safe regardless; this exists
 * so the later autocomplete/selection surfaces have one validator.
 */
export function validateReadableTag(tag: string, catalog: TagCatalog | null): string {
  if (!isValidTagShape(tag)) {
    throw new ArgBuildError('bad-tag-shape', `"${tag}" is not a valid tag name.`);
  }
  if (catalog !== null) {
    const bare = (tag.split(':').pop() ?? '').toLowerCase();
    const group = tag.includes(':') ? (tag.split(':')[0] ?? '').toLowerCase() : null;
    const keys = catalog.nameIndex[bare];
    const known =
      keys !== undefined &&
      keys.some((key) => (group === null ? true : (key.split(':')[0] ?? '') === group));
    if (!known) {
      throw new ArgBuildError('tag-unknown', `"${tag}" is not a tag exiftool knows.`);
    }
  }
  return tag;
}

export interface WriteArgOptions {
  /** Group prefix enforcement is implicit in the whitelist. */
  catalog?: TagCatalog | null;
}

/**
 * Build the argv for a write batch: assignments first, then the absolute file
 * paths. Default backup mode is implied — no overwrite flag is ever emitted,
 * and exiftool itself creates FILE_original.
 */
export function buildWriteArgs(
  filePaths: readonly string[],
  intents: readonly TagWriteIntent[],
  _opts: WriteArgOptions = {},
): WriteArgv {
  if (filePaths.length === 0) {
    throw new ArgBuildError('no-files', 'A write needs at least one target file.');
  }
  if (intents.length === 0) {
    throw new ArgBuildError('no-edits', 'A write needs at least one tag edit.');
  }

  const argv: string[] = [];
  for (const intent of intents) {
    const tag = validateWritableTag(intent.tag);
    switch (intent.op) {
      case 'set': {
        const value = toValueSlot(requireValue(intent, tag));
        argv.push(`-${tag}=${value}`);
        break;
      }
      case 'append': {
        const value = toValueSlot(requireValue(intent, tag));
        argv.push(`-${tag}+=${value}`);
        break;
      }
      case 'remove': {
        const value = toValueSlot(requireValue(intent, tag));
        argv.push(`-${tag}-=${value}`);
        break;
      }
      case 'delete': {
        if (intent.value !== undefined && intent.value.length > 0) {
          throw new ArgBuildError(
            'delete-with-value',
            'A delete operation takes no value. Use "set" to change a tag.',
          );
        }
        // The ONLY route to a bare -TAG= in the entire app.
        argv.push(`-${tag}=`);
        break;
      }
      default: {
        const exhaustive: never = intent.op;
        throw new ArgBuildError('unknown-op', `Unknown edit operation: ${String(exhaustive)}`);
      }
    }
  }

  argv.push(...filePaths.map(assertAbsoluteFile));

  assertNoOverwriteArgs(argv);
  assertArgsSafe(argv);
  return argv as unknown as WriteArgv;
}

function requireValue(intent: TagWriteIntent, tag: string): string {
  if (intent.value === undefined || intent.value.length === 0) {
    throw new ArgBuildError(
      'missing-value',
      `"${tag}" needs a value. Leave the field untouched to leave the tag unchanged.`,
    );
  }
  return intent.value;
}

/** Runtime backstop: no produced argv may contain an overwrite flag. */
export function assertNoOverwriteArgs(argv: readonly string[]): void {
  for (const arg of argv) {
    if (isOverwriteFlag(arg)) {
      throw new ArgBuildError(
        'overwrite-forbidden',
        'MetaDesk never overwrites without a backup; -overwrite_original and -overwrite_original_in_place are disabled in code.',
      );
    }
  }
}

export interface ReadArgOptions {
  /** Emit `-j`. Default true. */
  json?: boolean;
  /** Emit `-G1` group prefixes. Default true. */
  groupNames?: boolean;
  /** Emit `-a` (duplicates). Default true. */
  duplicates?: boolean;
  /** Emit `-struct`. Default true. */
  struct?: boolean;
  /** Emit `-n` raw values. Default false. */
  numeric?: boolean;
  /** Explicit tag selections (validated). Empty = all tags. */
  tags?: readonly string[];
  /** Emit `-r` recursion. Default false. */
  recursive?: boolean;
  /** Extension filters (lowercase, no dot). */
  extensions?: readonly string[];
  /** `-fast` level 1-4. */
  fast?: 1 | 2 | 3 | 4;
  catalog?: TagCatalog | null;
}

/** Standard GUI read payload flags: `-j -G1 -a -struct`. */
export function buildJsonReadArgs(
  filePaths: readonly string[],
  opts: ReadArgOptions = {},
): ReadArgv {
  return buildReadArgs(filePaths, { json: true, groupNames: true, duplicates: true, struct: true, ...opts });
}

/** Build the argv for a read command. */
export function buildReadArgs(filePaths: readonly string[], opts: ReadArgOptions = {}): ReadArgv {
  if (filePaths.length === 0) {
    throw new ArgBuildError('no-files', 'A read needs at least one file.');
  }

  const argv: string[] = [];
  if (opts.json ?? false) argv.push('-j');
  if (opts.groupNames ?? false) argv.push('-G1');
  if (opts.duplicates ?? false) argv.push('-a');
  if (opts.struct ?? false) argv.push('-struct');
  if (opts.numeric ?? false) argv.push('-n');
  if (opts.recursive ?? false) argv.push('-r');
  if (opts.fast !== undefined) argv.push(`-fast${opts.fast}`);
  for (const ext of opts.extensions ?? []) {
    if (!/^[a-z0-9]{1,8}$/.test(ext)) {
      throw new ArgBuildError('bad-extension', `"${ext}" is not a plain file extension.`);
    }
    argv.push('-ext', ext);
  }
  for (const tag of opts.tags ?? []) {
    argv.push(`-${validateReadableTag(tag, opts.catalog ?? null)}`);
  }

  argv.push(...filePaths.map(assertAbsoluteFile));

  assertNoOverwriteArgs(argv);
  assertArgsSafe(argv);
  return argv as unknown as ReadArgv;
}

/** `-ver` for the one-shot health handshake. */
export function buildVersionArgs(): string[] {
  return ['-ver'];
}

/** `-listx -f`: full tag database including the flags column. */
export function buildListxArgs(): string[] {
  return ['-listx', '-f'];
}

function assertAbsoluteFile(filePath: string): string {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new ArgBuildError('bad-path', 'A file path is required.');
  }
  if (/[\r\n\0]/.test(filePath)) {
    throw new ArgBuildError(
      'newline-in-path',
      'A file path contains a line break and cannot be used.',
    );
  }
  if (!path.isAbsolute(filePath)) {
    throw new ArgBuildError(
      'relative-path',
      `File paths must be absolute: "${filePath}" is relative.`,
    );
  }
  return filePath;
}
