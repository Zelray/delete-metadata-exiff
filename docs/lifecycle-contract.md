# MetaDesk lifecycle contract — launcher ↔ server ↔ shell (explicit)

Leaf 1.7 (arch-v11, candidate 7). One file, two audiences: the fenced pin table in
§0.1 is **machine-readable** — it is the expectation source that
`app/scripts/verify-lifecycle-contract.mjs` parses; the prose wrapped around it is
the human **WHY**. The gate asserts **each adapter against its own contract row
only** — adapter-vs-adapter parity is asserted nowhere in this file and nowhere in
the gate, because the two adapters deliberately disagree (§5).

## 0. Authority deference & the same-commit change protocol

**This file is NOT a contract of record.** The contracts of record are, in order:

| Authority | Governs |
|---|---|
| `app/HANDOFF.md` §2 | the dev launch lifecycle (`bin/metadesk.mjs`), the tsx-hop pid-of-record rule, `--stop`, residue rules |
| `app/HANDOFF-V1.md` §2 | the desktop shell ladder (sweep → spawn → health gate → close → escalate → Job-Object backstop → crash dialog) |
| `.unlazy/metagui-phase2/BUILD-NOTES.md` (D1–D7 + the pinned ladder) | the wrapped shape, single-instance decision, tray, ESM bundle, portable node |

Every load-bearing row in this file cites one of those authorities and may not
contradict them. **Where this file and an authority appear to disagree, the
authority wins and this file is corrected.**

**Same-commit change protocol:** a commit that moves a lifecycle fact in code MUST
move the matching pin-table row and prose section **in the same commit**. The gate
parses the pin table below as its expectation source, so a fact that moves without
its row goes RED at the next gate run (`contract anchor moved — update
verify-lifecycle-contract.mjs`), and a row that moves without its fact goes RED the
same way. The gate is fail-closed by design: a missing or moved anchor is a loud
failure naming its row, never a quiet pass. Changing this file alone (without code)
or code alone (without this file) is a contract violation even when every gate is
green — the gates cannot see intent.

The gate itself is a **static, spawn-free, process-count-free** cross-check: it
never launches a process and never counts `node.exe`/`exiftool.exe`, so it is safe
in any gate-ladder slot. Its `verify-*`/matrix poll budgets are GATE-LOCAL, not
contract facts (§9).

### 0.1 The machine-readable pin table

Everything below the surface of this fenced block is what the gate asserts. Row
names are stable identifiers: the gate's failure lines cite them, and the mutation
battery (leaf-1.7 G3) expects each mutation to name its row.

