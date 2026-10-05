/**
 * Path sanitizer: every user-supplied path passes through here before it can
 * reach the filesystem or the engine (data-safety requirement #11).
 *
 * Rules, in enforcement order:
 *  - string, non-empty, at most 240 characters (long-path handling is a
 *    later concern; >240 is rejected with a clear human message),
 *  - absolute Windows paths only (drive-letter or UNC), never relative —
 *    a relative argument could be mistaken for an option/tag by exiftool,
 *  - no control characters (which also kills embedded newlines, the argfile
 *    line-splitting injection) and no double quotes (illegal on NTFS),
 *  - no `*` or `?` anywhere (glob grammar for exiftool; cannot occur in real
 *    NTFS names, so rejecting is false-positive-free),
 *  - no `..` path segments (traversal),
 *  - no colon outside the drive position (NTFS alternate-data-stream guard),
 *  - the leading character of the whole path may not be `-`, `%`, `*` or `?`
 *    (exiftool option/tag/FMT grammar; belt-and-braces on top of absoluteness),
 *  - the final segment may not end with a space or a dot (Win32 quirk names
 *    that only exist via the \\?\ device path),
 *  - UNC paths are allowed but must pass a read probe before first use.
 *
 * Odd names that ARE legal on NTFS (`--All=`, `50%#off=.png`, CJK, emoji,
 * quotes-free percent/hash/equals names) pass the guard ON PURPOSE: safety
 * comes from absolute argv-array addressing, not from refusing the names.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';

/** Structured reasons a path was rejected; drives both the API error code and
 *  the human message. */
export type PathRejectionReason =
  | 'empty'
  | 'not-a-string'
  | 'too-long'
  | 'control-characters'
  | 'not-absolute'
  | 'leading-special-character'
  | 'wildcard'
  | 'double-quote'
  | 'traversal'
  | 'stream-colon'
  | 'trailing-space-or-dot';

export class PathRejectedError extends Error {
  readonly code = 'path_rejected' as const;
  readonly reason: PathRejectionReason;
  readonly inputPath: string;

  constructor(reason: PathRejectionReason, inputPath: string, message: string) {
    super(message);
    this.name = 'PathRejectedError';
    this.reason = reason;
    this.inputPath = inputPath;
  }
}

export type PathInspection =
  | { ok: true; path: string }
  | { ok: false; reason: PathRejectionReason; message: string };

const MAX_PATH_LENGTH = 240;
const ABSOLUTE_RE = /^[a-zA-Z]:[\\/]/;
const UNC_RE = /^\\\\[^\\]/;

/** Inspect a user-supplied path; non-throwing form used by the scanner. */
export function inspectPath(input: unknown): PathInspection {
  if (typeof input !== 'string') {
    return { ok: false, reason: 'not-a-string', message: 'A path must be a string.' };
  }
  if (input.length === 0) {
    return { ok: false, reason: 'empty', message: 'A path is required.' };
  }
  if (input.length > MAX_PATH_LENGTH) {
    return {
      ok: false,
      reason: 'too-long',
      message: `The path is ${input.length} characters long. Paths over ${MAX_PATH_LENGTH} characters are not supported; move the files to a shorter folder.`,
    };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(input)) {
    return {
      ok: false,
      reason: 'control-characters',
      message: 'The path contains control characters (including line breaks) and cannot be used.',
    };
  }
  if (input.includes('"')) {
    return {
      ok: false,
      reason: 'double-quote',
      message: 'The path contains a double quote, which Windows file names cannot contain.',
    };
  }
  if (/[*?]/.test(input)) {
    return {
      ok: false,
      reason: 'wildcard',
      message:
        'The path contains * or ?. Wildcards are not allowed in a path; select the exact file or folder.',
    };
  }
  if (!ABSOLUTE_RE.test(input) && !UNC_RE.test(input)) {
    return {
      ok: false,
      reason: 'not-absolute',
      message: `The path must be absolute (start with a drive letter like C:\\ or a \\\\server\\share). "${truncate(
        input,
      )}" is not absolute.`,
    };
  }
  if (/^[-%*?#]/.test(input)) {
    return {
      ok: false,
      reason: 'leading-special-character',
      message:
        'The path starts with a character that the engine reads as an option or pattern (- % * ? #) and cannot be used.',
    };
  }
  const segments = input.split(/[\\/]/).filter((s) => s.length > 0 && s !== ':');
  if (segments.some((s) => s === '..')) {
    return {
      ok: false,
      reason: 'traversal',
      message: 'The path contains ".." and cannot be used. Provide the full path instead.',
    };
  }
  // A colon is legal only as the drive separator (index 1; absoluteness above
  // already guarantees a separator follows). Anything else is an NTFS
  // alternate-data-stream reference, which exiftool should never see.
  if (input.indexOf(':', 2) !== -1) {
    return {
      ok: false,
      reason: 'stream-colon',
      message:
        'The path contains a colon outside the drive letter (NTFS stream syntax) and cannot be used.',
    };
  }
  const last = segments[segments.length - 1] ?? '';
  if (/[. ]$/.test(last)) {
    return {
      ok: false,
      reason: 'trailing-space-or-dot',
      message:
        'The path ends with a space or a dot. Windows treats such names specially; rename the file or folder.',
    };
  }
  return { ok: true, path: path.normalize(input) };
}

/** Validate and return a normalized absolute path; throws PathRejectedError. */
export function assertSafePath(input: unknown): string {
  const result = inspectPath(input);
  if (!result.ok) throw new PathRejectedError(result.reason, String(input), result.message);
  return result.path;
}

/**
 * Read probe, mandatory for UNC paths (network shares add locking and latency
 * quirks; requirement #11 says verify before use) and useful for callers that
 * want an existence check with a human message attached.
 */
export async function probeReadable(
  target: string,
  opts: { isUnc?: boolean } = {},
): Promise<void> {
  let stats;
  try {
    stats = await stat(target);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PathRejectedError(
      'not-absolute',
      target,
      `The path "${truncate(target)}" could not be read: ${message}`,
    );
  }
  if (opts.isUnc === true && !stats.isDirectory() && !stats.isFile()) {
    throw new PathRejectedError(
      'not-absolute',
      target,
      `The network path "${truncate(target)}" is neither a file nor a folder.`,
    );
  }
}

export function isUncPath(target: string): boolean {
  return UNC_RE.test(target);
}

function truncate(text: string): string {
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}
