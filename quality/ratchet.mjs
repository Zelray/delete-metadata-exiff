import { readFileSync, writeFileSync, realpathSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, sourceFiles, testFiles, repositoryPaths, readRepoFile } from './inventory.mjs';
import { CONTRACT_RULES, contractFindings, partitionContractFindings } from './contracts.mjs';
import { codeLineCount } from './code-lines.mjs';
import { lintFindings, testQualityFindings, TEST_RULES } from './lint.mjs';
export { codeLineCount, normalizedNode, parseSource } from './code-lines.mjs';
export { lintFindings, testQualityFindings } from './lint.mjs';

export const baselinePath = path.join(ROOT, '.quality-baseline.json');
export const SLACK = 5;
export const MAX_CODE_LINES = 399;
export const counters = { filesOverLength: () => sourceFiles().filter((file) => codeLineCount(file) > MAX_CODE_LINES).length };
const own = (object, key) => Object.hasOwn(object, key);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const countValid = (value) => Number.isSafeInteger(value) && value >= 0;
const ruleKey = (rule) => `rule:${rule}`;
const fileKey = (file, rule) => `file:${JSON.stringify([file, rule])}`;
export const findingKey = (finding) => JSON.stringify([finding.path, finding.rule,
  createHash('sha256').update(finding.identity ?? finding.evidence).digest('hex')]);

function validateCounts(counts, label) {
  if (!object(counts)) throw new Error(`${label} must be an object of counts`);
  for (const [name, value] of Object.entries(counts)) {
    if (!name || !countValid(value)) throw new Error(`${label} ${name}: ${JSON.stringify(value)} is not a count`);
  }
}

/** Reference API: a thrown/broken counter never becomes a zero. */
export function currentCounts(config = counters) {
  if (!object(config) || Object.keys(config).length === 0) throw new Error('no counters configured');
  const counts = {};
  for (const [name, counter] of Object.entries(config)) {
    try {
      if (typeof counter !== 'function') throw new Error('counter is not a function');
      counts[name] = counter();
    } catch (error) { throw new Error(`counter "${name}" failed to run: ${error.message}`); }
  }
  validateCounts(counts, 'counter');
  return counts;
}

/** Union includes baseline-only names; removing a configured counter is a failure. */
export function check(counts, baseline, slack = SLACK) {
  validateCounts(counts, 'current'); validateCounts(baseline, 'baseline');
  if (!countValid(slack)) throw new Error('invalid slack');
  const lines = [];
  for (const name of [...new Set([...Object.keys(counts), ...Object.keys(baseline)])].sort()) {
    if (!own(counts, name)) lines.push(`${name}: in baseline but no counter configured`);
    else if (counts[name] > (baseline[name] ?? 0)) lines.push(`${name}: ${baseline[name] ?? 0} allowed, ${counts[name]} found (+${counts[name] - (baseline[name] ?? 0)})`);
    else if ((baseline[name] ?? 0) - counts[name] > slack) lines.push(`${name}: baseline ${baseline[name]} exceeds ${counts[name]} by more than slack ${slack}; run --update`);
    else if (counts[name] < (baseline[name] ?? 0)) lines.push(`${name}: ${baseline[name]} -> ${counts[name]}, run --update to lock gain`);
  }
  const code = lines.some((line) => !line.endsWith('run --update to lock gain')) ? 1 : 0;
  return { lines, code };
}

export function planUpdate(counts, baseline) {
  validateCounts(counts, 'current'); validateCounts(baseline, 'baseline');
  const refusals = [];
  for (const [name, value] of Object.entries(counts)) {
    if (value > (baseline[name] ?? 0)) refusals.push(`${name}: ${baseline[name] ?? 0} -> ${value} is a rise`);
  }
  for (const name of Object.keys(baseline)) if (!own(counts, name)) refusals.push(`${name}: no counter configured`);
  return { refusals, next: { ...baseline, ...counts } };
}

function validateSnapshot(snapshot) {
  if (!object(snapshot) || snapshot.version !== 1) throw new Error('baseline format/version invalid; expected version 1');
  for (const key of ['counts', 'findings', 'lengths']) validateCounts(snapshot[key], key);
  for (const key of Object.keys(snapshot.findings)) {
    const parts = JSON.parse(key);
    if (!Array.isArray(parts) || parts.length !== 3 || parts.some((part) => typeof part !== 'string' || !part)) throw new Error('invalid finding fingerprint');
  }
  return snapshot;
}

