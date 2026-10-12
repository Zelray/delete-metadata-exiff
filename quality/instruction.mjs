import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { ROOT, SOURCE_SCOPES, TEST_SCOPES, sourceFiles, testFiles, repositoryPaths, trackedPaths,
  changedPaths, safeFile, readRepoFile, git } from './inventory.mjs';
import { contractFindings, partitionContractFindings } from './contracts.mjs';

export const WORD_BUDGET = 3000;
export const REQUIRED_INSTRUCTIONS = ['AGENTS.md', 'AGENTS.project.md', 'CLAUDE.md',
  'agents/generic/agent-workflows.md', 'agents/project/domain-context.md', 'agents/project/glossary.md',
  'agents/project/out-of-scope.md', 'agents/project/testing.md', 'agents/project/documentation.md',
  'agents/project/agent-workflows.md'];
export const HELP_PAIR = ['resources/help/metadesk-help.md', 'ui/src/shell/HelpOverlay.tsx'];
const TEMPLATE_HASHES = { 'AGENTS.md': 'fd143fef9fa05836fbb8632962ede7815ce5756fd20c72355044839cc004bac0',
  'agents/generic/agent-workflows.md': 'ccacc5a9e9eb75224ee18a60011414153d24b359f8d3d3039fb909c24617f169' };
const CONTRACT_NAMES = ['Engine arguments', 'Server write pipeline', 'UI write consent', 'API transport', 'Lifecycle'];
const JS = /^\.(?:[cm]?[jt]s|[jt]sx)$/;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const words = (text) => text.split(/\s+/).filter(Boolean).length;

export function foldFields(body) {
  const fields = [];
  let open = false;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) open = false;
    else if (/^(Owns|Path|Never|Gate):/.test(line)) { fields.push(line); open = true; }
    else if (open) fields[fields.length - 1] += ` ${line}`;
  }
  return fields;
}

function parseContracts(text) {
  const section = text.split('## Architecture contracts')[1]?.split('\n## ')[0] ?? '';
  return section.split('\n### ').slice(1).map((block) => {
    const [name, ...body] = block.split('\n');
    return { name: name.trim(), fields: foldFields(body.join('\n')) };
  });
}

