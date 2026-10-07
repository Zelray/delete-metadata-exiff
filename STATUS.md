# MetaDesk — STATUS (one-glance chart)

Updated: 2026-10-07 (v1.0.0 released; arch-v11 leaves 1.1 `97511ff`+`421219b`, 1.2 `b747379`+`572b97c`+`cb8eb6c`, 1.3 destructive leaf-kit `590a465` + docs, 1.4 UI write-fire consolidation `4482a9c`+`43512fa`, 1.4b dependency pass `f9fac34`+`73f5f67`, 1.5 session-scoped batch in flight `077847c`+`7730292` — all committed, all gates green, npm audit 0; **leaf-1.5 commits LOCAL, push pending Mike's word**). Detailed handoff: `HANDOFF.md`; release runbook: `HANDOFF-V1.md`; **next work: candidate 6 per `..\HANDOFF-CANDIDATE6.md` (repo root)**.
Build contract of record: `../.unlazy/metagui/BUILD-NOTES.md` + `../.unlazy/metagui-phase2/BUILD-NOTES.md`.

## Patient chart

| Area | State | Verified by |
|---|---|---|
| Write subsystem composition root (arch-v11: ONE `WriteSubsystem` owns write mode + journal + pipeline/scrub/gps strip graph; routes thinned; mode-changed announce fused) | WORKING — committed `97511ff` | `.unlazy/arch-v11/gates/leaf-1.1.md` G1–G6 + senior review PASS (details `HANDOFF.md` §9) |
| SSE single writer + graceful close (arch-v11 leaf 1.2: ONE frame writer; preClose hub drain — live-reader close ≈2 ms, was a 20 s taskkill escalation; event union now honest) | WORKING — committed `b747379`; nine gates green on final bytes | `.unlazy/arch-v11/gates/leaf-1.2.md` G1–G9 + senior review PASS (details `HANDOFF.md` §9.1) |
| Destructive leaf-kit (arch-v11 leaf 1.3: ONE internal kit owns the RAW refusal list, the all-tier batched read, and the pre-write export for both destructive flows; their deliberate safety differences stay per-flow; the full driver is deferred with a recorded promotion trigger) | WORKING — committed `590a465`; ten gates gate-check-bound green on final bytes + senior review PASS | `.unlazy/arch-v11/gates/leaf-1.3.md` G1–G11 (details `HANDOFF.md` §9.2) |
| UI write-fire consolidation (arch-v11 leaf 1.4: ONE runner + SaveReviewModal fire every write — the wizard's and GPS strip's confirm forks are gone; the TYPED phrase is the execute payload; refusals render in-modal; detection evidence is labeled by type and can never masquerade as a preview; GPS non-streamed by contract; enforced by a source-contract test) | WORKING — committed `4482a9c`+`43512fa`; nine gates gate-check-bound green on final bytes + senior review PASS | `.unlazy/arch-v11/gates/leaf-1.4.md` G1–G10 (details `HANDOFF.md` §9.3) |
| Dependency pass (arch-v11 leaf 1.4b: @fastify/static 8→10.1.5 — the runtime path-traversal class — plus vitest 2→5 / vite 5→8 / plugin-react 5 clearing every dev advisory; zero source bytes changed; npm audit 0) | WORKING — ten gates gate-check-bound green on final bytes + senior review PASS | `.unlazy/arch-v11/gates/leaf-1.4b.md` G1–G11 (details `HANDOFF.md` §9.4) |
| Session-scoped batch in flight (arch-v11 leaf 1.5: ONE transient `writeRun` slice — progress + honest Cancel reachable INSIDE the busy dialog from every route; the gate, progress, and cancel survive any navigation; one-write-at-a-time enforced and visible; completion never yanks — a 'Write finished — View report' note instead — and failure never claims success; proven by two real-browser oracles incl. a real between-chunks cancellation on a ~400-file fixture) | WORKING — nine gates double-bound green on final bytes + senior review PASS | `.unlazy/arch-v11/gates/leaf-1.5.md` G1–G10 (details `HANDOFF.md` §9.5) |
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
   fix is DONE — arch-v11 leaf 1.2.) Leaf-1.4 additions: streamed batch-complete
   frames should carry consistencyNotes (unlocks the one-field GPS stream flip);
   scrub execute stream + batchId exposure; routed scrub preview (real WritePreview);
   the two preserved Retry quirks (GPS inert; scrub → unsafe_tag).
2. ~~Post-MVP dependency pass~~ **DONE — arch-v11 leaf 1.4b** (npm audit 0; the
   `--force` warning stands as the standing rule). Residual: root `engines` floor
   could tighten to `>=22.12.0` (the new toolchain's real floor; review LOW-1,
   flag-only).
3. If distribution widens: purchase a code-signing certificate (removes SmartScreen) and
   exercise the NSIS install/update flow, then re-record the release story.
