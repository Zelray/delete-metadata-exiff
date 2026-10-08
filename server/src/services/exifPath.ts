/**
 * THE one exif path key (arch-v11 leaf 1.8): the single canonicalizer used
 * everywhere the server matches an exiftool-reported path against a
 * server-side path.
 *
 * The one contract: exiftool reports manifest / SourceFile paths with FORWARD
 * slashes, so the KEY this module returns is forward slashes + lowercase.
 * The output is a KEY for map lookups — NOT a usable path. Never hand it to
 * the filesystem, the engine, or the UI: `\\?\C:\x\a.PNG` keys as
 * `//?/c:/x/a.png`, which addresses nothing.
 *
 * Probe-pinned semantics (exiftool 13.59; arch-v11 leaf 1.8 P6): exiftool
 * echoes argv case VERBATIM and forward-normalizes slashes in argv one-shots,
 * `-@` argfiles, and the `-efile1`/`-efile8` manifests alike. Exiftool does NO
 * case folding — case resolution is the filesystem's (a wrong-case argv opens
 * fine on default NTFS; a per-directory case-sensitive flag makes the engine
 * refuse it). The `.toLowerCase()` here is therefore PURELY server-side
 * canonicalization resting on the case-insensitive-volume norm, and it is
 * load-bearing exactly once: recovery.ts (readdir spellings vs
 * journal-recorded backup paths — two producers, two times). UNC forms
 * (`\\localhost\C$\x` and `//localhost/C$/x`) both echo `//localhost/C$/x`.
 *
 * Two DELIBERATE non-uses — do not "fix" either (arch-v11 leaf 1.8, decision
 * item 1):
 *  - `test/helpers.ts` `exifPath` stays case-PRESERVING (slash-only): it
 *    pins exiftool's verbatim SourceFile echo, and lowering it would turn
 *    those asserts red;
 *  - `scan.ts` badge diagnostics match `e.path` against the echoed
 *    `diagnostic.sourceFile` with an inline slash-only compare — an
 *    ECHO-match, not a key-match, and it stays one.
 */
export function normalizeExifPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}