export function snapshotFrom(findings, lengths, rules) {
  validateCounts(lengths, 'lengths');
  const counts = { filesOverLength: Object.values(lengths).filter((length) => length > MAX_CODE_LINES).length };
  const fingerprints = {};
  for (const rule of rules) counts[ruleKey(rule)] = 0;
  for (const finding of findings) {
    if (!finding.path || !finding.rule || !(finding.identity ?? finding.evidence)) throw new Error('finding lacks path/rule/identity');
    const key = findingKey(finding);
    fingerprints[key] = (fingerprints[key] ?? 0) + 1;
    counts[ruleKey(finding.rule)] = (counts[ruleKey(finding.rule)] ?? 0) + 1;
    counts[fileKey(finding.path, finding.rule)] = (counts[fileKey(finding.path, finding.rule)] ?? 0) + 1;
  }
  return { version: 1, counts, findings: fingerprints, lengths: { ...lengths } };
}

function countsWithTombstones(snapshot, baseline) {
  const counts = { ...snapshot.counts };
  for (const name of Object.keys(baseline.counts)) if (name.startsWith('file:') && !own(counts, name)) {
    const parts = JSON.parse(name.slice(5));
    if (!Array.isArray(parts) || parts.length !== 2) throw new Error(`invalid file counter ${name}`);
    if (own(counts, ruleKey(parts[1]))) counts[name] = 0;
  }
  return counts;
}

function identityAndLengthFailures(snapshot, baseline) {
  const lines = [];
  for (const [key, count] of Object.entries(snapshot.findings)) {
    const allowed = baseline.findings[key] ?? 0;
    if (count > allowed) {
      const [file, rule] = JSON.parse(key);
      lines.push(`${file}: ${rule}: new finding identity (${count - allowed} new occurrence(s)): ${JSON.parse(key)[2]}`);
    }
  }
  for (const [file, length] of Object.entries(snapshot.lengths)) {
    const allowed = Math.max(MAX_CODE_LINES, baseline.lengths[file] ?? MAX_CODE_LINES);
    if (length > allowed) lines.push(`${file}: ${allowed} code lines allowed, ${length} found`);
  }
  return lines;
}

export function checkSnapshot(snapshot, baseline) {
  validateSnapshot(snapshot); validateSnapshot(baseline);
  const counts = countsWithTombstones(snapshot, baseline);
  const result = check(counts, baseline.counts);
  const failures = identityAndLengthFailures(snapshot, baseline);
  return { lines: [...result.lines, ...failures], code: failures.length ? 1 : result.code };
}

export function planSnapshotUpdate(snapshot, baseline) {
  validateSnapshot(snapshot); validateSnapshot(baseline);
  const counts = countsWithTombstones(snapshot, baseline);
  const planned = planUpdate(counts, baseline.counts);
  const refusals = [...planned.refusals, ...identityAndLengthFailures(snapshot, baseline)];
  const lengths = {};
  for (const [file, length] of Object.entries(baseline.lengths)) lengths[file] = Math.min(length, snapshot.lengths[file] ?? 0);
  return { refusals, next: { version: 1, counts: planned.next, findings: { ...snapshot.findings }, lengths } };
}

function toolingFiles() {
  return repositoryPaths().filter((name) => (name.startsWith('quality/') || name === 'eslint.config.mjs')
    && /\.[cm]?[jt]sx?$/.test(name)).map((name) => ({ path: name, text: readRepoFile(ROOT, name), language: path.extname(name) }));
}

const REQUIRED_PATHS = ['server/src/index.ts', 'ui/src/App.tsx', 'shared/src/index.ts', 'bin/metadesk.mjs',
  'scripts/verify-lifecycle-contract.mjs', 'tauri/src-tauri/src/main.rs'];
function fixtureFiles(directory) {
  const root = realpathSync(directory);
  if (root === realpathSync(ROOT)) throw new Error('fixture root must be an owned scratch directory');
  const files = [];
  function visit(relative) {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('fixture symlinks are forbidden');
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(name);
      else if (/\.(?:[cm]?[jt]sx?|rs|ps1)$/.test(name)) files.push({ path: name, text: readFileSync(path.join(root, name), 'utf8'), language: path.extname(name) });
    }
  }
  visit('');
  if (!files.length) throw new Error('empty fixture inventory');
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

