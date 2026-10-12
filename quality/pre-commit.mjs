import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { childCode, isMain, runPlan } from './gates.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createPreCommitPlan(root = ROOT, node = process.execPath) {
  return ['instruction', 'ratchet'].map((name) => ({
    name: `pre-commit ${name}`, command: node, args: [path.join(root, 'quality', `${name}.mjs`)], cwd: root,
  }));
}

export function runPreCommit(options = {}) {
  return runPlan(createPreCommitPlan(options.root ?? ROOT, options.node ?? process.execPath), options);
}

/** CI installs dependencies without mutating hooks; a local install preserves custom hook paths. */
export async function installHooks({ root = ROOT, cwd = process.cwd(), env = process.env,
  execute = spawnSync, loadInstaller = async () => (await import(pathToFileURL(path.join(root, 'node_modules/husky/index.js')).href)).default,
  log = console.log } = {}) {
  if (env.CI === 'true') {
    log('prepare: CI=true; skipped local Husky installation');
    return 0;
  }
  if (realpathSync(cwd) !== realpathSync(root)) throw new Error('Run npm run prepare from the app Git root');
  if (!existsSync(path.join(root, '.git'))) throw new Error('prepare needs a Git clone with its .git entry');
  if (!existsSync(path.join(root, '.husky/pre-commit'))) throw new Error('Reviewed .husky/pre-commit is missing');
  const git = (args, allowMissing = false) => {
    const child = execute('git', args, {
      cwd: root, shell: false, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 120_000,
    });
    const code = childCode(child);
    if (code && !(allowMissing && code === 1)) throw new Error(`prepare: git ${args.join(' ')} failed (${code})`);
    return code ? '' : child.stdout.trim();
  };
  const top = git(['rev-parse', '--show-toplevel']);
  if (realpathSync(top) !== realpathSync(root)) throw new Error('prepare refuses hooks outside the app Git root');
  const previous = git(['config', '--get', 'core.hooksPath'], true);
  if (previous && previous !== '.husky/_') throw new Error(`prepare refuses to replace existing core.hooksPath=${previous}; review it first`);
  const install = await loadInstaller();
  const diagnostic = install();
  if (diagnostic !== '') throw new Error(`Husky installation did not complete: ${String(diagnostic)}`);
  if (git(['config', '--get', 'core.hooksPath']) !== '.husky/_'
    || !existsSync(path.join(root, '.husky/_/pre-commit'))) {
    throw new Error('Husky installation did not leave the expected pre-commit path');
  }
  log('prepare: Husky installed; pre-commit runs instruction then ratchet');
  return 0;
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--install') process.exitCode = await installHooks();
    else if (!args.length) process.exitCode = runPreCommit();
    else throw new Error('usage: node quality/pre-commit.mjs [--install]');
  } catch (error) {
    console.error(`pre-commit infrastructure: ${String(error)}`);
    process.exitCode = 2;
  }
}
