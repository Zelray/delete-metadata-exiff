# MetaDesk — HANDOFF (agent-facing technical handoff)

Audience: the next coding agent (or human contributor) picking up MetaDesk work.
Updated: 2026-10-06, arch-v11 WriteSubsystem lift (orchestrator; post-release work).
Mike-facing overview is `README.md`; the
one-glance chart is `STATUS.md`; working rules for agent sessions are `CLAUDE.md`.

**The contract of record is `../.unlazy/metagui/BUILD-NOTES.md`.** It pins the engine
protocol facts (`--` is forbidden, CRLF framing, in-band JSON errors, `-config` only on
the initial command line, NTFS-hostile-name rules), the shared API contract, the pinned
server/UI handshake, the route paths of record, and the write-pipeline facts. **Read it
before writing any code; this file references it and does not duplicate it.** The design
bible is `../.unlazy/metagui/artifacts/ux-spec.json`; the architecture decision is
`../.unlazy/metagui/artifacts/architecture-verdict.json`; the full safety contract
(20 mandatory requirements) is `../.unlazy/metagui/artifacts/data-safety.json`.

---

## 1. Architecture map

npm-workspaces monorepo under `app/` (workspaces: `shared`, `server`, `ui`, `tests-e2e`).
Node 22 + TypeScript end to end. TypeScript strict.

```
double-click bin\metadesk.cmd      (or metadesk-dev.cmd; or npm run dev)
      │  pwsh shim
      ▼
bin\metadesk.ps1 ──────────────► bin\metadesk.mjs        ◄── leaf 1.1.6: THE lifecycle
      (dev pair first runs bin\engine-smoke.mjs)
      │  argv-array spawn (stdin pipe held)
      ▼
node node_modules\tsx\dist\cli.mjs server\src\index.ts --port N
      │  (tsx runs the entry in a child of itself: see §5 "the tsx hop")
      ▼
server\src\index.ts  — Fastify on 127.0.0.1 ONLY
      ├─ engine\exiftoolSession.ts   one persistent `exiftool -stay_open True -@ -` session
      ├─ routes\*                    api / files / metadata / thumbnails / events / writes / recovery
      ├─ services\*                  scan, metadata, thumbnails, watcher, writePipeline,
      │                              journal, results, recovery, lock, pathGuard, scrub
      └─ ui\dist\                    static host of the built React bundle (boot script injected)
      ▲
      │  HTTP + SSE (X-MetaDesk-Token per launch; token in portfile + window.__METADESK__)
ui\src\*   React + Vite + Tailwind/shadcn (shell, views, write surfaces)
```

