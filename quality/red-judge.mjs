import { resultFor, validateRun } from './test-runner.mjs';

const firstLine = (message) => message.trim().split(/\r?\n/)[0] ?? '';
const missingReference = /(?:Cannot find (?:module|package)|Failed to resolve import|does not provide an export|has no exported member|is not (?:defined|a function|a constructor))/;
const assertion = /^(?:AssertionError(?:\s*\[ERR_ASSERTION\])?:|Error: expect\(|Error: Snapshot .*mismatch)/;
// Vitest replaces the .rejects/.resolves Error stack message with its assertion
// message, retaining the Error prefix. The quoted value may span several lines.
const promiseAssertion = /^Error: promise (?:resolved "[\s\S]*" instead of rejecting|rejected "[\s\S]*" instead of resolving)$/;
const verdictHeader = (message) => message.trim().split(/\r?\n\s+at\s/)[0];

/** Only runner verdict messages, never echoed source or console output, supply proof. */
export function classifyFailures(messages) {
  let assertions = 0;
  let missing = 0;
  let other = 0;
  let sample;
  for (const message of messages) {
    const headline = firstLine(message);
    if (assertion.test(headline) || promiseAssertion.test(verdictHeader(message))) assertions++;
    else if (missingReference.test(headline)
      && (!/SyntaxError|Transform failed|ParseError/.test(headline)
        || /^SyntaxError:.*does not provide an export/.test(headline))) {
      missing++;
      sample ??= headline;
    } else other++;
  }
  return { assertions, missing, other, sample };
}

export function judgeBaseline(file, run) {
  const problem = validateRun(run, file);
  const result = resultFor(run.fileResults, file);
  if (problem || run.code !== 0 || !result || result.status !== 'passed'
    || !result.tests.some((test) => test.status === 'passed')) {
    return { code: 2, names: new Set(), reason: problem ?? 'fork-point test baseline did not pass with executed tests' };
  }
  return { code: 0, names: new Set(result.tests.map((test) => test.name)), reason: '' };
}

/** A passing new sibling is rejected even when the same file has assertion red. */
export function judge(file, run, oldNames = new Set()) {
  const lines = [];
  const warnings = [];
  const fail = (code, reason) => ({ code, lines: [`proven-red: ${file}: ${reason}`], warnings });
  const problem = validateRun(run, file);
  if (problem) return fail(2, problem);
  const result = resultFor(run.fileResults, file);
  const active = result.tests.filter((test) => ['passed', 'failed'].includes(test.status));
  const pendingNew = result.tests.filter((test) => !oldNames.has(test.name)
    && ['skipped', 'todo', 'disabled'].includes(test.status));
  if (pendingNew.length) return fail(1, `new tests were not executed: ${pendingNew.map((test) => test.name).join(', ')}`);
  if (result.status === 'passed') return fail(1, active.length
    ? 'changed tests pass on pre-change code' : 'skipped/todo-only file supplies no red proof');
  const newGreen = active.filter((test) => test.status === 'passed' && !oldNames.has(test.name));
  if (newGreen.length) return fail(1, `new tests pass on pre-change code: ${newGreen.map((test) => test.name).join(', ')}`);
  let assertions = 0;
  let missing = 0;
  let sample;
  for (const test of active.filter((test) => test.status === 'failed')) {
    const kinds = classifyFailures(test.messages);
    if (!test.messages.length || kinds.other) return fail(2, `non-assertion failure in ${test.name}`);
    assertions += kinds.assertions;
    missing += kinds.missing;
    sample ??= kinds.sample;
  }
  if (result.message) {
    const kinds = classifyFailures([result.message]);
    // Collection/hook errors cannot be assertion evidence for a test body.
    if (kinds.other || kinds.assertions) return fail(2, 'collection/setup failure is not test assertion proof');
    missing += kinds.missing;
    sample ??= kinds.sample;
  }
  if (assertions + missing === 0) return fail(2, 'failed file has no classified failure verdict');
  if (!assertions && missing) warnings.push(
    `proven-red: ${file} is red only by missing reference (${sample}); review assertion strength or run mutation smoke.`,
  );
  lines.push(`proven-red: ${file}: assertion-failures=${assertions} missing-references=${missing} executed-tests=${active.length} old-names=${oldNames.size}`);
  return { code: 0, lines, warnings };
}