```json
{
  "authority": {
    "dev-launcher-lifecycle": "app/HANDOFF.md section 2",
    "shell-ladder": "app/HANDOFF-V1.md section 2",
    "phase2-decisions": ".unlazy/metagui-phase2/BUILD-NOTES.md D1-D7 and the pinned ladder"
  },
  "sources": {
    "launcher": "app/bin/metadesk.mjs",
    "engine": "app/tauri/src-tauri/src/engine.rs",
    "main": "app/tauri/src-tauri/src/main.rs",
    "serverIndex": "app/server/src/index.ts",
    "serverConfig": "app/server/src/config.ts"
  },
  "timings": {
    "launcher": [
      { "row": "launcher.HEALTH_DEADLINE_MS", "name": "HEALTH_DEADLINE_MS", "valueMs": 45000 },
      { "row": "launcher.PORTFILE_AFTER_HEALTH_MS", "name": "PORTFILE_AFTER_HEALTH_MS", "valueMs": 10000 },
      { "row": "launcher.SECOND_INSTANCE_PORTFILE_WAIT_MS", "name": "SECOND_INSTANCE_PORTFILE_WAIT_MS", "valueMs": 20000 },
      { "row": "launcher.GRACEFUL_EXIT_TIMEOUT_MS", "name": "GRACEFUL_EXIT_TIMEOUT_MS", "valueMs": 20000 },
      { "row": "launcher.STOP_REQUEST_POLL_MS", "name": "STOP_REQUEST_POLL_MS", "valueMs": 250 },
      { "row": "launcher.STOP_GRACE_WINDOW_MS", "name": "STOP_GRACE_WINDOW_MS", "valueMs": 20000 },
      { "row": "launcher.STOP_TASKKILL_WINDOW_MS", "name": "STOP_TASKKILL_WINDOW_MS", "valueMs": 10000 },
      { "row": "launcher.ORPHAN_SETTLE_MS", "name": "ORPHAN_SETTLE_MS", "valueMs": 10000 }
    ],
    "shell": [
      { "row": "shell.HEALTH_DEADLINE", "name": "HEALTH_DEADLINE", "valueMs": 20000, "file": "engine" },
      { "row": "shell.GRACE_WINDOW", "name": "GRACE_WINDOW", "valueMs": 5000, "file": "engine" },
      { "row": "shell.ESCALATION_WINDOW", "name": "ESCALATION_WINDOW", "valueMs": 5000, "file": "engine" },
      { "row": "shell.SOCKET_SETTLE", "name": "SOCKET_SETTLE", "valueMs": 750, "file": "main" },
      { "row": "shell.LADDER_JOIN_WINDOW", "name": "LADDER_JOIN_WINDOW", "valueMs": 20000, "file": "main" }
    ]
  },
  "portfile": {
    "writer": {
      "row": "server.portfile.payload",
      "file": "serverIndex",
      "interface": "interface PortfilePayload",
      "fields": ["port", "token", "pid", "startedAt", "engine", "url"],
      "writeOnly": ["startedAt"],
      "authority": "app/HANDOFF.md section 2 item 3 (the launcher never writes the portfile; the server owns it)"
    },
    "shellReads": {
      "row": "shell.portfile.struct",
      "file": "engine",
      "struct": "pub struct Portfile",
      "fields": ["port", "pid", "engine", "url"],
      "ignoredBy": ["token", "startedAt"],
      "authority": "app/HANDOFF-V1.md section 2 ladder step 2; engine.rs header comment (token/startedAt are not the shell's business)"
    },
    "launcherReads": {
      "row": "launcher.portfile.reads",
      "file": "launcher",
      "aliases": ["portfile.", "portfile?.", "instance."],
      "fields": ["port", "pid", "url"],
      "authority": "app/HANDOFF.md section 2 items 4 and 7 (authoritative pid/url read-back; the --stop candidate set)"
    }
  },
  "instanceLock": {
    "launcherWrites": {
      "row": "launcher.lock.writeLock",
      "file": "launcher",
      "fn": "function writeLock",
      "fields": ["launcherPid", "serverPid", "port", "startedAt", "dataDir"],
      "writeOnly": ["port", "startedAt", "dataDir"],
      "portIsNullInEveryDefaultLaunch": true,
      "authority": "app/HANDOFF.md section 2 item 1"
    },
    "launcherReads": {
      "row": "launcher.lock.reads",
      "file": "launcher",
      "fields": ["launcherPid", "serverPid"],
      "authority": "app/HANDOFF.md section 2 items 1, 7 and 8 (ownership check; --stop candidate set)"
    },
    "shellReads": {
      "row": "shell.lock.struct",
      "file": "engine",
      "struct": "pub struct InstanceLock",
      "field": "launcher_pid",
      "serdeRename": "launcherPid",
      "authority": "engine.rs InstanceLock comment (only launcherPid matters here); .unlazy/metagui-phase2/BUILD-NOTES.md D5"
    },
    "shellWrites": false,
    "deleters": {
      "row": "lock.two-deleters",
      "parties": ["launcher", "shell"],
      "launcherAnchor": "tryUnlink(lockPath)",
      "shellAnchor": "remove_file(&lock_path)",
      "authority": "app/HANDOFF.md section 2 items 1 and 8 (stale-lock removal, own-lock cleanup); engine.rs launch_sweep (dead-pid and recycled-pid removal)"
    }
  },
  "stopRequest": {
    "row": "stop.request.launcher-internal",
    "forbiddenIn": ["app/tauri/src-tauri/src/**/*.rs", "app/server/src/**/*.ts"],
    "forbiddenTokens": ["stop.request", "stop_request"],
    "positiveAnchor": { "file": "launcher", "text": "stop.request" },
    "authority": "app/HANDOFF.md section 2 item 6 (stop.request is a launcher-internal trigger); measured premise P2 (zero references in the Rust crate and the server, grep-verified)"
  },
  "stopChannel": {
    "rows": [
      {
        "row": "server.stdin-eof",
        "file": "serverIndex",
        "anchors": ["process.stdin.on('end'", "process.stdin.on('close'"],
        "authority": "app/HANDOFF.md section 2 item 6 (the server shuts down when its stdin ends)"
      },
      {
        "row": "launcher.stop-channel.stdin-end",
        "file": "launcher",
        "anchors": ["serverChild?.stdin.end()"],
        "authority": "app/HANDOFF.md section 2 item 6 (the launcher closes the server's stdin pipe — the established Windows stop channel)"
      },
      {
        "row": "launcher.own-stdin-eof",
        "file": "launcher",
        "anchors": ["process.stdin.on('end'", "process.stdin.on('close'"],
        "authority": "app/HANDOFF.md section 2 item 6 and Known caveats (window closed / parent died -> pipe handles close)"
      },
      {
        "row": "shell.stop-channel.childstdin-held",
        "file": "engine",
        "anchors": ["Mutex<Option<ChildStdin>>"],
        "authority": "app/HANDOFF-V1.md section 2 ladder step 1 (the ChildStdin handle lives in Tauri managed state — it IS the stop channel)"
      },
      {
        "row": "shell.stop-channel.shutdown-drop",
        "file": "engine",
        "fn": "pub fn shutdown",
        "anchors": ["drop(pipe)"],
        "authority": "app/HANDOFF-V1.md section 2 ladder step 3 (drop the child's stdin pipe)"
      },
      {
        "row": "shell.quit-order.about-blank-then-settle",
        "file": "main",
        "fn": "fn begin_quit",
        "textualOrder": ["about:blank", "SOCKET_SETTLE"],
        "authority": "app/HANDOFF-V1.md section 2 (close-to-exit is measured ~1 s because the shell navigates to about:blank BEFORE pulling the stop channel); main.rs measured comment (~3 s vs never)"
      }
    ]
  },
  "env": {
    "serverReads": {
      "row": "server.env.knobs",
      "files": ["serverIndex", "serverConfig"],
      "extraction": "anchored on real process.env accesses (bracket and dot forms); window.__METADESK__ and METADESK_PLACEHOLDER are not env knobs",
      "declared": ["METADESK_DATA_DIR", "METADESK_EXIFTOOL", "METADESK_PORT", "METADESK_TOKEN", "METADESK_SSE_HEARTBEAT_MS", "METADESK_WATCHER_DEBOUNCE_MS"],
      "authority": "KNOWN-GAP-1 (section 6): the server reads SIX knobs, config.ts:50/61/86 + index.ts:91/462/464"
    },
    "shellStrips": {
      "row": "shell.env.strip",
      "file": "engine",
      "fn": "pub fn spawn_engine",
      "declared": ["METADESK_PORT", "METADESK_TOKEN", "METADESK_EXIFTOOL", "METADESK_SSE_HEARTBEAT_MS"],
      "authority": "engine.rs spawn_engine env_remove block; KNOWN-GAP-1 (section 6): the shell strips exactly FOUR"
    },
    "dataDirSetters": {
      "row": "env.datadir.both-sides-set",
      "launcherAnchor": "METADESK_DATA_DIR: dataDir",
      "shellAnchor": ".env(\"METADESK_DATA_DIR\"",
      "authority": "app/HANDOFF.md section 2 item 3 (METADESK_DATA_DIR forwarded); app/HANDOFF-V1.md section 2 ladder step 1 (METADESK_DATA_DIR set)"
    }
  },
  "backstop": {
    "row": "backstop.asymmetry",
    "presentIn": { "file": "engine", "text": "JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE" },
    "absentFrom": { "file": "launcher", "text": "KILL_ON_JOB_CLOSE" },
    "authority": "app/HANDOFF-V1.md section 2 ladder step 6 (kernel backstop, shell only); app/HANDOFF.md section 2 item 6 (the dev backstop is the OS closing pipe handles — documented only)"
  },
  "sweepGuard": {
    "row": "shell.sweep.image-guard",
    "file": "engine",
    "fn": "pub fn launch_sweep",
    "killCall": "taskkill_tree",
    "guardCall": "process_image_path",
    "proofClass": "static-asserted-only",
    "authority": "engine.rs module invariants (the launch sweep checks the IMAGE PATH before killing anything); .unlazy/metagui-phase2/BUILD-NOTES.md pinned ladder step 0"
  }
}
```

