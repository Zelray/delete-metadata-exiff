import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertEnvironment, childCode, createPlan, resolveNpmCli, runControl, runPlan, STEP_TIMEOUT_MS } from './gates.mjs';
import { createPreCommitPlan, installHooks, runPreCommit } from './pre-commit.mjs';

const root = path.resolve('owned gates fixture');
const node = path.join(root, 'node.exe');
const npmCli = path.join(root, 'npm-cli.js');
const quiet = () => {};
const planned = () => createPlan({ root, node, npmCli, frameworkTests: ['gates.test.mjs', 'pr-body.test.mjs'] });

test('plan covers the required eight steps with workspace cwd and direct Node argv', () => {
  const plan = planned();
  assert.deepEqual(plan.map((step) => step.name), ['server unit tests', 'UI unit tests', 'framework Node tests',
    'workspace typecheck', 'workspace build', 'instruction gate', 'quality ratchet', 'lifecycle static verification']);
  assert.deepEqual(plan.map((step) => step.cwd), [path.join(root, 'server'), path.join(root, 'ui'), root, root, root, root, root, root]);
  assert.deepEqual(plan.map((step) => step.command), Array(8).fill(node));
  const vitest = path.join(root, 'node_modules/vitest/vitest.mjs');
  assert.deepEqual(plan[0].args, [vitest, 'run', '--maxWorkers=1', '--fileParallelism=false']);
  assert.deepEqual(plan[1].args, plan[0].args);
  assert.deepEqual(plan[2].args, ['--test', '--test-concurrency=1', path.join(root, 'quality/gates.test.mjs'), path.join(root, 'quality/pr-body.test.mjs')]);
  assert.deepEqual(plan[3].args, [npmCli, '--workspaces', '--if-present', 'run', 'typecheck']);
  assert.deepEqual(plan[4].args, [npmCli, 'run', 'build']);
  assert.deepEqual(plan.slice(5).map((step) => step.args), [[path.join(root, 'quality/instruction.mjs')],
    [path.join(root, 'quality/ratchet.mjs')], [path.join(root, 'scripts/verify-lifecycle-contract.mjs')]]);
});

test('plan rejects an empty framework test denominator and paths outside quality', () => {
  assert.throws(() => createPlan({ root, node, npmCli, frameworkTests: [] }), /inventory is empty/);
  assert.throws(() => createPlan({ root, node, npmCli, frameworkTests: ['../other.test.mjs'] }), /basenames/);
});

test('executor receives one synchronous child at a time, raw stdio, no shell and finite timeout', () => {
  const calls = [];
  const code = runPlan(planned(), { log: quiet, execute: (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, signal: null };
  } });
  assert.equal(code, 0);
  assert.deepEqual(calls.map((call) => call.args), planned().map((step) => step.args));
  assert.deepEqual(calls.map((call) => call.options), planned().map((step) => ({
    cwd: step.cwd, shell: false, windowsHide: true, stdio: 'inherit', timeout: STEP_TIMEOUT_MS,
  })));
});

test('every failed step propagates its status and prevents every later step', () => {
  const plan = planned();
  for (let failure = 0; failure < plan.length; failure++) {
    const called = [];
    const code = runPlan(plan, { log: quiet, execute: (command, args) => {
      called.push({ command, args });
      return { status: called.length === failure + 1 ? 17 : 0 };
    } });
    assert.equal(code, 17);
    assert.deepEqual(called.map((call) => call.args), plan.slice(0, failure + 1).map((step) => step.args));
  }
});

test('signals, spawn errors, invalid outcomes and thrown executors fail without later children', () => {
  for (const outcome of [{ status: null, signal: 'SIGTERM' }, { status: 0, error: new Error('spawn failed') },
    { status: null }, { status: -1 }, {}, undefined]) {
    let count = 0;
    assert.equal(runPlan(planned(), { log: quiet, execute: () => { count++; return outcome; } }), 2);
    assert.equal(count, 1);
  }
  let count = 0;
  assert.equal(runPlan(planned(), { log: quiet, execute: () => { count++; throw new Error('executor failed'); } }), 2);
  assert.equal(count, 1);
  assert.equal(childCode({ status: 23 }), 23);
});

test('empty or malformed plans cannot report success', () => {
  assert.throws(() => runPlan([], { log: quiet }), /empty/);
  assert.throws(() => runPlan([{ name: 'bad', command: node, args: 'one string', cwd: root }], { log: quiet }), /argv/);
  assert.throws(() => runPlan([{ name: 'bad', command: node, args: [], cwd: 'relative' }], { log: quiet }), /absolute cwd/);
});

