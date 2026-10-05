# MetaDesk — HANDOFF-V1 (release-state runbook, v1.0.0)

Audience: a FRESH agent session (or human contributor) that has to build, verify, release,
or fix MetaDesk **after** the v1.0.0 release. Written 2026-10-05 at the close of Phase 2
(leaf 2.2.3). Mike is the PM and product owner; he does not read code — brief him in plain
English. This file supersedes nothing: it is the successor of `HANDOFF.md` (Phase 1) for
RELEASE matters. Phase-1 technical depth stays in `HANDOFF.md`; the desktop-wrap decisions
live in `../.unlazy/metagui-phase2/BUILD-NOTES.md`.

**Read first, in this order:**

1. `CLAUDE.md` — hard rules for this repo (ownership, argv-array only, safety core).
2. `../.unlazy/metagui/BUILD-NOTES.md` — Phase-1 contract of record (engine protocol facts
   #1-5, pinned routes, shared contract). Still fully in force.
3. `../.unlazy/metagui-phase2/BUILD-NOTES.md` — Phase-2 contract of record: the pinned
   package layout, decisions D1-D7, the lifecycle ladder, packaging invariants, known
   limits. **Do not contradict; report deviation requests to the orchestrator.**
4. `STATUS.md` (chart) and `HANDOFF.md` (Phase-1 technical handoff).
5. `docs/release/RELEASE-NOTES-v1.0.0.md` — the release record (hashes, signing status,
   honest limits, update story). `README.md` carries the same story in Mike's English.

---

## 1. Where things live

`app/` is an npm-workspaces monorepo (`shared`, `server`, `ui`, `tests-e2e`) plus the
desktop wrapper and the packaging toolchain:

```
app\
  bin\                      Phase-1 launchers (metadesk.cmd/.ps1/.mjs, engine-smoke.mjs)
                            — STILL the supported dev path; NOT retired in v1 (D5).
  server\  ui\  shared\     The product (Fastify server, React UI, frozen shared contract).
  tests-e2e\                Playwright matrix + evidence snapshot mirror.
  tauri\                    The desktop wrap (Phase 2).
    src-tauri\src\          main.rs (ladder, tray, drag-drop, single-instance),
                            engine.rs (node spawn + job object), dialog.rs, logging.rs
    src-tauri\tauri.conf.json   version stamp + bundle targets ["nsis"] + capabilities
    src-tauri\Cargo.toml        version stamp
    src-tauri\capabilities\metadesk.json   the ONLY capability: drag-drop events for
                                           remote urls http://127.0.0.1:*
  scripts\                  Build + gate toolchain (node built-ins only) — see §3.
  dist-desktop\             BUILD OUTPUTS (gitignored): the zip, manifest, provenance,
                            the assembled portable\ folder, and the stage\ tree.
  vendor\node\node.exe      The pinned portable Node download (gitignored; fetched by
                            scripts/fetch-node.mjs, sha256-verified).
  vendor\exiftool\          ExifTool 13.59 — frozen, never modify.
  data\                     Runtime state (gitignored contents).
  docs\release\             Release records (committed): RELEASE-NOTES-v1.0.0.md.
```

**dist-desktop artifacts (what a release ships):**

| File | What it is |
|---|---|
| `metadesk-<v>-portable-win-x64.zip` | THE distribution (a `MetaDesk/` top folder inside; 519 files at v1.0.0). |
| `portable-manifest-<v>.json` | SHA-256 per content file; the zip's exact file set. |
| `provenance-<v>.txt` | Build record: version stamp, zip/node/exiftool/MetaDesk.exe/setup hashes + sizes, Authenticode status. **An input to the release notes.** |
| `portable\MetaDesk\` | The assembled folder the zip is made from. |
| `stage\` | The intermediate pinned-layout tree (server bundle + ui dist + node + exiftool). |

The pinned package layout (BUILD-NOTES "The wrapped shape" — the include list in
`build-portable.mjs` is the law): `MetaDesk.exe`, `package.json`, `node\node.exe`,
`server\dist\server.mjs`, `ui\dist\**`, `vendor\exiftool\**`, `scripts\selfcheck.mjs`, and
`data\` (runtime, created at boot, never shipped). The NSIS installer lands at
`tauri\src-tauri\target\release\bundle\nsis\MetaDesk_<v>_x64-setup.exe`.

**Why the packaged server needs zero code changes:** `server\dist\server.mjs` sits two
levels below the folder root, so the frozen server's `APP_ROOT` math (config.ts:15) lands
on the folder root → `ui/dist`, `vendor/exiftool`, `data/` all hit config defaults, and
`ENTRY_DIRECT` fires because the shell passes the bundle path as argv[1].

## 2. Architecture in one paragraph

MetaDesk is a local Fastify server (127.0.0.1 only, per-launch token, Host/Origin gates)
serving a built React bundle and talking to a persistent `exiftool -stay_open` session; the
v1.0.0 desktop shape wraps that exact stack in a Tauri v2 shell that spawns
`node\node.exe server\dist\server.mjs` as a direct child (argv array, stdin pipe held as
the stop channel, Windows Job Object with KILL_ON_JOB_CLOSE as the backstop), reads
`data\portfile.json` at runtime, and opens a webview on `http://127.0.0.1:<port>/` (remote
pages get no Tauri IPC by default; the one granted capability is the drag-drop event
channel). The server is an esbuild ESM single-file bundle (D1 — ESM is mandatory so
`import.meta.url` stays live). Full decisions D1-D7 and the ladder: read
`../.unlazy/metagui-phase2/BUILD-NOTES.md`; Phase-1 depth: `HANDOFF.md`.