## 1. Tri-party writer / reader / DELETER matrix

The seam is **three-party, not two** (measured premise P2): the server is the
portfile's sole writer and the stdin stop channel's receiver; the launcher is the
sole writer of the lock and of `stop.request`; **the shell writes NOTHING on this
seam** — it honors `launcherPid` only, and its whole `OwnedByLauncher` veto
(engine.rs `launch_sweep` → `SweepOutcome::OwnedByLauncher`) hangs on that one
field name. One file has **TWO DELETERS**: `instance.lock` is removed by the
launcher (its own stale-lock sweep and its exit cleanup) *and* by the shell's
launch sweep (dead-pid removal, recycled-pid removal).

| File | Writer (sole) | Readers | DELETER(s) | Write-only fields |
|---|---|---|---|---|
| `portfile.json` | **server only** — `writePortfile` after `listen` (`index.ts`: payload `{port, token, pid, startedAt, engine, url}`) | launcher reads `{port, pid, url}`; shell reads `{port, pid, engine, url}` — `token` and `startedAt` are deliberately ignored by both (`engine.rs` serde struct comment: "not the shell's business"; serde `ignore-unknown` keeps them out) | launcher (exit cleanup + `--stop` sweep, owned files only) and shell (launch sweep of a dead pid; post-shutdown sweep) | `startedAt` (written by the server, read by nobody) |
| `instance.lock` | **launcher only** — `writeLock`: `{launcherPid, serverPid, port, startedAt, dataDir}` | launcher reads `{launcherPid, serverPid}` (ownership + `--stop` candidates); shell reads `{launcherPid}` ONLY | **two**: launcher (3 sites: exit cleanup, `--stop` sweep, stale-lock sweep) + shell launch sweep (2 sites: dead-pid, recycled-pid) | `port` (**null in every default launch** — `requestedPort` is only set by `--port`; the caveat is missing at `HANDOFF.md:64`, correction rides docs closeout), `startedAt`, `dataDir` |
| `stop.request` | **launcher only** (`--stop` writes `{requestedAt, byPid}`) | **nobody parses the contents** — the launcher polls EXISTENCE only (`existsSync` boot guard + 250 ms poll); the server and shell never see it | launcher only (cleanup on exit / on the no-instance sweep) | both fields (`requestedAt`, `byPid` — existence-polled, never read) |

