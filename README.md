# MetaDesk

MetaDesk is a small Windows program for looking at — and safely correcting — the hidden
metadata inside your photos: the camera settings, the timestamps, the GPS coordinates,
the copyright line, and the fingerprints that AI image generators embed. It is a friendly
graphical front end for the industry-standard **ExifTool** engine, which ships inside this
folder, so nothing needs to be installed and no account or cloud service is involved.
Everything runs on this machine.

## Starting MetaDesk

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
| `scripts\` | Verification gates — one command each that proves a layer still works (see `HANDOFF.md`). |

More for contributors and build agents: `STATUS.md` (one-glance chart), `HANDOFF.md`
(deep technical handoff), `CLAUDE.md` (working rules for agent sessions).