/** Require declarations, not imports, re-exports, uses, comments, or quoted examples. */
function hasSymbol(file, symbol) {
  if (JS.test(file.language)) {
    const ast = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true,
      /\.[jt]sx$/.test(file.language) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    let found = false;
    function bindingHasName(name) {
      if (ts.isIdentifier(name)) return name.text === symbol;
      if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
        return name.elements.some((element) => ts.isBindingElement(element) && bindingHasName(element.name));
      }
      return false;
    }
    function visit(node) {
      const implementation = (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.body;
      const declaration = implementation || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)
        || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
        || (ts.isVariableDeclaration(node) && node.initializer);
      if (declaration && node.name && bindingHasName(node.name)) found = true;
      ts.forEachChild(node, visit);
    }
    visit(ast);
    return found;
  }
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (file.language === '.rs') return new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?(?:fn|struct|enum|const|type)\\s+${escaped}\\b`, 'm').test(file.text);
  if (file.language === '.ps1') return new RegExp(`^\\s*function\\s+${escaped}\\b`, 'mi').test(file.text);
  return false;
}

export function vendorSnapshot(root = ROOT, tracked = trackedPaths(root)) {
  const names = tracked.filter((name) => name.startsWith('vendor/exiftool/')).sort();
  const digest = createHash('sha256');
  for (const name of names) {
    digest.update(`${name}\0${sha256(readFileSync(safeFile(root, name)))}\n`);
  }
  return { version: 1, scope: 'vendor/exiftool/', fileCount: names.length, sha256: digest.digest('hex') };
}

export function loadInstructionInputs(root = ROOT, changed) {
  const paths = repositoryPaths(root);
  const texts = Object.fromEntries(paths.filter((name) => REQUIRED_INSTRUCTIONS.includes(name)
    || /^agents\/.*\.md$/.test(name)).map((name) => [name, readRepoFile(root, name)]));
  const docs = paths.filter((name) => name.startsWith('docs/') && /\.(md|rst)$/.test(name))
    .map((name) => ({ path: name, text: readRepoFile(root, name) }));
  const tracked = trackedPaths(root);
  return { texts, paths, files: sourceFiles(root), tests: testFiles(root), docs, tracked,
    changed: changed ?? changedPaths(root), vendorBaseline: JSON.parse(readRepoFile(root, 'quality/vendor-baseline.json')),
    vendorActual: vendorSnapshot(root, tracked), commitExists: (hash) => {
      try { git(['cat-file', '-e', `${hash}^{commit}`], root); return true; } catch { return false; }
    } };
}

/** Pure fixture seam. All loaded inputs are explicit so negative controls cannot mutate the app. */
export function inspectInstructions(input) {
  const findings = [];
  const stats = { words: 0, wordBudget: WORD_BUDGET, contracts: 0, tokens: 0, knowledgeFiles: 0,
    commitHashes: 0, docs: input.docs.length, ruleReferences: 0, sources: input.files.length,
    tests: input.tests.length, parsedSources: input.files.filter((file) => JS.test(file.language)).length,
    reviewSources: input.files.filter((file) => !JS.test(file.language)).length, vendorFiles: input.vendorActual.fileCount,
    sourceScopes: {}, testScopes: {}, processFindings: 0 };
  const add = (rule, target, evidence, line = 1) => findings.push({ rule, path: target, line, evidence });
  for (const scope of SOURCE_SCOPES) {
    const count = input.files.filter((file) => file.path.startsWith(`${scope}/`)).length;
    stats.sourceScopes[scope] = count;
    if (!count) add('instruction-denominator', scope, 'empty required production scope');
  }
  for (const scope of TEST_SCOPES) {
    const count = input.tests.filter((file) => file.path.startsWith(`${scope}/`)).length;
    stats.testScopes[scope] = count;
    if (!count) add('instruction-denominator', scope, 'empty required test scope');
  }
  if (!stats.parsedSources || !stats.docs) add('instruction-denominator', 'quality/instruction.mjs', 'empty source or documentation denominator');
  for (const name of REQUIRED_INSTRUCTIONS) {
    if (!input.texts[name]?.trim()) add('instruction-required', name, 'required instruction file missing or empty');
  }
  for (const name of REQUIRED_INSTRUCTIONS.slice(0, 3)) stats.words += words(input.texts[name] ?? '');
  if (stats.words > WORD_BUDGET) add('instruction-budget', 'AGENTS.project.md', `${stats.words} words exceed ${WORD_BUDGET}`);
  for (const [name, expected] of Object.entries(TEMPLATE_HASHES)) {
    if (sha256((input.texts[name] ?? '').replace(/\r\n/g, '\n')) !== expected) add('instruction-template', name, 'immutable template differs');
  }
  const core = (input.texts['AGENTS.md'] ?? '').toLowerCase();
  for (const token of ['metadesk', 'exiftool', 'fastify', 'react', 'server/src', 'ui/src', 'vendor/exiftool']) {
    if (new RegExp(`\\b${token}\\b`, 'i').test(core)) add('instruction-portable', 'AGENTS.md', `project token ${token}`);
  }
  const loader = (input.texts['CLAUDE.md'] ?? '').replace(/\r\n/g, '\n');
  if (loader !== 'Use @AGENTS.md and @AGENTS.project.md as your instructions\nMulti-agent or long-running work? Read agents/generic/agent-workflows.md first.\n') {
    add('instruction-loader', 'CLAUDE.md', 'loader must import both instruction files and the workflow playbook');
  }
  const contracts = parseContracts(input.texts['AGENTS.project.md'] ?? '');
  stats.contracts = contracts.length;
  if (contracts.length !== 5 || CONTRACT_NAMES.some((name) => !contracts.some((contract) => contract.name === name))) {
    add('instruction-contract', 'AGENTS.project.md', 'expected the five verified contracts');
  }
  for (const contract of contracts) {
    for (const name of ['Owns', 'Path', 'Never', 'Gate']) {
      if (!contract.fields.some((field) => field.startsWith(`${name}:`) && field.slice(name.length + 1).trim())) {
        add('instruction-contract', 'AGENTS.project.md', `${contract.name}: missing ${name}`);
      }
    }
    let resolved = 0;
    for (const field of contract.fields.filter((line) => /^(Path|Gate):/.test(line))) {
      const isPath = field.startsWith('Path:');
      for (const group of isPath ? field.split(';') : [field]) {
        const tokens = [...group.matchAll(/`([^`]+)`/g)].map((match) => match[1].replace(/\(\)$/, ''));
        for (const [index, token] of tokens.entries()) {
          if (token.includes('/')) {
            if (!input.paths.includes(token)) add('instruction-reference', 'AGENTS.project.md', `${contract.name}: path ${token} missing`);
          } else {
            const owner = isPath ? tokens.slice(index + 1).find((name) => name.includes('/')) : undefined;
            const scope = isPath ? input.files.filter((file) => file.path === owner) : input.files;
            if (!scope.some((file) => hasSymbol(file, token))) {
              add('instruction-reference', 'AGENTS.project.md', `${contract.name}: declaration ${token} missing in ${isPath ? owner ?? 'unpaired Path symbol' : 'production source'}`);
            }
          }
          stats.tokens++; resolved++;
        }
      }
    }
    if (!resolved) add('instruction-denominator', 'AGENTS.project.md', `${contract.name}: no reference tokens`);
  }
  const knowledge = Object.entries(input.texts).filter(([name]) => name.startsWith('agents/'));
  stats.knowledgeFiles = knowledge.length;
  for (const [name, text] of knowledge) {
    if (/\b\d{1,3}(?:\.\d{1,3}){3}\b|\b[\w.+-]+@[\w-]+\.[A-Za-z]{2,}\b/.test(text)) add('instruction-private', name, 'email or IP address in knowledge');
    if (/\b[A-Z]:[\\/]|\\\\[\w-]+\\|\b(?:[a-f\d]{0,4}:){2,}[a-f\d:]+\b/i.test(text)) add('instruction-private', name, 'machine path or IPv6 address in knowledge');
  }
  const hashes = [...new Set((input.texts['agents/project/domain-context.md'] ?? '').match(/\b[0-9a-f]{7,40}\b/g) ?? [])].filter((hash) => /\d/.test(hash));
  stats.commitHashes = hashes.length;
  for (const hash of hashes) if (!input.commitExists(hash)) add('instruction-history', 'agents/project/domain-context.md', `commit ${hash} absent; CI requires full history`);
  if (!hashes.length) add('instruction-denominator', 'agents/project/domain-context.md', 'no evidence hashes checked');
  const validRules = new Set();
  for (const name of ['AGENTS.md', 'AGENTS.project.md']) {
    for (const match of (input.texts[name] ?? '').matchAll(/^- ([A-Z]+[0-9]+)\./gm)) validRules.add(match[1]);
  }
  for (const doc of input.docs) {
    for (const match of doc.text.matchAll(/\brules?\s+((?:[IPCM]|MD)[0-9]+)\b/gi)) {
      stats.ruleReferences++;
      if (!validRules.has(match[1].toUpperCase())) add('instruction-rule', doc.path, `unknown rule ${match[1]}`);
    }
  }
  if (!validRules.size) add('instruction-denominator', 'AGENTS.md', 'no rule definitions checked');
  for (const name of input.tracked.filter((file) => file.startsWith('data/') && file !== 'data/.gitkeep')) add('instruction-runtime', name, 'runtime state must remain untracked');
  const baseline = input.vendorBaseline;
  if (baseline.version !== 1 || baseline.scope !== 'vendor/exiftool/' || baseline.fileCount < 1
    || !/^[a-f\d]{64}$/.test(baseline.sha256) || baseline.fileCount !== input.vendorActual.fileCount
    || baseline.sha256 !== input.vendorActual.sha256) add('instruction-vendor', 'quality/vendor-baseline.json', 'tracked vendor file set or content changed');
  for (const name of HELP_PAIR) if (!input.paths.includes(name)) add('instruction-help', name, 'help mirror missing or deleted');
  const touched = HELP_PAIR.filter((name) => input.changed.includes(name));
  if (touched.length === 1) add('instruction-help', touched[0], `update both help mirrors: ${HELP_PAIR.join(', ')}`);
  const partition = partitionContractFindings(contractFindings(input.files));
  findings.push(...partition.clean);
  stats.processFindings = partition.ratcheted.length;
  return { findings, stats, processFindings: partition.ratcheted };
}

