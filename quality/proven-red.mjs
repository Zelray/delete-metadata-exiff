import path from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { changedPaths, copyFromCommit, createScratch, git, resolveCommit, safePath } from './scratch-worktree.mjs';
import { judge, judgeBaseline } from './red-judge.mjs';
import { isMain, runVitest } from './test-runner.mjs';

export const SKIP_TYPES = ['docs', 'chore', 'ci', 'refactor', 'build', 'style', 'test'];
const unitTest = /^(?:server\/test\/.*\.test\.ts|ui\/src\/.*\.test\.tsx?)$/;
const gateFile = /^(?:quality\/|server\/test\/(?:quality\/|instruction-gate\.test\.ts$)|AGENTS(?:\.project)?\.md$|CLAUDE\.md$|agents\/|eslint\.config\.mjs$|\.quality-baseline\.json$|\.husky\/|\.github\/)/;
const support = /^(?:server\/test\/|ui\/src\/(?:.*\/)?(?:__tests__|test|tests|fixtures)\/)|^ui\/src\/(?:.*\/)?(?:test[-.]?(?:utils|helpers)|setupTests)\.tsx?$|^ui\/src\/.*\.fixtures?\.tsx?$/;
const e2eTest = /^tests-e2e\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/;
const nonCode = /^(?:docs\/|resources\/help\/|.*\.(?:md|rst|txt|png|jpe?g|gif|svg|ico)$|\.gitignore$|\.gitattributes$)/;

export function classify(files, deleted = new Set()) {
  const gateFiles = files.filter((file) => gateFile.test(file));
  const unitTests = files.filter((file) => unitTest.test(file) && !gateFile.test(file) && !deleted.has(file));
  const e2eTests = files.filter((file) => e2eTest.test(file) && !deleted.has(file));
  const testSupport = files.filter((file) => support.test(file) && !unitTest.test(file)
    && !gateFile.test(file) && !deleted.has(file));
  const source = files.filter((file) => !unitTest.test(file) && !support.test(file)
    && !/^tests-e2e\//.test(file) && !nonCode.test(file));
  return { unitTests, e2eTests, testSupport, source, gateFiles };
}

export function skipReason(title, split) {
  if (!split.source.length) return { reason: 'no source file changed', warn: false };
  if (split.source.every((file) => gateFile.test(file)) && !split.unitTests.length) {
    return { reason: 'only framework gate files changed; parent scratch controls supply proof', warn: false };
  }
  if (split.unitTests.length) return null;
  const type = /^([a-z]+)(?:\([^\r\n]*\))?!?:/.exec(title ?? '')?.[1];
  if (SKIP_TYPES.includes(type)) return { reason: `unverified title type ${type} bypasses red proof`, warn: true };
  if (split.e2eTests.length) return { reason: 'only end-to-end tests changed; these require a live server', warn: true };
  return null;
}

function warning(log, text) {
  log(`WARNING: ${text}`);
}

/** Uses committed head tests/support on a real merge-base worktree, file by file. */
export function proveRed({ base, head = 'HEAD', repo, title, dependencyRoot = repo,
  runTests = runVitest, log = console.log }) {
  let scratch;
  let code = 2;
  try {
    const headCommit = resolveCommit(repo, head);
    if (/^0{40,64}$/.test(base)) {
      const parents = git(repo, ['rev-list', '--parents', '-n', '1', headCommit]).trim().split(/\s+/);
      if (parents.length !== 1) throw new Error('Zero BASE is only valid for a root commit with no parent');
      log('WARNING: proven-red: skipped initial root push; no prior commit/fork point exists');
      return 0;
    }
    const baseCommit = resolveCommit(repo, base);
    const forkPoint = git(repo, ['merge-base', baseCommit, headCommit]).trim();
    const { files, deleted } = changedPaths(repo, forkPoint, headCommit);
    const split = classify(files, deleted);
    log(`proven-red: fork-point=${forkPoint} head=${headCommit} changed-paths=${files.length} source-files=${split.source.length} unit-files=${split.unitTests.length} support-files=${split.testSupport.length}`);
    const subject = title ?? git(repo, ['log', '-1', '--format=%s', headCommit]).trim();
    const skip = skipReason(subject, split);
    if (skip) {
      const message = `proven-red: skipped: ${skip.reason}`;
      if (skip.warn) warning(log, message); else log(message);
      return 0;
    }
    if (!split.unitTests.length) {
      log('proven-red: behavior/correctness changed with no live changed unit test (P2)');
      return 1;
    }
    scratch = createScratch({ repo, ref: forkPoint, dependencyRoot, log });
    const oldNames = new Map();
    for (const file of split.unitTests) {
      if (!existsSync(path.join(scratch.root, file))) {
        oldNames.set(file, new Set());
        log(`proven-red: ${file}: absent at fork point; all head tests are new`);
        continue;
      }
      const baseline = judgeBaseline(file, runTests(scratch.root, file, { log }));
      if (baseline.code) throw new Error(`${file}: ${baseline.reason}`);
      oldNames.set(file, baseline.names);
      log(`proven-red: ${file}: baseline passed; old-names=${baseline.names.size}`);
    }
    for (const file of [...split.unitTests, ...split.testSupport]) {
      copyFromCommit(repo, headCommit, scratch.root, file);
    }
    for (const file of deleted) {
      if (support.test(file) && !unitTest.test(file) && !gateFile.test(file)) {
        const destination = safePath(scratch.root, file);
        if (existsSync(destination)) unlinkSync(destination);
      }
    }
    code = 0;
    for (const file of split.unitTests) {
      const verdict = judge(file, runTests(scratch.root, file, { log }), oldNames.get(file));
      for (const message of verdict.warnings) warning(log, message);
      for (const message of verdict.lines) log(message);
      code = Math.max(code, verdict.code);
    }
    log(`proven-red: judged-files=${split.unitTests.length} exit=${code}`);
  } catch (error) {
    log(`proven-red: infrastructure error: ${String(error)}`);
    code = 2;
  } finally {
    if (scratch) {
      try { scratch.cleanup(); log('proven-red: owned scratch worktree removed'); }
      catch (error) { log(`proven-red: cleanup error: ${String(error)}`); code = 2; }
    }
  }
  return code;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const valid = args.length === 0 || args.length === 2 || (args.length === 4 && args[2] === '--title');
  const base = args[0] ?? process.env.BASE;
  const head = args[1] ?? process.env.HEAD;
  if (!valid || !base || !head) {
    console.error('usage: node quality/proven-red.mjs <base> <head> [--title <title>]');
    process.exitCode = 2;
  } else {
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    process.exitCode = proveRed({ repo, base, head, title: args[3] ?? process.env.PR_TITLE });
  }
}
