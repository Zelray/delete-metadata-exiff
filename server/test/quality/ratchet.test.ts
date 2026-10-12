import { describe, expect, it } from 'vitest';
import { check, currentCounts, planUpdate, snapshotFrom, checkSnapshot, planSnapshotUpdate,
  findingKey, codeLineCount, lintFindings, testQualityFindings, run,
  type Finding, type SourceFile } from '../../../quality/ratchet.mjs';

const file = (path: string, text: string, language = '.ts'): SourceFile => ({ path, text, language });
const finding = (identity: string, path = 'ui/src/View.tsx', rule = 'lint:copy'): Finding =>
  ({ path, rule, line: 1, evidence: identity, identity });
const snapshot = (findings: Finding[] = [], lengths: Record<string, number> = {}) =>
  snapshotFrom(findings, lengths, ['lint:copy']);

describe('ratchet reference count contract', () => {
  it('allows equality and records a small improvement', () => {
    expect(check({ backlog: 3 }, { backlog: 3 })).toEqual({ lines: [], code: 0 });
    expect(check({ backlog: 1 }, { backlog: 3 })).toEqual({ lines: ['backlog: 3 -> 1, run --update to lock gain'], code: 0 });
  });

  it('rejects a rise, removed counter, new nonzero counter and excess slack', () => {
    expect(check({ backlog: 4 }, { backlog: 3 })).toEqual({ lines: ['backlog: 3 allowed, 4 found (+1)'], code: 1 });
    expect(check({}, { backlog: 3 })).toEqual({ lines: ['backlog: in baseline but no counter configured'], code: 1 });
    expect(check({ added: 1 }, {})).toEqual({ lines: ['added: 0 allowed, 1 found (+1)'], code: 1 });
    expect(check({ backlog: 0 }, { backlog: 6 })).toEqual({ lines: ['backlog: baseline 6 exceeds 0 by more than slack 5; run --update'], code: 1 });
    expect(check({ backlog: 0 }, { backlog: 5 }).code).toBe(0);
  });

  it('rejects broken, fractional, negative, string and missing counters', () => {
    expect(() => currentCounts({ broken: () => { throw new Error('scanner failed'); } })).toThrow('counter "broken" failed to run: scanner failed');
    for (const value of [1.5, -1, '0', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => currentCounts({ broken: () => value })).toThrow('is not a count');
    }
    expect(() => currentCounts({})).toThrow('no counters configured');
    expect(() => check({ backlog: 0 }, { backlog: -1 })).toThrow('is not a count');
    expect(currentCounts({ measured: () => 2 })).toEqual({ measured: 2 });
  });

  it('update refuses rises or deleted counters and permits reductions beyond slack', () => {
    expect(planUpdate({ backlog: 0 }, { backlog: 10 })).toEqual({ refusals: [], next: { backlog: 0 } });
    expect(planUpdate({ backlog: 4 }, { backlog: 3 }).refusals).toEqual(['backlog: 3 -> 4 is a rise']);
    expect(planUpdate({}, { backlog: 3 }).refusals).toEqual(['backlog: no counter configured']);
    expect(planUpdate({ newCounter: 1 }, {}).refusals).toEqual(['newCounter: 0 -> 1 is a rise']);
  });
});

