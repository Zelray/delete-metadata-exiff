# Testing playbook

Read before tests, UI changes, gate verification, or platform checks. MD19 owns execution order.
Run every command singly with raw output. Workers obey their released brief; the parent owns setup verification.

## Native runners and platform

Tests live in `server/test/**` and run via `npm test`.
Never bare Vitest from app root: it discovers the UI suite together and disrupts the shutdown tests.
UI unit tests live beside ui/src modules; use their own workspace runner.
PowerShell is the shell. The verify scripts legitimately use tasklist/pwsh and need Windows.
Use the launcher for casual runs: node bin/metadesk.mjs or pwsh -NoProfile -File bin/metadesk-dev.ps1.
Do not add a second lifecycle implementation. HANDOFF.md sections 2 and 3 carry lifecycle details and verify markers/caveats.

Run from the app Git root, one command at a time:

```powershell
npm test
npm --workspace ui test
npm --workspaces --if-present run typecheck
npm run build
node quality/instruction.mjs
node quality/instruction-control.mjs
node scripts/verify-lifecycle-contract.mjs
```

For targeted native instruction tests, invoke the workspace-local Vitest entry with cwd server:
node ../node_modules/vitest/vitest.mjs run test/instruction-gate.test.ts test/quality/instruction-controls.test.ts.
For targeted UI tests, use cwd ui and that same ../node_modules/vitest/vitest.mjs entry.
Choose touched-layer verify scripts from scripts/; invoke node scripts/verify-X.mjs from app.
Never run verify-launch.mjs concurrently with npm test because it counts machine-wide processes.
The existing lifecycle verifier requires the parent/app checkout layout described in the domain playbook.

## Test design

Exercise the highest interface that reaches the required behavior. Assert changed data, refusal, recovery, navigation, or rendered values.
Use system-boundary mocks for ExifTool processes, filesystem faults, HTTP, or desktop integration when a real boundary is impractical.
Internal module mocks and weak assertions enter the quality ratchet under C6 and C7.
Use retrying conditions rather than fixed sleeps in end-to-end steps. New interactive controls need stable IDs.
UI behavior/navigation changes require an outcome-based end-to-end scenario under MD16; cosmetic changes use existing gates.
Inspect tests-e2e/package.json and scripts/verify-e2e.mjs before selecting an end-to-end run; these need the launcher and built UI.

Product feature/bug tests follow P2 proven red against pre-change code. Gate assertions use scratch violations instead.
Only a test assertion failure proves a mutation kill. Missing modules, runner errors, timeouts, and setup failures are different results.
Parent captures each clean check and each intended negative-control failure before committing a gate.

## Instruction measurements

The native instruction test runs with npm test. The helper also has a Node CLI for hooks and CI.
Its stats count contracts, resolved reference tokens, production scopes, JS/TS files parsed, Rust/PowerShell review files,
knowledge files, evidence hashes, docs scanned, test scopes, tracked engine files, and combined instruction words.
Empty required production/test scopes fail before a result can silently pass.
Process findings and existing launch imports are ratcheted separately; unknown expressions mean review required.
The hard gate holds clean UI transport/write/persistence clauses and parser health at zero.
Contract sequencing, whitelist completeness, previews, token semantics, readback correctness, and PID identity remain review plus existing tests.

The instruction controls inject owned in-memory snapshots. They never mutate app files, vendor files, or runtime data.
Controls cover a missing path, moved/comment-only symbol, private address, missing instruction, alias bypass, comment traps,
empty denominator, help mirror changes/deletions, vendor drift, process options aliases/spreads, and forbidden persistence.
Run controls serially before the first clean native test. Do not claim proof until the parent records the actual output.
