# MetaDesk

A local Windows GUI over ExifTool: view, edit, and strip file metadata safely, with
every write previewed, journalled, backed up, and verified before it counts as done.

## Language

### Writing

**Save Review**:
The mandatory preview screen between intent and execution; no write ever runs without one.
_Avoid_: confirmation dialog, dry run

**preview/execute**:
The two-phase write: a frozen preview (per-file old→new plus the exact argv), then a
separate deliberate execute of that preview.
_Avoid_: apply, commit

**command preview**:
The exact exiftool argument array a request did (or would) execute, shown for trust.
_Avoid_: command log, debug output

**journal**:
The append-only, intent-first record of every write batch; the product's memory for
undo, recovery, and interrupted-batch detection.
_Avoid_: log, history file

**three-valued outcome**:
Every file in a write ends updated, unchanged, or needs attention — never a bare success/fail.
_Avoid_: status, result flag

**destructive flow**:
A write path that deletes data (AI scrub, GPS strip); phrase-gated, export-first, with an
honest cannot-remove list.
_Avoid_: cleanup, wipe

**confirmation phrase**:
A typed phrase (e.g. `REMOVE AI METADATA`) required to arm a destructive flow.
_Avoid_: password, PIN

**notRemoved**:
The honesty section of a destructive-flow report listing detections the tool cannot remove.
_Avoid_: skipped, failed

### Mode & session

**write mode**:
Whether the running session may write: read-only or write-unlocked. Reported by /api/health
and always visible in the UI.
_Avoid_: lock state, permission level

**read-only by default**:
The invariant that every boot starts read-only; writing requires a deliberate unlock.
_Avoid_: safe mode

**session unlock**:
The deliberate act that flips the write mode, for the running session only — never persisted.
_Avoid_: login, authentication

### Lifecycle

**engine**:
The vendored exiftool.exe and its persistent stay-open session; the server degrades to
read-only when it is unhealthy.
_Avoid_: backend, process

**launcher**:
The development lifecycle owner (`bin/metadesk.mjs`): sweep, spawn, health handshake,
graceful stop.
_Avoid_: runner, script

**desktop shell**:
The packaged Tauri window that owns the engine in production via the same lifecycle ladder.
_Avoid_: app, wrapper

**portfile**:
The handshake file the server writes naming its port, token, and pid — the pid of record
for the whole lifecycle.
_Avoid_: lock file
