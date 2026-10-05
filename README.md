# MetaDesk

MetaDesk is a small Windows program for looking at — and safely correcting — the hidden
metadata inside your photos: the camera settings, the timestamps, the GPS coordinates,
the copyright line, and the fingerprints that AI image generators embed. It is a friendly
graphical front end for the industry-standard **ExifTool** engine, which ships inside this
folder, so nothing needs to be installed and no account or cloud service is involved.
Everything runs on this machine.

## Getting MetaDesk onto a PC

You get MetaDesk as a single zip file (`metadesk-1.0.0-portable-win-x64.zip`). There is no
installer wizard and no website account — for this release the zip is passed along directly.

1. **Put the zip somewhere you want to keep it** (your Desktop or a `MetaDesk` folder is
   fine) and extract it with right-click → **Extract All…**. You get one folder, `MetaDesk`.
   **Extract the WHOLE folder and keep it together** — the program, its engine, and its
   runtime all live side by side in there, and the folder is the app. Move or copy the
   folder as a unit, never the `.exe` on its own.
2. **Double-click `MetaDesk.exe`** inside that folder. Your data will live in a `data`
   subfolder the app creates there on first run.
3. **The first time you run it, Windows will probably show a blue "Windows protected your
   PC" message.** That is expected, and here is the honest reason: Microsoft shows that
   warning for programs it has never seen before, and the recognized-program status comes
   from a code-signing certificate this release does not have (it costs money per year and
   v1 does not carry one). It is a "we don't know this file", not a "we found something
   bad". If you got the zip from a source you trust: click **More info**, then **Run
   anyway**. You only do this once — Windows remembers. If you want to double-check the
   file you were given before running it, the release notes that come with the zip (in the
   source folder they live at `docs\release\RELEASE-NOTES-v1.0.0.md`) list the fingerprint
   (SHA-256) of every file that shipped, and your PC can compute the same fingerprint to
   compare.

**What MetaDesk needs:** Windows 10 (version 1803 or newer) or Windows 11, on a 64-bit PC.
The web piece it draws its window with (WebView2) is already built into both of those, so
there is nothing else to install — and in the rare case a machine is missing it, MetaDesk
shows a clear message with Microsoft's download link instead of a broken window. No
internet connection is needed to use the app.

## How to update

Close MetaDesk first (close its window — that shuts the app down cleanly). Then download
the new zip and **extract it over the old folder**, the same way you installed it: same
place, overwrite when asked. Your data — journals, settings, caches, and the exported
before-values of destructive operations — lives in the `data` subfolder, and the zip does
not contain a `data` folder, so extracting over the top leaves your data exactly where it
was. (The `_original` backup copies sit next to your photos, so an update does not touch
those either.) This update path is rehearsed by an automated check on every release
(`node app/scripts/run-clean-machine.mjs update`).

To verify a downloaded zip before running it, compare its SHA-256 fingerprint with the one
in the release notes that come with the release
(`docs\release\RELEASE-NOTES-v1.0.0.md` in the source folder).

## Starting MetaDesk

The sections above cover the packaged program: double-click **`MetaDesk.exe`** in the
`MetaDesk` folder. What follows is the launcher route used inside this source folder
(how the people building MetaDesk run it before it is packaged).

Double-click **`bin\metadesk.cmd`**.

That one icon does the whole ritual for you: it picks a free local port, starts the app's
engine room, waits until it is healthy, and opens MetaDesk in your default browser at a
private address only this computer can see (`127.0.0.1`, with a fresh secret key every
launch). You should be looking at the app in well under a minute.

- Closing that console window (or pressing Ctrl+C in it) stops MetaDesk cleanly — it
  finishes and shuts down its engine properly, never leaving stray processes behind.
- Starting it a second time while it is already running does **not** start a second copy;
  it just opens the running app in your browser again.
- To stop it from any other console: `node bin\metadesk.mjs --stop` (or `bin\metadesk.ps1 -Stop`).

Developers and build agents use `bin\metadesk-dev.cmd` instead: identical behavior, plus a
pre-launch engine self-test. If you ever see a red "Read-Only Mode" banner, the engine did
not start — viewing still works, editing stays locked, and there are Retry and Choose-path
buttons (press **F1** inside the app for plain-English help on any panel; the same text
lives in `resources/help/metadesk-help.md`).

## The safety model, in one paragraph

MetaDesk starts **read-only, every time** — nothing can change a file until you
deliberately unlock writing for the current session, and while it is unlocked the whole
window wears an amber border so there is never any doubt. When you do write, nothing
happens blind: you first see an exact preview of every old → new value on every file
together with the literal ExifTool command that will run, and only your explicit
confirmation executes it. Every write keeps a backup (`filename_original`) whose
fingerprint is recorded and verified before a file may be called "updated", every change
is journalled so it can be undone, and only a short whitelist of well-behaved fields is
editable at all — arbitrary text can never become an ExifTool command. Destructive
operations (like removing GPS) additionally demand a typed confirmation phrase and export
your current values first, so they survive even if the backups are deleted.

## Folder map

| Path | What it is |
|---|---|
| `bin\` | The launchers. `metadesk.cmd` / `metadesk.ps1` = the app itself; `metadesk-dev.*` = same plus engine self-test; `metadesk.mjs` = the shared lifecycle code; `engine-smoke.mjs` = the self-test. |
| `server\` | The engine room (TypeScript/Fastify): the only place that talks to ExifTool and touches your files. |
| `ui\` | The screen layer (React) you see in the browser. `ui\dist\` is the built bundle the server serves. |
| `shared\` | The typed API contract both sides compile against. |
| `resources\` | Plain-English help text and static assets. |
| `data\` | Runtime state only (port file, journal, caches). Created on first run, never edited by hand, not kept in git. |
| `vendor\exiftool\` | The ExifTool program itself. **Never modified, never deleted.** |
| `tauri\` | The desktop wrapper: the code that turns the app above into `MetaDesk.exe`, its own window, with the tray icon. |
| `dist-desktop\` | The finished, packaged release: the zip you hand out, plus the fingerprint list (see the release notes in `docs\release\`). Build outputs only — not kept in git. |
| `scripts\` | Verification gates — one command each that proves a layer still works (see `HANDOFF.md`). |

More for contributors and build agents: `STATUS.md` (one-glance chart), `HANDOFF.md` and
`HANDOFF-V1.md` (deep technical handoffs — V1 is the release runbook),
`docs\release\RELEASE-NOTES-v1.0.0.md` (the release record), `CLAUDE.md` (working rules
for agent sessions).
