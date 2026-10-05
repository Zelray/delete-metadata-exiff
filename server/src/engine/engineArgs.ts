/**
 * Argument-safety gate for everything the engine sends to exiftool.
 *
 * Two hard rules from the data-safety requirements live here:
 *
 *  1. Arguments travel ONLY as argv arrays or as `-@ -` stdin lines — never a
 *     shell string. The spawn calls in this engine pass `shell: false`
 *     explicitly and never interpolate into a command text.
 *
 *  2. The `-@` argfile protocol treats each LINE as one argument, so any
 *     embedded newline shifts every following argument by one (the classic
 *     injection). A line starting with `#` is a comment, so it would be
 *     silently DROPPED. Both are rejected here at the boundary.
 *
 * This module is the second line of defence: `argBuilder.ts` is the first
 * (whitelist + value validation). The session refuses to transmit anything
 * that fails these checks, whatever produced it.
 */

/** Destructive overwrite flags, forbidden at the type level and at runtime. */
export type OverwriteFlag = never;

/**
 * Options the engine itself is allowed to emit as bare flags. Anything else
 * beginning with `-` must match the tag grammar (see {@link looksLikeTagArg}).
 */
export const KNOWN_OPTIONS: ReadonlySet<string> = new Set([
  '-charset',
  'filename=UTF8',
  '-stay_open',
  'True',
  'False',
  '-@',
  '-',
  '-ver',
  '-v',
  '-j',
  '-G',
  '-G1',
  '-g',
  '-a',
  '-struct',
  '-n',
  '-l',
  '-s',
  '-listx',
  '-listw',
  '-listd',
  '-listg',
  '-listf',
  '-list',
  '-r',
  '-ext',
  '-ee',
  '-fast',
  '-b',
  '-W',
  '-w',
  '-execute',
  '-common_args',
  '-config',
  '-use',
  'MWG',
  '-P',
  '-api',
  '-echo4',
  '-progress',
  '-T',
  '-t',
  '-sep',
  '-d',
  '-c',
  '-fast3',
  '-fast4',
  '-validate',
  '-warning',
  '-diff',
  '-o',
]);

export class UnsafeArgumentError extends Error {
  readonly arg: string;
  readonly reason: string;

  constructor(arg: string, reason: string) {
    super(`Unsafe exiftool argument rejected (${reason}): ${describe(arg)}`);
    this.name = 'UnsafeArgumentError';
    this.arg = arg;
    this.reason = reason;
  }
}

function describe(arg: string): string {
  const visible = arg.replace(/[\r\n\0]/g, (c) =>
    c === '\n' ? '\\n' : c === '\r' ? '\\r' : '\\0',
  );
  return JSON.stringify(visible.length > 120 ? `${visible.slice(0, 117)}...` : visible);
}

/** True when the token is one of the destructive overwrite flags in any
 *  spelling exiftool would accept (`-overwrite_original`, with or without the
 *  `_in_place` suffix and the `!` modifier, any case). */
export function isOverwriteFlag(arg: string): boolean {
  return /^-{1,2}overwrite/i.test(arg.trim());
}

/** Characters legal in exiftool tag/group names and wildcards. */
const TAG_NAME_CHARS = /^[A-Za-z0-9_?*#+.:-]+$/;

/**
 * True when an argument looks like exiftool tag grammar rather than an
 * option: `-TAG`, `-GROUP:TAG`, `-TAG=VALUE`, `-TAG+=VALUE`, `-TAG<SRCTAG`.
 *
 * The tag part must be clean tag characters; the VALUE part after the first
 * operator is free-form (the argBuilder's `toValueSlot` already validated it),
 * so values containing spaces, quotes or `=` survive this check.
 */
export function looksLikeTagArg(arg: string): boolean {
  const body = arg.replace(/^-+/, '');
  if (body.length === 0) return false;

  const opIndex = [...body].findIndex((c) => c === '=' || c === '<' || c === '>');
  if (opIndex === -1) return TAG_NAME_CHARS.test(body);

  const prefix = body.slice(0, opIndex);
  return prefix.length > 0 && TAG_NAME_CHARS.test(prefix);
}

/**
 * Validate a single argument that will become one line of the argfile or one
 * argv element. Throws {@link UnsafeArgumentError} on any violation.
 */
export function assertArgSafe(arg: string): void {
  if (typeof arg !== 'string') {
    throw new UnsafeArgumentError(String(arg), 'not-a-string');
  }
  if (arg.length === 0) {
    // A blank argfile line is ignored by exiftool, which would silently drop
    // whatever we meant to send.
    throw new UnsafeArgumentError(arg, 'empty-argument');
  }
  if (arg.length > 32768) {
    throw new UnsafeArgumentError(arg, 'argument-too-long');
  }
  if (/[\r\n\0]/.test(arg)) {
    // An embedded newline splits into two arguments and shifts every
    // following argument by one; NUL has no meaning in the protocol.
    throw new UnsafeArgumentError(arg, 'embedded-newline-or-nul');
  }
  if (/^#/.test(arg)) {
    // A line starting with '#' is a comment in an argfile and would be
    // silently dropped. (Values needing a literal leading '#' must be
    // #[CSTR]-encoded by a later layer that owns that decision.)
    throw new UnsafeArgumentError(arg, 'leading-hash-comment');
  }
  if (isOverwriteFlag(arg)) {
    // Structurally impossible to reach the process, whatever the caller did.
    throw new UnsafeArgumentError(arg, 'overwrite-original-forbidden');
  }
  if (arg === '-') {
    throw new UnsafeArgumentError(arg, 'bare-dash-stdin-token');
  }
  if (arg === '--') {
    // Verified against the vendored engine: '--' is accepted one-shot but
    // hangs the -stay_open protocol (no {readyN} is ever emitted). Absolute
    // paths make an end-of-options separator unnecessary — never emit it.
    throw new UnsafeArgumentError(arg, 'double-dash-hangs-stay-open');
  }
  if (/^-/.test(arg)) {
    const known = KNOWN_OPTIONS.has(arg) || KNOWN_OPTIONS.has(arg.toLowerCase());
    const tagShaped = looksLikeTagArg(arg) || /^--$/.test(arg) || /^-[A-Za-z0-9]{1,3}[0-9]*$/.test(arg);
    if (!known && !tagShaped) {
      throw new UnsafeArgumentError(arg, 'unrecognized-option-shaped-argument');
    }
  }
}

/** Validate a whole argument list. Throws on the first offending element. */
export function assertArgsSafe(args: readonly string[]): void {
  for (const arg of args) assertArgSafe(arg);
}
