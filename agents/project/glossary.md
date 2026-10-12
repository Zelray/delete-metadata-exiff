# Glossary

Read before naming code, writing briefs, or proposing work. Use one name per concept.

## Process

Contract: an architecture block in AGENTS.project.md naming owner, path, forbidden bypass, and gate.
Gate: a command that fails when its measured rule breaks.
Brief: the requirements and released ownership for one task.
Spec: the approved product/design requirements before implementation.
Seam: the interface exercised by a test.
Proven red: a changed test that fails against the pre-change code.
Ratchet: a stored backlog measurement that can hold or fall, with reviewed evidence for increases.

## Metadata

ExifTool: the vendored metadata engine. Its tracked bytes are protected under MD1.
Preview: server-generated plan required before a write.
Journal: durable records of a batch and its recovery information.
Readback: reading metadata after a write to verify the actual result.
Write run: the transient UI execution state coordinated by useWriteRunner.
Detect-only: metadata the product can identify but cannot remove. Rule MD9 governs user wording.
Portfile: the server-owned runtime record of the server PID and endpoint.
Launcher: the owner of local startup and teardown; it is distinct from the server child.
