# Project agent workflow

Read before dispatch, long work, dependency changes, or framework maintenance.
The generic playbook is advisory. MD3, MD4, MD10, MD11, and MD19 are the binding project rules.

## Entry and ownership

Session entry point: `../HANDOFF-ARCH-V11-COMPLETE.md`.
Design-council record: `../.unlazy/design-council-v11/`.
Ownership PLAN location: `../.unlazy/metagui/PLAN.md` dispatch table.
These parent references are optional context outside the app Git root. Standalone clones and CI do not need them.
Use the current portable brief and checked-in contracts; request missing decisions only for work that depends on them.
The parent and global instructions remain intact. Personal owner details stay there.

Release each leaf's globs before edits. Shared/engine ownership remains with its released leaf.
One builder owns a leaf. Design waves have at most three agents; build waves at most two; machine-wide cap is five.
Workers return files, APIs, assumptions, limitations, and unrun parent commands.
The parent owns scratch .unlazy records, gate-check, serial checks, and commits.
Do not start a new builder while an existing builder still owns that slot.

## Local bootstrap and instruction budget

The owner authorized this local framework setup on feat/gap-trap-setup without external publication.
No external issue or PR was created or authorized. Its acceptance record is the parent's local scratch setup record.
This is an explicit local bootstrap exception to P1, not authorization for future feature or bug work without an issue.
Future product work uses P1 and an acceptance-linked PR. Push/publication still needs owner instruction under MD12.

The prior always-loaded instructions measured 485 words. The usual current-plus-half formula rounded to 1000 words.
The unchanged portable core is 844 words, and required project safety rules, five contracts, and loader do not fit the remainder.
The initial setup budget is therefore 3000 combined whitespace-delimited words for AGENTS.md, AGENTS.project.md, and CLAUDE.md.
Record this deliberate initial raise and the measured filled count in the first framework commit; future increases need review.
Detailed facts and practices live in these on-demand playbooks. Never shrink the denominator by deleting a required file.

## Verification and evidence

Run one test/gate/build command at a time under MD19. Inspect raw results and their measured inputs under M2.
Framework builders do not run the parent checks. Parent verifies negative controls, clean restoration, native unit integration,
typecheck, and the full setup gates before claiming installation complete.
Preserve existing warnings as limitations. A runner failure is never test evidence.
Split logical gate commits so each gate and its scratch proof can be assessed independently.
Keep research files outside the framework staging list. Check branch and exact staged paths before each commit.

## Enforcement boundaries

The instruction gate checks immutable template hashes, loader, references, five contract fields, budget, privacy,
rule-ID citations, nonempty source/test scopes, tracked vendor state, tracked runtime state, and changed help mirrors.
It parses JS/TS with the TypeScript compiler AST. Rust/PowerShell keep their existing lifecycle checks and review.
Process syntax and launch import findings enter the ratchet. The existing build-server-bundle.mjs dynamic esbuild import
is a recorded violation of the builtins-only rule, not a new sanctioned exception or a whole-file exemption.
An unresolved process argument/options expression requires review; it does not prove shell use or unsafe arguments.

Semantic ordering, preview expiry, signed claims, tag-whitelist completeness, backup/readback meaning, consent blockers,
credential semantics, and PID identity use existing behavior tests plus explicit independent review.
The scanner does not claim a semantic count for any of those concerns.
The help gate checks paired changed paths, not equivalent wording. Instruction hashes catch accidental drift, not an adversarial edit to the checker itself.
New source aliases through wrappers, re-export chains, reflective properties, or dynamic code require review when the local AST cannot resolve them.
Never conceal a finding by renaming a counter, expanding an exemption, or treating a skipped gate as a pass.
