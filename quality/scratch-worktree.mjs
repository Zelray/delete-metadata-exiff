import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  realpathSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function git(repo, args, binary = false) {
  return execFileSync('git', args, { cwd: repo, shell: false, windowsHide: true,
    encoding: binary ? undefined : 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
}

export function resolveCommit(repo, ref) {
  if (typeof ref !== 'string' || !ref || ref.startsWith('-')) throw new Error('A commit reference is required');
  return git(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
}

export function safePath(root, relative) {
  if (!relative || path.isAbsolute(relative) || relative.includes('\\')
    || relative.split('/').some((part) => part === '..' || part === '.' || !part)) {
    throw new Error(`Unsafe repository path: ${relative}`);
  }
  const destination = path.resolve(root, relative);
  let cursor = root;
  for (const part of relative.split('/')) {
    cursor = path.join(cursor, part);
    let entry;
    try { entry = lstatSync(cursor); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (entry?.isSymbolicLink()) throw new Error(`Refusing to traverse a source symlink: ${relative}`);
  }
  return destination;
}

export function changedPaths(repo, base, head) {
  const entries = git(repo, ['diff', '--name-status', '--no-renames', '-z', base, head, '--']).split('\0');
  const files = [];
  const deleted = new Set();
  for (let index = 0; index < entries.length - 1; index += 2) {
    const status = entries[index];
    const file = entries[index + 1];
    if (!/^[AMDTUXB]$/.test(status) || !file) throw new Error('Malformed Git changed-path result');
    safePath(repo, file);
    files.push(file);
    if (status === 'D') deleted.add(file);
  }
  return { files, deleted };
}

/** Private directories prevent npm's absolute workspace junctions escaping to head. */
export function linkDependencies(root, dependencyRoot) {
  const source = path.join(dependencyRoot, 'node_modules');
  if (!existsSync(source)) throw new Error('Installed dependency directory is missing');
  const directories = [];
  const links = [];
  const workspaces = new Map();
  for (const name of ['shared', 'server', 'ui', 'tests-e2e']) {
    const manifest = path.join(root, name, 'package.json');
    if (existsSync(manifest)) {
      const data = JSON.parse(readFileSync(manifest, 'utf8'));
      if (data.name !== `@metadesk/${name}` || workspaces.has(data.name)) {
        throw new Error(`Invalid or duplicate scratch workspace package name: ${String(data.name)}`);
      }
      workspaces.set(data.name, path.join(root, name));
    }
  }
  const directory = (destination) => {
    if (existsSync(destination)) throw new Error(`Scratch dependency directory already exists: ${destination}`);
    mkdirSync(destination);
    directories.push(destination);
  };
  const link = (from, to) => {
    const resolved = realpathSync(from);
    symlinkSync(resolved, to, process.platform === 'win32' ? 'junction' : 'dir');
    links.push(to);
  };
  const populate = (from, to) => {
    directory(to);
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const sourceEntry = path.join(from, entry.name);
      const destination = path.join(to, entry.name);
      if (entry.name.startsWith('@')) {
        directory(destination);
        for (const child of readdirSync(sourceEntry)) {
          const name = `${entry.name}/${child}`;
          const local = workspaces.get(name);
          if (entry.name === '@metadesk' && !local) continue;
          link(local ?? path.join(sourceEntry, child), path.join(destination, child));
        }
      } else if (entry.isDirectory() || entry.isSymbolicLink()) {
        link(workspaces.get(entry.name) ?? sourceEntry, destination);
      }
    }
  };
  const removeOwnedDirectory = (directoryPath) => {
    for (const entry of readdirSync(directoryPath)) {
      const child = path.join(directoryPath, entry);
      const stat = lstatSync(child);
      if (stat.isSymbolicLink() || !stat.isDirectory()) unlinkSync(child);
      else removeOwnedDirectory(child);
    }
    rmdirSync(directoryPath);
  };
  const cleanup = () => {
    // unlinkSync removes the reparse point itself, never its dependency target.
    for (const linkPath of links.reverse()) {
      if (lstatSync(linkPath).isSymbolicLink()) unlinkSync(linkPath);
      else throw new Error(`Dependency link changed type: ${linkPath}`);
    }
    // Vitest/Vite can create private .vite/.vite-temp caches inside these directories.
    for (const directoryPath of directories.reverse()) {
      if (lstatSync(directoryPath).isSymbolicLink()) throw new Error(`Private dependency directory changed type: ${directoryPath}`);
      removeOwnedDirectory(directoryPath);
    }
  };
  try {
    populate(source, path.join(root, 'node_modules'));
    for (const name of ['server', 'shared', 'ui', 'tests-e2e']) {
      const nested = path.join(dependencyRoot, name, 'node_modules');
      if (existsSync(nested) && existsSync(path.join(root, name))) {
        populate(nested, path.join(root, name, 'node_modules'));
      }
    }
    const localScope = path.join(root, 'node_modules/@metadesk');
    if (workspaces.size && !existsSync(localScope)) directory(localScope);
    for (const [name, workspace] of workspaces) {
      const destination = path.join(root, 'node_modules', name);
      if (!existsSync(destination)) link(workspace, destination);
      if (realpathSync(destination) !== realpathSync(workspace)) {
        throw new Error(`Workspace dependency escaped scratch source: ${name}`);
      }
    }
    return { links: links.length, workspaces: [...workspaces.keys()], cleanup };
  } catch (error) {
    try { cleanup(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Dependency setup/cleanup failed'); }
    throw error;
  }
}

export function createScratch({ repo, ref, dependencyRoot = repo, log = console.log }) {
  const commit = resolveCommit(repo, ref);
  const container = mkdtempSync(path.join(tmpdir(), 'gap-trap-worktree-'));
  const root = path.join(container, 'tree');
  let registered = false;
  let dependencies;
  const cleanup = () => {
    const errors = [];
    if (dependencies) {
      try { dependencies.cleanup(); } catch (error) { errors.push(error); }
      dependencies = undefined;
    }
    if (registered && !errors.length) {
      try { git(repo, ['worktree', 'remove', '--force', root]); registered = false; }
      catch (error) { errors.push(error); }
    }
    // A failed git removal leaves its owned path for diagnosis, never prunes other worktrees.
    if (!registered) {
      try { rmSync(container, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, `Scratch cleanup failed: ${root}`);
  };
  try {
    git(repo, ['worktree', 'add', '--detach', '-q', root, commit]);
    registered = true;
    dependencies = linkDependencies(root, dependencyRoot);
    log(`scratch-worktree: commit=${commit} root=${root} package-links=${dependencies.links} local-workspaces=${dependencies.workspaces.join(',')}`);
    return { root, commit, cleanup };
  } catch (error) {
    try { cleanup(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Scratch setup/cleanup failed'); }
    throw error;
  }
}

export function copyFromCommit(repo, ref, root, file) {
  const destination = safePath(root, file);
  const object = git(repo, ['ls-tree', ref, '--', file]).trim();
  if (!/^100(?:644|755) blob /.test(object)) throw new Error(`Head path is not a regular tracked file: ${file}`);
  const content = git(repo, ['show', `${ref}:${file}`], true);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

/** Exclusive synthetic Git repository, used only by the executable controls. */
export function createControlRepo() {
  const container = mkdtempSync(path.join(tmpdir(), 'gap-trap-control-'));
  const repo = path.join(container, 'repo');
  mkdirSync(repo);
  git(repo, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  const write = (file, content) => {
    const destination = safePath(repo, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  };
  const commit = (subject) => {
    git(repo, ['add', '--all']);
    git(repo, ['-c', 'user.name=Quality control', '-c', 'user.email=control@example.invalid',
      'commit', '-qm', `${subject}\n\nCo-Authored-By: Claude <noreply@anthropic.com>`]);
    return resolveCommit(repo, 'HEAD');
  };
  return { repo, write, commit, cleanup: () => rmSync(container, { recursive: true, force: true }) };
}