### The lifecycle ladder (pinned — the shell implements exactly this)

0. Launch sweep: stale portfile (dead pid) removed; live pid running OUR bundled node.exe
   is `taskkill /T /F`'d, then swept. Never kill a foreign exiftool.
1. Spawn: node.exe child, stdio piped, `CREATE_NO_WINDOW`, `METADESK_DATA_DIR` set, stdout/
   stderr appended to `<dataDir>\metadesk-shell.log`, assigned to the Job Object.
2. Health gate (~20 s): `/api/health` (token-exempt) → read portfile → create hidden window
   → navigate → show. Failure = branded dialog + ladder + non-zero exit. Engine-unhealthy
   is NOT a boot failure (degraded read-only by design). WebView2 missing = branded dialog
   with the download link.
3. Close (X, tray-Quit): drop the child's stdin pipe → the server's graceful ladder runs.
4. Grace poll ~5 s on the child handle. 5. Escalate: `taskkill /PID <portfile.pid> /T /F`,
   ~5 s more. 6. Backstop: the Job Object kills the tree even on a violent shell death.
7. Server crash while open: native dialog (Reopen / Quit). NO silent auto-restart.

Close-to-exit is measured ≈1 s because the shell navigates the webview to `about:blank`
before pulling the stop channel (the SSE mitigation below).

## 3. How to build + verify EVERYTHING

Run from the repo root (`MetaProject/`) unless noted. Each gate prints its marker as the
FIRST stdout line and exits 0/1. Progress goes to stderr.

