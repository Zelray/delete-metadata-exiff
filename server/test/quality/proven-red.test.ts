import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify, skipReason } from '../../../quality/proven-red.mjs';
import { classifyFailures, judge, judgeBaseline } from '../../../quality/red-judge.mjs';
import { readFileResults, validateRun } from '../../../quality/test-runner.mjs';
import { linkDependencies, safePath } from '../../../quality/scratch-worktree.mjs';
import type { RunResult, TestResult } from '../../../quality/test-runner.mjs';

const file = 'server/test/feature.test.ts';
const passing: TestResult = { name: 'old test', status: 'passed', messages: [] };
const red: TestResult = { name: 'old test', status: 'failed', messages: ['AssertionError: expected 1 to be 2'] };
function run(tests: TestResult[], message = ''): RunResult {
  const failed = tests.some((test) => test.status === 'failed') || Boolean(message);
  return { code: failed ? 1 : 0, reportAvailable: true, signal: null,
    fileResults: [{ file, status: failed ? 'failed' : 'passed', message, tests }] };
}
const old = new Set(['old test']);

describe('proven-red range policy', () => {
  it('requires a product unit test when framework tests accompany product source', () => {
    const split = classify(['server/src/product.ts', 'server/test/quality/proven-red.test.ts', 'quality/proven-red.mjs']);
    expect(split.unitTests).toEqual([]);
    expect(split.source).toEqual(['server/src/product.ts', 'quality/proven-red.mjs']);
    expect(skipReason('feat: behavior', split)).toBeNull();
  });

  it('recognizes server and UI tests without accepting deleted tests or support as proof', () => {
    const split = classify(['server/test/live.test.ts', 'ui/src/live.test.tsx', 'server/test/deleted.test.ts',
      'server/test/helpers.ts', 'server/test/write/helpers.ts', 'ui/src/test/fixtures.ts'],
    new Set(['server/test/deleted.test.ts']));
    expect(split.unitTests).toEqual(['server/test/live.test.ts', 'ui/src/live.test.tsx']);
    expect(split.testSupport).toEqual(['server/test/helpers.ts', 'server/test/write/helpers.ts', 'ui/src/test/fixtures.ts']);
    expect(split.source).toEqual([]);
  });

  it('requires proof for scripts, runtime config and manifest behavior', () => {
    for (const changed of ['scripts/verify-behavior.mjs', 'bin/metadesk.mjs', 'package.json',
      'package-lock.json', 'server/vitest.config.ts', 'ui/vite.config.ts', 'tauri/tauri.conf.json']) {
      expect(skipReason('feat: correctness', classify([changed]))).toBeNull();
    }
  });

  it('keeps manifests as source and warns explicitly for maintenance title skips', () => {
    const changed = classify(['package.json', 'package-lock.json', 'quality/proven-red.mjs']);
    expect(skipReason('feat: framework', changed)).toBeNull();
    expect(skipReason('chore: framework prerequisites', changed)?.warn).toBe(true);
    expect(skipReason('chore: relabel', classify(['package.json', file]))).toBeNull();
  });

  it('announces no-source and gate-only skips, and warns about title and e2e bypasses', () => {
    expect(skipReason('docs: update', classify(['docs/guide.md']))).toEqual({ reason: 'no source file changed', warn: false });
    expect(skipReason('feat: gates', classify(['quality/proven-red.mjs', 'server/test/quality/proven-red.test.ts']))?.warn).toBe(false);
    expect(skipReason('chore: dependencies', classify(['package.json']))?.warn).toBe(true);
    expect(skipReason('feat: workflow', classify(['server/src/product.ts', 'tests-e2e/workflow.spec.ts']))?.warn).toBe(true);
    expect(skipReason('chore: relabel', classify(['server/src/product.ts', file]))).toBeNull();
  });
});