Authority: `app/HANDOFF.md` §2 items 1, 3, 7, 8; `app/HANDOFF-V1.md` §2 ladder steps
0–2; `.unlazy/metagui-phase2/BUILD-NOTES.md` D5 (the shell's single-instance is the
Tauri plugin's named mutex; it keeps *honoring* the launcher's lock but never writes
it — "one file with two writers is confusion", engine.rs `InstanceLock` comment).

## 2. The stop channel

**The stop channel is stdin EOF, per party:**

- **Server (receiver):** `stdin` `end` **or** `close` → `stop()` — watcher stop, SSE
  hub drain, engine session shutdown through the Fastify close ladder
  (`index.ts`, non-TTY only). Windows sends no signals on console close; this pipe
  is the stop channel for *both* adapters (`HANDOFF.md` §2 item 6).
- **Launcher (dev side):** closes the **server's** stdin (`serverChild?.stdin.end()`)
  when: its own stdin ends/closes (window closed, parent died — the OS closes pipe
  handles on process death, so a hard-killed launcher still stops the server),
  Ctrl+C/SIGINT/SIGTERM/SIGBREAK, `stop.request` appearing, or its own failure path.
- **Shell (desktop side):** the `ChildStdin` handle is held in Tauri managed state
  for the shell's whole life and **dropped on purpose** as step 3 of the shutdown
  ladder (`engine.rs shutdown`: `drop(pipe)`). The spawn path's fresh-engine guard
  stops a boot that races a quit the same way.