| Command | Marker (first stdout line) | Proves |
|---|---|---|
| `node app/scripts/verify-engine.mjs` | `engine layer verification passed` | Server vitest suite: stay_open protocol, hostile filenames, arg builder, tag DB. |
| `node app/scripts/verify-server.mjs` | `server smoke verification passed` | Live-server smoke: token gates, Host-spoof, scan/metadata/thumbnail/binary, SSE, console, stdin-close shutdown, no orphans. |
| `node app/scripts/verify-ui.mjs` | `ui build verification passed` | Strict UI build + UI unit tests. |
| `node app/scripts/verify-write.mjs` | `write pipeline verification passed` | Preview/execute/verify, journal, lock, recovery, scrub. |
| `node app/scripts/verify-ui-write.mjs` | `ui write surfaces verification passed` | UI write surfaces + strict build. |
| `node app/scripts/verify-launch.mjs` | `launcher verification passed` | Drives `bin\metadesk.mjs` end to end: boot, single-instance, health, served UI, `--stop`, zero residue, counts to baseline. |
| `node app/scripts/verify-diagnostics.mjs` | `diagnostics verification passed` | Diagnostics bundle route + Settings copy-logs action (leaf 2.2.1). |
| `node app/scripts/verify-e2e.mjs <unit\|roundtrip\|scrub\|gps\|evidence\|all> [--packaged]` | `e2e unit verification passed` / `e2e roundtrip verification passed` / `e2e AI-scrub verification passed` / `e2e gps-strip verification passed` / `evidence snapshot verification passed` / `all e2e verifications passed` | The oracles. `roundtrip`/`scrub` are root gates G3/G4. `all` ≈ 5 min incl. the Playwright matrix (10 screenshots). `--packaged` (only with `all`) boots the EXTRACTED ZIP's MetaDesk.exe instead of the dev launcher. |
| `node app/scripts/verify-desktop.mjs bundle` | `server bundle verification passed` | Builds the stage and boots the EXACT shipped artifact: health, injected page, engine path, stdin-close stop, no orphans. |
| `node app/scripts/verify-desktop.mjs shell` | `desktop shell verification passed` | Builds the Tauri shell (release) and drives the REAL wrapped app: pinned layout + fresh resource content, spawn tree, one loopback listener, second-launch focus, WM_CLOSE teardown, no residue. |
| `node app/scripts/verify-desktop.mjs matrix` | `desktop lifecycle matrix verification passed` | The 4-case kill matrix: graceful close; hard-kill backstop (Job Object); stale-portfile sweep; mid-boot second instance. |
| `node app/scripts/verify-package.mjs` | `package verification passed` | dist-desktop zip + provenance: hash match, manifest = extracted set, junk absence, node/exiftool run from inside, PE x64, selfcheck, real boot + teardown. |
| `node app/scripts/run-clean-machine.mjs` | `clean-machine drill passed` | The zip extracted and booted with PATH = `C:\Windows\system32;C:\Windows;C:\Windows\System32\Wbem` (no node/cargo/git/pwsh reachable; `where.exe` run under the sanitized env proves it): health, injected page, shipped-bundle spawn tree, close, teardown, no orphans. |
| `node app/scripts/run-clean-machine.mjs update` | `update rehearsal passed` | The update story: zip carries no `data/` entries; seeded journal/settings/engine-cache survive an extract-over byte-identical; the upgraded folder boots the portable way and closes clean. |
| `node app/scripts/build-server-bundle.mjs` | `server bundle built` | Builds the esbuild bundle + the pinned stage (also `npm run build:server-bundle`). |
| `node app/scripts/fetch-node.mjs` (`--verify`) | (`node runtime fetch verified`) | Ensures/re-checks the pinned portable node.exe. |
| `node app/scripts/build-portable.mjs --all` | `portable build completed` | THE release build: stage → shell + NSIS → portable folder → zip + manifest + provenance. |
| `npm test` (from `app/` or `app/server/`) | vitest summary | The server suite. |

**Cautions (biting, all proven here):**

- **Machine-wide process counting:** `verify-launch`, `verify-desktop` (all modes),
  `verify-package`, `run-clean-machine` (both modes) count node.exe/exiftool.exe
  machine-wide (baseline vs after, pid SETS, one settle+retry). NEVER run them
  concurrently with each other, `npm test`, or `build-portable.mjs`. They wait for a
  quiet machine (60 s) and warn, but do not hard-fail on busy — do not rely on that.
- **Never bare vitest from `app/`** (no config there) — it parallel-discovers the UI suite
  and scrambles the shutdown test's process counts. Use `npm test`.
