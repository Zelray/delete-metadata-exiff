import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutationSmoke } from './mutation-smoke.mjs';
import { createControlRepo, git } from './scratch-worktree.mjs';
import { isMain } from './test-runner.mjs';

/** Real clean/mutant runs in owned worktrees; app files remain untouched. */
export function runMutationControls(dependencyRoot, log = console.log) {
  const fixture = createControlRepo();
  let checks = 0;
  try {
    fixture.write('package.json', JSON.stringify({ name: 'quality-mutation-control', private: true, type: 'module' }));
    fixture.write('shared/package.json', JSON.stringify({ name: '@metadesk/shared', type: 'module', exports: './src/index.ts' }));
    fixture.write('shared/src/index.ts', 'export const answer = 1;\n');
    fixture.write('server/package.json', JSON.stringify({ name: '@metadesk/server', type: 'module' }));
    fixture.write('server/vitest.config.ts', "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'node', maxWorkers: 1 } });\n");
    const source = "import { answer } from '@metadesk/shared';\nexport const value = answer;\n";
    fixture.write('server/src/value.ts', source);
    fixture.write('server/test/value.test.ts', "import { expect, it } from 'vitest';\nimport { value } from '../src/value';\nit('selected value', () => expect(value).toBe(1));\nit('unselected sibling', () => expect(value).toBeGreaterThan(0));\n");
    fixture.commit('test: synthetic mutation baseline');
    const target = { id: 'control', file: 'server/src/value.ts', from: 'export const value = answer;',
      to: 'export const value = answer + 1;', test: 'server/test/value.test.ts', testName: 'selected value' };
    const invoke = (to, expectedCode, text) => {
      const lines = [];
      const code = mutationSmoke({ repo: fixture.repo, dependencyRoot, targets: [{ ...target, to }],
        log: (line) => { lines.push(line); log(line); } });
      assert.equal(code, expectedCode, lines.join('\n'));
      assert.match(lines.join('\n'), text);
      assert.equal(readFileSync(path.join(fixture.repo, target.file), 'utf8'), source);
      assert.equal(git(fixture.repo, ['worktree', 'list', '--porcelain']).split('worktree ').length - 1, 1);
      checks++;
    };
    invoke(target.to, 0, /killed=1\/1 exit=0/);
    invoke('export const value = answer + 0;', 1, /survived: selected tests still pass/);
    invoke('export const value = answer + ;', 2, /collection\/setup|runner|assertion proof/);
    const lines = [];
    const code = mutationSmoke({ repo: fixture.repo, dependencyRoot,
      targets: [{ ...target, from: 'absent target anchor' }], log: (line) => { lines.push(line); log(line); } });
    assert.equal(code, 2);
    assert.match(lines.join('\n'), /anchor occurrences=0/);
    checks++;
    for (const hook of ['beforeEach', 'afterEach']) {
      fixture.write('server/test/value.test.ts', `import { expect, it, ${hook} } from 'vitest';\nimport { value } from '../src/value';\n${hook}(() => expect(value).toBe(1));\nit('selected value', () => expect(value).toBeGreaterThan(0));\n`);
      fixture.commit(`test: synthetic ${hook} mutant assertion`);
      invoke(target.to, 2, /provenance rejected/);
    }
    log(`mutation-control: PASS checks=${checks} real-vitest=true real-worktrees=true`);
    return 0;
  } finally { fixture.cleanup(); }
}

if (isMain(import.meta.url)) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    process.exitCode = runMutationControls(root);
  } catch (error) { console.error(`mutation-control: FAIL ${String(error)}`); process.exitCode = 2; }
}