test('platform guard uses actual platform and version inputs and the exact vendored executable', () => {
  const probed = [];
  assert.equal(assertEnvironment({ root, platform: 'win32', version: '22.0.0', fileExists: (name) => { probed.push(name); return true; } }), undefined);
  assert.deepEqual(probed, [path.join(root, 'vendor/exiftool/exiftool.exe')]);
  assert.throws(() => assertEnvironment({ root, platform: 'linux', version: '22.0.0', fileExists: () => true }), /actual platform is linux/);
  assert.throws(() => assertEnvironment({ root, platform: 'win32', version: '21.9.0', fileExists: () => true }), /actual version is 21.9.0/);
  assert.throws(() => assertEnvironment({ root, platform: 'win32', version: 'unknown', fileExists: () => true }), /Node 22/);
  assert.throws(() => assertEnvironment({ root, platform: 'win32', version: '24.0.0', fileExists: () => false }), /Vendored ExifTool executable is missing/);
});

test('npm resolution selects a real npm-cli.js instead of a Windows command shim', () => {
  const bundled = path.join(root, 'node_modules/npm/bin/npm-cli.js');
  assert.equal(resolveNpmCli({ node, env: { npm_execpath: npmCli }, fileExists: (name) => name === npmCli }), npmCli);
  assert.equal(resolveNpmCli({ node, env: { npm_execpath: path.join(root, 'npm.cmd') }, fileExists: (name) => name === bundled }), bundled);
  assert.throws(() => resolveNpmCli({ node, env: {}, fileExists: () => false }), /Cannot locate npm-cli.js/);
});

test('pre-commit runs only instruction then ratchet and preserves the failure exit', () => {
  assert.deepEqual(createPreCommitPlan(root, node).map((step) => step.args),
    [[path.join(root, 'quality/instruction.mjs')], [path.join(root, 'quality/ratchet.mjs')]]);
  const calls = [];
  assert.equal(runPreCommit({ root, node, log: quiet, execute: (command, args) => {
    calls.push({ command, args }); return { status: 19 };
  } }), 19);
  assert.deepEqual(calls, [{ command: node, args: [path.join(root, 'quality/instruction.mjs')] }]);
});

test('prepare in CI skips the installer and Git with an explicit diagnostic', async () => {
  const messages = [];
  const forbidden = () => { throw new Error('CI touched local hooks'); };
  assert.equal(await installHooks({ root: '/absent', cwd: '/absent', env: { CI: 'true' },
    execute: forbidden, loadInstaller: forbidden, log: (message) => messages.push(message) }), 0);
  assert.deepEqual(messages, ['prepare: CI=true; skipped local Husky installation']);
});

function installerFixture(body) {
  const owned = mkdtempSync(path.join(tmpdir(), 'metadesk-prepare-unit-'));
  mkdirSync(path.join(owned, '.git'));
  mkdirSync(path.join(owned, '.husky'));
  writeFileSync(path.join(owned, '.husky/pre-commit'), 'node quality/pre-commit.mjs\n');
  return Promise.resolve().then(() => body(owned)).finally(() => rmSync(owned, { recursive: true, force: true }));
}

test('prepare validates official installer output and the effective hook configuration', () => installerFixture(async (owned) => {
  let installed = false;
  const calls = [];
  const execute = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === 'rev-parse') return { status: 0, stdout: `${owned}\n` };
    return installed ? { status: 0, stdout: '.husky/_\n' } : { status: 1, stdout: '' };
  };
  const loadInstaller = async () => () => {
    installed = true;
    mkdirSync(path.join(owned, '.husky/_'));
    writeFileSync(path.join(owned, '.husky/_/pre-commit'), 'owned installer fixture');
    return '';
  };
  assert.equal(await installHooks({ root: owned, cwd: owned, env: {}, execute, loadInstaller, log: quiet }), 0);
  assert.deepEqual(calls.map((call) => [call.command, call.args]), [['git', ['rev-parse', '--show-toplevel']],
    ['git', ['config', '--get', 'core.hooksPath']], ['git', ['config', '--get', 'core.hooksPath']]]);
  assert.deepEqual(calls[0].options, { cwd: owned, shell: false, windowsHide: true, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'], timeout: 120_000 });
}));

test('prepare refuses a custom hook path and a nonempty Husky installation diagnostic', () => installerFixture(async (owned) => {
  let loaded = 0;
  const custom = (command, args) => ({ status: 0, stdout: args[0] === 'rev-parse' ? owned : '.other-hooks' });
  await assert.rejects(installHooks({ root: owned, cwd: owned, env: {}, execute: custom,
    loadInstaller: async () => { loaded++; }, log: quiet }), /refuses to replace/);
  assert.equal(loaded, 0);
  const missing = (command, args) => args[0] === 'rev-parse' ? { status: 0, stdout: owned } : { status: 1, stdout: '' };
  await assert.rejects(installHooks({ root: owned, cwd: owned, env: {}, execute: missing,
    loadInstaller: async () => () => 'git command not found', log: quiet }), /did not complete: git command not found/);
}));

test('real CLI negative control preserves exit 17 and proves later execution after restoration', () => {
  const messages = [];
  assert.equal(runControl((message) => messages.push(message)), 0);
  assert.deepEqual(messages, ['gates-control: PASS; exit 17 prevented later execution; restored control ran both steps']);
});
