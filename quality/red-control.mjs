import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { proveRed } from './proven-red.mjs';
import { createControlRepo, git } from './scratch-worktree.mjs';
import { isMain } from './test-runner.mjs';

/** Actual Vitest + actual merge-base worktrees in an exclusive temp Git fixture. */
export function runRedControls(dependencyRoot, log = console.log) {
  const fixture = createControlRepo();
  let checks = 0;
  try {
    fixture.write('package.json', JSON.stringify({ name: 'quality-red-control', private: true, type: 'module' }));
    fixture.write('shared/package.json', JSON.stringify({ name: '@metadesk/shared', type: 'module', exports: './src/index.ts' }));
    fixture.write('shared/src/index.ts', 'export const answer = 1;\n');
    fixture.write('server/package.json', JSON.stringify({ name: '@metadesk/server', type: 'module' }));
    fixture.write('server/vitest.config.ts', "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'node', maxWorkers: 1 } });\n");
    fixture.write('server/src/value.ts', 'export const value = 1;\n');
    fixture.write('server/test/helpers.ts', 'export const expected = 1;\n');
    const imports = "import { expect, it } from 'vitest';\nimport { value } from '../src/value';\n";
    fixture.write('server/test/value.test.ts', `${imports}it('old baseline', () => expect(value).toBe(1));\n`);
    const base = fixture.commit('test: synthetic red baseline');
    fixture.write('server/src/value.ts', 'export const value = 2;\n');
    let head = fixture.commit('feat: synthetic code without red');
    const invoke = (expectedCode, expectedText, runTests) => {
      const lines = [];
      const code = proveRed({ base, head, repo: fixture.repo, dependencyRoot,
        runTests, log: (line) => { lines.push(line); log(line); } });
      assert.equal(code, expectedCode, lines.join('\n'));
      assert.match(lines.join('\n'), expectedText);
      assert.equal(git(fixture.repo, ['worktree', 'list', '--porcelain']).split('worktree ').length - 1, 1);
      checks++;
    };
    invoke(1, /no live changed unit test/);
    // Changed old test body passes on old source: it must fail the gate.
    fixture.write('server/test/value.test.ts', `${imports}it('old baseline', () => expect(value + 0).toBe(1));\n`);
    head = fixture.commit('test: synthetic passing-on-old test');
    invoke(1, /pass on pre-change code/);
    fixture.write('server/test/helpers.ts', 'export const expected = 2;\n');
    fixture.write('server/test/value.test.ts', `${imports}import { expected } from './helpers';\nit('old baseline', () => expect(value).toBe(expected));\n`);
    head = fixture.commit('feat: synthetic assertion red and head helper');
    invoke(0, /assertion-failures=1/);
    // The same file's red must not shelter a new green sibling.
    fixture.write('server/test/value.test.ts', `${imports}it('old baseline', () => expect(value).toBe(2));\nit('new green sibling', () => expect(value).toBeGreaterThan(0));\n`);
    head = fixture.commit('feat: synthetic new green sibling');
    invoke(1, /new tests pass on pre-change code/);
    fixture.write('server/test/value.test.ts', `${imports}it('old baseline', () => expect(value).toBe(2));\n`);
    fixture.write('server/test/green.test.ts', "import { expect, it } from 'vitest';\nit('new green file', () => expect(1).toBe(1));\n");
    head = fixture.commit('feat: synthetic green sibling file');
    invoke(1, /green\.test\.ts: changed tests pass/);
    // A package import must resolve the fork-point shared source, not parent head.
    fixture.write('server/test/green.test.ts', "import { expect, it } from 'vitest';\nimport { answer } from '@metadesk/shared';\nit('scratch shared', () => expect(answer).toBe(2));\n");
    fixture.write('shared/src/index.ts', 'export const answer = 2;\n');
    head = fixture.commit('feat: synthetic workspace isolation');
    invoke(0, /judged-files=2 exit=0/);
    // New source exists at head only; old collection is honest missing-reference red.
    fixture.write('server/src/added.ts', 'export const added = 2;\n');
    fixture.write('server/test/green.test.ts', "import { expect, it } from 'vitest';\nimport { added } from '../src/added';\nit('new API', () => expect(added).toBe(2));\n");
    head = fixture.commit('feat: synthetic missing reference');
    invoke(0, /WARNING:.*red only by missing reference/);
    fixture.write('server/test/green.test.ts', "import { expect, it } from 'vitest';\nimport { value } from '../src/value';\nit('new API', () => expect(value).toBe(2));\n");
    fixture.write('server/test/value.test.ts', `${imports}it('old baseline', () => expect(value).toBe(2));\nit('old baseline', () => expect(value).toBeGreaterThan(0));\n`);
    head = fixture.commit('feat: synthetic duplicate title');
    invoke(2, /duplicate full test names/);
    for (const hook of ['beforeEach', 'afterEach']) {
      fixture.write('server/test/value.test.ts', `${imports}import { ${hook} } from 'vitest';\n${hook}(() => expect(1).toBe(2));\nit('old baseline', () => expect(value).toBe(1));\n`);
      head = fixture.commit(`feat: synthetic ${hook} assertion`);
      invoke(2, /provenance rejected/);
    }
    fixture.write('server/test/wrapper.ts', "import { aroundEach } from 'vitest';\naroundEach(async (run) => { await run(); });\n");
    fixture.write('server/test/value.test.ts', `${imports}import './wrapper.js';\nit('old baseline', () => expect(value).toBe(2));\n`);
    head = fixture.commit('feat: synthetic TypeScript wrapper via js import');
    invoke(2, /Unsupported wrapper-hook provenance/);
    fixture.write('server/test/value.test.ts', `${imports}it('old baseline', () => expect(value).toBe(2));\nit('new runtime exception', () => { throw new TypeError('broken fixture'); });\n`);
    head = fixture.commit('feat: synthetic unrelated runtime failure');
    invoke(2, /non-assertion failure/);
    const broken = (root, file) => {
      // The injected failure still sees a real isolated worktree and local shared source.
      assert.notEqual(realpathSync(path.join(root, 'node_modules/@metadesk/shared')), realpathSync(path.join(dependencyRoot, 'shared')));
      assert.equal(readFileSync(path.join(root, 'shared/src/index.ts'), 'utf8'), 'export const answer = 1;\n');
      return { code: null, signal: 'SIGTERM', reportAvailable: false, fileResults: [], error: `runner broken: ${file}` };
    };
    invoke(2, /fork-point|runner broken/, broken);
    log(`red-control: PASS checks=${checks} real-vitest=true real-worktrees=true`);
    return 0;
  } finally { fixture.cleanup(); }
}

if (isMain(import.meta.url)) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    process.exitCode = runRedControls(root);
  } catch (error) { console.error(`red-control: FAIL ${String(error)}`); process.exitCode = 2; }
}
