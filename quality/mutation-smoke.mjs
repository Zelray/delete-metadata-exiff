import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScratch, safePath } from './scratch-worktree.mjs';
import { classifyFailures } from './red-judge.mjs';
import { isMain, resultFor, runVitest, validateRun } from './test-runner.mjs';
import { applyMutation, MUTATIONS } from './mutations.mjs';

export function judgeMutation(target, clean, mutant) {
  const fail = (code, reason) => ({ code, reason });
  const cleanProblem = validateRun(clean, target.test);
  const cleanFile = resultFor(clean.fileResults, target.test);
  if (cleanProblem || clean.code !== 0 || !cleanFile || cleanFile.status !== 'passed') {
    return fail(2, `clean selected test failed: ${cleanProblem ?? 'not passed'}`);
  }
  const selected = cleanFile.tests.filter((test) => ['passed', 'failed'].includes(test.status));
  if (!selected.length || selected.some((test) => test.status !== 'passed')) {
    return fail(2, 'clean selection did not execute a passing test');
  }
  const problem = validateRun(mutant, target.test);
  if (problem) return fail(2, problem);
  const file = resultFor(mutant.fileResults, target.test);
  if (file.message) return fail(2, 'mutant failed during collection/setup');
  const active = file.tests.filter((test) => ['passed', 'failed'].includes(test.status));
  const names = new Set(selected.map((test) => test.name));
  if (active.length !== selected.length || active.some((test) => !names.has(test.name))
    || selected.some((test) => !active.some((other) => other.name === test.name))) {
    return fail(2, 'mutant did not execute the same selected tests as the clean control');
  }
  const failures = active.filter((test) => test.status === 'failed');
  if (mutant.code === 0 && !failures.length) return fail(1, 'survived: selected tests still pass');
  let assertions = 0;
  for (const test of failures) {
    const kinds = classifyFailures(test.messages);
    if (!test.messages.length || kinds.other || kinds.missing || !kinds.assertions) {
      return fail(2, `mutant failed without assertion proof: ${test.name}`);
    }
    assertions += kinds.assertions;
  }
  return assertions ? { code: 0, reason: `killed: selected-tests=${selected.length} assertion-failures=${assertions}` }
    : fail(2, 'mutant has no selected assertion failure');
}

/** Each clean/mutant pair runs serially in committed HEAD, never the working app. */
export function mutationSmoke({ repo, ref = 'HEAD', dependencyRoot = repo,
  targets = MUTATIONS, runTests = runVitest, log = console.log }) {
  let scratch;
  let code = 2;
  let killed = 0;
  try {
    if (!targets.length || new Set(targets.map((target) => target.id)).size !== targets.length) {
      throw new Error('Mutation target denominator must be nonempty and IDs unique');
    }
    scratch = createScratch({ repo, ref, dependencyRoot, log });
    code = 0;
    for (const target of targets) {
      const destination = safePath(scratch.root, target.file);
      const original = readFileSync(destination, 'utf8');
      const modified = applyMutation(original, target);
      const hash = createHash('sha256').update(original).digest('hex');
      log(`mutation-smoke: target=${target.id} file=${target.file} original-sha256=${hash} anchor-occurrences=1 test=${target.test} selection=${target.testName}`);
      const options = { testName: target.testName, log };
      const clean = runTests(scratch.root, target.test, options);
      const cleanProblem = validateRun(clean, target.test);
      const cleanFile = resultFor(clean.fileResults, target.test);
      if (cleanProblem || clean.code !== 0 || !cleanFile
        || !cleanFile.tests.some((test) => test.status === 'passed')) {
        log(`mutation-smoke: ${target.id}: infrastructure error: clean selection failed (${cleanProblem ?? 'no passing selected test'})`);
        code = 2;
        break;
      }
      let verdict;
      let mutationError;
      let restorationError;
      try {
        writeFileSync(destination, modified);
        verdict = judgeMutation(target, clean, runTests(scratch.root, target.test, options));
      } catch (error) { mutationError = error; }
      finally {
        try {
          writeFileSync(destination, original);
          if (readFileSync(destination, 'utf8') !== original) restorationError = new Error(`Could not restore ${target.id}`);
        } catch (error) { restorationError = error; }
      }
      if (mutationError || restorationError) {
        throw new AggregateError([mutationError, restorationError].filter(Boolean), `${target.id}: mutation/restoration failed`);
      }
      log(`mutation-smoke: ${target.id}: ${verdict.reason}`);
      if (!verdict.code) killed++;
      code = Math.max(code, verdict.code);
      if (code === 2) break;
    }
    log(`mutation-smoke: killed=${killed}/${targets.length} exit=${code}`);
  } catch (error) {
    log(`mutation-smoke: infrastructure error: ${String(error)}`);
    code = 2;
  } finally {
    if (scratch) {
      try { scratch.cleanup(); log('mutation-smoke: owned scratch worktree removed'); }
      catch (error) { log(`mutation-smoke: cleanup error: ${String(error)}`); code = 2; }
    }
  }
  return code;
}

if (isMain(import.meta.url)) {
  if (process.argv.length !== 2) {
    console.error('usage: node quality/mutation-smoke.mjs');
    process.exitCode = 2;
  } else {
    process.exitCode = mutationSmoke({ repo: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') });
  }
}