describe('proven-red file and individual test evidence', () => {
  it('rejects a file passing on old code', () => {
    expect(judge(file, run([passing]), old).code).toBe(1);
  });

  it('accepts an assertion failure and reports its measured denominator', () => {
    const verdict = judge(file, run([red]), old);
    expect(verdict.code).toBe(0);
    expect(verdict.lines.join('\n')).toContain('assertion-failures=1 missing-references=0 executed-tests=1');
  });

  it('rejects a new green sibling and a new skipped/todo sibling', () => {
    expect(judge(file, run([red, { ...passing, name: 'new green' }]), old).code).toBe(1);
    expect(judge(file, run([red, { ...passing, name: 'new todo', status: 'todo' }]), old).code).toBe(1);
    expect(judge(file, run([{ ...passing, status: 'skipped' }]), old).code).toBe(1);
  });

  it('accepts missing-reference red with a warning but never arbitrary TypeError', () => {
    const missing = judge(file, run([], "Cannot find module '../src/new-module'"));
    expect(missing.code).toBe(0);
    expect(missing.warnings.join('\n')).toContain('red only by missing reference');
    expect(judge(file, run([{ ...red, messages: ['TypeError: Cannot read properties of null'] }]), old).code).toBe(2);
    expect(judge(file, run([red], 'Error: beforeAll setup broke'), old).code).toBe(2);
  });

  it('classifies only verdict headlines, never source containing assert', () => {
    expect(classifyFailures(['TypeError: broken\n  assert(value)'])).toMatchObject({ assertions: 0, missing: 0, other: 1 });
    expect(classifyFailures(['AssertionError: expected a function\n  throw new TypeError()'])).toMatchObject({ assertions: 1, other: 0 });
    expect(classifyFailures(['SyntaxError: module does not provide an export named added'])).toMatchObject({ missing: 1, other: 0 });
    expect(classifyFailures(['SyntaxError: Unexpected token ;'])).toMatchObject({ missing: 0, other: 1 });
    expect(judge(file, run([], 'SyntaxError: module does not provide an export named added')).warnings.join('\n')).toContain('missing reference');
  });

  it('recognizes Vitest promise assertion stacks with Error prefixes and multiline values', () => {
    const resolved = 'Error: promise resolved "{\n  outcome: { updated: 1 }\n}" instead of rejecting\n    at writePipeline.test.ts:231:74';
    const rejected = 'Error: promise rejected "Error: refused" instead of resolving\n    at feature.test.ts:10:3';
    expect(classifyFailures([resolved, rejected])).toMatchObject({ assertions: 2, missing: 0, other: 0 });
    expect(judge(file, run([{ ...red, messages: [resolved] }]), old).code).toBe(0);
    expect(classifyFailures(['Error: promise resolved "value" unexpectedly'])).toMatchObject({ assertions: 0, other: 1 });
    expect(classifyFailures(['TypeError: broken\n    at feature.test.ts:1:1\nError: promise resolved "value" instead of rejecting'])).toMatchObject({ assertions: 0, other: 1 });
  });

  it('rejects absent reports, signals, incomplete results and a different reported file', () => {
    const good = run([red]);
    expect(judge(file, { ...good, code: null }).code).toBe(2);
    expect(judge(file, { ...good, signal: 'SIGTERM' }).code).toBe(2);
    expect(judge(file, { ...good, reportAvailable: false }).code).toBe(2);
    expect(judge(file, { ...good, code: 127 }).code).toBe(2);
    expect(judge(file, run([{ ...passing, status: 'pending' }])).code).toBe(2);
    expect(judge(file, { ...good, fileResults: [{ ...good.fileResults[0]!, file: 'ui/src/feature.test.ts' }] }).code).toBe(2);
    expect(validateRun({ ...run([passing]), code: 1 }, file)).toContain('outside');
    expect(judge(file, run([red, passing]), old).code).toBe(2);
  });

  it('requires a real passing old baseline rather than treating its failure as empty old names', () => {
    expect(judgeBaseline(file, run([red])).code).toBe(2);
    expect(judgeBaseline(file, run([])).code).toBe(2);
    expect(judgeBaseline(file, run([passing])).names).toEqual(old);
  });
});

describe('scratch source path containment', () => {
  it('rejects workspace package names that would escape private dependencies', () => {
    const temp = mkdtempSync(path.join(tmpdir(), 'red-package-test-'));
    try {
      mkdirSync(path.join(temp, 'node_modules'));
      mkdirSync(path.join(temp, 'shared'));
      writeFileSync(path.join(temp, 'shared/package.json'), JSON.stringify({ name: '../../escape' }));
      expect(() => linkDependencies(temp, temp)).toThrow(/Invalid or duplicate/);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it('rejects a dangling junction before any source file can follow it', () => {
    const temp = mkdtempSync(path.join(tmpdir(), 'red-path-test-'));
    const link = path.join(temp, 'redirect');
    const target = path.join(temp, 'missing-target');
    mkdirSync(target);
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    rmSync(target, { recursive: true });
    try {
      expect(() => safePath(temp, 'redirect/source.ts')).toThrow(/source symlink/);
      expect(() => safePath(temp, '../outside.ts')).toThrow(/Unsafe/);
    } finally {
      unlinkSync(link);
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

describe('Vitest JSON ingestion', () => {
  it('retains separate collection and per-test errors using the installed reporter shape', () => {
    const temp = mkdtempSync(path.join(tmpdir(), 'red-report-test-'));
    try {
      const report = path.join(temp, 'report.json');
      const json = { success: false, testResults: [{ name: path.join(temp, file), status: 'failed',
        message: 'setup error', assertionResults: [{ fullName: 'suite old test', status: 'failed',
          failureMessages: ['AssertionError: expected false to be true'] }] }] };
      writeFileSync(report, JSON.stringify(json));
      expect(readFileResults(report, temp)).toEqual([{ file, status: 'failed', message: 'setup error',
        tests: [{ name: 'suite old test', status: 'failed', messages: ['AssertionError: expected false to be true'] }] }]);
      writeFileSync(report, '{broken JSON');
      expect(() => readFileResults(report, temp)).toThrow();
      writeFileSync(report, JSON.stringify({ success: false, testResults: [{ name: 'x', status: 'failed' }] }));
      expect(() => readFileResults(report, temp)).toThrow(/Malformed/);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});
