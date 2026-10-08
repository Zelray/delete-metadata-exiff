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

**The tabulated contract for these facts** — file schemas with writer/reader/deleter
rights, every timing constant per adapter (the 45 s vs 20 s and 20 s vs 5 s pairs are
deliberate, never "harmonize" them), the stop channel, the env read/strip sets, and the
accepted asymmetries — is `docs/lifecycle-contract.md` (arch-v11 leaf 1.7), cross-checked
by `scripts/verify-lifecycle-contract.mjs` (static, fail-closed; a source change without
a same-commit contract edit fails the gate). This section is the narrative; the contract
is the pinned table; neither may contradict the other.

1. **Single-instance**: `data/instance.lock` records `{launcherPid, serverPid, port,
   startedAt, dataDir}` (`port` is the REQUESTED port — null on every default free-port
   launch; `serverPid` is rewritten to `portfile.pid` after the handshake, metadesk.mjs
   `markServerPid`). A second launch sees a live `launcherPid` (or a live,
   health-answering portfile) and does NOT start a second server — it waits briefly for
   the portfile, opens the running URL in the browser, exits 0. A lock whose pid is dead
   is stale and removed. Liveness = `process.kill(pid, 0)` (EPERM counts as alive).
2. **Free port**: bind `127.0.0.1:0`, read the port, close (or `--port N` — the launcher
   itself reads NO env knob; `METADESK_PORT` is a server-side default that the launcher's
   `--port` argv always overrides).
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
| `node app/scripts/verify-lifecycle-contract.mjs` | `lifecycle contract verification passed` | arch-v11 leaf 1.7: static contract↔code agreement for the lifecycle seam — file schemas (writer/reader/deleter per field), every pinned timing constant, stop-channel anchors (incl. the textual about:blank→SOCKET_SETTLE order), env read/strip sets, backstop + sweep-guard asymmetries. Reads `docs/lifecycle-contract.md` as the expectation source; fail-closed anchors; <100 ms; spawns NOTHING and counts NO processes — safe in any ladder slot (keep the one-at-a-time convention anyway). A source change without a same-commit contract edit fails here, not at release. |
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

## 9. arch-v11 — the WriteSubsystem composition-root lift (2026-10-06)

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

### 9.1 arch-v11 leaf 1.2 — SSE single writer + graceful close (2026-10-06, committed `b747379` + `572b97c` + `cb8eb6c`)