**The tsx-hop pid-of-record rule** (`HANDOFF.md` §2, "The tsx hop"): the launcher's
direct child is `tsx/dist/cli.mjs`, which may run the server entry in-process or
fork it (observed both ways). Either way tsx forwards stdin, so closing the
launcher→tsx pipe reaches the server's `stdin end` handler. Consequence: **always
trust `portfile.json.pid` as the server pid** — it is what `--stop` watches and
what the orphan checks test. The lock's `serverPid` records the launcher's direct
child and **may or may not equal it; both die together on every stop path**
(verified in `verify-launch.mjs`).

**The close ordering (shell):** inside `begin_quit` — and asserted by the gate as
TEXTUAL ORDER inside that function slice, never line numbers — the window is
hidden and navigated to `about:blank` **first** (the page's SSE connection dies
with that trip; WebView2's browser process otherwise keeps the socket open after
the window is gone, and the engine cannot finish its own close while a request is
in flight), **then** one `SOCKET_SETTLE` beat (750 ms) lets that socket close reach
the engine, **then** the shutdown ladder runs on a worker thread. The measured
comment (`main.rs`): with the stream already dropped the engine exits in ~3 s;
without dropping it, **it never exits on its own**. `HANDOFF-V1` §2 records the
outcome: close-to-exit measured ≈1 s. `LADDER_JOIN_WINDOW` (20 s) is how long the
event loop waits for a close ladder that a worker thread already started
(`RunEvent::Exit`) before falling back to running it inline — a ladder started by a
close click is never cut short by the process going away.

## 3. Timing table

**These pairs are NOT meant to converge.** The dev launcher and the desktop shell
deliberately run different budgets: the launcher's numbers are sized for a **cold
tsx boot** (TypeScript compiled on every start) inside a **visible console the user
is watching**; the shell's numbers are sized for a **warm bundle** (direct
`node.exe` on the prebuilt esbuild bundle, ~1–2 s boot) behind a **hidden window
that must feel instant** on close. Both grace windows protect the mid-batch write
— the exact risk the lifecycle exists to prevent — but from opposite ends: the
launcher can wait long because the user asked for a stop and can see the console;
the shell's user clicked X and sees nothing, so its margin lives in the
journal/backup pipeline plus the Job Object instead of in a long window.
A parity check across this table is forbidden and would be wrong.

### Launcher (`app/bin/metadesk.mjs`) — cold path, console visible

| Constant | Value | Failure-budget why |
|---|---|---|
| `HEALTH_DEADLINE_MS` | 45 000 ms | cold tsx compile + server boot + exiftool `-stay_open` handshake must fit; 45 s absorbed the slow-first-boot class of failures (a 20 s number false-fails cold dev boots) |
| `PORTFILE_AFTER_HEALTH_MS` | 10 000 ms | after the health 200 the portfile write is a near-immediate disk tick; 10 s is already generous |
| `SECOND_INSTANCE_PORTFILE_WAIT_MS` | 20 000 ms | a second launch waits for the first's portfile (focus path) before giving up and exiting 0 |
| `GRACEFUL_EXIT_TIMEOUT_MS` | 20 000 ms | stdin EOF → Fastify close ladder (watcher, SSE hub drain, exiftool shutdown) protects a mid-batch write; long on purpose |
| `STOP_REQUEST_POLL_MS` | 250 ms | `stop.request` existence poll + child-exit poll cadence: responsive enough to feel immediate, cheap enough to leave running |
| `STOP_GRACE_WINDOW_MS` | 20 000 ms | `--stop` waits for the pid(s) to die before escalating; the same mid-batch-write protection, from the second-process side |
| `STOP_TASKKILL_WINDOW_MS` | 10 000 ms | after `taskkill /T /F`, wait for death before reporting FAILED |
| `ORPHAN_SETTLE_MS` | 10 000 ms | the engine's shutdown ladder may still be reaping; settle window before declaring exiftool orphans against baseline |

### Shell (`engine.rs` / `main.rs`) — warm path, hidden window