- The gates spawn `pwsh`/`tasklist` — Windows-only by design.
- `npm audit`: 5 findings, all dev-only inside vitest 2.x. Deliberate pass is post-MVP.
  **Do NOT `npm audit fix --force`.** npm `allowScripts` blocks some postinstalls (esbuild
  ships prebuilt, so vitest works); new native deps may need `npm install-scripts approve`.
- Max 5 GLM agents machine-wide; build waves ≤ 2 (HTTP 429 history).
- The packaged app's window appears on the desktop for a few seconds during desktop gates,
  verify-package, verify-e2e `--packaged`, and both run-clean-machine modes. Expected.

## 4. The RELEASE RUNBOOK (v1.0.1 from a cold session)

Preconditions: clean `git -C app status`; no other leaf/gate running; `node` 22 on PATH.

1. **Bump the version stamp — THREE files must agree** (build-portable asserts it, but
   change them yourself): `app/package.json`, `app/tauri/src-tauri/tauri.conf.json`,
   `app/tauri/src-tauri/Cargo.toml` (all currently `1.0.0` → e.g. `1.0.1`). If the pinned
   node version changed, do §5 first. A different exiftool version is a vendored-engine
   refresh — orchestrator-approved only, never a hand edit.
2. **Run the whole gate ladder** (each command waits for the previous one — never
   parallel):
   `node app/scripts/verify-engine.mjs` → `verify-server` → `verify-ui` → `verify-write`
   → `verify-ui-write` → `verify-launch` → `verify-diagnostics` →
   `node app/scripts/verify-e2e.mjs all`.
3. **Build LAST, after all gates are green:** `node app/scripts/build-portable.mjs --all`.
   This re-stages, rebuilds the shell + NSIS installer, assembles the folder, and writes
   the zip + `portable-manifest-<v>.json` + `provenance-<v>.txt`. Building after the gates
   matters: it is the only step that produces the artifacts the remaining gates consume.