describe('finding identity and file-length allowances', () => {
  it('rejects replacing a finding when its aggregate count is unchanged', () => {
    const baseline = snapshot([finding('old')]);
    const current = snapshot([finding('replacement')]);
    expect(current.counts).toEqual(baseline.counts);
    const result = checkSnapshot(current, baseline);
    expect(result.code).toBe(1);
    expect(result.lines.join('\n')).toContain('new finding identity');
    expect(planSnapshotUpdate(current, baseline).refusals.join('\n')).toContain('new finding identity');
  });

  it('retains duplicate identities and ignores line shifts', () => {
    const one = finding('same source');
    expect(checkSnapshot(snapshot([{ ...one, line: 90 }]), snapshot([one])).code).toBe(0);
    const duplicates = snapshot([one, one]);
    expect(duplicates.findings[findingKey(one)]).toBe(2);
    expect(checkSnapshot(duplicates, snapshot([one])).code).toBe(1);
    expect(checkSnapshot(snapshot([one]), duplicates).code).toBe(0);
  });

  it('locks disappeared identities and per-file counters at zero', () => {
    const baseline = snapshot([finding('old')]);
    const result = planSnapshotUpdate(snapshot(), baseline);
    expect(result.refusals).toEqual([]);
    expect(result.next.findings).toEqual({});
    expect(Object.values(result.next.counts)).toEqual([0, 0, 0]);
    expect(checkSnapshot(snapshot([finding('old')]), result.next).code).toBe(1);
  });

  it('rejects aggregate length swaps and growth of existing oversized files', () => {
    const baseline = snapshot([], { 'old.ts': 450 });
    expect(checkSnapshot(snapshot([], { 'old.ts': 451 }), baseline).lines).toContain('old.ts: 450 code lines allowed, 451 found');
    const swapped = snapshot([], { 'old.ts': 399, 'new.ts': 400 });
    expect(swapped.counts.filesOverLength).toBe(baseline.counts.filesOverLength);
    expect(checkSnapshot(swapped, baseline).lines).toContain('new.ts: 399 code lines allowed, 400 found');
    const lowered = planSnapshotUpdate(snapshot([], { 'old.ts': 420 }), baseline);
    expect(lowered.next.lengths).toEqual({ 'old.ts': 420 });
    expect(checkSnapshot(snapshot([], { 'old.ts': 421 }), lowered.next).code).toBe(1);
    expect(checkSnapshot(snapshot([], { 'small.ts': 399 }), snapshot()).code).toBe(0);
    expect(checkSnapshot(snapshot([], { 'small.ts': 400 }), snapshot()).code).toBe(1);
  });
});

