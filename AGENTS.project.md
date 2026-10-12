# MetaDesk project instructions

Read `AGENTS.md` first. Contracts, project rules, verification, playbooks.
The sanctioned path is the only path; a bypass is a bug even when it works.

## Architecture contracts

### Engine arguments
Owns: approved ExifTool arguments. Every process execution uses an argv array and explicit shell: false.
Path: `assertArgsSafe` (`server/src/engine/engineArgs.ts`); `buildWriteArgs`
  (`server/src/engine/argBuilder.ts`); `ExifToolSession` (`server/src/engine/exiftoolSession.ts`).
Never: shell commands, concatenated command strings, shell true, unreviewed indirect args/options,
  overwrite-original flags, or writes outside the tag whitelist. Double-hyphen rejection is deliberate.
Gate: `server/test/instruction-gate.test.ts` detects process syntax; existing omissions remain ratcheted.
  `server/test/argBuilder.test.ts`, `server/test/hostileFilenames.test.ts` cover argument safety; review traces indirect execution without waiving argv arrays or shell: false, and reviews new tags.

### Server write pipeline
Owns: unlock, preview, lock, journal, backup, readback verification, and recovery for every write.
Path: `WriteSubsystem` (`server/src/writeSubsystem.ts`); `WritePipeline`
  (`server/src/services/writePipeline.ts`); `registerWriteRoutes` (`server/src/routes/writes.ts`).
Never: a write that skips the whitelist, mandatory preview, journal, backup/verification, or refusal checks.
  Escalate a requested bypass before implementation.
Gate: `server/test/write/composition.test.ts`, `server/test/write/writePipeline.test.ts`,
  `server/test/write/journal.test.ts`, `server/test/write/recovery.test.ts`; review sequence, preview validity, readback meaning, and new write paths.

### UI write consent
Owns: every write-firing UI path, explicit consent, blockers, and transient run state.
Path: `useWriteRunner` (`ui/src/write/useWriteRun.tsx`); `useUiStore` (`ui/src/state/store.ts`).
Never: executeWrite, scrubExecute, or confirmUndo outside the runner; persist writeRun, consent, unlock, previews,
  files, or results. Only recents, theme, density, consoleHistory may persist. Safety toggles stay visible, explained, and hard-floored.
Gate: `server/test/instruction-gate.test.ts` resolves write aliases and persistence objects;
  `ui/src/write/write.surfaces.test.tsx`, `ui/src/write/writeRun.session.test.tsx`; review consent, blocker ordering, and indirect state/transport paths.

### API transport
Owns: UI requests, per-launch token headers, errors, and streamed responses.
Path: `send`, `authHeaders`, `readSse` (`ui/src/api/client.ts`).
Never: raw fetch outside send, EventSource, XMLHttpRequest, axios, or independent credentials handling.
Gate: `server/test/instruction-gate.test.ts` parses transport calls and aliases;
  `ui/src/api/client.transport.test.ts`; review credential semantics, envelopes, and stream cancellation.

### Lifecycle
Owns: launcher/server/Tauri startup, shutdown, owned process identity, runtime files, and caches.
Path: `runStart`, `gracefulStop` (`bin/metadesk.mjs`); `buildServer`, `writePortfile`
  (`server/src/index.ts`); `spawn_engine`, `launch_sweep` (`tauri/src-tauri/src/engine.rs`).
Never: a second lifecycle owner, casual server spawning, killing an unowned ExifTool, or hand-edited runtime state.
  data/portfile.json records the server PID; launcher sweeps only its files and preserves server-owned caches.
Gate: `scripts/verify-lifecycle-contract.mjs`, `server/test/shutdown.test.ts`;
  `server/test/instruction-gate.test.ts` checks tracked runtime/vendor state and builtin imports; review PID identity and Rust/PowerShell behavior.

## Project rules

- MD1. Protected engine/reference copies never change except orchestrator-approved copying.
  Gate: instruction vendor hash manifest for tracked app files; review external copies.
- MD2. Read available contract-of-record context before work, contradict nothing, and escalate deviations.
  Gate: review; optional parent pointers and standalone-clone handling are in the domain playbook.
