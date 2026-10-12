# Local quality framework

The quality commands check repository instructions and measured source patterns. Existing findings stay visible in `.quality-baseline.json`. New findings fail even when the total falls. Setup adds no product behavior or translation runtime.

Run commands from the app Git root, one at a time. The setup parent owns installation, initial baseline creation, verification and commits. This builder wrote the ratchet and controls without executing tests, builds or gates. Successful verification must be recorded by the parent before the framework is committed.

## Ratchet commands

```powershell
node quality/ratchet.mjs --update --init
node quality/ratchet.mjs
node quality/ratchet.mjs --report
node quality/ratchet.mjs --update
node quality/ratchet-control.mjs
```

`--update --init` creates a missing baseline once. It refuses an existing file, malformed JSON, missing dependencies, disabled required rules, parser failures and empty required inventories. Review the measured backlog before committing the seed. Later `--update` only lowers counts, finding allowances and oversized-file allowances. It removes fingerprints for findings that disappeared. A deliberately raised allowance needs the reviewed reason required by C7.

The default check prints denominators, nonzero totals by rule, oversized files and failures. `--report` also prints every finding with its file, line and evidence, plus counts by file and rule. Exit 0 means the comparison passed. Exit 1 means a count, finding identity, file length or stale allowance failed. Exit 2 means the gate could not measure or read its configuration; it is never evidence of a clean backlog.

The baseline has `version: 1`, `counts`, `findings` and `lengths`. Counts include `filesOverLength`, `rule:<rule>` and `file:<JSON [path, rule]>`. Every baseline counter is checked, including names absent from the current configuration. A baseline more than five above a measured count fails until lowered. Per-file finding counters remain at zero after their findings disappear.

Finding keys contain `[path, rule, SHA256(normalized AST source/context)]`. Their values are occurrence counts, so identical defects occurring twice consume two allowances. Line numbers are diagnostic evidence, not identity. Changing the offending text or context creates a new finding even if the rule total stays unchanged. Comments and whitespace between tokens are excluded; literal contents remain significant.

`lengths` initially records oversized files only. Each existing oversized file may hold or shrink; its allowance shrinks on update. A new file has a 399-code-line ceiling. Replacing one oversized file with another, growing an old oversized file, or restoring a removed oversized file above the current ceiling fails independently of the aggregate count.

## What gets measured

The shared inventory covers production code in `server/src`, `ui/src`, `shared/src`, `bin`, `scripts` and `tauri/src-tauri/src`. It also supplies server, UI and end-to-end test files. Missing required scopes or known entry points fail. Generated outputs, dependencies, vendored engine files, runtime state and declared fixture directories are excluded.

C2 counts production files, `quality` code and the ESLint configuration. Test fixture and unit/end-to-end files are outside this length counter. JavaScript and TypeScript use compiler tokens to exclude comments and blank lines while preserving JSX, regex and string contents. Their compiler line map recognizes LF, CR, CRLF, U+2028 and U+2029. Rust and PowerShell use explicit lexical scanners for their comments and strings. Rust uses LF/CRLF boundaries, including for line comments; bare CR and Unicode separators do not create Rust source lines. Its scanner handles nested block comments, raw strings, character literals and lifetimes. PowerShell recognizes LF, CR and CRLF in line comments, source lines and here-strings; it does not adopt JavaScript's Unicode line boundaries. Its scanner also handles block comments, quotes and escapes. These two scanners approximate lexical structure; they do not compile those languages. Unsupported languages and unterminated comments or strings fail instead of returning zero.

ESLint runs recommended JavaScript and TypeScript correctness rules without type-aware linting, plus recommended JSX accessibility rules on production UI TSX. TypeScript checks undeclared names through its own compiler. JavaScript uses explicit Node globals; browser globals are scoped to end-to-end files for Playwright callbacks. Correctness lint includes test files and new framework code. Inline source directives cannot suppress findings, and the gate never autofixes source.

C3 uses the installed i18next rule with explicit React, JSX-only and template validation options. Default word and component exclusions are cleared. Additional syntax selectors cover direct strings and templates in label, hint, title, description, message, placeholder, alternative/accessibility text, confirmation labels and known toast/dialog calls. Tests are excluded from copy and accessibility rules. Only `ui/src/copy.ts` is exempt from production copy checks; setup does not create an empty resource file. The app currently has English only. On the first text change, introduce that resource file for the affected copy and review all supported locales together.

Copy checks cannot establish that every string reaching a screen was centralized. Indirect variables, arbitrary helper calls, aliases, data-driven messages, dynamically composed text and locale completeness still need review. Accessibility findings also need context; a syntactic warning alone does not prove a user-visible defect.

C6 checks supported AST patterns: calls mocking production modules through Vitest `vi.mock`, including imported aliases and known workspace/UI aliases; positive `toBeDefined`, `toBeTruthy` and `toBeInTheDocument`; explicit Boolean coercions asserted true; and `waitForTimeout` calls in end-to-end files. The legacy `internalMockFiles` counter name now counts mock-call occurrences, not files. Every call has a fingerprint, so adding a second mock, replacing a later mock or repeating an identical mock consumes a separate allowance. Negated assertions, expected null/false and ordinary domain predicates asserted true are excluded. These are measured weak patterns, not a judgment on every assertion. Dynamic module paths, unconfigured aliases and other assertion styles need review. Existing core tests are not rewritten by setup.

Contract findings come from the shared contract scanner. Process execution findings and existing non-builtin launch-script imports enter the ratchet. Indirect argv/options are unresolved syntax requiring review, not proved unsafe behavior. UI transport, write bypass, persisted state and parse findings remain clean instruction checks. Preview validity, journal ordering, readback meaning, process ownership and semantic lifecycle behavior rely on behavior tests and review; there are no guessed counters for them.

## Controls and native tests

`node quality/ratchet-control.mjs` owns a temporary directory and removes it in `finally`. It exercises the CLI against a scratch source inventory and scratch baseline. Controls require the intended status and matching diagnostic for raw JSX, refused updates, equal-count finding replacement, second-mock growth and replacement, restored inputs, retired counters, stale slack, corrupt JSON, syntax failure and oversized-file growth, including standalone-CR source lines. Infrastructure failures cannot satisfy a defect control. Product source and the product baseline are never mutated.

For individual inspection, the CLI accepts `--baseline <path> --fixture-root <directory>`. Fixture mode requires an explicit scratch baseline and rejects the product baseline or product root. It uses the installed flat configuration with virtual lint input. Fixture mode is for owned controls only; it bypasses the production inventory completeness checks and must not replace the normal commit gate.

Native tests live in `server/test/quality/ratchet.test.ts`. From the server workspace, the parent can run the focused suite with:

```powershell
node ../node_modules/vitest/vitest.mjs run test/quality/ratchet.test.ts
```

The tests cover count rise/deletion/slack, broken counters, only-lowering updates, duplicate and replacement identities, per-file length growth, language scanners, mock/assertion/wait controls, installed lint options and parser failures. The normal server suite discovers them through its existing configuration. The parent wires the combined serial command, pre-commit hook and CI separately, and records their verification after execution.
