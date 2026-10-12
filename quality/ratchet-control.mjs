import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './inventory.mjs';

/** Every child must return the expected status AND the diagnostic for the intended defect. */
export function runControls(output = console) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'metadesk-ratchet-control-'));
  const baseline = path.join(scratch, 'baseline.json');
  const fixtureRoot = path.join(scratch, 'source');
  const source = path.join(fixtureRoot, 'ui', 'src', 'Control.tsx');
  mkdirSync(path.dirname(source), { recursive: true });
  const cli = path.join(ROOT, 'quality', 'ratchet.mjs');
  let runs = 0;
  function invoke(extra, expected, evidence) {
    const result = spawnSync(process.execPath, [cli, '--baseline', baseline, '--fixture-root', fixtureRoot, ...extra],
      { cwd: ROOT, shell: false, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    const transcript = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    runs += 1;
    if (result.error || result.signal || result.status !== expected || !evidence.test(transcript)) {
      throw new Error(`control ${runs}: expected exit ${expected} and ${evidence}, got ${result.status}\n${result.error?.message ?? ''}\n${transcript}`);
    }
    output.log(`control ${runs}: exit ${result.status}, matched ${evidence}`);
  }
  function put(text) { writeFileSync(source, text); }
  function savedBaseline() { return readFileSync(baseline, 'utf8'); }
  function save(value) { writeFileSync(baseline, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); }
  const clean = 'export function Control() { return <span>{42}</span>; }\n';
  try {
    put(clean);
    invoke([], 2, /cannot read baseline/);
    invoke(['--update', '--init'], 0, /RATCHET_INITIALIZED/);
    invoke([], 0, /RATCHET_OK/);
    const initial = savedBaseline();
    put('export function Control() { return <span>New raw copy</span>; }\n');
    invoke([], 1, /lint:i18next\/no-literal-string: new finding identity/);
    invoke(['--update'], 1, /--update only lowers/);
    if (savedBaseline() !== initial) throw new Error('refused update changed baseline');
    put(clean);
    invoke([], 0, /RATCHET_OK/);

    // Initialize a separate owned backlog, then substitute different text at the same count.
    rmSync(baseline);
    put('export function Control() { return <span>Old approved copy</span>; }\n');
    invoke(['--update', '--init'], 0, /RATCHET_INITIALIZED/);
    put('export function Control() { return <span>Different replacement copy</span>; }\n');
    invoke([], 1, /new finding identity/);
    put('export function Control() { return <span>Old approved copy</span>; }\n');
    invoke([], 0, /RATCHET_OK/);
    put(clean);
    invoke(['--update'], 0, /RATCHET_UPDATED/);
    put('export function Control() { return <span>Old approved copy</span>; }\n');
    invoke([], 1, /new finding identity/);
    put(clean);
    invoke([], 0, /RATCHET_OK/);
    const lowered = savedBaseline();
    const deleted = JSON.parse(lowered);
    deleted.counts.retiredCounter = 1;
    save(deleted);
    invoke([], 1, /retiredCounter: in baseline but no counter configured/);
    save(lowered);
    const raised = JSON.parse(lowered);
    raised.counts['rule:existenceAssertions'] = 6;
    save(raised);
    invoke([], 1, /more than slack 5/);
    save(lowered);
    save('{ invalid json');
    invoke(['--update', '--init'], 2, /cannot read baseline/);
    save(lowered);
    put('export const broken = ;\n');
    invoke([], 2, /ratchet infrastructure/);
    put(clean);
    invoke([], 0, /RATCHET_OK/);

    rmSync(baseline);
    const shared = path.join(fixtureRoot, 'shared', 'src');
    const mockTest = path.join(fixtureRoot, 'server', 'test', 'MockControl.test.ts');
    mkdirSync(shared, { recursive: true });
    mkdirSync(path.dirname(mockTest), { recursive: true });
    for (const name of ['first', 'second', 'replacement']) writeFileSync(path.join(shared, `${name}.ts`), 'export const value = 1;\n');
    function mockCalls(names) {
      writeFileSync(mockTest, ['import { vi as mocker } from "vitest";',
        ...names.map((name) => `mocker.mock("../../shared/src/${name}.js");`)].join('\n'));
    }
    mockCalls(['first']);
    invoke(['--update', '--init'], 0, /RATCHET_INITIALIZED/);
    const oneMockBaseline = savedBaseline();
    mockCalls(['first', 'second']);
    invoke([], 1, /rule:internalMockFiles: 1 allowed, 2 found/);
    invoke(['--update'], 1, /--update only lowers/);
    if (savedBaseline() !== oneMockBaseline) throw new Error('second-mock refused update changed baseline');
    mockCalls(['first']);
    invoke([], 0, /RATCHET_OK/);
    rmSync(baseline);
    mockCalls(['first', 'second']);
    invoke(['--update', '--init'], 0, /RATCHET_INITIALIZED/);
    mockCalls(['first', 'replacement']);
    invoke([], 1, /internalMockFiles: new finding identity/);
    mockCalls(['first', 'second']);
    invoke([], 0, /RATCHET_OK/);
    rmSync(mockTest);

    rmSync(baseline);
    put(Array.from({ length: 400 }, (_, index) => `export const value${index} = ${index};`).join('\n'));
    invoke(['--update', '--init'], 0, /RATCHET_INITIALIZED/);
    put(Array.from({ length: 401 }, (_, index) => `export const value${index} = ${index};`).join('\n'));
    invoke([], 1, /400 code lines allowed, 401 found/);
    put(Array.from({ length: 399 }, (_, index) => `export const value${index} = ${index};`).join('\n'));
    invoke(['--update'], 0, /RATCHET_UPDATED/);
    put(Array.from({ length: 400 }, (_, index) => `export const value${index} = ${index};`).join('\n'));
    invoke([], 1, /399 code lines allowed, 400 found/);
    put(Array.from({ length: 399 }, (_, index) => `export const value${index} = ${index};`).join('\n'));
    invoke([], 0, /RATCHET_OK/);
    // An existing 399-line allowance must reject 400 standalone-CR lines too.
    put(Array.from({ length: 400 }, (_, index) => `export const value${index} = ${index};`).join('\r'));
    invoke([], 1, /399 code lines allowed, 400 found/);
    put(Array.from({ length: 399 }, (_, index) => `export const value${index} = ${index};`).join('\r'));
    invoke([], 0, /RATCHET_OK/);
    output.log(`RATCHET_CONTROLS_OK: ${runs} CLI controls; every rejection restored to passing scratch input`);
    return 0;
  } catch (error) { output.error(`ratchet control failure: ${error.message}`); return 2; }
  finally { rmSync(scratch, { recursive: true, force: true }); }
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (invokedDirectly()) process.exitCode = runControls();
