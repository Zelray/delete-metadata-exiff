# CLAUDE.md — rules for agent sessions working in `app/`

MetaDesk: local ExifTool GUI for Windows. Node 22 + TypeScript, Fastify server, React UI.
Mike is the PM and product owner; he does not read code — write for him in plain English.

## Hard rules

1. **Never modify the engine or its clone.** `app/vendor/exiftool/**` and the repo-root
   `exiftool/` + `vendor/exiftool/` are reference copies. Copy files in only via an
   orchestrator-approved step; never edit, move, or delete.
2. **Never bypass the safety core.** No write path that skips the whitelist arg builder,
   the mandatory preview, the journal, or the backup+verify loop. `engineArgs` rejecting
   `--` is a pinned safety fact, not a bug (BUILD-NOTES fact #1). If a feature seems to
   need a bypass, stop and escalate to the orchestrator.
3. **Argv-array execution only, never shell strings.** Every `spawn` takes an argument
   array with `shell: false`. No string concatenation of commands, no `shell: true`.
4. **Respect ownership globs** (`../.unlazy/metagui/PLAN.md` dispatch table). Do not edit
   `shared/src/**`, `server/src/engine/**`, or any leaf's OWNS set unless that leaf is
   released to you. Do not run gate-check — the orchestrator owns gate approvals. Do not
   modify `.unlazy/**`.
5. **Run the gates before claiming done.** `node app/scripts/<verify-X>.mjs` for every
   layer you touched (markers + caveats in `HANDOFF.md` §3). Never run `verify-launch.mjs`
   concurrently with `npm test` (machine-wide process counting).

## Working conventions

- **Docs by function** (house convention): `STATUS.md` = one-glance chart only, no
  handoffs; `HANDOFF.md` = deep technical handoff, kept current *as* work happens;
  `CLAUDE.md` = this file; `README.md` = Mike-facing plain English. Contract of record =
  `../.unlazy/metagui/BUILD-NOTES.md` — read it first, contradict nothing in it, and
  report deviation requests to the orchestrator instead of silently diverging.
- **Conventional commits** on `app/` main (`feat:`, `fix:`, `docs:`, `chore:` …), scope
  in the body, leaf number in the subject when applicable.
- **Tests live in `server/test/**`** and run via `npm test` (never bare vitest from
  `app/` — it parallel-discovers the UI suite and scrambles the shutdown test).
- **Concurrency cap: max 5 agents on this machine; build waves ≤ 2** (HTTP 429 history).
- **Windows-only by design.** PowerShell is the shell; the verify scripts legitimately
  use `tasklist`/`pwsh`. Node built-ins only in `bin/` and `scripts/` (no new runtime
  deps in the launch path).
- **The launcher owns the lifecycle.** Don't spawn the server by hand for casual runs —
  use `bin/metadesk.mjs` / `metadesk-dev.ps1`. Don't add a second lifecycle implementation;
  don't kill `exiftool.exe` processes you did not create. The server pid of record is
  always `data/portfile.json` (see HANDOFF §2, including the tsx child-process note).
- **`data/` is runtime state** (gitignored). Never hand-edit it, never commit it; the
  launcher sweeps its own files (`portfile.json`, `instance.lock`, `stop.request`) and
  leaves server-owned caches alone.
- **F1 help is the product.** User-facing strings follow the ux-spec tone: plain English,
  honest about limits (detect-only items say "cannot be removed"), no false success.
  `resources/help/metadesk-help.md` mirrors the in-app F1 overlay — update both together.
