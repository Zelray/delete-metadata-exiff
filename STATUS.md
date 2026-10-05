# MetaDesk — STATUS (one-glance chart)

Updated: 2026-10-05 (wave 5, leaf 1.1.6). Detailed handoff: `HANDOFF.md`.
Build contract of record: `../.unlazy/metagui/BUILD-NOTES.md`.

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
| GPS destructive channel + graceful batch cancel + history scrub linkage | **IN FLIGHT** | leaf 1.1.4b (wave 5, parallel with 1.1.6) |
| End-to-end round trip + AI-scrub e2e oracles (Playwright matrix) | NOT STARTED | leaf 1.2.1 + root gates G3/G4 (`app/scripts/verify-e2e.mjs`) |
| Desktop wrap (own window, Start-menu icon, installer) | NOT STARTED | buildOutline step 9 (Tauri v2) |

## How to start it

Double-click `bin\metadesk.cmd` → browser opens at a 127.0.0.1 address. Close the window
to stop. Full plain-English detail: `README.md`.

## Known gaps (honest list)

- **Desktop wrap pending** — MetaDesk currently lives in a browser tab the launcher opens;
  the Tauri v2 wrap (own window, tray, Explorer drag-drop with absolute paths, installer)
  is buildOutline step 9 and is numbered, non-optional work before v1.
- **ComfyUI `prompt`/`workflow` chunks and C2PA/JUMBF manifests are detect-only** — the AI
  scrub reports them under "cannot be removed" with plain-English notes; it never silently
  skips them.
- **Hidden-alpha data is warning-only** — pixel-level data (alpha-channel pnginfo,
  SynthID-style watermarks) is beyond any metadata tool; the UI says so.
- **Settings: engine-path restore and the `-api` knob are deferred**; safety toggles there
  are hard-floored (visible, explained, not switchable-off).
- **Write-capable console deferred to v1.1** — the v1 console is strictly read-only.
- **Launcher idle-exit deferred to the Tauri wrap** — with a browser tab there is no
  reliable "the user is gone" signal, so the v1 lifecycle closes only when you close its
  console, press Ctrl+C, or run `--stop`. The Tauri shell ties server lifetime to the
  window and removes the question entirely.

## Next steps

1. Leaf 1.1.4b release (GPS destructive channel + cancel) → re-run `verify-write` +
   `verify-ui-write`.
2. Leaf 1.2.1: `app/scripts/verify-e2e.mjs roundtrip` and `... scrub` (root gates G3/G4),
   then the Playwright matrix.
3. Tauri v2 wrap (step 9) → double-click icon opens its own window with zero server/UI
   code changes.
4. v1 release checklist (step 10): clean-machine smoke, diagnostics bundle + copy-logs
   button, `HANDOFF-V1.md`, tag the release.
