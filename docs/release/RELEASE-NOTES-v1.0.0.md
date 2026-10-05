# MetaDesk 1.0.0 — Release Notes

Released: 2026-10-05. Primary distribution: the portable zip (`metadesk-1.0.0-portable-win-x64.zip`).
These notes are the release record of truth: what shipped, what it does, what it honestly
cannot do yet, and how to check a copy of the download is the real thing.

---

## What MetaDesk is

MetaDesk is a small Windows program for looking at — and safely correcting — the hidden
metadata inside your photos: camera settings, timestamps, GPS coordinates, copyright, and
the fingerprints AI image generators embed. It is a friendly front end for the
industry-standard **ExifTool** engine (ExifTool 13.59, shipped inside the folder, unmodified),
so nothing needs installing beyond the folder itself, no account or cloud service is
involved, and everything runs on your machine.

## What's in the box

**Read everything.** Scan any folder and browse a thumbnail grid with badges (GPS present /
copyright present / AI-generated). Open the full inspector: Exif, XMP, IPTC, GPS, file and
maker-notes groups, search-as-you-type, human-readable and raw values side by side, map
links for GPS, and raw binary extraction of embedded previews.

**Write safely.** Edit the human fields (title, description, keywords, rating, dates and
timezone, GPS, copyright, creator) behind a **mandatory Save Review** — you see every
old → new value and the exact ExifTool command before anything happens. Every write keeps a
backup (`filename_original`), the backup's fingerprint is checked before a file is called
"updated", every change is journalled, and **Undo restores byte-identical originals**
(proven by test). MetaDesk starts read-only every single time; writing is a deliberate
per-session unlock, and while unlocked the whole window wears an amber border.

**AI prompt scrubber.** Detects Stable Diffusion / ComfyUI / NovelAI / Fooocus / C2PA
generation data, shows what it found, and wipes the removable parts after you type
`REMOVE AI METADATA` — with your original values exported first. It is honest about limits
(see below).

**GPS strip.** A 59-tag whitelist wiped with the same typed-phrase, export-first, undo-able
pattern.

**Batch operations** with date-shift preview, graceful cancel between files, and a
plain-English results report (updated / nothing changed / needs attention, with retry).
A read-only console shows the exact ExifTool command behind any result.

**The desktop program (new in this release).** MetaDesk is now a real Windows program —
its own window with its own taskbar identity and icon, a minimal tray icon (left-click
brings it up, right-click gives Open and Quit), real Explorer drag-drop with full file
paths onto the Home drop zone, single-instance (launching it twice focuses the running
one), and a native error dialog instead of a white window if anything ever goes wrong at
startup. Closing the window closes the whole app — the engine shuts down gracefully and
nothing is left running; even a hard kill of the window is backed by a kernel-level
cleanup so no stray processes survive. A **diagnostics bundle** button in Settings zips up
the app's logs and journal tail for support.

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
  machine is somehow missing it, MetaDesk is built to show a clear message with
  Microsoft's download link rather than a broken window (verified in the program's code;
  not exercised on a machine actually missing the component). No internet connection is
  needed to use the app.

## First run: the SmartScreen message

The first time you run `MetaDesk.exe`, Windows will probably show a blue **"Windows
protected your PC"** message. This is the expected experience for this release, and the
reason is simple and honest: that warning appears for programs without a track record with
Microsoft, and the recognized-program status comes from a code-signing certificate —
**MetaDesk 1.0.0 is not signed** (no certificate was purchased for v1). The message means
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
2026-10-05 (build record: `provenance-1.0.0.txt`).

| File | Size (bytes) | SHA-256 |
|---|---|---|
| `metadesk-1.0.0-portable-win-x64.zip` | 48,548,729 | `2cd298bccf3dba2b40bc0f4e4bf2f4fc3f8b047241f054de139c38b7fd715e1a` |
| `MetaDesk_1.0.0_x64-setup.exe` | 32,453,978 | `07a7cfde69ed488811bbf13aaa2defaea52d36093fa437fe51847da0d4b5ee52` |
| `MetaDesk.exe` (inside the package; product version 1.0.0) | 4,895,232 | `08d32235688c1824876877fcd69ff09b7a0eff56d69f98f0750f3d591a56ea58` |
| `node\node.exe` (inside the package; Node v22.22.3) | 86,969,160 | `780f44f2c53c108bae261ada21a525b4bfe733c020ac85e41bfe94479090ac9b` |
| `vendor\exiftool\exiftool.exe` (inside the package; ExifTool 13.59) | 58,368 | `68c079c32fdae0d6c7130e9a5fb73f8ac9dabdf9ab8da312da4f6c549d6d3385` |

**Signing status, stated plainly:** `MetaDesk.exe` and `MetaDesk_1.0.0_x64-setup.exe` are
Authenticode **NotSigned** — no certificate was purchased for v1, so neither file carries a
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
of everything inside it is emitted at build time (`portable-manifest-1.0.0.json`), and the
zip hash above is what the release checklist verifies before anything else.

## How to update (from any earlier release)

Close MetaDesk, download the new zip, and **extract it over the old folder** — same place,
overwrite when asked. Your data lives in the `data` subfolder and the zip contains no
`data` folder, so nothing you care about is touched. This exact path is rehearsed
automatically on every release: an automated check seeds a used install (journal, settings,
engine cache), extracts the new zip over it, and proves the data files survive
byte-identical and the upgraded app boots healthy (`node app/scripts/run-clean-machine.mjs update`).

## Known limits (documented, not hidden)

- **SmartScreen on first run** — the "Windows protected your PC" click-through above. It
  goes away permanently once you click through it, and disappears entirely in a future
  release that carries a signing certificate.
- **The one-click installer (`MetaDesk_1.0.0_x64-setup.exe`) is built but not the primary
  way to run v1.** The NSIS installer is shipped for completeness; the portable zip is the
  distribution of record, the flow the release checklist exercises end to end, and the
  flow whose update path is rehearsed. Use the zip.
- **ComfyUI `prompt`/`workflow` chunks and C2PA/JUMBF manifests are detect-only.** The AI
  scrubber finds them and tells you plainly they cannot be removed yet (the ExifTool
  engine cannot delete unlisted PNG chunks by name, and group-wipes are forbidden in v1 for
  safety). They are listed under "cannot be removed" with their detected values — never
  silently skipped.
- **Hidden alpha-channel data is warning-only.** Images from tools that hide data in
  pixels (alpha-channel pnginfo, SynthID-style watermarks) get an honest warning: no
  metadata tool can scrub pixels, so MetaDesk says so rather than implying a clean file.
- **A dev-mode quirk with live screens:** when MetaDesk is driven the developer way (the
  browser route) with a live updating screen held open, shutdown waits out a grace window
  instead of closing instantly — no orphans, journals intact. The packaged program is not
  affected: the app navigates its window away before shutting the engine, and closing is
  measured at about one second. Scheduled for v1.1.
- **The console is read-only in v1** (a write-capable console is a v1.1 item), and
  a few Settings conveniences (restoring a custom engine path, the `-api` advanced knob)
  are deferred.

## Support

The Settings view has a **diagnostics bundle** button that zips the app's logs, the journal
tail, and the engine version — that file is the first thing to send with any problem
report. In-app, **F1** opens plain-English help for every panel (the same text is in
`resources\help\metadesk-help.md`).