Data flow on disk: `data\` (gitignored) holds the runtime state — `portfile.json`
(server-written), `instance.lock` + `stop.request` (launcher-written), plus server-owned
caches (`engine-version.json`, `tag-catalog-13.59.json`, `thumbs\`). The write journal
lives under the data dir as JSONL (see `services/journal.ts`).

Ownership boundaries are in `../.unlazy/metagui/PLAN.md` (dispatch table). Current
actives: leaf 1.1.4b owns `server/src/services/{writePipeline,gpsStrip}.ts`,
`server/src/routes/writes.ts`, `server/test/write/**`, `ui/src/api/client.ts`,
`ui/src/write/types.ts`, `ui/src/views/EditPanel/**`. Everything in `shared/src/**`,
`server/src/engine/**`, and `vendor/**` is frozen outside orchestrator-approved changes.

## 2. The launch lifecycle (leaf 1.1.6) — what exists and why

`bin/metadesk.mjs` is the single lifecycle implementation shared by the dev pair
(`metadesk-dev.ps1`/`.cmd`: engine smoke probe first, then delegate) and the production
pair (`metadesk.ps1`/`.cmd`: straight launch). Node built-ins only; every child process
is spawned with an argv array.

1. **Single-instance**: `data/instance.lock` records `{launcherPid, serverPid, port,
   startedAt, dataDir}`. A second launch sees a live `launcherPid` (or a live,
   health-answering portfile) and does NOT start a second server — it waits briefly for
   the portfile, opens the running URL in the browser, exits 0. A lock whose pid is dead
   is stale and removed. Liveness = `process.kill(pid, 0)` (EPERM counts as alive).
2. **Free port**: bind `127.0.0.1:0`, read the port, close (or `--port N` / `METADESK_PORT`).
3. **Server start**: `spawn(process.execPath, [tsx, server/src/index.ts, '--port', N])`
   with `stdio: ['pipe','pipe','pipe']` and `METADESK_DATA_DIR` forwarded. The launcher
   never writes the portfile — the server owns it (`{port, token, pid, startedAt, engine,
   url}`, `server/src/index.ts → writePortfile`).
4. **Health handshake**: poll `GET /api/health` (token-exempt by pinned contract) until
   200. `ok:false` (engine broken) is a loud WARN + the app starts READ-ONLY per the
   ux-spec first-run flow — it is not a boot failure. Then the launcher reads the
   portfile for the authoritative pid/url.
5. **Browser**: `rundll32 url.dll,FileProtocolHandler <url>` (argv array), skipped with
   `--no-browser`.
6. **Graceful stop**: the launcher closes the server's **stdin pipe** — the established
   Windows stop channel (Windows sends no signals on console close; `server/src/index.ts`
   shuts down when its stdin ends, closing the watcher, SSE hub, and engine session
   through the graceful ladder). Triggers: launcher stdin ends (window closed / parent
   died — the OS closes pipe handles on process death, so a hard-killed launcher still
   stops the server), Ctrl+C/SIGINT/SIGTERM/SIGBREAK, or `stop.request` appearing in the
   data dir.
7. **`--stop`**: a second invocation writes `data/stop.request`, waits up to 20 s for the
   portfile pid to die, sweeps `portfile.json` / `instance.lock` / `stop.request`, and
   reports the exiftool process count. Only if the graceful window expires does it
   escalate to `taskkill /PID <pid> /T /F` (tree kill, so the engine child dies too) —
   verified in testing to never be needed on the graceful path.
8. **After every exit**: launcher verifies the server pid is gone, removes the portfile
   and its own lock (only if it owns them), re-checks the exiftool count against the
   pre-spawn baseline (10 s settle), and WARNs loudly on orphans. **The launcher never
   kills exiftool processes it does not own** — Mike may have his own running.

### The tsx hop (process-tree fact)

The launcher's direct child is `tsx/dist/cli.mjs`, which may run the server entry
in-process or fork it (observed both ways across runs). Either way tsx forwards stdin,
so closing the launcher→tsx stdin pipe reaches the server's `stdin end` handler.
Consequence: **always trust `portfile.json.pid` as the server pid** — it is what
`--stop` watches and what the orphan checks test. The lock's `serverPid` records the
launcher's direct child and may or may not equal it; both die together on every stop
path (verified in `verify-launch.mjs`).

### Known caveats

- **stdin-detached starts stop immediately.** If the launcher is started with its stdin
  closed or at EOF (some schedulers, `start /b`, a null-stdin CI step), it treats that as
  "the console is gone" and gracefully stops — mirroring the server's own contract. The
  supported starts are: double-click the shim (new console, TTY stdin), run it in an
  open console, or spawn it with a held-open stdin pipe (what the verify gate does).
- **Idle exit is deliberately deferred** to the Tauri wrap (a browser tab gives no
  reliable "user is gone" signal; see STATUS known-gaps). Do not add a timer-based idle
  exit without an orchestrator decision — it risks stranding a write mid-batch, which is
  the exact risk #2 the lifecycle exists to prevent.
- `engine-version.json` and `tag-catalog-*.json` in the data dir are server-owned caches;
  the launcher (and you) should leave them alone.

## 3. How to run / test / verify every gate

Run from the repo root (`MetaProject/`) unless noted. Each verify script prints its
marker as the FIRST stdout line and exits 0/1. The orchestrator runs the same scripts as
gate checks; agents run them locally before claiming done.

| Command | Marker (first stdout line) | Proves |
|---|---|---|
| `node app/scripts/verify-engine.mjs` | `engine layer verification passed` | Server Vitest suite green: stay_open protocol framing, hostile filenames (`--All=`, quotes, newlines, CJK/emoji), arg-builder goldens, tag database. 15-min timeout. |
| `node app/scripts/verify-server.mjs` | `server smoke verification passed` | 14-step live smoke of the real server: token gates (401/403), Host-spoof, scan/metadata tiers, thumbnail JPEG magic, binary endpoint, SSE hello/heartbeat/folder-changed, read-only console, path guard, boot-script injection, stdin-close shutdown with zero orphan exiftool. |
| `node app/scripts/verify-ui.mjs` | `ui build verification passed` | Strict UI build + UI unit tests. |
| `node app/scripts/verify-write.mjs` | `write pipeline verification passed` | Write suite: preview/execute/verify, journal, lock, recovery, results, scrub. |
| `node app/scripts/verify-ui-write.mjs` | `ui write surfaces verification passed` | UI write-surface tests + strict build. |
| `node app/scripts/verify-launch.mjs` | `launcher verification passed` | Drives `bin/metadesk.mjs` end to end with a temp `METADESK_DATA_DIR`: boot+portfile, instance lock, health, served UI with token, second-launch focus (no second server), `--stop` from a separate process, launcher exit 0, pid gone, zero residue, node+exiftool counts back to baseline. |
| `npm test` (from `app/` or `app/server/`) | vitest summary | The server test suite (same one verify-engine runs). |

Cautions (pinned in BUILD-NOTES "Test seams" and proven here):

- **Never** invoke vitest directly from `app/` (no config there) — it parallel-discovers
  the UI suite and scrambles the shutdown test's process counts. Use `npm test`.
- **Never** run `verify-launch.mjs` concurrently with `npm test` or other node-heavy
  jobs — its no-orphan assertion counts node.exe/exiftool.exe machine-wide (baseline vs
  after), so concurrent process churn reads as orphans.
- The verify scripts spawn PowerShell (`pwsh`) and `tasklist`; they are Windows-only by
  design (this is a Windows-only product).
- `npm audit` reports 5 findings, all inside the vitest 2.x dev tree. Deliberate
  dependency pass is scheduled post-MVP. **Do NOT `npm audit fix --force`.**
- npm `allowScripts` on this machine blocks some postinstall scripts (esbuild ships
  prebuilt, so vitest still works). New native deps may need
  `npm install-scripts approve`.

## 4. Wave history and adjudications

| Wave | Leaf | Commit | Delivered |
|---|---|---|---|
| 1 | 1.0.1 (discovery) | artifacts only | capability map, prior art, data-safety contract, ux-spec |
| 1 | 1.0.2 (verdict) | artifacts only | hybrid-web-first architecture verdict (Tauri v2 as the v1 shell) |
| 1 | 1.1.1 | `776b479` | monorepo scaffold + exiftool engine layer (sessions, argBuilder, engineArgs, healthCheck, tagDatabase) + `verify-engine` |
| 2 | 1.1.2 | `984eafd` | read API: Fastify bootstrap (127.0.0.1, token, Host/Origin gates), scan/metadata/thumbnail/watcher services, read-only console, `verify-server` |
| 2 | 1.1.3 | `41b44a6` | UI read surfaces (shell, browser, grid, inspector, console) per ux-spec; `d2c44c5` fix: verify-ui progress to stderr so the marker is stdout-first |
| 2/3 | 1.1.2 follow-up | `e175dc0` | server verify reports which UI surface (bundle vs status page) it injected into |
| 3 | 1.1.4 | `fa8c697` | write pipeline + safety core: preview/execute/verify, JSONL journal, single-writer lock, pathGuard, recovery, AI-scrub service, `verify-write` |
| 3 | orchestrator | `b4ef514` | integration: mounted write + recovery routes in `server/src/index.ts` (onSend adds `writeUnlocked`/`mode` to /api/health) |
| 4 | 1.1.5 | `86e18c6` | UI write surfaces: Save Review gate, Edit, Batch, Results, History/Undo, AI scrub wizard, Settings; `verify-ui-write` |
| 5 | 1.1.4b | DONE — d13db99 | GPS destructive channel (phrase-gated, export-first), graceful batch cancel, history scrub linkage |
| 5 | 1.1.6 | DONE — f4e7964 | launch lifecycle (`bin/metadesk.mjs` + dev/prod pairs), `verify-launch`, README/STATUS/HANDOFF/CLAUDE.md, `resources/help`, `data/.gitkeep` |

Orchestrator adjudications worth remembering (full log: `../.unlazy/metagui/status.log`):

- **Wave-2 route reconciliation**: the UI client's route paths were wrong until the
  orchestrator reconciled them to the server (`POST /api/files/scan`, `GET /api/thumbnail`);
  the route map was then pinned in BUILD-NOTES. Lesson: shared contract first, routes
  second — do not invent route paths from the UI side.
- **leaf 1.1.4 OWNS amended** before re-dispatch: `routes/console.ts` → `routes/recovery.ts`
  (the read-only console already lived in `routes/api.ts` from 1.1.2).
- **Routes are mounted by the orchestrator**, not by leaf 1.1.4 (it did not own
  `index.ts`) — hence commit `b4ef514`. If you add routes, expect the same split.
- **`App.tsx` transferred 1.1.3 → 1.1.5** at wave 4; **`bin/**` transferred 1.1.1 → 1.1.6**
  at wave 5 (this leaf). Transfers are recorded in PLAN.md; never concurrent.
- **Contract revision 4 (wave-4 review)**: honest UI surfacing showed the Remove-GPS flow
  could not fire and batch lacked graceful cancel → leaf 1.1.4b was ADDED rather than the
  gap being waved through. Report gaps honestly; the orchestrator amends the tree.
- **Write-capable console is deferred to v1.1** (BUILD-NOTES pin); the v1 console stays
  read-only through the strict validator in `routes/api.ts`.
- **AI scrub (C9) was promoted into v1** mid-plan (Mike's amendment 2) and rides the
  destructive-flow pattern.
- Wave policy: ≤2 build leaves in parallel, ≤5 GLM agents machine-wide (HTTP 429 history).

## 5. Safety contract — summary and where the full version lives

Full version: `../.unlazy/metagui/artifacts/data-safety.json` (the 20 mandatory
requirements), enforced by the Vitest suites (`server/test/**`, incl.
`hostileFilenames.test.ts`), not by convention. Engine protocol facts are pinned in
BUILD-NOTES and are NOT restated here. The shape of it:

- **Read-only by default.** Write unlock is session-scoped, deliberate, plain-English,
  amber-bindered; mode is readable from `/api/health`.
- **Whitelist-driven arg builder.** User text only ever occupies the VALUE slot of one
  `-TAG=VALUE` argument; empty means leave-unchanged; deletion is a separate explicit
  action; `-overwrite_original`/`_in_place` are hard-rejected in code; `--` is rejected by
  `engineArgs` (BUILD-NOTES fact #1 — never re-add it). Absolute paths only.
- **Mandatory preview before any write** (Save Review): per-tag old→new per file plus the
  exact argv (`commandPreview`); `noop` flag is the real "nothing will change" signal.
- **Backups + verification.** Default `_original` backup mode, `-P` to preserve times;
  backup path/size/SHA-256 journaled intent-first; read-back verification before a file
  may be called "updated"; three-valued results, never exit-code-based (fact #3).
- **Undo from journal before-values**, two-step, refuses double-undo; nuclear `_original`
  restore is labeled and hash-verified.
- **Destructive flows are typed-phrase gated and export-first** (scrub requires
  `REMOVE AI METADATA`; GPS strip follows the same pattern — landing via leaf 1.1.4b).
  Detect-only items (ComfyUI prompt/workflow chunks, C2PA) are listed under a
  cannot-be-removed section with plain-English notes; hidden-alpha is a warning only.
- **Single-writer lock + path sanitizer** (`services/lock.ts`, `services/pathGuard.ts`).
- All file operations funnel through the one server process; the local port is loopback-
  only with Host/Origin checks and a per-launch token (architecture-verdict risk #3).

**Never bypass any of this for convenience.** If a feature seems to require bypassing it,
stop and escalate to the orchestrator instead.

## 6. Remaining work, with acceptance criteria

1. ~~**Leaf 1.1.4b — GPS destructive channel + cancel**~~ **DONE** (wave 5, commit
   d13db99; gates met — see §8 and `.unlazy/metagui/gates/leaf-1.1.4b.md`).
2. ~~**Leaf 1.2.1 — e2e oracles + Playwright matrix**~~ **DONE** (wave 6, commit 593159c;
   root gates G3/G4 MET with bound evidence; `app/scripts/verify-e2e.mjs` modes:
   `unit | roundtrip | scrub | gps | all` — `all` ≈ 5 min).
3. **Tauri v2 wrap (buildOutline step 9) — the v1 desktop shell.** Add `app/tauri/`
   (`src-tauri/`, `tauri.conf.json`): register `vendor/exiftool/exiftool.exe` as a Tauri
   sidecar; bundle portable `node.exe` and spawn the server as its child; own window +
   icon + tray + taskbar identity; real Explorer drag-drop with absolute paths; file
   associations; installer (portable zip + Inno Setup). **AC:** double-click icon →
   window opens → identical UI, **zero code changes** to server or UI. The launcher's
   lifecycle is the seam: Tauri replaces "console window lifetime" with "window
   lifetime" (retiring the stdin-stop caveat and the idle-exit gap); `bin/metadesk.mjs`
   remains the supported dev/no-Tauri path. Do not remove it during the wrap.
4. **v1 release checklist (buildOutline step 10).** Clean-machine smoke test (no dev
   tools installed), diagnostics bundle + copy-logs button, `HANDOFF-V1.md` runbook for
   future agent sessions, tag the release.
5. **Deferred to v1.1+** (mvpScope, do not pull forward without Mike): full Strip/Clean
   wizard presets, write-capable console, CSV/JSON bulk import-export, geotag-from-GPX,
   rename/move-by-date, MIE/XMP sidecar archive-and-restore, tag database browser,
   standards-validation report, compare beyond `_original`, analytics/plot, map panel
   with reverse geocoding, deep RAW editing. Plus the Settings engine-path restore and
   `-api` knob deferred by leaf 1.1.5.
6. **Post-MVP dependency pass** for the 5 vitest-tree audit findings (dev-only).

## 7. Conventions for working here

See `CLAUDE.md` (short version) and `../.unlazy/metagui/PLAN.md` (ownership truth). The
two that bite hardest: **argv-array execution only, never shell strings**, and **never
modify `exiftool/` (repo reference clone), `vendor/**`, `shared/**`, or
`server/src/engine/**`** — shared-contract changes go through the orchestrator only.
Keep docs honest as work happens (STATUS = chart, HANDOFF = this file, README = Mike).

## 8. Wave 6 + integration fixes (2026-10-05, recorded by the orchestrator)

- **Leaf 1.2.1 (commit 593159c):** `app/scripts/verify-e2e.mjs` with subcommands
  `unit | roundtrip | scrub | gps | all`. The `roundtrip` and `scrub` subcommands ARE
  root gates G3/G4 (markers: "e2e roundtrip verification passed" / "e2e AI-scrub
  verification passed"); `all` adds the Playwright matrix and prints "all e2e
  verifications passed". The matrix drives the real launcher + built bundle headlessly
  and writes 10 real-flow screenshots to `app/evidence/` (mirrored byte-identical to
  `app/tests-e2e/__evidence-snapshot__/`, which is what git tracks).
- **Two real product bugs the e2e matrix caught (unit-stubbed tests could not see
  them), fixed by the orchestrator (commit f82066c) in `ui/src/api/client.ts`:**
  (1) streaming `executeWrite` lacked `Content-Type: application/json`, so Fastify
  never parsed the body and EVERY Edit/Batch write 400'd in the real browser;
  (2) `getThumbnail` JSON-parsed an endpoint that streams raw JPEG bytes, so the grid
  always showed the placeholder — it now fetches bytes (an `<img>` cannot send the
  token header) and returns a blob URL. The matrix asserts both fixed behaviors.
- **Cancel wiring:** BatchPanel Cancel button (visible only while a batch streams),
  ResultsReport not-attempted rows (leaf 1.2.1, transferred ownership).
- **Orchestrator housekeeping commits:** b4ef514 (mount write/recovery routes in
  index.ts), 3909b2f (gitignore vendored exiftool runtime Data caches), f82066c
  (the two client fixes), plus the docs/evidence commit recorded after this section.
- **QA verdicts (Agency gate):** Evidence Collector — EVIDENCE SUFFICIENT (7/10 frames
  fully prove their claims; 3 partial with cosmetic framing notes, listed in STATUS
  next steps). Reality Checker — NEEDS WORK on first audit, with explicit closing
  conditions (fill manual review gates, commit refreshed snapshots, update docs through
  wave 6, deliver the decision brief); all conditions closed by the orchestrator — see
  `.unlazy/metagui/status.log` and the confirmation re-audit verdict.
- **Every verify gate in one place:** `verify-engine|server|ui|write|ui-write|launch|e2e`
  (§3 table gains one row: `verify-e2e.mjs` — subcommands as above, ~5 min for `all`).

## 9. arch-v11 — the WriteSubsystem composition-root lift (2026-10-06, UNCOMMITTED)

Implemented architecture-review candidate 1 ("one owner at the composition root"),
approved by Mike. Contract of record for the change: `../.unlazy/arch-v11/BUILD-NOTES.md`
(design, file-by-file plan, pinned constraints, parked items — read it before touching
any of these files again). Acceptance ledger: `../.unlazy/arch-v11/gates/leaf-1.1.md`.

What changed (wiring only — no route path, payload shape, or safety-core change):

- **NEW `server/src/writeSubsystem.ts`** — `WriteSubsystem`, constructed once in
  `buildServer`, is the ONE owner of: session write mode (private `WriteSessionState`;
  `unlock()`/`lock()` are the only mutators and the `mode-changed` announce is fused
  inside them via the `announce` ctor callback), THE Journal instance, and the
  pipeline/scrub/gpsStrip graph (null iff engine null). It imports no Fastify types and
  owns no lifecycle.
- `routes/writes.ts` shrank to a `{ write }` dependency (the WriteSessionState class,
  assembly block, onSend hook and `publishModeChanged` cast all moved/died); handler
  bodies are byte-equivalent via four readonly aliases.
- `routes/recovery.ts` receives the shared journal (its own `new Journal` is gone;
  RecoveryService stays at its registrar). `routes/diagnostics.ts` reads
  `write.healthFields()` + `getHealth` directly — the `app.inject` self-scrape is gone
  (LiveHealth shape, defensive null path and the unreachable context.txt string kept).
  `routes/events.ts` gained the one public `SseHub.publishModeChanged`.
- `index.ts` hosts the onSend `/api/health` stamp (verbatim mechanism, now fed by
  `write.healthFields()`), wires announce → hub, and returns `write` on
  `BuildServerResult` (+`writeChunkSize?` on options — the only new test seam).
- Tests: `routes.test.ts` now runs against the REAL `buildServer` composition (the
  mock-hub twin is dead; every prior assertion kept). NEW
  `test/write/composition.test.ts` (10 tests) pins journal flow-through, engine-null
  503 on all seven write surfaces, the nullability invariant, unlock→bundle flip,
  and mode-changed frames over a real SSE connection (announce fusion — previously
  untested anywhere).

Evidence: baseline gates green on d9a7258; after the lift, gates G1–G6 re-executed on
final bytes (server smoke / write pipeline / diagnostics / ui write surfaces / engine
suite 232 tests / frozen-file check). Senior review: PASS, zero contract deviations;
review findings were fixed in the same pass (diagnostics comment honesty, `export type
WriteMode`, journal-flow test header, GPS destructive-preview 503 surface). `tsc` clean.

Parked / flagged (do not smuggle into other work — full list in arch-v11 BUILD-NOTES):
getHealth freshness (production always shows the boot snapshot; diagnostics wording
overstates — PM decision pending); the diagnostics bundle no longer refreshes the hub's
hello-frame snapshot (accepted delta from deleting the self-scrape; launcher polls
remain the refresher); pre-existing `mapped.code as never` in writes.ts left per the
surgical rule. `.unlazy/metagui/BUILD-NOTES.md` route-mounting sentence was amended by
the orchestrator (hook home moved to index.ts). A domain glossary now lives at
`CONTEXT.md` (repo root) — keep terms consistent with it.
