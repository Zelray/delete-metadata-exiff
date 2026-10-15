# MetaDesk 1.0.1 — Release Notes

Released: 2026-10-15. Primary distribution: the portable zip (`metadesk-1.0.1-portable-win-x64.zip`).
These notes are the release record of truth: what changed since 1.0.0, what shipped, and how
to check a copy of the download is the real thing. For the full product tour, read
`RELEASE-NOTES-v1.0.0.md` beside this file — everything it says about how MetaDesk works
still holds.

---

## What's new in 1.0.1 (two honesty fixes, no new features)

Both fixes came from real runtime findings, filed as issues, fixed with red-first tests,
and verified against the real vendored engine.

**1. A delete can no longer call itself verified when the verification read produced
nothing (issue #3).** In 1.0.0, deleting a tag compared "expected nothing" against
"actually read nothing" and — if the re-read itself returned no data (empty output, an
in-band engine error, an unparseable reply) — the empty-vs-empty comparison passed and the
file was reported `verified`. Now the re-read carries an explicit per-file read status, and
a file whose verification read did not succeed fails honestly at the verify stage instead.
Related: a *warning-shaped* re-read (real on damaged-but-readable files) is now classified
as a reached file with a note, not as a permanent verification failure.

**2. A batch whose old value contained line breaks now says up front that it cannot be
undone (issue #4).** The engine's value guard correctly refuses to write line breaks, so a
journal undo that would restore a multiline value can never work — but 1.0.0 left the Undo
button enabled forever and answered every attempt with a misleading "tag is not safe"
hint. Now both undo steps refuse before touching anything with a dedicated
`undo_blocked` outcome, the History screen disables and badges such a batch, and the
message points at the real recovery path: the `_original` byte backup. Nothing was ever
changed by the failed attempts — that was true before and is unchanged.

Everything else in 1.0.0 — the safety model, the whitelisted fields, the AI prompt
scrubber, the GPS strip, the desktop shell — is exactly as documented, unchanged.

## What MetaDesk is

MetaDesk is a small Windows program for looking at — and safely correcting — the hidden
metadata inside your photos: camera settings, timestamps, GPS coordinates, copyright, and
the fingerprints AI image generators embed. It is a friendly front end for the
industry-standard **ExifTool** engine (ExifTool 13.59, shipped inside the folder,
unmodified), so nothing needs installing beyond the folder itself, no account or cloud
service is involved, and everything runs on your machine.

**Safety model, in one sentence:** nothing changes a file until you unlock writing for the
session, preview first always, backups + journal + hash-verified undo always, and only a
short whitelist of well-behaved fields is editable — arbitrary text can never become an
ExifTool command.

## What's in the folder

One folder, everything together: `MetaDesk.exe` (the program), `node\node.exe` (the runtime
it needs — stock Node v22.22.3, kept under its original name so its existing vendor
signature counts in its favor), `server\` + `ui\` (the engine room and the screen layer),
`vendor\exiftool\` (ExifTool 13.59, unmodified), and `data\` (created on first run — your
journals, caches, and settings live there). Extract the whole folder and keep it together.

## Requirements

- Windows 10 (version 1803 or newer) or Windows 11, 64-bit.
- Nothing else. The WebView2 component both of those ship with draws the window; if a
  machine is somehow missing it, MetaDesk shows a clear message with Microsoft's download
  link rather than a broken window. No internet connection is needed to use the app.

## First run: the SmartScreen message

The first time you run `MetaDesk.exe`, Windows will probably show a blue **"Windows
protected your PC"** message. This is the expected experience for this release, and the
reason is simple and honest: that warning appears for programs without a track record with
Microsoft, and the recognized-program status comes from a code-signing certificate —
**MetaDesk 1.0.1 is not signed** (no certificate was purchased). The message means
"unknown", not "dangerous".

If you received the zip from a source you trust: click **More info**, then **Run anyway**.
You only do this once per file; Windows remembers your choice.

If an antivirus or SmartScreen flags MetaDesk as a false positive, you can report it
directly to Microsoft at their security intelligence file-submission portal
(`https://www.microsoft.com/wdsi/filesubmission`) — submissions from the software's own
users are how a program builds reputation. The fingerprints below are the way to prove the
file you have is the file that was built.

## Verifying your download (SHA-256)

Compute a file's fingerprint on Windows with PowerShell:
`Get-FileHash <path-to-file> -Algorithm SHA256` (or `certutil -hashfile <file> SHA256`),
then compare with the values below. These are the fingerprints of the exact files built on
2026-10-15 (build record: `provenance-1.0.1.txt`).

| File | Size (bytes) | SHA-256 |
|---|---|---|
| `metadesk-1.0.1-portable-win-x64.zip` | 48,534,227 | `358b22fabc20d4bd0ebcf11faf606967c15ba309aac8b452e5193fcb17da791d` |
| `MetaDesk_1.0.1_x64-setup.exe` | 32,440,071 | `dab41325f1715baf39d94aa4224d6013879aa553d765548dd7ed6294dfa36cf2` |
| `MetaDesk.exe` (inside the package; product version 1.0.1) | 4,895,232 | `31617bebb9cdb799801b63ac0518df9a4bacd4dd4c3ab533c270afe36f818d20` |
| `node\node.exe` (inside the package; Node v22.22.3) | 86,969,160 | `780f44f2c53c108bae261ada21a525b4bfe733c020ac85e41bfe94479090ac9b` |
| `vendor\exiftool\exiftool.exe` (inside the package; ExifTool 13.59) | 58,368 | `68c079c32fdae0d6c7130e9a5fb73f8ac9dabdf9ab8da312da4f6c549d6d3385` |

**Signing status, stated plainly:** `MetaDesk.exe` and `MetaDesk_1.0.1_x64-setup.exe` are
Authenticode **NotSigned** — no certificate was purchased, so neither file carries a
publisher signature. The two engines inside the folder are exactly as distributed by their
makers: `node.exe` is the stock OpenJS-signed Node v22.22.3 (shipped under its original
name precisely so that signature keeps working for it), and `exiftool.exe` is the
unmodified ExifTool 13.59 Windows binary exactly as it was vendored — that copy carries no
publisher signature, which was measured and recorded at build time. The rest of the engine
lives in `exiftool_files\`, which must stay beside it.

(Reader's note on the build log: Windows' signature checker sometimes appends a
parenthetical to a "NotSigned" result that mentions execution policies. That
parenthetical is generic Windows boilerplate, not a failed check — the status field
itself ("NotSigned") is the fact of record.)

The zip contains 519 files under the single `MetaDesk/` folder; a per-file SHA-256 manifest
of everything inside it is emitted at build time (`portable-manifest-1.0.1.json`), and the
zip hash above is what the release checklist verifies before anything else.

## How to update (from 1.0.0)

Close MetaDesk, download the new zip, and **extract it over the old folder** — same place,
overwrite when asked. Your data lives in the `data` subfolder and the zip contains no
`data` folder, so nothing you care about is touched (the `_original` backup copies sit next
to your photos and are not touched either). This exact path is rehearsed automatically on
every release: an automated check seeds a used install (journal, settings, engine cache),
extracts the new zip over it, and proves the data files survive byte-identical and the
upgraded app boots healthy (`node app/scripts/run-clean-machine.mjs update`).

## How this release was verified

Before the build: the full gate ladder (engine layer, server, UI build, write pipeline,
UI write surfaces, launch lifecycle, diagnostics, and the complete end-to-end matrix,
including real-engine write → verify → undo rounds). After the build: package verification
(zip hash match, manifest = extracted contents, junk absence, engines run from inside the
package), the packaged end-to-end matrix booting the extracted zip's `MetaDesk.exe`, a
clean-machine drill (the zip extracted and booted with PATH stripped to bare Windows — no
Node, no dev tools reachable), and the update rehearsal described above. All green on
2026-10-15.

## Known limits (documented, not hidden)

- **SmartScreen on first run** — the click-through above. It goes away permanently once
  you click through it, and disappears entirely in a future release that carries a signing
  certificate.
- **The one-click installer (`MetaDesk_1.0.1_x64-setup.exe`) is built but not the primary
  way to run MetaDesk.** The NSIS installer is shipped for completeness — its
  install/uninstall flow remains unexercised — while the portable zip is the distribution
  of record, the flow the release checklist exercises end to end. Use the zip.
- **ComfyUI `prompt`/`workflow` chunks and C2PA/JUMBF manifests are detect-only.** The AI
  scrubber finds them and tells you plainly they cannot be removed yet. They are listed
  under "cannot be removed" with their detected values — never silently skipped.
- **Hidden alpha-channel data is warning-only.** Images from tools that hide data in
  pixels get an honest warning: no metadata tool can scrub pixels, so MetaDesk says so
  rather than implying a clean file.
- **The console is read-only**, and a few Settings conveniences (restoring a custom engine
  path, the `-api` advanced knob) are deferred. The dev-mode graceful-shutdown quirk from
  1.0.0's notes applies only to the browser development route, not this package.
- **Two scoped honesty items intentionally remain open** (documented on the issue tracker,
  not hidden): a *throwing* re-read (engine timeout or process death mid-verify) still
  rejects as a raw error rather than degrading into an honest per-file failure, and
  natively restoring multiline values through the safety builder (the "eventual
  capability" behind the `undo_blocked` fix) is future work — until then the `_original`
  byte backup is the way back.

## Support

The Settings view has a **diagnostics bundle** button that zips the app's logs, the journal
tail, and the engine version — that file is the first thing to send with any problem
report. In-app, **F1** opens plain-English help for every panel (the same text is in
`resources\help\metadesk-help.md`).