| Constant | Value | Failure-budget why |
|---|---|---|
| `HEALTH_DEADLINE` | 20 000 ms | warm bundle boots in ~1–2 s; 20 s is failure budget, not boot budget |
| `GRACE_WINDOW` | 5 000 ms | WM_CLOSE must feel instant; the measured beat is 750 ms + ~3 s engine exit, so 5 s covers the ladder, then escalate |
| `ESCALATION_WINDOW` | 5 000 ms | wait after `taskkill /T /F` before giving up on the kill |
| `SOCKET_SETTLE` | 750 ms | the beat for the `about:blank` socket close to reach the engine (§2) |
| `LADDER_JOIN_WINDOW` | 20 000 ms | event-loop join for a worker-thread ladder already in flight |

### Inline beats (documented-only — recorded here, not gate-asserted)

Inline poll/settle literals are part of the same failure budgets but carry no named
anchor, so the gate does not pin them; they ride the same same-commit protocol via
this table. Launcher: health poll 400 ms; portfile poll 250 ms; second-instance
poll 500 ms; post-taskkill settle 1 500 ms; `httpGet` timeout 3 000 ms. Shell:
health poll 250 ms; grace poll 100 ms; crash-watcher poll 500 ms; ladder-join poll
50 ms; `http_get` timeout 3 000 ms.

## 4. Kill rules & backstops

- **Never kill a foreign process.** The launcher never kills an exiftool process it
  does not own — it compares the machine-wide count against its pre-spawn baseline
  and WARNs on orphans (`HANDOFF.md` §2 item 8; Mike may have his own running). The
  shell never kills a portfile pid whose image path is not the bundled `node.exe`
  (`engine.rs` module invariants; pinned ladder step 0).
- **The sweep's image-path proof.** Inside `launch_sweep`, every `taskkill_tree`
  call is preceded by a `process_image_path` check — the pid is proven to be our own
  bundled node.exe before anything is killed. The gate asserts this shape
  (C8) but labels it **static-asserted-only**: it proves the code's shape, and it
  proves nothing about pid recycling (§5, asymmetry 7's cousin; see the accepted
  asymmetry below). `wait_for_exit_or_escalate`'s **unguarded** escalation
  (`engine.rs`, outside `launch_sweep`) is **correct-by-design** — it acts on a
  handle-held child we spawned, not on a recycled pid-of-record — and is recorded
  in §5; the gate never asserts against it.
- **ACCEPTED ASYMMETRY — the launcher's pid-of-record precondition.** The launcher
  trusts `portfile.pid` + `process.kill(pid, 0)` liveness with **no image-path
  check** (`findRunningInstance`, the `--stop` candidate set). A **recycled pid**
  — the OS reassigning a dead server's pid to an unrelated process in the window
  between the crash and the next launch/stop — would be misread as "instance
  alive". The shell closes exactly this hole with `process_image_path`. The
  live-but-unhealthy variant of this divergence is OPEN (§7, O2). **Change
  requires an orchestrator decision** (align-or-pin; fixing here would be a
  behavior change this leaf forbids).
- **Backstops: oracle-proven vs documented-only, carried honestly.** The shell's
  Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) is **oracle-proven**:
  `verify-desktop.mjs matrix` case 2 hard-kills the shell and asserts the
  node+exiftool tree died with it. The dev side's backstop — the OS closing the
  launcher's pipe handles on a violent launcher death, which surfaces as server
  stdin EOF — is **documented-only** (`HANDOFF.md` §2 item 6 and Known caveats);
  no behavioral oracle exercises it. The gate pins the *asymmetry itself* (C7:
  the Job Object token exists in `engine.rs` and does not exist in the launcher) —
  evidence that the kernel guarantee is shell-only, not a defect to homogenize.

## 5. Accepted-asymmetries register

Each row is a deliberate disagreement between the adapters. **Change requires an
orchestrator decision** — none of these may be "harmonized" by a drive-by edit.