- MD3. Edit only released ownership globs; one builder per leaf. Workers never edit .unlazy or run gate-check.
  Gate: orchestrator dispatch and changed-path review.
- MD4. Use best practices and delegate substantive decisions within max five machine-wide agents,
  design waves max three, build waves max two. Gate: dispatch review.
- MD5. Default YES to feature existence after checking the current surface; never enlarge an authorized task silently.
  Safety and truthful outcomes remain absolute. Gate: product and contract review.
- MD6. Use PowerShell on Windows. bin/ and scripts/ import Node builtins only; no new launch runtime dependency.
  Gate: import findings enter the ratchet; manifest and indirect-import review.
- MD7. No hand edits to data/ or committed runtime state except data/.gitkeep.
  Gate: instruction tracked-state check and execution review.
- MD8. F1 help is product work; update resources/help/metadesk-help.md and ui/src/shell/HelpOverlay.tsx together.
  Gate: instruction changed-path pair check; review content agreement.
- MD9. Explain limits plainly. Detect-only items say "cannot be removed"; never report false success.
  Gate: behavior tests and outcome/copy review.
- MD10. Warn at 45% context, stop new streams; wrap at 50%; hand off and stop by 55%. Never compact.
  Gate: context accounting and handoff review.
- MD11. Owner approval precedes money, live-system changes, or actions hard to undo.
  Gate: explicit approval review.
- MD12. Conventional commits include scope in the body and leaf number in the subject when applicable.
  Existing main workflow yields to explicit owner branch instructions; setup uses feat/gap-trap-setup.
  Never force-push or amend a pushed commit; push only when the owner instructs it. Gate: history and command review.
- MD13. Never run npm audit fix --force. Gate: dependency-command review.
- MD14. Run commands from the app Git root. Install hooks once per clone with npm run prepare after reviewing the hook.
  Gate: command review and CI rerun of the same gates.
- MD15. Human prose uses slop-mop; prose reviewers use detect mode on the harness's top coding model.
  Gate: independent prose review.
- MD16. Behavior/navigation changes need outcome-based end-to-end coverage; cosmetic changes use existing gates.
  Gate: spec review and end-to-end scenarios.
- MD17. A feat PR links its spec or explains its absence in the Spec section. Gate: pr-acceptance CI job.
- MD18. Authorized agent GitHub comments end with attribution naming the agent and the owner's login from gh api user.
  Gate: comment review; no external comment is authorized by this rule.
- MD19. All tests, gates, builds, and typechecks run singly. Never bare Vitest from app root or verify-launch concurrently with npm test.
  Parent verifies released worker work; workers obey their brief's execution limits. Gate: serial runner and command review.

## Verification

Run only the checks authorized by the current brief. Parent records raw outputs and denominators before claiming completion.

```powershell
npm run gates
npm test
npm --workspace ui test
npm run build
npm --workspaces --if-present run typecheck
node quality/instruction.mjs
node quality/ratchet.mjs
node scripts/verify-lifecycle-contract.mjs
```

Run relevant app/scripts/verify-X.mjs layers singly; markers and caveats live in HANDOFF.md section 3.
Use node bin/metadesk.mjs or pwsh -NoProfile -File bin/metadesk-dev.ps1 for casual launches.
The testing playbook lists workspaces, launch restrictions, and platform prerequisites.
Ratchet --update only lowers baselines; a manual increase needs the reason required by C7.
Future feature/bug work follows P1 issue and acceptance-linked PR. The local bootstrap exception is documented in the workflow playbook.

## Playbooks

Read each listed playbook before work in that area.

| Work | Read first |
|---|---|
| Multi-agent or long-running work | agents/generic/agent-workflows.md; agents/project/agent-workflows.md |
| Naming, briefs, proposals | agents/project/glossary.md; agents/project/out-of-scope.md |
| Tests, UI, platform checks | agents/project/testing.md |
| Developer/user documentation | agents/project/documentation.md |
| Engine, writes, lifecycle, domain facts | agents/project/domain-context.md |

Detailed migration and limitations live in the project playbooks. The instruction gate uses an explicit initial 3000-word budget.
