import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE_SCOPES = ['server/src', 'ui/src', 'shared/src', 'bin', 'scripts', 'tauri/src-tauri/src'];
export const TEST_SCOPES = ['server/test', 'ui/src', 'tests-e2e'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.rs', '.ps1']);
const EXCLUDED = /(^|\/)(node_modules|vendor|dist|build|target|data|coverage|\.git|\.testfixtures|__fixtures__|fixtures)(\/|$)/;
const TEST_PATH = /(^|\/)(__tests__|tests?|testfixtures)(\/|$)|\.(test|spec)\.[^.]+$/;

export function git(args, root = ROOT) {
  return execFileSync('git', args, { cwd: root, shell: false, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

export function trackedPaths(root = ROOT) {
  return git(['ls-files', '-z'], root).split('\0').filter(Boolean).sort();
}

/** Only git-visible files; ignored build/runtime outputs never enter a denominator. */
export function repositoryPaths(root = ROOT) {
  const names = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root).split('\0').filter(Boolean);
  return [...new Set(names)].sort();
}

/** Reject every symlink component, including junctions, before opening a file. */
export function safeFile(root, relative) {
  if (path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some((part) => part === '..' || part === '')) {
    throw new Error(`unsafe repository path: ${relative}`);
  }
  const realRoot = realpathSync(root);
  let current = root;
  for (const component of relative.split('/')) {
    current = path.join(current, component);
    if (lstatSync(current).isSymbolicLink()) throw new Error(`symlink excluded: ${relative}`);
  }
  const real = realpathSync(current);
  const within = path.relative(realRoot, real);
  if (within.startsWith('..') || path.isAbsolute(within) || !lstatSync(current).isFile()) {
    throw new Error(`not a regular repository file: ${relative}`);
  }
  return current;
}

export function readRepoFile(root, relative) {
  return readFileSync(safeFile(root, relative), 'utf8');
}

function filesIn(scopes, predicate, root) {
  const files = repositoryPaths(root)
    .filter((name) => !EXCLUDED.test(name) && EXTENSIONS.has(path.extname(name)))
    .filter((name) => scopes.some((scope) => name.startsWith(`${scope}/`)) && predicate(name))
    .map((name) => ({ path: name, text: readRepoFile(root, name), language: path.extname(name) }));
  for (const scope of scopes) {
    if (!files.some((file) => file.path.startsWith(`${scope}/`))) throw new Error(`empty required inventory scope: ${scope}`);
  }
  return files;
}

export function sourceFiles(root = ROOT) {
  return filesIn(SOURCE_SCOPES, (name) => !TEST_PATH.test(name), root);
}

export function testFiles(root = ROOT) {
  return filesIn(TEST_SCOPES, (name) => !name.startsWith('ui/src/') || TEST_PATH.test(name), root);
}

/** Union staged, working, untracked and optional CI-range paths; deletions stay visible. */
export function changedPaths(root = ROOT, base = process.env.GT_BASE, head = process.env.GT_HEAD ?? 'HEAD') {
  const commands = [['diff', '--name-only', '-z', 'HEAD'], ['diff', '--cached', '--name-only', '-z'],
    ['ls-files', '--others', '--exclude-standard', '-z']];
  if (base) commands.push(['diff', '--name-only', '-z', `${base}...${head}`]);
  return [...new Set(commands.flatMap((args) => git(args, root).split('\0').filter(Boolean)))].sort();
}