describe('C2 counts code with each language scanner', () => {
  it('ignores TS blank/comments, preserves URLs, templates, JSX and regex tokens', () => {
    expect(codeLineCount(file('probe.ts', '// comment\n\nconst url = "https://x/#/*"; // trailing\n/* block\n comment */\nconst template = `a\nb`;\nconst re = /https?:\\/\\//;\n'))).toBe(4);
    expect(codeLineCount(file('probe.tsx', '/* comment */\nexport const view = <div>\n  visible\n  {/* comment */}\n</div>;\n', '.tsx'))).toBe(4);
    const lines = Array.from({ length: 400 }, (_, index) => `export const v${index} = ${index};`).join('\n');
    expect(codeLineCount(file('probe.ts', lines))).toBe(400);
  });

  it('counts 400 JS/TS code lines consistently across compiler line terminators', () => {
    const separators = ['\n', '\r', '\r\n', String.fromCharCode(0x2028), String.fromCharCode(0x2029)];
    for (const separator of separators) {
      const text = ['// excluded comment', '', ...Array.from({ length: 400 }, (_, index) => `export const v${index} = ${index};`)];
      for (const language of ['.ts', '.js']) {
        const candidate = file(`probe${language}`, text.join(separator), language);
        const count = codeLineCount(candidate);
        expect(count).toBe(400);
        expect(checkSnapshot(snapshot([], { [candidate.path]: count }), snapshot()).code).toBe(1);
        expect(codeLineCount(file(`probe${language}`, ['export const text = `first', 'second`;'].join(separator), language))).toBe(2);
      }
    }
  });

  it('keeps Rust and PowerShell line and comment boundaries language-specific', () => {
    for (const separator of ['\n', '\r\n']) {
      const rust = ['// excluded comment', '', ...Array.from({ length: 400 }, (_, index) => `let v${index} = ${index};`)];
      expect(codeLineCount(file('probe.rs', rust.join(separator), '.rs'))).toBe(400);
    }
    for (const separator of ['\n', '\r', '\r\n']) {
      const powershell = ['# excluded comment', '', ...Array.from({ length: 400 }, (_, index) => `$v${index} = ${index}`)];
      expect(codeLineCount(file('probe.ps1', powershell.join(separator), '.ps1'))).toBe(400);
      expect(codeLineCount(file('probe.ps1', ['$x = @\'', '# literal content', '\'@', 'Write-Host $x'].join(separator), '.ps1'))).toBe(4);
    }
    // Rust comments only terminate at LF; PS and Rust do not adopt JS Unicode boundaries.
    expect(codeLineCount(file('probe.rs', '// still comment\rlet hidden = 1;\nlet visible = 2;', '.rs'))).toBe(1);
    for (const separator of [String.fromCharCode(0x2028), String.fromCharCode(0x2029)]) {
      expect(codeLineCount(file('probe.rs', `let first = 1;${separator}let second = 2;`, '.rs'))).toBe(1);
      expect(codeLineCount(file('probe.ps1', `$first = 1;${separator}$second = 2`, '.ps1'))).toBe(1);
      expect(codeLineCount(file('probe.ps1', `# still comment${separator}$hidden = 1\r$visible = 2`, '.ps1'))).toBe(1);
    }
  });

  it('uses Rust nested/raw-string and PowerShell here-string comment rules', () => {
    expect(codeLineCount(file('probe.rs', '// comment\n/* outer /* nested */ done */\nlet url = r#"https://x/*"#;\nlet life: &\'a str = "ok";\nlet char = \'/\';\n', '.rs'))).toBe(3);
    expect(codeLineCount(file('probe.ps1', '<# heading\ncomment #>\n$x = "https://x/#" # trailing\n$y = @\'\n# literal content\n\'@\nWrite-Host $y\n', '.ps1'))).toBe(5);
    expect(() => codeLineCount(file('probe.rs', '/* broken', '.rs'))).toThrow('unterminated block comment');
    expect(() => codeLineCount(file('probe.ps1', '$x = @\'\nbroken', '.ps1'))).toThrow('unterminated PowerShell here-string');
    expect(() => codeLineCount(file('probe.txt', 'unknown', '.txt'))).toThrow('unsupported code-line language');
  });
});

describe('supported C6 syntax has positive and negative controls', () => {
  it('rejects adding or replacing the second internal mock in the same file', () => {
    const production = ['first', 'second', 'replacement'].map((name) => file(`server/src/${name}.ts`, 'export const value = 1;'));
    const mocks = (names: string[]) => testQualityFindings([file('server/test/probe.test.ts', [
      'import { vi as mocker } from "vitest";',
      ...names.map((name) => `mocker.mock("../src/${name}.js");`),
    ].join('\n'))], production);
    const mockSnapshot = (names: string[]) => snapshotFrom(mocks(names), {}, ['internalMockFiles']);
    const one = mockSnapshot(['first']);
    const two = mockSnapshot(['first', 'second']);
    expect(two.counts['rule:internalMockFiles']).toBe(2);
    expect(Object.keys(two.findings)).toHaveLength(2);
    expect(checkSnapshot(two, one).code).toBe(1);
    expect(planSnapshotUpdate(two, one).refusals.join('\n')).toContain('is a rise');
    const replaced = mockSnapshot(['first', 'replacement']);
    expect(replaced.counts).toEqual(two.counts);
    expect(checkSnapshot(replaced, two).lines.join('\n')).toContain('internalMockFiles: new finding identity');
    expect(planSnapshotUpdate(replaced, two).refusals.join('\n')).toContain('new finding identity');
    expect(checkSnapshot(mockSnapshot(['first', 'second']), two).code).toBe(0);
    const duplicated = mockSnapshot(['first', 'first']);
    expect(duplicated.findings[findingKey(mocks(['first'])[0]!)]).toBe(2);
    expect(checkSnapshot(duplicated, one).code).toBe(1);
  });

  it('finds aliased internal mocks, positive existence and e2e timeout calls only', () => {
    const production = [file('server/src/service.ts', 'export const value = 1;'), file('shared/src/index.ts', 'export {};')];
    const tests = [file('server/test/probe.test.ts', [
      'import { vi as mocker, expect } from "vitest";',
      'mocker.mock("../src/service.js");',
      'mocker.mock("node:fs");',
      'expect(payload).toBeDefined();',
      'expect(payload).not.toBeDefined();',
      'expect(payload).toBeNull();',
      'expect(payload).toBe(false);',
      'expect(predicate()).toBe(true);',
      'expect(Boolean(payload)).toBe(true);',
      '// expect(payload).toBeTruthy();',
      'const sample = "expect(payload).toBeTruthy()";',
    ].join('\n')), file('tests-e2e/probe.spec.ts', 'await page.waitForTimeout(100);')];
    const results = testQualityFindings(tests, production);
    expect(results.map((item) => item.rule)).toEqual(['internalMockFiles', 'existenceAssertions', 'existenceAssertions', 'fixedSleeps']);
    expect(results.map((item) => item.line)).toEqual([2, 4, 9, 1]);
    expect(results[0]?.evidence).toBe('mocker.mock("../src/service.js")');
  });
});

