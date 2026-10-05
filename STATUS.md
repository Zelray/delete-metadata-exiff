# MetaDesk — STATUS (one-glance chart)

Updated: 2026-10-05 (**v1.0.0 RELEASED** — desktop wrap complete, package verified, release tagged). Detailed handoff: `HANDOFF.md`; release runbook: `HANDOFF-V1.md`.
Build contract of record: `../.unlazy/metagui/BUILD-NOTES.md` + `../.unlazy/metagui-phase2/BUILD-NOTES.md`.

## Patient chart

| Area | State | Verified by |
|---|---|---|
| Engine layer (stay_open protocol, hostile filenames, safety arg builder) | WORKING | `node app/scripts/verify-engine.mjs` → "engine layer verification passed" (leaf 1.1.1) |
| Server read API (scan, metadata tiers, thumbnails, SSE, read-only console) | WORKING | `node app/scripts/verify-server.mjs` → "server smoke verification passed" (leaf 1.1.2) |
| UI read surfaces (shell, browser, grid, inspector, console) | WORKING | `node app/scripts/verify-ui.mjs` → "ui build verification passed" (leaf 1.1.3) |
| Write pipeline + safety core (preview/execute/verify, journal, recovery, AI-scrub service) | WORKING | `node app/scripts/verify-write.mjs` → "write pipeline verification passed" (leaf 1.1.4) |
| UI write surfaces (Save Review, Edit, Batch, Results, History/Undo, AI scrub, Settings) | WORKING | `node app/scripts/verify-ui-write.mjs` → "ui write surfaces verification passed" (leaf 1.1.5) |
| Launch lifecycle (double-click → browser; single-instance; free port; health handshake; graceful stop; `--stop`; no orphans) | WORKING | `node app/scripts/verify-launch.mjs` → "launcher verification passed" (leaf 1.1.6) |
| Docs (README / STATUS / HANDOFF / CLAUDE.md / resources/help) | DONE | leaf 1.1.6 G2 manual review |
| GPS destructive channel + graceful batch cancel + history scrub linkage | DONE (59-tag whitelist, phrase-gated, export-first, byte-identical undo; cancel between files only) | `node app/scripts/verify-write.mjs` (leaf 1.1.4b, 90 tests) + e2e `gps` oracle |
| End-to-end oracles + Playwright visual matrix (10 real-flow screenshots) | DONE | `node app/scripts/verify-e2e.mjs all` → "all e2e verifications passed" (leaf 1.2.1); root gates G3/G4 MET with bound evidence |
| Desktop wrap (own window, tray, Explorer drag-drop with real paths, single-instance, crash dialog, portable package) | WORKING | `node app/scripts/verify-desktop.mjs bundle\|shell\|matrix` → "desktop … verification passed" (leaves 2.1.1/2.1.2); `node app/scripts/verify-package.mjs` → "package verification passed" (leaf 2.2.2); `node app/scripts/run-clean-machine.mjs` → "clean-machine drill passed" (leaf 2.2.3) |
| Release v1.0.0 (clean-machine smoke, update rehearsal, release records, tag) | DONE (zip + NSIS built; provenance hashes published; tag `v1.0.0`) | `node app/scripts/run-clean-machine.mjs` + `… update` → "clean-machine drill passed" / "update rehearsal passed"; `docs/release/RELEASE-NOTES-v1.0.0.md`; runbook `HANDOFF-V1.md` (leaf 2.2.3) |

## How to start it

Users: double-click `MetaDesk.exe` inside the extracted package folder (first run shows the
documented SmartScreen click-through — `README.md` + `docs/release/`). Development:
double-click `bin\metadesk.cmd` → browser opens at a 127.0.0.1 address. Close the window to
stop. Full plain-English detail: `README.md`.

## Known gaps (honest list)

- **ComfyUI `prompt`/`workflow` chunks and C2PA/JUMBF manifests are detect-only** — the AI
  scrub reports them under "cannot be removed" with plain-English notes; it never silently
  skips them.
- **Hidden-alpha data is warning-only** — pixel-level data (alpha-channel pnginfo,
  SynthID-style watermarks) is beyond any metadata tool; the UI says so.
- **Settings: engine-path restore and the `-api` knob are deferred**; safety toggles there
  are hard-floored (visible, explained, not switchable-off).
- **Write-capable console deferred to v1.1** — the v1 console is strictly read-only.
- **SSE-held-open close (dev path only)** — with a live `/api/events` connection the
  graceful close waits out the 20 s launcher window and ends in the documented
  `taskkill /T /F` escalation (no orphans, journals intact). The packaged app is immune:
  the shell navigates the webview away first and closes in ≈1 s. Fix is a v1.1 server
  touch, forbidden while the freeze holds (`metagui-phase2/BUILD-NOTES.md`).
- **No signing certificate in v1** — first run shows SmartScreen "Windows protected your
  PC" → More info → Run anyway (documented in README + release notes); NSIS
  installer is built but the portable zip is the distribution of record.

## Next steps

**The release is cut. Future sessions start from `HANDOFF-V1.md` (release runbook).**

1. v1.1 backlog (Mike's call, per `..\HANDOFF-PHASE2.md` §2): write-capable console,
   strip/clean wizard presets, CSV/JSON bulk import-export, geotag-from-GPX, the SSE
   server fix, Settings engine-restore + `-api` knob, and the rest of the list.
2. Post-MVP dependency pass for the 5 vitest-tree audit findings (dev-only; do NOT
   `npm audit fix --force`).
3. If distribution widens: purchase a code-signing certificate (removes SmartScreen) and
   exercise the NSIS install/update flow, then re-record the release story.
