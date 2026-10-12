import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const RUN_TIMEOUT_MS = 120_000;
const slash = (value) => value.replace(/\\/g, '/');
const statuses = new Set(['passed', 'failed', 'pending', 'skipped', 'todo', 'disabled']);

/** Read Vitest's JSON reporter, retaining per-test and collection errors separately. */
export function readFileResults(report, root) {
  const json = JSON.parse(readFileSync(report, 'utf8'));
  if (!Array.isArray(json.testResults) || typeof json.success !== 'boolean') {
    throw new Error('Malformed Vitest report: missing testResults/success');
  }
  return json.testResults.map((file) => {
    if (typeof file.name !== 'string' || !['passed', 'failed'].includes(file.status)
      || !Array.isArray(file.assertionResults)) throw new Error('Malformed Vitest file result');
    const tests = file.assertionResults.map((test) => {
      if (typeof test.fullName !== 'string' || !statuses.has(test.status)
        || !Array.isArray(test.failureMessages)
        || test.failureMessages.some((message) => typeof message !== 'string')) {
        throw new Error('Malformed Vitest assertion result');
      }
      return { name: test.fullName, status: test.status, messages: test.failureMessages };
    });
    return {
      file: root ? slash(path.relative(root, file.name)) : slash(file.name),
      status: file.status,
      message: typeof file.message === 'string' ? file.message : '',
      tests,
    };
  });
}

export function resultFor(results, file) {
  const wanted = slash(file);
  const matches = results.filter((result) => slash(result.file) === wanted);
  return matches.length === 1 ? matches[0] : undefined;
}

/** A process failure or incomplete collection can never supply red evidence. */
export function validateRun(run, file) {
  if (run.error || run.signal || ![0, 1].includes(run.code) || !run.reportAvailable) {
    return run.error || `runner exited ${run.code}, signal ${run.signal ?? 'none'}, report ${run.reportAvailable}`;
  }
  const result = resultFor(run.fileResults, file);
  if (!result || run.fileResults.length !== 1) return `runner did not report exactly the selected file ${file}`;
  if (result.tests.some((test) => test.status === 'pending')) return 'runner report contains incomplete tests';
  if (new Set(result.tests.map((test) => test.name)).size !== result.tests.length) {
    return 'duplicate full test names cannot identify new-test proof reliably';
  }
  if (result.tests.some((test) => test.status === 'passed' && test.messages.length)) {
    return 'passed test carries failure messages';
  }
  if (run.code === 0 && result.message) return 'passing file carries a collection/setup error';
  if (run.code === 0 && (result.status !== 'passed' || result.tests.some((test) => test.status === 'failed'))) {
    return 'exit status and failed report disagree';
  }
  if (run.code === 1 && result.status !== 'failed') return 'runner failed outside the selected test file';
  if (result.status === 'failed' && !result.message
    && !result.tests.some((test) => test.status === 'failed')) return 'failed file has no failure evidence';
  return null;
}

/** Vitest 5 wrapper hooks have no reporter provenance; reject their reachable use. */
function unsupportedWrappers(root, file) {
  const seen = new Set();
  const resolveLocal = (specifier, from) => {
    const imported = path.resolve(path.dirname(from), specifier);
    const swapped = imported.replace(/\.(?:js|jsx|mjs|cjs)$/, (extension) => ({
      '.js': '.ts', '.jsx': '.tsx', '.mjs': '.mts', '.cjs': '.cts',
    })[extension]);
    const candidates = [imported, swapped, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs'].map((extension) => imported + extension),
      path.join(imported, 'index.ts'), path.join(imported, 'index.tsx')];
    const resolved = candidates.find((candidate) => existsSync(candidate) && /\.[cm]?[jt]sx?$/.test(candidate));
    if (!resolved || path.relative(root, resolved).startsWith('..')) {
      // A genuine head-only module remains missing-reference proof, not a wrapper guess.
      return;
    }
    return resolved;
  };
  const visit = (absolute) => {
    if (seen.has(absolute)) return;
    seen.add(absolute);
    const source = ts.createSourceFile(absolute, readFileSync(absolute, 'utf8'), ts.ScriptTarget.Latest, true);
    const inspect = (node) => {
      if ((ts.isIdentifier(node) || ts.isStringLiteral(node)) && ['aroundEach', 'aroundAll'].includes(node.text)) {
        throw new Error(`Unsupported wrapper-hook provenance in ${path.relative(root, absolute)}`);
      }
      if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
        && node.name.text === 'setupFiles') {
        const values = ts.isArrayLiteralExpression(node.initializer) ? node.initializer.elements : [node.initializer];
        for (const value of values) {
          if (!ts.isStringLiteral(value)) throw new Error('Dynamic Vitest setupFiles needs provenance review');
          const setup = resolveLocal(value.text, absolute);
          if (!setup) throw new Error(`Unresolved Vitest setupFiles needs provenance review: ${value.text}`);
          visit(setup);
        }
      }
      const follow = (specifier) => {
        if (specifier.includes('?') || /\.(?:css|svg|png|json)$/.test(specifier)) return;
        if (specifier.startsWith('.')) {
          const resolved = resolveLocal(specifier, absolute);
          if (resolved) visit(resolved);
        } else if (specifier === '@metadesk/shared') {
          const shared = path.join(root, 'shared/src/index.ts');
          if (existsSync(shared)) visit(shared);
        } else if (specifier.startsWith('@metadesk/')) {
          throw new Error(`Unsupported workspace hook provenance needs review: ${specifier}`);
        }
      };
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
        && ts.isStringLiteral(node.moduleSpecifier)) follow(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        const specifier = node.arguments[0];
        if (!specifier || !ts.isStringLiteral(specifier)) throw new Error('Dynamic helper import needs wrapper-hook provenance review');
        follow(specifier.text);
      }
      ts.forEachChild(node, inspect);
    };
    inspect(source);
  };
  visit(path.join(root, file));
  for (const workspace of ['server', 'ui']) {
    for (const config of ['vitest.config.ts', 'vite.config.ts']) {
      const absolute = path.join(root, workspace, config);
      if (existsSync(absolute)) visit(absolute);
    }
  }
}