describe('installed ESLint copy, accessibility, parser and identity controls', () => {
  it('counts direct JSX, templates, label properties and accessibility text, excluding test copy', async () => {
    const raw = file('ui/src/QualityProbe.tsx', [
      'export const labels = { label: "Choose a file", hint: `Read ${1} file` };',
      'export function Probe() { return <button aria-description="More detail" aria-valuetext={`Level ${1}`}>Raw copy</button>; }',
    ].join('\n'), '.tsx');
    const result = await lintFindings([raw], { virtual: true });
    expect(result.files).toBe(1);
    expect(result.rules).toContain('lint:jsx-a11y/alt-text');
    expect(result.findings.filter((item) => item.rule === 'lint:i18next/no-literal-string').length).toBeGreaterThan(0);
    expect(result.findings.filter((item) => item.rule === 'lint:no-restricted-syntax').length).toBeGreaterThanOrEqual(4);
    const testCopy = await lintFindings([file('ui/src/QualityProbe.test.tsx', raw.text, '.tsx')], { virtual: true });
    expect(testCopy.findings.filter((item) => item.rule === 'lint:i18next/no-literal-string' || item.rule === 'lint:no-restricted-syntax')).toEqual([]);
    const resource = await lintFindings([file('ui/src/copy.ts', 'export const copy = { label: "Choose a file" };')], { virtual: true });
    expect(resource.findings).toEqual([]);
  });

  it('preserves duplicate findings, tolerates layout changes and rejects malformed syntax', async () => {
    const text = 'export function Probe() { return <><span>Same</span><span>Same</span></>; }';
    const first = await lintFindings([file('ui/src/QualityProbe.tsx', text, '.tsx')], { virtual: true });
    const moved = await lintFindings([file('ui/src/QualityProbe.tsx', `\n// spacing\n${text}`, '.tsx')], { virtual: true });
    expect(first.findings.filter((item) => item.rule === 'lint:i18next/no-literal-string').length).toBe(2);
    expect(first.findings.map(findingKey)).toEqual(moved.findings.map(findingKey));
    await expect(lintFindings([file('ui/src/QualityProbe.tsx', 'export const broken = ;', '.tsx')], { virtual: true })).rejects.toThrow();
    await expect(lintFindings([], { virtual: true })).rejects.toThrow('lint measured no JS/TS files');
  });

  it('reports CLI option/configuration errors as infrastructure exit 2', async () => {
    const messages: string[] = [];
    const output = { log: (message: string) => messages.push(message), error: (message: string) => messages.push(message) };
    expect(await run(['--unknown'], output)).toBe(2);
    expect(messages.join('\n')).toContain('unknown option --unknown');
    expect(await run(['--init'], output)).toBe(2);
    expect(messages.join('\n')).toContain('--init requires --update');
  });
});