const FIXTURE_TEST_PATH = /(^|\/)(?:__tests__|tests?|tests-e2e)(\/|$)|\.(test|spec)\.[^.]+$/;
export async function measure({ fixtureRoot } = {}) {
  const fixtures = fixtureRoot ? fixtureFiles(fixtureRoot) : null;
  const production = fixtures ? fixtures.filter((file) => !FIXTURE_TEST_PATH.test(file.path)) : sourceFiles();
  const tests = fixtures ? fixtures.filter((file) => FIXTURE_TEST_PATH.test(file.path)) : testFiles();
  if (!production.length) throw new Error('empty production inventory');
  const tooling = fixtureRoot ? [] : toolingFiles();
  if (!fixtureRoot) for (const required of REQUIRED_PATHS) {
    if (!production.some((file) => file.path === required)) throw new Error(`required inventory path missing: ${required}`);
  }
  const lengths = Object.fromEntries([...production, ...tooling].map((file) => [file.path, codeLineCount(file)]));
  const lint = await lintFindings([...production, ...tests, ...tooling], { virtual: Boolean(fixtureRoot) });
  const contracts = partitionContractFindings(contractFindings(production));
  if (contracts.clean.length) throw new Error(`clean instruction contract violated: ${contracts.clean.map((finding) => `${finding.path}:${finding.line} ${finding.rule}: ${finding.evidence}`).join('\n')}`);
  const findings = [...lint.findings, ...contracts.ratcheted, ...testQualityFindings(tests, production)];
  return { ...snapshotFrom(findings, lengths, [...lint.rules, ...CONTRACT_RULES, ...TEST_RULES]), diagnostics: findings,
    denominators: { production: production.length, tests: tests.length, tooling: tooling.length,
      lintFiles: lint.files, lintRules: lint.rules.length, lengthFiles: Object.keys(lengths).length } };
}

function seed(snapshot) {
  return { version: 1, counts: snapshot.counts, findings: snapshot.findings,
    lengths: Object.fromEntries(Object.entries(snapshot.lengths).filter(([, length]) => length > MAX_CODE_LINES)) };
}

function options(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--update' || argument === '--init' || argument === '--report') parsed[argument.slice(2)] = true;
    else if (argument === '--baseline' || argument === '--fixture-root') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${argument} needs a path`);
      parsed[argument === '--baseline' ? 'baseline' : 'fixtureRoot'] = path.resolve(value);
    } else throw new Error(`unknown option ${argument}`);
  }
  if (parsed.init && !parsed.update) throw new Error('--init requires --update');
  if (parsed.fixtureRoot && !parsed.baseline) throw new Error('--fixture-root requires an explicit scratch --baseline');
  if (parsed.fixtureRoot && path.resolve(parsed.baseline) === baselinePath) throw new Error('fixture cannot use product baseline');
  return parsed;
}

export async function run(argv, output = console) {
  try {
    const config = options(argv);
    const file = config.baseline ?? baselinePath;
    let baseline;
    try { baseline = validateSnapshot(JSON.parse(readFileSync(file, 'utf8'))); }
    catch (error) {
      if (!(error.code === 'ENOENT' && config.init && config.update)) throw new Error(`cannot read baseline ${file}: ${error.message}`);
    }
    if (baseline && config.init) throw new Error('--init refuses an existing baseline');
    const snapshot = await measure(config);
    output.log(`Ratchet denominators: ${JSON.stringify(snapshot.denominators)}`);
    if (config.report) for (const finding of snapshot.diagnostics) output.log(`${finding.path}:${finding.line} ${finding.rule}: ${finding.evidence}`);
    for (const [name, count] of Object.entries(snapshot.counts).sort(([a], [b]) => a.localeCompare(b))) {
      if (config.report || name === 'filesOverLength' || (name.startsWith('rule:') && count > 0)) output.log(`${name}: ${count}`);
    }
    for (const [name, length] of Object.entries(snapshot.lengths).filter(([, length]) => length > MAX_CODE_LINES)) output.log(`${name}: ${length} code lines (C2)`);
    if (!baseline) {
      writeFileSync(file, `${JSON.stringify(seed(snapshot), null, 2)}\n`, { flag: 'wx' });
      output.log('RATCHET_INITIALIZED: review the measured backlog before committing'); return 0;
    }
    if (config.update) {
      const planned = planSnapshotUpdate(snapshot, baseline);
      for (const line of planned.refusals) output.log(line);
      if (planned.refusals.length) { output.log('--update only lowers; increases need a reviewed hand edit with a reason (C7)'); return 1; }
      writeFileSync(file, `${JSON.stringify(planned.next, null, 2)}\n`);
      output.log('RATCHET_UPDATED: counts, identities and oversized allowances only hold or fall'); return 0;
    }
    const result = checkSnapshot(snapshot, baseline);
    result.lines.forEach((line) => output.log(line));
    if (!result.code) output.log('RATCHET_OK: counts, finding identities and file lengths within baseline');
    return result.code;
  } catch (error) { output.error(`ratchet infrastructure: ${error.message}`); return 2; }
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (invokedDirectly()) process.exitCode = await run(process.argv.slice(2));
