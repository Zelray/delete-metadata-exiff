import { describe, expect, it } from 'vitest';
import { judgeMutation } from '../../../quality/mutation-smoke.mjs';
import { applyMutation, MUTATIONS } from '../../../quality/mutations.mjs';
import type { MutationTarget } from '../../../quality/mutations.mjs';
import type { RunResult, TestResult } from '../../../quality/test-runner.mjs';

const target: MutationTarget = { id: 'synthetic', file: 'server/src/value.ts', from: 'const value = 1;',
  to: 'const value = 2;', test: 'server/test/value.test.ts', testName: 'selected value' };
const pass: TestResult = { name: 'suite selected value', status: 'passed', messages: [] };
const failed: TestResult = { ...pass, status: 'failed', messages: ['AssertionError: expected 2 to be 1'] };
function run(tests: TestResult[], message = ''): RunResult {
  const bad = tests.some((test) => test.status === 'failed') || Boolean(message);
  return { code: bad ? 1 : 0, signal: null, reportAvailable: true,
    fileResults: [{ file: target.test, status: bad ? 'failed' : 'passed', tests, message }] };
}

describe('mutation smoke evidence', () => {
  it('accepts only a selected assertion failure after a passing clean control', () => {
    const verdict = judgeMutation(target, run([pass]), run([failed]));
    expect(verdict.code).toBe(0);
    expect(verdict.reason).toContain('selected-tests=1 assertion-failures=1');
  });

  it('accepts the native rejects assertion stack without broadening arbitrary Error evidence', () => {
    const message = 'Error: promise resolved "{ outcome: { updated: 1 } }" instead of rejecting\n    at writePipeline.test.ts:231:74';
    expect(judgeMutation(target, run([pass]), run([{ ...failed, messages: [message] }])).code).toBe(0);
    expect(judgeMutation(target, run([pass]), run([{ ...failed, messages: ['Error: promise resolved unexpectedly'] }])).code).toBe(2);
    expect(judgeMutation(target, run([pass]), { ...run([{ ...failed, messages: [message] }]), error: 'runner provenance rejected: unfinishedHooks=1' }).code).toBe(2);
  });

  it('returns survivor exit 1 when the same selected test passes', () => {
    expect(judgeMutation(target, run([pass]), run([pass]))).toEqual({ code: 1, reason: 'survived: selected tests still pass' });
  });

  it('fails closed when clean control fails or selection executes no tests', () => {
    expect(judgeMutation(target, run([failed]), run([failed])).code).toBe(2);
    expect(judgeMutation(target, run([{ ...pass, status: 'skipped' }]), run([failed])).code).toBe(2);
    expect(judgeMutation(target, run([]), run([failed])).code).toBe(2);
  });

  it('never counts runtime exceptions, missing modules or syntax errors as kills', () => {
    for (const message of ['TypeError: Cannot read properties of undefined',
      "Error: Cannot find module '../missing'", 'SyntaxError: Unexpected token ;',
      'Error: Test timed out in 60000ms']) {
      expect(judgeMutation(target, run([pass]), run([{ ...failed, messages: [message] }])).code).toBe(2);
    }
    expect(judgeMutation(target, run([pass]), run([], 'Transform failed: syntax error')).code).toBe(2);
    expect(judgeMutation(target, run([pass]), run([failed], 'AssertionError: beforeAll failed')).code).toBe(2);
  });

  it('rejects signal, timeout, absent report and mismatched file even with assertion text', () => {
    const bad = run([failed]);
    expect(judgeMutation(target, run([pass]), { ...bad, signal: 'SIGTERM' }).code).toBe(2);
    expect(judgeMutation(target, run([pass]), { ...bad, code: null }).code).toBe(2);
    expect(judgeMutation(target, run([pass]), { ...bad, reportAvailable: false }).code).toBe(2);
    expect(judgeMutation(target, run([pass]), { ...bad, error: 'spawn ENOENT' }).code).toBe(2);
    expect(judgeMutation(target, run([pass]), { ...bad, fileResults: [{ ...bad.fileResults[0]!, file: 'ui/src/unrelated.test.ts' }] }).code).toBe(2);
  });

  it('rejects failure in a different test or a selection that stopped executing', () => {
    expect(judgeMutation(target, run([pass]), run([{ ...failed, name: 'unrelated test' }])).code).toBe(2);
    expect(judgeMutation(target, run([pass]), run([{ ...pass, status: 'skipped' }])).code).toBe(2);
    expect(judgeMutation(target, run([pass]), run([{ ...pass, status: 'pending' }])).code).toBe(2);
    expect(judgeMutation(target, run([pass]), run([failed, { ...pass, name: 'extra unrelated test' }])).code).toBe(2);
  });
});

describe('mutation anchor and target contract', () => {
  it('changes exactly one anchor and rejects missing or ambiguous anchors', () => {
    expect(applyMutation('const value = 1;\n', target)).toBe('const value = 2;\n');
    expect(() => applyMutation('const value = 9;', target)).toThrow(/occurrences=0/);
    expect(() => applyMutation('const value = 1; const value = 1;', target)).toThrow(/occurrences=2/);
    expect(() => applyMutation('const value = 1;', { ...target, to: target.from })).toThrow(/Invalid/);
  });

  it('names the four released safety behaviors and selects their concrete unit tests', () => {
    expect(MUTATIONS.map((mutation) => [mutation.id, mutation.file, mutation.test])).toEqual([
      ['engine-overwrite', 'server/src/engine/engineArgs.ts', 'server/test/argBuilder.test.ts'],
      ['write-unlock', 'server/src/services/writePipeline.ts', 'server/test/write/writePipeline.test.ts'],
      ['ui-blockers', 'ui/src/components/SaveReviewModal.tsx', 'ui/src/write/write.surfaces.test.tsx'],
      ['api-token', 'ui/src/api/client.ts', 'ui/src/api/client.transport.test.ts'],
    ]);
    expect(MUTATIONS.map((mutation) => mutation.testName)).toEqual([
      'rejects an overwrite flag wherever it appears in the argv',
      'refuses execute while the session is read-only',
      'disables execute while blockers stand',
      'getThumbnail sends token-ONLY headers',
    ]);
  });
});
