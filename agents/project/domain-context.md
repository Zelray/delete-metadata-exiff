# MetaDesk domain context

Read before engine, write, API, or lifecycle work. Facts below describe the audited source tree at c4cf236.
New facts use the self-improvement protocol in M5 and cite the source commit. Public playbooks contain no personal data or machine addresses.

## Product and platform

MetaDesk: local ExifTool GUI for Windows. Node 22 + TypeScript, Fastify server, React UI.
Windows-only by design. Node/npm versions and dependency versions are read from the installed environment and manifests.

The product principle in MD5 includes a default YES for feature existence. Check existing code and help before proposing additions.
The Engine arguments and Server write pipeline contracts set the safety limits on every feature.

## Engine and write facts

`app/vendor/exiftool/**` and the repo-root `exiftool/` + `vendor/exiftool/` are reference copies.
From this Git root, the parent reference pointers are `../exiftool/` and `../vendor/exiftool/`.
MD1 governs edits and approved copying. The instruction gate hashes only Git-tracked files under vendor/exiftool/.
The two outside-Git copies require orchestrator review. They are never recursively read by the source inventory.

`engineArgs` rejecting `--` is a pinned safety fact, not a bug (BUILD-NOTES fact #1).
The argument boundary and write builder forbid overwrite-original flags. Preserve this behavior when adding options.
New write paths require the existing whitelist, preview, journal, backup, and readback verification.
The AST scanner checks process syntax and known bypasses; it does not prove the safety sequence.

## Contract record and optional parent context

Contract of record = `../.unlazy/metagui/BUILD-NOTES.md`.
The original ownership table is `../.unlazy/metagui/PLAN.md`.
MD2 and MD3 govern record review and released ownership. These paths are optional context outside this Git repository.
Read them when present in the orchestrator workspace. They need not exist in a standalone clone or CI.
If a change depends on missing record decisions, obtain a portable brief from the orchestrator before that dependent work.
The checked-in contracts, docs/lifecycle-contract.md, and task brief remain available without the parent workspace.
Never silently invent missing decisions or treat absent parent files as permission to edit a subsystem.

## Lifecycle and runtime

`data/` is runtime state (gitignored).
The launcher sweeps its own files (`portfile.json`, `instance.lock`, `stop.request`) and leaves server-owned caches alone.
MD7 governs runtime edits and tracking. data/.gitkeep is the sole tracked runtime-directory placeholder.
The launcher owns the lifecycle; the server PID of record is always data/portfile.json.
HANDOFF.md section 2 explains the tsx child-process distinction. The UI and engine process are not substitutes for that server PID.

The existing scripts/verify-lifecycle-contract.mjs derives the parent directory and reads app/docs/lifecycle-contract.md.
It therefore requires a checkout directory named app inside a parent directory, including CI checkout path app.
A clone under another basename needs an equivalent parent/app layout before that existing verification command can run.
New quality modules derive the actual Git root from their own file URL and have no basename assumption.
Rust/PowerShell process ownership stays with the existing lifecycle gate and independent behavior review.

## History facts

- Scrub truncation compares against the name-filtered scope; count formatting and oldest-modified labeling must describe the displayed results (a10631ca).
- Streamed writes need a JSON Content-Type. Protected thumbnails use authenticated fetch and a blob rather than an unauthenticated image URL (f82066cd).
- Drain the SSE hub in preClose before Fastify waits on connections. Removing that hook caused the recorded test timeout; shared framing uses writeSseFrame (b747379a).

## Transport and state

The API transport contract names send, authHeaders, and readSse in ui/src/api/client.ts.
Only send calls fetch. Credentials belong to the per-launch bootstrap, not durable settings.
The UI write consent contract limits persistence to recents, theme, density, and consoleHistory.
Preview IDs, consent, unlock state, selected files, results, and writeRun remain transient.
Review indirect wrappers, credential handling, expiry, and state changes; syntax findings do not prove those behaviors.
