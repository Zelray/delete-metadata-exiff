# Local quality framework

The quality commands check repository instructions and measured source patterns. Existing findings stay visible in `.quality-baseline.json`. New findings fail even when the total falls. Setup adds no product behavior or translation runtime.

Run commands from the app Git root, one at a time. These commands need locked dependencies installed. The combined runner also requires Windows, Node 22+ and the vendored `vendor/exiftool/exiftool.exe`. The lifecycle verifier requires this clone to sit in a directory named `app` inside a parent directory.

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

The tests cover count rise/deletion/slack, broken counters, only-lowering updates, duplicate and replacement identities, per-file length growth, language scanners, mock/assertion/wait controls, installed lint options and parser failures. The normal server suite discovers them through its existing configuration.

## Combined gates

```powershell
npm run gates
node quality/gates.mjs --control
node --test --test-concurrency=1 quality/gates.test.mjs quality/pr-body.test.mjs
```

`gates.mjs` checks the actual platform, Node version and vendored executable before starting. Its eight steps run in order: server unit tests, UI unit tests, framework Node tests, workspace typechecks, workspace builds, instruction, ratchet and lifecycle static verification. Each step starts only after the preceding step exits zero. The first failure stops the plan. Successful completion prints `GATES_OK`.

Server and UI tests invoke the installed Vitest JavaScript entry directly with their own workspace as the working directory. Framework tests use Node's test runner with concurrency one. Typecheck and build invoke `process.execPath` with the installed `npm-cli.js`; npm runs workspaces in order. There is one lint measurement, inside ratchet. Mutation smoke is separate because it measures committed Git HEAD in scratch worktrees. The combined command does not launch desktop verification or the browser end-to-end matrix.

Each child has an argv array, explicit `shell: false`, inherited stdout/stderr and a ten-minute timeout. Ordinary nonzero exits propagate. Spawn errors, signals and missing exit statuses return 2. The runner preserves each verifier's raw output, including lifecycle caveats. The lifecycle check is static; its named C6 gap and C8 static-only scope still need the existing behavior checks and review.

`createPlan(options)` returns `{ name, command, args, cwd }` steps. `runPlan(plan, { execute, log })` executes them serially; tests inject a synchronous executor. `assertEnvironment(options)` and `resolveNpmCli(options)` expose their inputs for guard tests. These seams let plan tests run without a production ratchet baseline. The real `--control` command runs a scratch Node driver: exit 17 must prevent a later sentinel write, and restoring exit zero must produce that write. It removes only the temporary directory it created.

## Local pre-commit hook

Review `.husky/pre-commit` and `quality/pre-commit.mjs` before installing hooks. With locked dependencies present, run from the app Git root:

```powershell
npm run hooks:control
npm run prepare
```

The tracked hook contains `node quality/pre-commit.mjs`. Husky 9 supplies its small POSIX shim; local command entry remains PowerShell. `createPreCommitPlan(root, node)` selects only instruction then ratchet. `runPreCommit(options)` uses the serial runner, and either child's failure refuses the commit. It does not run full tests or mutation smoke at commit time. Run the relevant checks before committing under P3.

`prepare` calls the installed official Husky 9 API through `pre-commit.mjs --install`. It checks the app working directory and Git root, refuses an existing hook path other than `.husky/_`, validates Husky's returned diagnostic and verifies the resulting local hook path. Husky uses a native Git argv call without enabling a shell. No dependency or custom shim implementation is added. The dependency is already pinned in the lockfile; adding a prepare script requires no dependency resolution change.

GitHub Actions sets `CI=true`. In that ephemeral checkout, prepare prints a skip diagnostic before touching Git hooks. This is the only automated hook-install skip in these commands. A local installation needs Git, Node on the hook's PATH and the full dev dependencies. A custom global or repository hook path must be reviewed before replacement. This workflow does not install global hooks or alter global Git configuration.