Implemented architecture-review candidate 4 (also the SSE v1.1 backlog fix). Contract:
`../.unlazy/arch-v11/BUILD-NOTES.md` §"Leaf 1.2" (synthesized from a second
design-it-twice workflow, wf_8ca33b5f-3ec — both adversarial verifiers probe-tested the
close physics on this machine's Node 22.22.3). Ledger:
`../.unlazy/arch-v11/gates/leaf-1.2.md`.

What changed:

- **ONE frame writer**: `writeSseFrame` exported from `routes/events.ts` (pure,
  throw-through — each caller keeps its failure policy: hub disconnects, execute
  stream swallows). Hub `sendTo` delegates; the execute-stream `send` delegates with
  `{type, ...payload}` so `type` serializes third — frame bytes identical on both
  transports (golden-bytes test pins EVERY `SseEvent` member against its legacy byte
  string; the compiler forces new members into the pin).
- **Graceful close, fixed**: a `preClose` hook in `index.ts` drains the hub
  (`hub.closeAll()` → one `setImmediate` macrotask → `app.server.closeIdleConnections()`)
  BEFORE Fastify waits on connections. With a live SSE reader, `app.close()` now
  resolves in ~2 ms; on pre-fix bytes it never resolves (the documented 20 s
  launcher-grace → `taskkill /T /F` dev-path escalation). The regression pin
  (`server/test/sse-close.test.ts`) was revert-proven: with the hook removed it hangs
  to its own 20 s timeout. The onClose ladder is untouched and idempotent; the wrapped
  shell's `about:blank` trip is now redundant but harmless. In-flight (mid-batch)
  execute streams still delay close — pre-existing, documented at the hook.
- **The event union is honest**: `shared/src/api.ts` gained the four
  emitted-but-unnamed members (folder-changed, mode-changed, write-error,
  batch-cancelled) + `SseWatchChange` + `phase?` (read by the UI) +
  `commandPreview?` (read by the client) + the ONE orchestrator-authorized amendment
  (`SseWriteProgressEvent.filePath` required→optional — zero wire bytes; no emit site
  sends it). `clients ignore unknown event types` still holds. `SseWriteErrorEvent.code`
  is `string` — every code the mapper can emit is an ApiErrorCode member; the comment
  in api.ts names them exactly.
- **Watcher debounce seam**: `BuildServerOptions.watcherDebounceMs?` → `FolderWatcher`
  (its own 250 default holds); `METADESK_WATCHER_DEBOUNCE_MS` env mirrors the heartbeat
  pattern.

Gates: all nine green on final bytes under orchestrator approval (engine suite 235
tests incl. the new suites · server smoke · write pipeline · diagnostics · ui build ·
ui write surfaces · e2e ALL incl. real-browser streamed write · launcher · frozen
check with the api.ts allowance). Senior review: PASS, zero contract deviations; two
MEDIUM honesty findings fixed by the orchestrator (write-error comment correction in
api.ts; probe evidence recorded here and in the scope BUILD-NOTES) plus one test
robustness nit (`app?.close()` guard). Evidence-snapshot PNGs were retaken by the e2e
matrix (3 frames + manifest, mirrored byte-identically) — folded in as `572b97c`.

REJECTED by design (do not smuggle into the v1.1 console leaf or elsewhere): the
SseSink/attachSink registry (its never-throw send policy is a probe-confirmed
write-after-end crash path; revisit ONLY when the write-capable console needs a second
sink consumer), `connect()` recomposition, SseEvent-typed writer signatures, any
SseBridge edit, closeAll ending execute streams.

### 9.2 arch-v11 leaf 1.3 — destructive leaf-kit (candidate 2) (2026-10-06, committed `590a465` + docs)

Implemented architecture-review candidate 2 per the SYNTHESIZED contract in
`../.unlazy/arch-v11/BUILD-NOTES.md` §"Leaf 1.3" — which supersedes the review card's
"~60% shared skeleton" premise (three-verifier measurement: ~45 verbatim lines of 728;
the load-bearing destructive gates were already once-written in writePipeline.ts and
verified once at writePipeline.test.ts:339-414). The full driver is DEFERRED with a
recorded promotion trigger (a third shape-compatible destructive-delete flow actually
landing; geotag-from-GPX writes values and must never become a row). Ledger:
`../.unlazy/arch-v11/gates/leaf-1.3.md`.

What changed (four files only; zero public-surface growth):

- **NEW `server/src/services/destructiveFlow.ts`** (~75 lines, pure leaf-kit, no
  orchestration, no policy, exactly two consumers): `RAW_EXTENSIONS` (the single
  23-entry set — both in-file copies died), `readAllTierByPath` (one all-tier JSON
  read per call, timeout `60_000 + paths.length*500`, normalizeExifPath-keyed map;
  the per-flow 50-file batch loops stay in the callers, which is what preserves gps's
  partial-rows-on-failure catch), and `writeDestructiveExport` (bare delegation to
  `journal.writeScrubExport` — payload construction stayed in the services, so neither
  sidecar's key set nor values source could change).
- `scrub.ts` 462→448 and `gpsStrip.ts` 268→254: consume the kit; every deliberate
  asymmetry survived line-verified against HEAD (RAW postures, phrase timing — scrub
  fail-fasts before any read, gps has none at service level — empty-selection
  refuse-vs-noop, choreography order, honesty-sweep sourcing, re-detect-at-wipe).
  writePipeline, journal, routes, writeSubsystem, shared, engine, ui, package.json:
  untouched.
- **NEW `server/test/write/destructiveFlow.test.ts`** (211 lines): falsifiable
  goldens — all 23 RAW extensions (with an explicit `dng` NEGATIVE guarding against
  the read-side classification set in metadata.ts), keying/timeout/argv shape, both
  sidecar key sets AND values sources.

Gates: G1–G10 re-executed by the orchestrator under gate-check with bound evidence on
final bytes — ALL PASS (write 108 tests · engine 243 tests · diagnostics · server
smoke · ui-write · typecheck · e2e scrub · e2e gps · e2e roundtrip · frozen). Senior
review (G11): PASS, zero CRITICAL/HIGH/MEDIUM; LOW-1 (gps sweep drops duplicate docs
on normalize collisions — same file spelled two ways in one selection) ACCEPTED as
product-unreachable (selections come from directory scans: one file, one spelling,
one doc) and recorded; NITs dispositioned in the ledger. ZERO code changes after gate
binding — the recorded evidence is final-bytes evidence.

Flagged for the v1.1 backlog (recorded in the scope BUILD-NOTES; do not smuggle): a
third RAW set at `services/metadata.ts:210-213` (read-side classification, adds dng —
DNG displays as RAW but is strip-eligible; unification is a future policy decision);
scrub.test.ts pins the phrase REFUSAL but not the before-any-read ORDERING (pair with
the gps sweep-failure-visibility soft spot in the next write-suite touch); the dead
`dataDir` options on both service option types (flag-only, orphan rule).

### 9.3 arch-v11 leaf 1.4 — UI: the runner is the only place a write is fired (2026-10-06, committed `4482a9c` + `43512fa`)

Implemented architecture-review candidate 3 per the SYNTHESIZED contract in
`../.unlazy/arch-v11/BUILD-NOTES.md` §"Leaf 1.4" — itself a three-verifier merge of a
4-designer round (workflow wf_6f2c8865-7cb; the card's premises were measured, not
trusted: the modal's phrase gate was drop-in, but three honesty gaps and a
consistencyNotes-streaming trade had to be designed around). Ledger:
`../.unlazy/arch-v11/gates/leaf-1.4.md`.

What changed (UI-only; 16 product paths + evidence; zero server/shared/engine bytes):

- **ONE fire site**: `useWriteRun.tsx` dispatches a four-arm `WriteRunPlan` — `edits`
  (byte-identical streamed loop) / `undo` (byte-identical) / `preview` (NEW:
  non-streamed executeWrite with the destructive envelope — the GPS arm;
  consistencyNotes concat preserved by construction) / `scrub` (NEW: scrubExecute
  fired INSIDE run(), compile-required `recordEdits` + `onRecorded`). The wizard's
  confirm step, the GPS ConfirmDialog, the duplicated `GPS_CONFIRM_PHRASE` client
  constant, and `executeGpsStrip`+`GpsStripExecuteResponse` are DEAD. A new
  source-contract test raw-imports all five views + runner + client and fails if any
  view ever fires a write again.
- **The TYPED phrase is the payload**: `SaveReviewModal` `onConfirm(phrase)` →
  `run(phrase)`; the server-minted phrase is gate display only. Server stays the
  authority (untouched).
- **Honesty by type, not convention**: `PreviewGroup.evidence: 'previewed'|'detected'`
  is REQUIRED; detected groups get the re-scan caveat header INSTEAD of the exact-change
  claim, no argv/command sections, no chunk-streaming note (chunkEstimate is
  file-count-driven — the note was false for any non-streamed >200-file group);
  `DetectedPreview` carries the real `report.scrubId` and can never execute generically.
- **In-modal refusal**: destructive-arm failures render the server message verbatim
  INSIDE the still-open dialog (the view ErrorBanner sits behind the modal overlay —
  the occlusion trap three verifiers flagged); the preview survives a refusal, so
  retype-and-retry re-POSTs the same previewId.
- **GPS non-streamed BY CONTRACT**: the wire accepts stream+destructive today
  (writes.ts:161-199) but streamed batch-complete frames omit consistencyNotes —
  flipping is ONE field once the server frame carries them (promotion trigger,
  recorded). GPS phrase now binds the preview envelope's server-minted phrase.
- Declared deltas: confirm surfaces moved into the modal (gate strength
  equal-or-stronger); GPS gate richer (diff table, blockers, backup statement, real
  preview argv); GPS-free files count as 'no change needed' rows; wizard step indicator
  3→2; chunk note absent from destructive gates; labels/pluralization byte-identical.

Gates: ALL NINE runnable gates gate-check-bound green on final bytes (ui · ui-write ·
write 108 · engine 243 · diagnostics · server smoke · typecheck · e2e ALL · frozen).
Two first-pass failures, both diagnosed, neither a code defect: G3 tripped the
routes.test.ts between-chunks cancel test once (ambient timing flake — unchanged
server bytes, builder-green on identical bytes, sequential re-run green); G8 failed
the manifest retake check until the orchestrator extended `RETAKEN_FRAMES` to
`06-scrub-confirm.png` (the frame depicted the REMOVED wizard confirm step;
`scripts/verify-e2e.mjs` + `tests-e2e/matrix.mjs` retake-contract amendment, OWNS
amended). Senior review (G10): PASS, zero CRITICAL/HIGH/MEDIUM; LOW-1 (scrub
`recordEdits` sourced from the detection report rather than the execute response's
re-detection — user-invisible on the already-flagged unsafe_tag quirk path; consequence
of the runner owning the fire) ACCEPTED and recorded; NIT-1 (evidence manifest dates
crossed UTC midnight) informational; NIT-2 (source-contract test's textual reach)
recorded for the v1.1 backlog. ZERO code changes after gate binding.

Flagged for the v1.1 backlog (BUILD-NOTES §"Leaf 1.4 outcome"; do not smuggle): streamed
batch-complete frames should carry consistencyNotes (unlocks the one-field GPS stream
flip); `/api/scrub/execute` stream + batchId exposure (lets wizard presets inherit
progress/cancel); routing scrub through a REAL frozen preview (closes the
detection-grade gate gap the UI can only label); the source-contract test's reach; the
two preserved Retry quirks (GPS enabled-but-inert; scrub retry re-previews through the
plain channel → unsafe_tag).

### 9.4 arch-v11 leaf 1.4b — dependency pass (2026-10-06, committed `f9fac34` + `73f5f67`)

Maintenance leaf (not a review card), contracted in `../.unlazy/arch-v11/BUILD-NOTES.md`
§"Leaf 1.4b", ledger `../.unlazy/arch-v11/gates/leaf-1.4b.md`. Cleared ALL 24 Dependabot
advisories on the public repo (5 critical / 4 high / 15 moderate → `npm audit` **0**):

- **RUNTIME fix**: `@fastify/static` `^8.3.0` → `^10.1.5` (4 advisories incl. the
  path-traversal class; registration options stable across 8→10; `fastify` ^5.12.5
  unchanged). Embedded in the desktop bundle — G10 (`verify-desktop bundle`) proves it
  builds, boots, serves the UI with the boot-script token injection, and stops clean.
- **Dev toolchain**: `vitest` `^2.1.x` → `^5.0.3` (server + ui), `vite` `^5.4.21` →
  `^8.3.3`, peer-required `@vitejs/plugin-react` `^4.4.1` → `^5.2.0`. Transitives
  cleared: tinypool GONE from the tree, vite-node gone, `@vitest/mocker` → 5.0.3, one
  hoisted esbuild 0.28.2 (the stale nested vite@5.4.21/esbuild@0.21.5 pair evicted by
  one `npm dedupe`).
- **Config migrations** (both mandatory, verified against installed package internals):
  `poolOptions.forks.singleFork` → `maxWorkers: 1` (singleFork is entirely ABSENT from
  vitest 5; G4 caught the silent un-pin when parallel forks raced the machine-wide
  exiftool process count), and `esbuild.target` → `oxc.target` (vite 8 deprecates the
  esbuild option; es2022 intent preserved). `ui/vite.config.ts` needed NOTHING — the
  metadesk-dev handshake plugin runs byte-identical on vite 8.
- ZERO source-file changes (ui/src, server/src, shared/src, scripts, tests-e2e logic
  all byte-identical; review-confirmed). Diff surface: the two workspace package.jsons,
  package-lock.json (net −503 lines), server/vitest.config.ts, evidence retakes.
- Gates: ALL TEN runnable gates gate-check-bound green on final bytes (ui · ui-write ·
  write 108 · engine 243 · diagnostics · server smoke incl. the static-serving proof ·
  typecheck · e2e ALL · frozen · desktop bundle). Test counts identical to baseline.
  Senior review (G11): PASS, zero CRITICAL/HIGH/MEDIUM; LOW-1 (root `engines`
  `>=22.0.0` now weaker than the toolchain's real `>=22.12.0` floor — flag-only, out
  of OWNS) recorded below; NIT-1/NIT-2 pre-existing manifest-writer behaviors.
  Ambient-flake watch: the builder saw one uncaptured non-ok e2e line between clean
  passes (recorded, leaf-1.2/leaf-1.4 precedent); the binder's own G8 run was clean.

Flagged for the next maintenance touch (do not smuggle): root `engines` floor tighten
to `>=22.12.0` (review LOW-1); manifest-writer header (UTC-date rollover + stale
"leaf 2.3.1" label) fold into any future manifest touch.

### 9.5 arch-v11 leaf 1.5 — UI: the session-scoped batch in flight (2026-10-07, committed `077847c` + `7730292`)

Implemented architecture-review candidate 5 per the SYNTHESIZED contract in
`../.unlazy/arch-v11/BUILD-NOTES.md` §"Leaf 1.5" — itself a three-verifier merge of a
4-designer round (workflow wf_c2ad132b-463; 7/7 returned; the card's premises were
measured, and the round found the bug BIGGER than the card: mid-run cancel is
dead-by-occlusion even without navigation, keyboard/in-app nav is reachable mid-run
(no focus trap; packaged WebView2 leaves Alt+Left/F5 live), graceful cancel is honored
only between 200-file chunks, and the hub carries no write progress). Ledger:
`../.unlazy/arch-v11/gates/leaf-1.5.md`.

What changed (UI + tests + e2e only; zero shared/server/engine/bin/vendor bytes):

- **ONE transient `writeRun` slice** in `ui/src/state/store.ts` (busy/progress/error/
  activeBatchId/cancelState/refusal/groups/config/startedRoute/completion) — never
  persisted (partialize untouched, test-pinned). `useWriteRun.tsx` becomes a thin
  reader: session single-flight guards on review()+run(), `startedRoute` captured at
  run() entry, completion latch written in the SUCCESS branch ('done') and CATCH
  branch ('failed') — never from finally. Every firing call stays physically in the
  runner file (source-contract test byte-identical); mergeOutcomes/recordLastWrite
  untouched. Types relocated verbatim to `write/types.ts` with re-exports.
- **In-dialog flight section** (`SaveReviewModal` one merged typed `flight?` prop):
  progress lines while busy; 'Cancel this batch' ONLY once the stream's batchId frame
  has landed (streamed edits arm); inline two-step confirm rendering the ONE shared
  `CANCEL_BATCH_CONFIRM_PARAGRAPH` (`write/copy.ts`, byte-identical in both surfaces);
  honest 404 note. Gate mechanics byte-identical; strictly additive typed props; no
  Escape/X (by design); no liveness claims (progress is last-frame-annotated).
- **Mounts**: the five views keep their modal mounts (view files byte-identical except
  BatchPanel's constant import + its promise-line honest conditional); ONE
  `WriteRunModalHost` in AppShell covers the four non-runner routes via `RUNNER_ROUTES`
  (derived from ROUTES in router.ts — compile-typed, no second hardcoded list);
  nine-route zero-or-one dialog partition pinned. Help-over-gate stacking preserved;
  no new z-tiers.
- **Honest completion**: origin route → navigate('/results') as HEAD; away → no yank,
  shell 'Write finished — the Results report is ready.' + View report (clears on
  click/new review); failure → 'check History' note, never success copy. StatusStrip
  writer line reflects the flight while one is in flight.
- **Tests**: NEW `write/writeRun.session.test.tsx` (13 tests, 8 pin families:
  survival across unmount, in-dialog cancel lifecycle, single-flight, nine-route host
  partition, latch truth, no-cancel-on-non-streamed arms, partialize exclusion,
  fidelity guard); the two big suites changed by exactly one import + one beforeEach
  reset line each (session state survives unmount BY DESIGN). matrix.mjs: two
  DOM-asserted real-browser flows — mid-write cancel through the in-dialog surface on
  a ~400-file generated multi-chunk fixture (dedicated mkdtemp folder; the REAL
  between-chunks cancellation, ~2.8 s write window, full matrix ~43 s vs 360 s
  watchdog) and back-mid-write (gate survives Back, no-yank latch) — plus the stale
  known-bug comment fix that now HARD-FAILS streamed-write failures. RETAKE contract
  untouched (still 01/09/10/06-scrub-confirm).

Gates: G1–G9 DOUBLE-BOUND green on final bytes (two consecutive gate-check passes
2026-10-07; builder's own sequential run also green ×3 on the matrix during
development). Senior review (G10): PASS, zero CRITICAL/HIGH/MEDIUM; LOW-1 (latch copy
wording vs contract shorthand — both oracles assert the shipped copy) and LOW-2 (latch
also appears when already on /results — harmless no-op) ACCEPTED; NIT-1 (router.ts:8
stale 'six routes' comment — pre-existing) flagged, orphan rule. Evidence churn: the
four RETAKE_SET PNGs + their MANIFEST lines only. ZERO code changes after gate
binding. Committed: `077847c` (code+tests) + `7730292` (evidence retakes) + docs
closeout. **LOCAL commits — push pending Mike's word (public repo).**

Flagged for the v1.1 backlog (BUILD-NOTES §"Leaf 1.5 outcome" + declined/promotion
lists; do not smuggle): a Home scan stays preview-local until 'Open grid', so Batch
can sit on the previous folder's scope (UX fact surfaced by the e2e work); hub
write-progress topic; batch re-attach/status endpoint (real reload recovery); focus
trap on the gate modal; deletion of BatchPanel's occluded view chrome (with the
cancel.wiring pin owner's consent); whole-runner hoist (useWriteRunner/WriteRunner
deletion) as optional hygiene; router.ts:8 comment touch.

### 9.6 arch-v11 leaf 1.6 — UI: a transport under client.ts's endpoints (2026-10-07, committed `665ef7a` + `4ea1711`)

Implemented architecture-review candidate 6 per the SYNTHESIZED contract in
`../.unlazy/arch-v11/BUILD-NOTES.md` §"Leaf 1.6" — a three-verifier merge of a
4-designer round (workflow wf_920f82e7-a1e; 7/7 returned; the card measured TRUE with
a catalog: token-header ×6, network-wrap ×4 + one bare fetch, envelope-parse ×3 with
five distinct fallback labels, SSE loop ×2; the blob/objectURL trio deliberately NOT
extracted — three different URL-ownership policies). Ledger:
`../.unlazy/arch-v11/gates/leaf-1.6.md`.

What changed (TWO files only; zero new exports, zero consumer edits, zero wire
changes beyond the declared deltas):

- **SIX module-private helpers** in `ui/src/api/client.ts` — tokenValue(), authHeaders(extra?),
  send(path, init) (THE only fetch, byte-identical TransportError(0) wrap),
  isEnvelope() (request()'s null-guarded predicate), failureOf(response, label)
  (assembles `${label} (HTTP N).`; exactly TWO callers: executeWrite's streamed
  refusal path + createDiagnosticsBundle), readSse(body, onFrame) (the SSE loop moved
  verbatim: no try/finally, no reader.cancel, no releaseLock, no final flush — a
  throw abandons the stream). The five special paths (getThumbnail, downloadBinary,
  executeWrite streamed arm, subscribeEvents, createDiagnosticsBundle) rewritten onto
  them; request() keeps HEAD's exact operation order per the ORCHESTRATOR
  AMENDMENT recorded in the contract (the builder's disclosure: the original two
  contract sentences were jointly unsatisfiable without changing one human message;
  ruled for byte-identity). capturePreview stays endpoint policy (13 sites unchanged).
- **Exactly TWO declared deltas**: downloadBinary's network failure now throws
  TransportError(0, 'Could not reach the MetaDesk server: …') instead of raw
  'TypeError: Failed to fetch' (surface: DetailViewer's extract row String(error);
  ErrorBanner NOT involved); executeWrite/createDiagnosticsBundle envelope
  classification gains the null guard (literal-JSON-null non-ok bodies now yield the
  honest fallback instead of TypeError). ALL TWELVE human messages otherwise
  byte-identical (review-verified).
- **NEW `ui/src/api/client.transport.test.ts`** (306 lines, 14 tests, `//
  @vitest-environment jsdom` line 1): pins TransportError(0) identity,
  failureOf→MetaApiError, assembled labels character-for-character, request()'s
  could-not-read message exactly, the null-guard hardening, ok+empty→undefined,
  authHeaders both branches, streamed init (Accept/Content-Type pair, NO signal key,
  '"stream":true'), unsubscribe-suppresses-onDisconnected, CRLF/split-chunk/invalid
  frames, write-error→MetaApiError-500 AND stream-abandoned (cancel-recording
  stream), duplicate-seq drop. **All six existing fetch-stub suites pass UNMODIFIED —
  the wire-identity canary and the leaf's binding acceptance gate.**
- **The binding acceptance constraint** (from the design round's stub map): fetch is
  called with a bare relative-path STRING and pre-stringified bodies; no URL objects
  (the Settings suite stubs global URL as non-constructible); no transport-level
  timeout/retry/AbortController EVER (writeRun.session's never-resolving-fetch test
  forbids it structurally); the events fetch stays inside subscribeEvents' try/catch
  (the e2e pageerror gate).

Gates: G1–G9 DOUBLE-BOUND green on final bytes (builder sequential ×2; orchestrator
pass 1 bound G1-G7+G9 with G8 tripping ONCE — 'Undo step 1: TypeError: fetch failed',
a harness-side connection failure with every real flow green around it; immediate
sequential re-run bound ALL NINE — recorded ambient-flake class, leaf-1.4 G3
precedent). Senior review (G10): PASS, zero CRITICAL/HIGH/MEDIUM; NIT-1 (MANIFEST
provenance header still 'leaf 2.3.1' — pre-existing, fix in a future evidence pass)
+ NIT-2 (test-length estimate drift) accepted; reviewer's own transient scratch-file
slip in .unlazy/ disclosed, cleaned, re-verified. Evidence churn: the four
RETAKE_SET PNGs + MANIFEST byte-count lines only. ZERO code changes after gate
binding. Test count 81 → 95 (+14). Committed: `665ef7a` (code+tests) + `4ea1711`
(evidence retakes) + docs closeout. **LOCAL commits — push pending Mike's word
(public repo); leaf-1.5's three commits are also still local.**

Flagged for the v1.1 backlog: the two stream flips are now ONE-LINE endpoint edits —
streamed batch-complete consistencyNotes (one line in handleFrame + the one-field GPS
stream flip) and /api/scrub/execute stream + batchId (~25 lines over the same six
helpers); MANIFEST provenance header fix rides the next evidence pass.

### 9.7 arch-v11 leaf 1.7 — the launcher ↔ shell lifecycle contract, explicit (2026-10-07, committed `6be166b` + docs)

Implemented architecture-review candidate 7 per the SYNTHESIZED contract in
`../.unlazy/arch-v11/BUILD-NOTES.md` §"Leaf 1.7" — a three-verifier merge of a
4-designer round (workflow wf_971c6e44-7af; 7/7 returned; the card's numbers all
verified true, but its solution sentence was amended: "assert both implementations
agree" is unbuildable because the adapters DELIBERATELY disagree on health deadline,
grace, env policy, handshake order, kill policy and single-instance mechanism — the
buildable gate asserts EACH side against its OWN contract row, never adapter-vs-
adapter). Ledger: `../.unlazy/arch-v11/gates/leaf-1.7.md`. Baseline: main @ `1ac8ad1`,
tree clean. **The tauri freeze lifted for READS ONLY** (orchestrator amendment) —
measurement found ZERO product edits needed, and the deliverable is exactly two NEW
files with every existing file byte-identical (frozen check bound twice).

What changed (nothing existing; two new files):

- **`docs/lifecycle-contract.md`** — the tri-party (server / node launcher / Tauri
  shell) lifecycle agreement: authority-defer header + the same-commit change
  protocol (§0) with the fenced JSON pin table the gate parses (§0.1); the
  writer/reader/DELETER matrix for portfile.json / instance.lock / stop.request (§1 —
  the server is the portfile's sole writer; the shell writes NOTHING and honors only
  `launcherPid`; stop.request is launcher-internal with zero Rust/server references;
  instance.lock has two deleters); the stdin stop channel incl. the tsx-hop
  pid-of-record rule and the about:blank→SOCKET_SETTLE ordering (§2); every timing
  constant per adapter with its failure-budget why, headed "these pairs are NOT meant
  to converge" (§3); kill rules & backstops (§4); seven accepted asymmetries, each
  "change requires an orchestrator decision" (§5); KNOWN-GAP-1 verbatim — the server
  reads SIX METADESK_* knobs, the shell strips FOUR, METADESK_WATCHER_DEBOUNCE_MS
  leaks into the packaged engine (§6, owner = candidate 1's config-channel design);
  the OPEN register (§7 — the --stop-against-shell chain; the live-but-unhealthy
  portfile divergence; the §2 prose corrections now applied); the fact→oracle table
  with SAFETY/OPERATIONAL class + proof status (§8); gate-local-budgets note (§9).
- **`scripts/verify-lifecycle-contract.mjs`** — the static cross-check gate
  (§3 table above): C1–C8 families, exact non-empty reader sets across all three
  launcher read aliases, process.env-anchored env extraction, comment-stripped
  matching (except C4's contracted zero-reference scan), textual-order pins (never
  line numbers), fail-closed `contract anchor moved` failures. Under 100 ms; spawns
  nothing; counts no processes.
- **§2 corrections applied at closeout** (the reviewer re-confirmed both defects):
  the free-port line no longer claims the launcher honors `METADESK_PORT` (it reads
  only `--port`; the env var is a server-side default the argv always overrides), and
  the instance.lock line now carries the null-requested-port caveat + the
  `markServerPid` rewrite fact.

Gates: G1–G6 DOUBLE-BOUND green on final bytes (orchestrator pass 1 bound; pass 2
reverified all six, zero flakes): frozen check (zero existing-file edits) ·
verify-lifecycle-contract · the falsifiability battery (four mutation classes RED
naming their rows; the no-op control GREEN; every byte restored — recorded) ·
verify-launch · verify-desktop shell · verify-desktop matrix. Senior review (G7):
PASS, zero CRITICAL/HIGH/MEDIUM; 6 LOW + 3 NIT dispositioned in the ledger (C8's
slice-global pairing, C4's comment sensitivity, reflow sensitivity, comment wording,
§1 owned-only wording, walkFiles swallow; NITs: §3 inline beats, first-serde-rename
assumption, per-row citations) — all v1.1 backlog or docs riders, ZERO code changes
after gate binding. Builder disclosures recorded: G1 initially RED through an
orchestrator-script repo-root assumption (fixed by the orchestrator); the builder's
own first-run alias-interpolation bug self-caught and fixed pre-binding. Committed:
`6be166b` (the two files) + docs closeout. **Pushed with the leaf-1.5/1.6 locals on
Mike's word, 2026-10-07.**

Flagged for the v1.1 backlog (do not smuggle): per-kill-site C8 pairing;
walkFiles named-failure conversion; C4 comment-semantics decision; §1 owned-only
wording + §3 inline beats (docs riders); verify-launch.mjs:114 cleanEnv misses
METADESK_WATCHER_DEBOUNCE_MS (same seam as KNOWN-GAP-1, dev-gate-local); the OPEN
register's two behavioral items (--stop-against-shell; live-but-unhealthy divergence)
await an orchestrator align-or-pin decision; KNOWN-GAP-1's fix rides candidate 1's
sanctioned config-channel design.

### 9.8 arch-v11 leaf 1.8 — one exif path-key (kit); the binary one-shot deferred (candidate 8, 2026-10-08)

Implemented architecture-review candidate 8 per the SYNTHESIZED contract in
`../.unlazy/arch-v11/BUILD-NOTES.md` §"Leaf 1.8" — the merge of a 4-designer round
+ 3 adversarial verifiers (workflow wf_079fdba5-1d5; 7/7 returned, ~597k subagent
tokens; live exiftool 13.59 probes). The card was STALE IN MIKE'S FAVOR: leaf 1.1's
reorganization had already put the entire write family on one canonical key
(`normalizeExifPath` in results.ts), the card's fifth site ("write/helpers.ts:71")
turned out to be a DEAD test export, and the live non-lowercasing builders are
deliberate case-preserving echo-witnesses. Ledger:
`../.unlazy/arch-v11/gates/leaf-1.8.md`. Baseline: main @ `ae450b7`, tree clean,
synced; fresh same-session baselines green (write 108 · engine 243 · diagnostics ·
typecheck · server 16 oracles).

**The engine freeze HOLDS — no amendment granted.** The card's second half (folding
the binary one-shot `runOnceBinary` from services/thumbnails.ts into the frozen
engine's `runOnce`) is DEFERRED with recorded promotion triggers T1/T2/T3 + a
fold-precondition (characterization goldens green against pre-fold bytes) in
BUILD-NOTES §"Leaf 1.8" — the measured duplication showed zero live defect (safety
posture verified identical), the fold would change two visible error strings, and
the prospective risk (a third private spawn) is cheaper to guard by recorded trigger
than by breaking a freeze that leaf 1.7 lifted only for reads. Also recorded, NOT
fixed (frozen bytes): `exiftoolSession.ts:425`'s docstring FALSELY lists "binary
extraction" as a runOnce use case — the fix rides trigger T3.

What changed (11 paths, 89+/35-, zero behavior delta on production paths):

- **NEW `server/src/services/exifPath.ts`** — the one dependency-free kit: single
  export `normalizeExifPath`, body byte-identical to the old results.ts:37, docstring
  carrying the probe-pinned semantics (exiftool echoes argv case verbatim and
  forward-normalizes slashes everywhere; the lowercase is purely server-side
  canonicalization on case-insensitive volumes, load-bearing exactly once —
  recovery's journal-vs-readdir lookup) and the two deliberate non-uses (the
  test/helpers.ts echo-witness; scan.ts's echo-match).
- **Three private copies deleted**, every consumer re-pointed (31 production call
  sites enumerated and verified: metadata 4 · scan 2 · recovery 4 · results 4 ·
  writePipeline 19 · destructiveFlow 1 · scrub 1); the three write-family import
  lines re-point; NO re-export in results.ts (one address, typecheck-tripwired).
- **Dead test export deleted** (test/write/helpers.ts `exifSlash`, zero importers).
- **Goldens-first, proven biting**: new `describe('normalizeExifPath')` in
  write/results.test.ts (backslash/slash, case, UNC, `\\?\` key-not-path, CJK
  passthrough, idempotence, exactness) + a case-swapped trackedBackup golden in
  write/recovery.test.ts at the ONE site where the lowercase crosses two producers.
  The builder landed goldens BEFORE rewiring (suite green at 251 with copies still
  present), then dropped `.toLowerCase()` to watch 6 tests red, restored
  byte-identical.
- **Untouched by contract**: scan.ts's inline echo-match (byte-identical, moved
  :301→:302 by the required import), test/helpers.ts:59 echo-witness, thumbnails.ts
  entirely, pathGuard.ts, metadata RAW_EXTENSIONS (dng), write classification logic,
  the thumbnail cache key.

Gates: G1–G9 bound green on final bytes (write 116 = 108+8 goldens · engine 251 ·
diagnostics · typecheck · server smoke · e2e roundtrip/scrub/gps · frozen check "11
changed paths, none frozen"); G10 senior review PASS — zero CRITICAL/HIGH/MEDIUM,
checklist a–i all CONFIRMED (independent 31-site consumer enumeration,
`cat -A` byte-compares, 14-hunk regression census), production behavior-delta set
EMPTY; 1 LOW + 2 NIT dispositioned record/leave in the ledger; ZERO code changes
after gate binding. Pass 2 (--reverify) recorded in BUILD-NOTES §"Leaf 1.8" outcome.

Flagged for the v1.1 backlog (do not smuggle): scan.ts:295-302 is exercised by NO
test (a pin needs a fakeEngine stub in the read suites — new harness machinery); a
real CJK-thumbnail limitation pin needs an argfile fixture writer; a one-line
pin-carrier comment on the recovery golden's trackedSha256 assertion (review LOW-1);
the runOnceBinary fold + the exiftoolSession.ts:425 docstring fix ride triggers
T1/T2/T3.