| # | Asymmetry | The two sides | Why it is deliberate |
|---|---|---|---|
| 1 | Health deadline | launcher 45 s vs shell 20 s | cold tsx boot vs warm bundle (§3) |
| 2 | Grace + escalation | launcher 20 s grace / 10 s post-kill vs shell 5 s grace / 5 s escalation | visible console may wait; hidden window must feel instant; mid-batch write protected by time (dev) vs by journal/backup + Job Object (shell) |
| 3 | Inverted handshake order | launcher picks the port (`--port`), polls health FIRST, then reads the portfile; shell strips `METADESK_PORT`, lets the server free-pick, reads the portfile FIRST, then polls health | two boot topologies, each self-consistent. NOTE: `HANDOFF.md:69` says the launcher's port pick honors `METADESK_PORT` — **already wrong in the contract of record** (the launcher reads only `--port`; `METADESK_PORT` is a server knob that always loses to argv). Correction rides docs closeout (§7 O3) |
| 4 | Adopt-vs-kill orphan policy | a portfile pid that is alive but fails `/api/health`: the shell image-proofs and tree-kills it; the launcher ignores it and spawns a second server over the stale portfile | shell owns its engine's corpse; launcher defers to "maybe it's somebody else's" (never-kill-foreign). Live-but-unhealthy divergence recorded OPEN (§7 O2) |
| 5 | Forward-vs-strip env policy | the launcher forwards the whole environment plus `METADESK_DATA_DIR`; the shell strips exactly four `METADESK_*` knobs and sets `METADESK_DATA_DIR` | dev wants your env (dev knobs, dev tools); the shipped engine must be immune to stray user env. The seam's drift is KNOWN-GAP-1 (§6) |
| 6 | Lock-vs-mutex single-instance | dev: `instance.lock` file liveness; shell: `tauri-plugin-single-instance` named mutex, registered FIRST (D5), which still *honors* the launcher's lock (`OwnedByLauncher`) | each side enforces single-instance with its own mechanism and defers to the other's |
| 7 | Unguarded escalation in `wait_for_exit_or_escalate` | escalates to `taskkill_tree` with no image-path check | correct-by-design: the child handle is held — it IS our child, not a recycled pid-of-record. Recorded so C8's `launch_sweep`-slice scoping is never "fixed" into asserting against it |

## 6. KNOWN-GAP-1 (verbatim, LIVE TODAY — not fixed in this leaf)

> **KNOWN-GAP-1 (medium, LIVE TODAY):** the server reads **SIX** `METADESK_*`
> knobs — `DATA_DIR`, `EXIFTOOL`, `PORT`, `TOKEN`, `SSE_HEARTBEAT_MS`,
> `WATCHER_DEBOUNCE_MS` (`config.ts:50/:61/:86`, `index.ts:91/:462/:464`) — but the
> shell strips exactly **FOUR** (`engine.rs:270-273`);
> `METADESK_WATCHER_DEBOUNCE_MS` **leaks into the packaged engine**, and the
> shell's own comment (`engine.rs:251-252`) overclaims "`METADESK_*` knobs
> stripped". NOT fixed here (zero behavior change); recorded verbatim with
> **owner = candidate 1's config-channel design**. A 7th knob or a 5th strip name
> must fail the gate.

The gate carries this gap **green-but-named**: C6 asserts the server read-set ==
the declared six AND the shell strip-list == the declared four — so today's
divergence is the pinned state, and any *further* drift (a seventh knob anywhere
under `server/src`, a fifth `env_remove`, a renamed knob) turns the gate RED.

## 7. OPEN register

Recorded gaps. Fixing any of them is a behavior change — **orchestrator decision
required**; this leaf fixes none of them.

- **O1 — `--stop` against a shell-owned engine (the P5 chain).** `metadesk.mjs
  --stop` against a shell-owned engine finds no lock (the shell writes none),
  `stop.request` is never read by the shell, the 20 s grace expires, `taskkill /T
  /F` fires at the engine tree, the shell's crash watcher pops its Reopen/Quit
  dialog, and **`stop.request` residue persists** (no unlink on the success path).
  Worse: a surviving `stop.request` plus one failed health probe then **masks a
  later dev boot failure as a clean exit 0** (the boot path honors a mid-boot
  `stop.request` as a deliberate stop).
- **O2 — live-but-unhealthy portfile divergence.** A portfile pid that is alive
  but fails `/api/health`: the shell image-proofs and tree-kills it; the launcher
  ignores it and spawns a second server over the stale portfile. No oracle seeds a
  live pid (matrix case 3 seeds a DEAD pid only). An align-or-pin decision (§5
  asymmetry 4).
