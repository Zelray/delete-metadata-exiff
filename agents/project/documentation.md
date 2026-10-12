# Documentation playbook

Read before user docs, developer docs, or a handoff. Rule P10 and MD15 govern prose.
Use slop-mop in this harness; it is already installed outside the repo.

## Documents by function

`STATUS.md` = one-glance chart only, no handoffs.
`HANDOFF.md` = deep technical handoff, kept current as work happens.
`CLAUDE.md` = this file's instruction loader; binding rules live in AGENTS.md and AGENTS.project.md.
`README.md` = reader-facing plain English.

The contract-of-record pointer is in agents/project/domain-context.md.
Preserve detailed records and explain completed work, remaining uncertainty, verification output, and the next step.
Refer to real symbols and source paths. Describe behavior through inputs, outputs, and consequences.
Examples must exist in source unless explicitly marked simplified.

## Product help

User-facing strings follow the ux-spec tone: plain English, honest about limits, no false success.
Rule MD9 owns detect-only wording. Rule MD8 owns the two help mirrors:
resources/help/metadesk-help.md and ui/src/shell/HelpOverlay.tsx.
The instruction gate accepts a clean baseline and changes touching both files; it rejects a single changed mirror or deletion.
It checks changed paths across HEAD, index, worktree, untracked files, and an optional CI range.
Content agreement and truthful success/error wording still require review.

## Developer records

New APIs, components, services, hooks, or utilities need their interface and call flow documented.
Update the existing journey trace when behavior changes. Add a trace only for a main journey missing one.
Docs cite rule IDs or contract names rather than copying binding rule text.
Keep claims tied to source evidence and existing commits. Never turn a skipped check into a passing result.
Public instructions omit personal names, machine paths, addresses, credentials, and private deployment context.
The ancestor/global owner instructions remain outside this migration and continue to govern that private context.