`hook-control.mjs` creates an owned Git repository, copies the actual hook and runner, and copies the installed Husky package. It installs Husky there with the actual prepare helper. Harmless instruction and ratchet payloads record their execution and return controlled failures. The control requires each bad commit to be refused, verifies no HEAD was created, then requires a restored commit with the exact expected history. It isolates Git configuration and Husky startup files, clears inherited hook bypass settings for this scratch process, and never bypasses the product hook. Success prints `hook-control: PASS`. Cleanup removes only its owned scratch directory.

To remove this clone's installation after confirming `.husky/_` is the effective path:

```powershell
git config --local --get core.hooksPath
git config --local --unset core.hooksPath
```

An inherited hook path becomes effective again when the local value is removed. Review it before committing. Generated `.husky/_` files are disposable; the tracked `.husky/pre-commit` remains available for reinstall. Hook installation and the control need local verification before their results can be relied on.

## Proven red and mutation smoke

```powershell
$env:BASE = '<existing base commit>'
$env:HEAD = '<committed head>'
$env:PR_TITLE = 'fix: describe the behavior change'
npm run test:proven-red
npm run test:mutation
```

The values above are inputs to supply for the range being reviewed. The proven-red CLI reads `BASE`, `HEAD` and `PR_TITLE`; positional base/head with optional `--title` remains available. It resolves both commits, computes their real merge base, checks old tests there, then runs committed head tests and support files against that old code. Missing-symbol failures are reported separately from assertion failures. Collection, setup, timeout and process failures cannot count as assertion proof. Clear task-specific environment variables when finished with a local range.

Documentation and framework-only ranges can skip proven red with a diagnostic. A conventional maintenance title can skip a source range with no changed product unit tests, with a warning. Root manifests remain source changes. This framework bootstrap is maintenance work and uses an explicit `chore: setup framework` title for range verification. That warned skip is not red proof. Changed product unit tests still take the real proof path, including for maintenance titles. A feature changing a root manifest still needs tests or fails P2.

Mutation smoke uses committed HEAD and runs each clean/mutant pair serially in an owned worktree. Only an assertion failure in the same selected tests kills a mutant. A survivor is failure; an infrastructure error is not a kill. Uncommitted product edits are not measured by this command. These commands remove their owned worktrees and leave the product working tree alone.

## Pull requests and Windows CI

The PR template has Acceptance and Spec sections. Fill Acceptance with the user's issue acceptance lines or a link to the exact section. For a `feat` title, link the spec or explain its absence. Template comments alone do not satisfy either section. `quality/pr-body.mjs` accepts `PR_TITLE` and `PR_BODY` through the environment, or body text through `--stdin`. It checks section content; reviewers still check whether the content matches the issue and whether the evidence supports it.

`.github/workflows/quality.yml` runs on push and PR updates. The `Windows gates` job checks out the actual head into `app` with full history, installs locked dependencies on Windows with Node 22, then runs combined gates, proven red and mutation smoke serially. The action references are immutable v4 SHAs supplied after upstream verification. Each clone keeps the parent/app layout required by lifecycle verification. PR base/head/title and instruction range inputs arrive through environment variables. PR text is never inserted into executable shell text.

An initial push with an all-zero before SHA has no base commit. CI prints a warning, clears the instruction range base and skips only proven red for that push. Other missing or invalid references fail normally. A PR always requires its base. The `PR acceptance` job runs after gates for same-repository PRs whose author is not a bot. It uses environment-only title/body inputs and the actual PR head. Fork and bot PRs skip that body job; they still run Windows gates.

The workflow has only `contents: read`, uses no secrets, and performs no publishing, pushes or branch-protection changes. It has not been run remotely. After a real CI run confirms the behavior, the candidate required-check names are `Windows gates` and `PR acceptance`. No branch protection is configured by this setup; the conditional PR check needs a maintainer policy before being made required.