- **O3 — contract-of-record prose corrections → docs closeout.** `HANDOFF.md:69`
  (the launcher's port pick does NOT honor `METADESK_PORT` — argv only) and
  `HANDOFF.md:64` (add the `lock.port` null-in-default-launch caveat). Both ride
  the orchestrator's docs-closeout commit; `HANDOFF.md`/`HANDOFF-V1.md` are not
  edited inside this leaf.

## 8. Fact → oracle pinning table

**The antidote to reading a green STATIC gate as behavioral coverage.** The gate
proves code *shape*. Behavior is proven by the oracles named here — or honestly
marked as not proven. Class: **SAFETY** (a failure can damage user data or kill
processes we do not own) vs **OPERATIONAL** (a failure is confusing or slow but
destroys nothing).

| Fact | Class | Proof status |
|---|---|---|
| Job Object kills the tree on a violent shell death | SAFETY | **oracle-proven** — `verify-desktop.mjs matrix` case 2 |
| stdin-EOF stop channel tears the server down through the graceful ladder | SAFETY | **oracle-proven** — `verify-server` stdin-close shutdown (zero orphan exiftool); `verify-desktop.mjs shell` WM_CLOSE teardown |
| Sweep never kills a foreign-image process | SAFETY | **static-asserted-only** (C8 image-guard shape) + documented (`engine.rs` invariants, pinned ladder step 0) |
| Launcher never kills a foreign exiftool | SAFETY | **documented-only** (`HANDOFF.md` §2 item 8); `verify-launch` asserts counts return to baseline, which exercises the owned path, not the foreign path |
| Dev pipe-EOF backstop (hard-killed launcher still stops the server) | SAFETY | **documented-only** (`HANDOFF.md` §2 item 6 + Known caveats) — no behavioral oracle |
| Launcher's pid-of-record precondition (no image check) | SAFETY | **accepted asymmetry** (§5.4) — the pid-recycling window is named there; behavior unproven either way |
| `portfile.pid` is the pid of record; lock `serverPid` may differ, both die together | OPERATIONAL | **oracle-proven** for die-together (`verify-launch.mjs`, per `HANDOFF.md` §2 tsx-hop note); the rule itself documented |
| Server is the portfile's sole writer; readers take deliberate subsets | OPERATIONAL | **static-asserted-only** (C2 exact sets) + documented (`HANDOFF.md` §2 item 3, `engine.rs` struct comment) |
| `launcherPid` key byte-agreement (launcher write ↔ shell serde read) | OPERATIONAL | **static-asserted-only** (C3) |
| `stop.request` is launcher-internal (zero refs in shell/server) | OPERATIONAL | **static-asserted-only** (C4) + documented (`HANDOFF.md` §2 item 6) |
| Shell env stripping isolates the shipped engine | SAFETY | **static-asserted-only** (C6) — no behavioral oracle strips-and-boots; KNOWN-GAP-1 (§6) is the live seam |
| about:blank → `SOCKET_SETTLE` → shutdown ordering | OPERATIONAL | **static-asserted-only** (C5 textual order) + measured comment documented (~3 s vs never); the *outcome* (close-to-exit ≈1 s) is exercised by the matrix's graceful-close case |
| Timing values (§3 table) | OPERATIONAL | **static-asserted-only** (C1) — no behavioral gate pins a single timing VALUE (`P8`: a 45 s→90 s health deadline passes every behavioral gate and just hangs the dev console) |
| `--stop` end-to-end (dev side) | OPERATIONAL | **oracle-proven** — `verify-launch.mjs` drives `--stop` from a separate process: exit 0, pid gone, zero residue, counts to baseline |

## 9. Gate-local budgets are not contract facts

The poll budgets and timeouts inside `app/scripts/verify-*.mjs` — for example
`verify-launch`'s 60 s `pollPortfile` ceiling and 4-minute overall watchdog, or
`verify-desktop`'s 5/20-minute overall watchdogs — are **GATE-LOCAL**: they size
how long a *test harness* is willing to wait, sit deliberately above the product
constants they observe, and change no product behavior. They are deliberately NOT
rows in the pin table: retuning a gate budget needs no contract change, and
tightening one to "match" a product constant would make the gate false-fail on
exactly the slow boots the product constant exists to absorb.