/** One file per native argv-array process; no npm forwarding, npx, or shell. */
export function runVitest(root, file, options = {}) {
  const empty = { code: null, signal: null, reportAvailable: false, fileResults: [], report: '' };
  let reportDir;
  try {
    const workspace = file.startsWith('server/test/') ? 'server'
      : file.startsWith('ui/src/') ? 'ui' : null;
    if (!workspace || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
      throw new Error(`Unsupported unit test path: ${file}`);
    }
    if (!existsSync(path.join(root, file))) throw new Error(`Selected test is missing: ${file}`);
    unsupportedWrappers(root, file);
    const engineRequired = options.requireEngine ?? (
      workspace === 'server' && JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).name === 'metadesk'
    );
    if (engineRequired && !existsSync(path.join(root, 'vendor/exiftool/exiftool.exe'))) {
      throw new Error('Vendored ExifTool engine is missing from the scratch worktree');
    }
    const entry = path.join(root, 'node_modules/vitest/vitest.mjs');
    if (!existsSync(entry)) throw new Error(`Installed Vitest entry is missing: ${entry}`);
    const timeout = options.timeoutMs ?? RUN_TIMEOUT_MS;
    if (!Number.isInteger(timeout) || timeout <= 0 || timeout > RUN_TIMEOUT_MS) {
      throw new Error(`Test timeout must be between 1 and ${RUN_TIMEOUT_MS} ms`);
    }
    reportDir = mkdtempSync(path.join(tmpdir(), 'gap-trap-report-'));
    const report = path.join(reportDir, 'vitest.json');
    const provenance = path.join(reportDir, 'provenance.json');
    const cwd = path.join(root, workspace);
    const reporter = fileURLToPath(import.meta.url);
    const args = [entry, 'run', file.slice(workspace.length + 1), '--maxWorkers=1',
      '--reporter=default', '--reporter=json', `--reporter=${reporter}`, `--outputFile.json=${report}`];
    if (options.testName) args.push('-t', options.testName);
    const log = options.log ?? console.log;
    log(`test-runner: cwd=${cwd} file=${file} selection=${options.testName ?? 'all'} report=${report}`);
    const child = spawnSync(process.execPath, args, {
      cwd, shell: false, windowsHide: true, stdio: 'inherit', timeout,
      env: { ...process.env, GAP_TRAP_PROVENANCE: provenance },
    });
    const run = { ...empty, code: child.status, signal: child.signal, report,
      error: child.error?.message, reportAvailable: existsSync(report) };
    if (run.reportAvailable) run.fileResults = readFileResults(report, root);
    if (!existsSync(provenance)) run.error ??= 'runner did not produce hook/body provenance';
    else {
      const proof = JSON.parse(readFileSync(provenance, 'utf8'));
      if (proof.completed !== true || !['passed', 'failed'].includes(proof.reason) || proof.unhandled !== 0
        || proof.unfinishedHooks !== 0) {
        run.error ??= `runner provenance rejected: ${JSON.stringify(proof)}`;
      }
    }
    return run;
  } catch (error) {
    return { ...empty, error: String(error) };
  } finally {
    if (reportDir) rmSync(reportDir, { recursive: true, force: true });
  }
}

/** Vitest 5 hook events end only on success; an unmatched start is setup red. */
export default class ProvenanceReporter {
  hooks = new Map();
  onHookStart({ name, entity }) {
    const key = `${entity.id}:${name}`;
    this.hooks.set(key, (this.hooks.get(key) ?? 0) + 1);
  }
  onHookEnd({ name, entity }) {
    const key = `${entity.id}:${name}`;
    this.hooks.set(key, (this.hooks.get(key) ?? 0) - 1);
  }
  onTestRunEnd(_modules, unhandledErrors, reason) {
    const destination = process.env.GAP_TRAP_PROVENANCE;
    if (!destination) throw new Error('Missing private provenance report destination');
    writeFileSync(destination, JSON.stringify({ completed: true, reason,
      unhandled: unhandledErrors.length,
      unfinishedHooks: [...this.hooks.values()].filter((count) => count !== 0).length }));
  }
}

export function isMain(url) {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(new URL(url)); }
  catch { return false; }
}