export function runInstructionGate(options = {}) {
  return inspectInstructions(loadInstructionInputs(options.root ?? ROOT, options.changedPaths));
}

function controlSnapshot(input) {
  const declarations = {
    'server/src/engine/engineArgs.ts': 'export function assertArgsSafe() {}',
    'server/src/engine/argBuilder.ts': 'export function buildWriteArgs() {}',
    'server/src/engine/exiftoolSession.ts': 'export class ExifToolSession {}',
    'server/src/writeSubsystem.ts': 'export class WriteSubsystem {}',
    'server/src/services/writePipeline.ts': 'export class WritePipeline {}',
    'server/src/routes/writes.ts': 'export function registerWriteRoutes() {}',
    'server/src/index.ts': 'export function buildServer() {} export function writePortfile() {}',
    'ui/src/write/useWriteRun.tsx': 'export function useWriteRunner() {}',
    'ui/src/state/store.ts': 'export const useUiStore = {};',
    'ui/src/api/client.ts': 'function send() {} function authHeaders() {} function readSse() {}',
    'shared/src/index.ts': 'export const shared = true;',
    'bin/metadesk.mjs': 'function runStart() {} function gracefulStop() {}',
    'scripts/control.mjs': 'export const control = true;',
    'tauri/src-tauri/src/engine.rs': 'pub fn spawn_engine() {}\npub fn launch_sweep() {}',
  };
  return { ...input, texts: { ...input.texts }, changed: [], files: Object.entries(declarations)
    .map(([name, text]) => ({ path: name, text, language: path.extname(name) })),
    tests: input.tests.map((file) => ({ ...file, text: '' })), docs: input.docs.map((doc) => ({ ...doc, text: '' })) };
}

