import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { childCode, isMain } from './gates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Actual Git -> Husky -> copied pre-commit runner, with harmless scratch gate payloads. */
export function runHookControl(log = console.log) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'metadesk-hook-control-'));
  try {
    const env = { ...process.env, CI: '',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(scratch, 'gitconfig'),
      XDG_CONFIG_HOME: path.join(scratch, 'config'),
    };
    for (const key of ['HUSKY', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
      'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT']) delete env[key];
    for (const key of Object.keys(env)) if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key];
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
    env[pathKey] = `${path.dirname(process.execPath)}${path.delimiter}${env[pathKey] ?? ''}`;
    writeFileSync(env.GIT_CONFIG_GLOBAL, '');
    for (const directory of ['quality', '.husky', 'config', 'node_modules']) mkdirSync(path.join(scratch, directory));
    for (const file of ['gates.mjs', 'pre-commit.mjs']) {
      copyFileSync(path.join(ROOT, 'quality', file), path.join(scratch, 'quality', file));
    }
    copyFileSync(path.join(ROOT, '.husky/pre-commit'), path.join(scratch, '.husky/pre-commit'));
    cpSync(path.join(ROOT, 'node_modules/husky'), path.join(scratch, 'node_modules/husky'), { recursive: true });
    writeFileSync(path.join(scratch, '.gitignore'), 'node_modules/\n.husky/_/\nevents.jsonl\ngitconfig\nconfig/\n');
    const invoke = (command, args) => spawnSync(command, args, {
      cwd: scratch, env, shell: false, windowsHide: true, stdio: 'inherit', timeout: 120_000,
    });
    const git = (args) => {
      const result = invoke('git', args);
      if (childCode(result)) throw new Error(`hook-control: git ${args.join(' ')} failed (${childCode(result)})`);
    };
    const captureGit = (args) => spawnSync('git', args, {
      cwd: scratch, env, shell: false, windowsHide: true, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'], timeout: 120_000,
    });
    const assertUnborn = () => {
      const head = captureGit(['rev-parse', '--verify', '--quiet', 'HEAD']);
      if (childCode(head) !== 1 || head.stdout.trim()) throw new Error('Refused hook created a commit');
    };
    git(['init', '--initial-branch=hook-control']);
    git(['config', '--local', 'user.name', 'Hook control']);
    git(['config', '--local', 'user.email', 'hook-control@example.invalid']);
    const installed = invoke(process.execPath, [path.join(scratch, 'quality/pre-commit.mjs'), '--install']);
    if (childCode(installed)) throw new Error('hook-control: actual prepare installer failed');
    const events = path.join(scratch, 'events.jsonl');
    const payload = (name, status) => writeFileSync(path.join(scratch, 'quality', `${name}.mjs`),
      `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(events)}, ${JSON.stringify(`${name}\n`)});\nprocess.exitCode = ${status};\n`);
    const trace = () => existsSync(events) ? readFileSync(events, 'utf8') : '';
    const commit = (name) => {
      git(['add', '.']);
      return invoke('git', ['commit', '-m', `${name}\n\nCo-Authored-By: Claude <noreply@anthropic.com>`]);
    };
    payload('instruction', 19);
    payload('ratchet', 0);
    writeFileSync(path.join(scratch, 'control.txt'), 'owned harmless hook control\n');
    const badInstruction = commit('test: scratch instruction refusal');
    if (childCode(badInstruction) !== 1 || trace() !== 'instruction\n') {
      throw new Error('hook-control: instruction failure did not refuse commit before ratchet');
    }
    assertUnborn();
    rmSync(events);
    payload('instruction', 0);
    payload('ratchet', 23);
    const badRatchet = commit('test: scratch ratchet refusal');
    if (childCode(badRatchet) !== 1 || trace() !== 'instruction\nratchet\n') {
      throw new Error('hook-control: ratchet failure did not refuse commit after instruction');
    }
    assertUnborn();
    rmSync(events);
    payload('ratchet', 0);
    const clean = commit('test: scratch hook acceptance');
    if (childCode(clean) !== 0 || trace() !== 'instruction\nratchet\n') {
      throw new Error('hook-control: restored actual hook did not accept the scratch commit');
    }
    const history = captureGit(['log', '--format=%s']);
    if (childCode(history) || history.stdout.trim() !== 'test: scratch hook acceptance') {
      throw new Error('hook-control: unexpected scratch history after refusals and acceptance');
    }
    log('hook-control: PASS; actual hook refused instruction and ratchet failures, then accepted restored payloads');
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('usage: node quality/hook-control.mjs');
    process.exitCode = runHookControl();
  } catch (error) {
    console.error(`hook-control infrastructure: ${String(error)}`);
    process.exitCode = 2;
  }
}
