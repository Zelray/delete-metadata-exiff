# MetaDesk — STATUS (one-glance chart)

Updated: 2026-10-06 (v1.0.0 released; arch-v11 leaves 1.1 `97511ff`+`421219b`, 1.2 `b747379`+`572b97c`+`cb8eb6c`, 1.3 destructive leaf-kit `590a465` + docs — all committed, all gates green). Detailed handoff: `HANDOFF.md`; release runbook: `HANDOFF-V1.md`; **next work: candidate 3 per `..\HANDOFF-CANDIDATE3.md` (repo root)**.
Build contract of record: `../.unlazy/metagui/BUILD-NOTES.md` + `../.unlazy/metagui-phase2/BUILD-NOTES.md`.

## Patient chart

| Area | State | Verified by |
|---|---|---|
| Write subsystem composition root (arch-v11: ONE `WriteSubsystem` owns write mode + journal + pipeline/scrub/gps strip graph; routes thinned; mode-changed announce fused) | WORKING — committed `97511ff` | `.unlazy/arch-v11/gates/leaf-1.1.md` G1–G6 + senior review PASS (details `HANDOFF.md` §9) |
| SSE single writer + graceful close (arch-v11 leaf 1.2: ONE frame writer; preClose hub drain — live-reader close ≈2 ms, was a 20 s taskkill escalation; event union now honest) | WORKING — committed `b747379`; nine gates green on final bytes | `.unlazy/arch-v11/gates/leaf-1.2.md` G1–G9 + senior review PASS (details `HANDOFF.md` §9.1) |
| Destructive leaf-kit (arch-v11 leaf 1.3: ONE internal kit owns the RAW refusal list, the all-tier batched read, and the pre-write export for both destructive flows; their deliberate safety differences stay per-flow; the full driver is deferred with a recorded promotion trigger) | WORKING — committed `590a465`; ten gates gate-check-bound green on final bytes + senior review PASS | `.unlazy/arch-v11/gates/leaf-1.3.md` G1–G11 (details `HANDOFF.md` §9.2) |
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
- **No signing certificate in v1** — first run shows SmartScreen "Windows protected your
  PC" → More info → Run anyway (documented in README + release notes); NSIS
  installer is built but the portable zip is the distribution of record.

## Next steps

**The release is cut. Closeout (drill + QA verdict) for the wrapping session:
`..\HANDOFF-PHASE2-CLOSEOUT.md` (repo root). Steady-state sessions start from
`HANDOFF-V1.md` (release runbook).**

1. v1.1 backlog (Mike's call, per `..\HANDOFF-PHASE2.md` §2): write-capable console,
   strip/clean wizard presets, CSV/JSON bulk import-export, geotag-from-GPX,
   Settings engine-restore + `-api` knob, and the rest of the list. (The SSE server
   fix is DONE — arch-v11 leaf 1.2.)
2. Post-MVP dependency pass for the 5 vitest-tree audit findings (dev-only; do NOT
   `npm audit fix --force`).
3. If distribution widens: purchase a code-signing certificate (removes SmartScreen) and
   exercise the NSIS install/update flow, then re-record the release story.