/** Each control asserts a specific gate finding; fixtures share no mutable app state. */
export function runInstructionControls(input = loadInstructionInputs()) {
  const base = controlSnapshot(input);
  const baseline = inspectInstructions(base);
  if (baseline.findings.length) throw new Error(`control baseline failed: ${JSON.stringify(baseline.findings)}`);
  const results = [];
  const check = (name, mutate, rule) => {
    const fixture = { ...base, texts: { ...base.texts }, paths: [...base.paths], files: base.files.map((file) => ({ ...file })),
      tests: base.tests.map((file) => ({ ...file })), docs: base.docs.map((doc) => ({ ...doc })),
      changed: [], tracked: [...base.tracked], vendorActual: { ...base.vendorActual } };
    mutate(fixture);
    const result = inspectInstructions(fixture);
    if (!result.findings.some((finding) => finding.rule === rule)) throw new Error(`${name}: missing expected ${rule} finding`);
    results.push({ name, rule, findings: result.findings.length });
  };
  const addSource = (fixture, name, text) => fixture.files.push({ path: name, text, language: path.extname(name) });
  check('missing contract path', (fixture) => { fixture.paths = fixture.paths.filter((name) => name !== 'ui/src/api/client.ts'); }, 'instruction-reference');
  check('comment-only symbol', (fixture) => { fixture.files.find((file) => file.path === 'ui/src/api/client.ts').text = '// send authHeaders readSse'; }, 'instruction-reference');
  check('moved declaration retains import and use', (fixture) => {
    fixture.files.find((file) => file.path === 'server/src/engine/engineArgs.ts').text = "import { assertArgsSafe } from './argBuilder'; assertArgsSafe([]);";
    fixture.files.find((file) => file.path === 'server/src/engine/argBuilder.ts').text += '\nexport function assertArgsSafe() {}';
  }, 'instruction-reference');
  check('wrong paired file still exists', (fixture) => {
    fixture.texts['AGENTS.project.md'] = fixture.texts['AGENTS.project.md'].replace(
      '`assertArgsSafe` (`server/src/engine/engineArgs.ts`); `buildWriteArgs`\n  (`server/src/engine/argBuilder.ts`)',
      '`assertArgsSafe` (`server/src/engine/argBuilder.ts`); `buildWriteArgs`\n  (`server/src/engine/engineArgs.ts`)');
  }, 'instruction-reference');
  check('private address', (fixture) => { fixture.texts['agents/project/glossary.md'] += '\n192.0.2.1'; }, 'instruction-private');
  check('missing loaded instruction', (fixture) => { delete fixture.texts['CLAUDE.md']; }, 'instruction-required');
  check('empty production denominator', (fixture) => { fixture.files = []; }, 'instruction-denominator');
  check('named write alias', (fixture) => addSource(fixture, 'ui/src/views/control.ts', "import { executeWrite as fire } from '../api/client'; fire('preview');"), 'ui-write-bypass');
  check('namespace write alias', (fixture) => addSource(fixture, 'ui/src/views/control.ts', "import * as api from '../api/client'; const fire = api.scrubExecute; fire([], 'phrase');"), 'ui-write-bypass');
  check('comment trap retains real transport', (fixture) => addSource(fixture, 'ui/src/views/control.ts', "const glob = 'src/**/*.ts'; const text = `/* ignored */`; // fetch('comment')\nfetch('/real');"), 'ui-transport');
  check('empty test denominator', (fixture) => { fixture.tests = []; }, 'instruction-denominator');
  check('single help mirror changed', (fixture) => { fixture.changed = [HELP_PAIR[0]]; }, 'instruction-help');
  check('paired help deletion', (fixture) => { fixture.changed = [...HELP_PAIR]; fixture.paths = fixture.paths.filter((name) => name !== HELP_PAIR[0]); }, 'instruction-help');
  check('vendor changed', (fixture) => { fixture.vendorActual.sha256 = '0'.repeat(64); }, 'instruction-vendor');
  check('runtime tracked', (fixture) => { fixture.tracked.push('data/portfile.json'); }, 'instruction-runtime');
  check('forbidden persistence alias', (fixture) => addSource(fixture, 'ui/src/state/control.ts', "import { persist as save } from 'zustand/middleware'; save(() => ({}), { partialize: s => ({ writeRun: s.writeRun }) });"), 'ui-persist');
  const safe = contractFindings([{ path: 'scripts/control.mjs', language: '.mjs',
    text: "import { spawn as launch } from 'child_process'; const args = ['a']; const options = { shell: false }; launch('exe', args, options);" }]);
  if (safe.length) throw new Error(`safe aliased process control failed: ${JSON.stringify(safe)}`);
  results.push({ name: 'resolved safe process alias', rule: 'process-argv', findings: 0 });
  const bad = contractFindings([{ path: 'scripts/control.mjs', language: '.mjs',
    text: "import * as child from 'node:child_process'; const options = { shell: true }; child.spawn('exe', [], { ...options });" }]);
  if (!bad.some((finding) => finding.rule === 'process-shell')) throw new Error('spread options failed to expose shell true');
  results.push({ name: 'shell true through spread', rule: 'process-shell', findings: bad.length });
  const comment = contractFindings([{ path: 'ui/src/views/control.ts', language: '.ts', text: "// fetch('/comment')\nconst text = \"fetch('/string')\"; const glob = 'src/**/*.ts';" }]);
  if (comment.length) throw new Error('comments or strings became executable transport findings');
  results.push({ name: 'comments and strings ignored', rule: 'ui-transport', findings: 0 });
  const pair = inspectInstructions({ ...base, changed: [...HELP_PAIR] });
  if (pair.findings.length) throw new Error('both help mirrors changed must pass');
  results.push({ name: 'both help mirrors changed', rule: 'instruction-help', findings: 0 });
  return { controls: results.length, results, stats: baseline.stats };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = runInstructionGate();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.findings.length ? 1 : 0;
  } catch (error) {
    process.stderr.write(`instruction gate could not inspect its inputs: ${error.message}\n`);
    process.exitCode = 2;
  }
}
