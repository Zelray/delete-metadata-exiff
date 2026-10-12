import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STEP_TIMEOUT_MS = 600_000;
const isFile = (name) => {
  try { return statSync(name).isFile(); } catch { return false; }
};

export function assertEnvironment({ root = ROOT, platform = process.platform,
  version = process.versions.node, fileExists = isFile } = {}) {
  if (platform !== 'win32') throw new Error(`MetaDesk gates require Windows; actual platform is ${platform}`);
  const major = /^(\d+)\./.exec(version)?.[1];
  if (!major || Number(major) < 22) throw new Error(`MetaDesk gates require Node 22+; actual version is ${version}`);
  const engine = path.join(root, 'vendor', 'exiftool', 'exiftool.exe');
  if (!fileExists(engine)) throw new Error(`Vendored ExifTool executable is missing: ${engine}`);
}

export function resolveNpmCli({ node = process.execPath, env = process.env, fileExists = isFile } = {}) {
  const candidates = [env.npm_execpath, path.join(path.dirname(node), 'node_modules/npm/bin/npm-cli.js')];
  const found = candidates.find((name) => name && path.basename(name) === 'npm-cli.js' && fileExists(name));
  if (!found) throw new Error('Cannot locate npm-cli.js; run npm run gates with the installed Node 22+ toolchain');
  return path.resolve(found);
}

/** Every workspace runner has its own cwd; npm is always a Node script. */
export function createPlan({ root = ROOT, node = process.execPath, npmCli = resolveNpmCli(),
  frameworkTests = readdirSync(path.join(root, 'quality')).filter((name) => name.endsWith('.test.mjs')).sort() } = {}) {
  if (!frameworkTests.length) throw new Error('Framework Node test inventory is empty');
  if (frameworkTests.some((name) => path.basename(name) !== name || !name.endsWith('.test.mjs'))) {
    throw new Error('Framework tests must be quality/*.test.mjs basenames');
  }
  const step = (name, cwd, args) => ({ name, command: node, args, cwd });
  const vitest = path.join(root, 'node_modules/vitest/vitest.mjs');
  return [
    step('server unit tests', path.join(root, 'server'), [vitest, 'run', '--maxWorkers=1', '--fileParallelism=false']),
    step('UI unit tests', path.join(root, 'ui'), [vitest, 'run', '--maxWorkers=1', '--fileParallelism=false']),
    step('framework Node tests', root, ['--test', '--test-concurrency=1', ...frameworkTests.map((name) => path.join(root, 'quality', name))]),
    step('workspace typecheck', root, [npmCli, '--workspaces', '--if-present', 'run', 'typecheck']),
    step('workspace build', root, [npmCli, 'run', 'build']),
    step('instruction gate', root, [path.join(root, 'quality/instruction.mjs')]),
    step('quality ratchet', root, [path.join(root, 'quality/ratchet.mjs')]),
    step('lifecycle static verification', root, [path.join(root, 'scripts/verify-lifecycle-contract.mjs')]),
  ];
}

export function childCode(child) {
  if (!child || child.error || child.signal || !Number.isInteger(child.status) || child.status < 0) return 2;
  return child.status;
}

/** Synchronous executor seam: tests supply outcomes without running product checks. */
export function runPlan(plan, { execute = spawnSync, log = console.log } = {}) {
  if (!Array.isArray(plan) || !plan.length) throw new Error('Gate plan is empty');
  for (const step of plan) {
    if (!step.name || !step.command || !Array.isArray(step.args)
      || step.args.some((arg) => typeof arg !== 'string') || !path.isAbsolute(step.cwd)) {
      throw new Error('Gate step needs a name, command, argv array and absolute cwd');
    }
    log(`gate: ${step.name}; cwd=${step.cwd}`);
    let child;
    try {
      child = execute(step.command, step.args, {
        cwd: step.cwd, shell: false, windowsHide: true, stdio: 'inherit', timeout: STEP_TIMEOUT_MS,
      });
    } catch (error) {
      log(`gate: ${step.name}: executor error: ${String(error)}`);
      return 2;
    }
    const code = childCode(child);
    if (code) {
      log(`gate: ${step.name}: failed; exit=${code}; signal=${child?.signal ?? 'none'}${child?.error ? `; error=${child.error.message}` : ''}`);
      return code;
    }
  }
  return 0;
}

/** Real Node CLI controls use only owned scratch scripts and sentinel files. */
export function runControl(log = console.log) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'metadesk-gates-control-'));
  try {
    const entry = path.join(scratch, 'driver.mjs');
    const events = path.join(scratch, 'events.json');
    const driver = (status) => `import { runPlan } from ${JSON.stringify(pathToFileURL(fileURLToPath(import.meta.url)).href)};
const cwd = ${JSON.stringify(scratch)};
const record = ${JSON.stringify(`import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(events)}, 'later step ran');`)};
process.exitCode = runPlan([
  { name: 'first scratch step', command: process.execPath, args: ['-e', 'process.exit(${status})'], cwd },
  { name: 'later scratch step', command: process.execPath, args: ['--input-type=module', '-e', record], cwd },
]);\n`;
    writeFileSync(entry, driver(17));
    const refused = spawnSync(process.execPath, [entry], {
      cwd: scratch, shell: false, windowsHide: true, stdio: 'inherit', timeout: 120_000,
    });
    if (childCode(refused) !== 17 || existsSync(events)) throw new Error('Failed CLI step did not stop the later step with exit 17');
    writeFileSync(entry, driver(0));
    const accepted = spawnSync(process.execPath, [entry], {
      cwd: scratch, shell: false, windowsHide: true, stdio: 'inherit', timeout: 120_000,
    });
    if (childCode(accepted) !== 0 || readFileSync(events, 'utf8') !== 'later step ran') {
      throw new Error('Restored CLI control did not execute the later step');
    }
    log('gates-control: PASS; exit 17 prevented later execution; restored control ran both steps');
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function isMain(url) {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url)); } catch { return false; }
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--control') process.exitCode = runControl();
    else if (!args.length) {
      assertEnvironment();
      process.exitCode = runPlan(createPlan());
      if (!process.exitCode) console.log('GATES_OK: all 8 steps passed serially');
    } else throw new Error('usage: node quality/gates.mjs [--control]');
  } catch (error) {
    console.error(`gates infrastructure: ${String(error)}`);
    process.exitCode = 2;
  }
}