4. **Verify the artifact:** `node app/scripts/verify-package.mjs`.
5. **Package e2e:** `node app/scripts/verify-e2e.mjs all --packaged` (the matrix boots the
   extracted zip's MetaDesk.exe).
6. **Release drills:** `node app/scripts/run-clean-machine.mjs` then
   `node app/scripts/run-clean-machine.mjs update` (sequentially).
   If you touched the shell/lifecycle sources, also `verify-desktop.mjs bundle`, `shell`,
   and `matrix` (each rebuilds the shell; each must run alone).
7. **Update the release records (committed):**
   - copy the new hashes/sizes/Authenticode lines from the fresh `provenance-<v>.txt` into
     `app/docs/release/RELEASE-NOTES-<v>.md` (table + signing section),
   - `app/README.md` (version references, update story wording if it changed),
   - `app/STATUS.md` chart rows for anything the release changed,
   - this file's "State of record" line (§4).
8. **Commit** (conventional commits, no attribution footer), then when
   `git -C app status --porcelain` is EMPTY: `git -C app tag -a v<version> -m "MetaDesk v<version> — <summary>"`.
   No push (no remote). Record the tag's commit hash in the release record.

**State of record at v1.0.0 (2026-10-05):** commit `f501235` stamped everything 1.0.0;
final build ran as `build-portable.mjs --all` (provenance generated 2026-10-05T20:39:26Z);
all gates green the same day, including both run-clean-machine modes; tag `v1.0.0` on the
release commit (hash recorded in the leaf-2.2.3 report / `git tag --list`).

## 5. How to bump the pinned Node runtime

The pin lives in the header of `app/scripts/fetch-node.mjs` (constants
`PINNED_NODE_VERSION`, `PINNED_NODE_EXE_SHA256`). To move it (e.g. a Node 22.x security
release): take the new version's `win-x64/node.exe` hash from
`https://nodejs.org/dist/<version>/SHASUMS256.txt`, set both constants, delete
`app/vendor/node/node.exe`, and re-run the release build — `fetch-node.mjs` re-downloads
and must match BOTH the pin and the LIVE published SHASUMS list (a mismatch is a
supply-chain tripwire and fails the build). The shipped copy's hash flows into
`provenance-<v>.txt` and must be reflected in the release notes. Never rename node.exe
(stock OpenJS signature = its AV reputation, decision D3), never commit it (gitignored).

## 6. Known limits + backlog

**Carried limits (documented in the release notes, not hidden):**

- **SSE-held-open close** — `server.app.close()` blocks while an `/api/events` SSE
  connection is open. Mitigated in the wrapped shape (webview navigated to `about:blank`
  first → ≈1 s close); the DEV path (browser tab) still rides the launcher's 20 s grace
  window and ends in the documented `taskkill /T /F` escalation — no orphans, journals
  intact. Fix = close the SSE hub in a preClose/stop hook in `server/src/index.ts` — a
  third server touch that C12 forbids; **v1.1**, orchestrator decision 2026-10-05.
- SmartScreen first-run (no signing certificate in v1); NSIS installer built but the zip is
  the distribution of record (install flow unexercised).
- ComfyUI `prompt`/`workflow` chunks + C2PA/JUMBF: detect-only. Hidden-alpha data:
  warning-only. Settings engine-path restore + `-api` knob deferred. Write-capable console:
  v1.1 (v1 console is strictly read-only).
- Wrap-vs-dev coexistence: the wrapped app keeps its state in the package folder's own
  `data\` (no `METADESK_DATA_DIR` override), so it never shares a portfile with a dev (tsx)
  instance; the shell honors but does not write `instance.lock` (the single-instance
  plugin's mutex owns the wrapped shape).

**v1.1 backlog (do NOT pull forward without Mike):** full Strip/Clean wizard presets,
write-capable console, CSV/JSON bulk import-export, geotag-from-GPX, rename/move-by-date,
MIE/XMP sidecar archive-and-restore, tag database browser, standards-validation report,
compare beyond `_original`, map panel with reverse geocoding, deep RAW editing, the SSE fix
above, Settings engine-restore + `-api`, post-MVP dependency pass (the 5 vitest-tree
findings). Cosmetic: the three evidence retakes are DONE (leaf 2.3.1); new captures should
keep `tests-e2e/__evidence-snapshot__/MANIFEST.txt` in sync (gate: `verify-e2e.mjs evidence`).

Full list of record: `../HANDOFF-PHASE2.md` §2 backlog + Phase-1 `HANDOFF.md` §6 item 5.

## 7. Phase-2 scope + evidence locations

- Phase-2 plan/ledger/gates: `../.unlazy/metagui-phase2/` (`PLAN.md`, `BUILD-NOTES.md`,
  `status.log`, `gates/leaf-*.md`). Leaf 2.2.3's gates: `gates/leaf-2.2.3.md` (G1 clean
  drill, G2 update rehearsal, G3 release records + tag).
- Phase-1: `../.unlazy/metagui/` (same shape; `BRIEFING-v1.md` is the product summary).
- Evidence screenshots: `app/tests-e2e/__evidence-snapshot__/` (committed mirror of
  `app/evidence/`) + `MANIFEST.txt` naming the claim each frame proves.
- Diagnostics: the Settings "copy logs" action and the server route zip `<dataDir>` logs +
  journal tail + engine version (leaf 2.2.1; gate in §3).

## 8. Conventions that still bite

argv-array execution only, `shell: false`, no shell strings — this binds the Rust too.
Never modify: `exiftool/` (repo clone), `vendor/**`, `app/shared/**`,
`app/server/src/engine/**`, `.unlazy/**` outside an orchestrator-approved step. No write
path may bypass preview/journal/backup-verify. Server/UI code changes stay limited to the
Phase-2 allowance (Home drop-zone seam + diagnostics feature) — anything else is stop and
escalate. Docs by function: STATUS = chart, HANDOFF/HANDOFF-V1 = agent depth, README =
Mike, CLAUDE.md = rules. Keep docs honest as work happens.
