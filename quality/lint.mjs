import path from 'node:path';
import ts from 'typescript';
import { ESLint } from 'eslint';
import { ROOT } from './inventory.mjs';
import { normalizedNode, parseSource } from './code-lines.mjs';

export const SCRIPT_LANGUAGE = /^\.(?:[cm]?[jt]s|[jt]sx)$/;
export const TEST_RULES = ['internalMockFiles', 'existenceAssertions', 'fixedSleeps'];
const enabled = (setting) => ![undefined, 0, 'off'].includes(Array.isArray(setting) ? setting[0] : setting);
const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js'];

function identityAt(source, message) {
  const line = Math.max(0, (message.line ?? 1) - 1);
  const column = Math.max(0, (message.column ?? 1) - 1);
  const offset = source.getPositionOfLineAndCharacter(line, column);
  let selected = source;
  function visit(node) {
    if (node.getStart(source) <= offset && offset < node.end) {
      selected = node;
      ts.forEachChild(node, visit);
    }
  }
  visit(source);
  // Keep the immediate AST context so two unrelated uses of the same identifier differ.
  if (selected.parent && !ts.isSourceFile(selected.parent)) selected = selected.parent;
  return normalizedNode(selected, source);
}

/** One ESLint engine/run, no fixes, no warning suppression or source directives. */
export async function lintFindings(files, { virtual = false } = {}) {
  const scripts = files.filter((file) => SCRIPT_LANGUAGE.test(file.language));
  if (scripts.length === 0) throw new Error('lint measured no JS/TS files');
  const eslint = new ESLint({ cwd: ROOT, overrideConfigFile: path.join(ROOT, 'eslint.config.mjs'),
    fix: false, allowInlineConfig: false, errorOnUnmatchedPattern: true, cache: false });
  const configuredRules = new Set();
  for (const file of scripts) {
    const config = await eslint.calculateConfigForFile(path.join(ROOT, file.path));
    if (!config) throw new Error(`lint ignored required file ${file.path}`);
    const required = ['no-debugger'];
    if (/\.[cm]?tsx?$/.test(file.path)) required.push('@typescript-eslint/no-explicit-any');
    if (/^ui\/src\/.*\.tsx$/.test(file.path) && !/\.(test|spec)\./.test(file.path)) required.push('jsx-a11y/alt-text');
    if (/^ui\/src\//.test(file.path) && file.path !== 'ui/src/copy.ts'
      && !/\.(test|spec)\.|\/(?:__tests__|test)\//.test(file.path)) {
      required.push('i18next/no-literal-string', 'no-restricted-syntax');
    }
    for (const rule of required) if (!enabled(config.rules?.[rule])) throw new Error(`${file.path}: required lint rule ${rule} disabled`);
    for (const [rule, setting] of Object.entries(config.rules ?? {})) if (enabled(setting)) configuredRules.add(rule);
  }
  const results = virtual
    ? (await Promise.all(scripts.map((file) => eslint.lintText(file.text, { filePath: path.join(ROOT, file.path), warnIgnored: true })))).flat()
    : await eslint.lintFiles(scripts.map((file) => path.join(ROOT, file.path)));
  if (results.length !== scripts.length) throw new Error(`lint denominator mismatch: ${results.length}/${scripts.length}`);
  const findings = [];
  const byPath = new Map(scripts.map((file) => [path.resolve(ROOT, file.path), file]));
  for (const result of results) {
    const file = byPath.get(path.resolve(result.filePath));
    if (!file) throw new Error(`unexpected lint result: ${result.filePath}`);
    const source = parseSource(file);
    for (const message of result.messages) {
      if (message.fatal || !message.ruleId) throw new Error(`${file.path}:${message.line ?? 1}: lint infrastructure: ${message.message}`);
      findings.push({ rule: `lint:${message.ruleId}`, path: file.path, line: message.line ?? 1,
        evidence: message.message, identity: identityAt(source, message) });
    }
  }
  return { findings, rules: [...configuredRules].sort().map((rule) => `lint:${rule}`), files: scripts.length };
}

function member(node) {
  if (ts.isPropertyAccessExpression(node)) return { object: node.expression, name: node.name.text };
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return { object: node.expression, name: node.argumentExpression.text };
  }
  return null;
}

function mockRoots(source) {
  const roots = new Set(['vi', 'vitest']);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== 'vitest') continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) roots.add(`${bindings.name.text}.vi`);
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) {
      if (['vi', 'vitest'].includes(element.propertyName?.text ?? element.name.text)) roots.add(element.name.text);
    }
  }
  return roots;
}

function internalModule(specifier, testPath, production) {
  let candidate;
  if (specifier.startsWith('.')) candidate = path.posix.normalize(path.posix.join(path.posix.dirname(testPath), specifier));
  else if (specifier.startsWith('@metadesk/shared')) candidate = `shared/src/${specifier.slice('@metadesk/shared'.length).replace(/^\//, '') || 'index'}`;
  else if (specifier.startsWith('@/')) candidate = `ui/src/${specifier.slice(2)}`;
  else if (specifier.startsWith('~/')) candidate = `ui/src/${specifier.slice(2)}`;
  else return false;
  const stem = candidate.replace(/\.[cm]?jsx?$/, '');
  return production.has(candidate) || extensions.some((extension) => production.has(`${stem}${extension}`));
}

function positiveExistence(call, source) {
  const matcher = member(call.expression);
  if (!matcher || !['toBeDefined', 'toBeTruthy', 'toBeInTheDocument', 'toBeNull', 'toBe', 'toEqual'].includes(matcher.name)) return false;
  let base = matcher.object;
  const modifiers = [];
  for (let part = member(base); part; part = member(base)) { modifiers.push(part.name); base = part.object; }
  if (modifiers.includes('not') || !ts.isCallExpression(base)
    || !ts.isIdentifier(base.expression) || base.expression.text !== 'expect') return false;
  if (['toBeDefined', 'toBeTruthy', 'toBeInTheDocument'].includes(matcher.name)) return true;
  // Boolean checks on domain predicates remain meaningful. Only explicit coercion is existence.
  const subject = base.arguments[0];
  const booleanCoercion = subject && ((ts.isPrefixUnaryExpression(subject) && subject.operator === ts.SyntaxKind.ExclamationToken
    && ts.isPrefixUnaryExpression(subject.operand) && subject.operand.operator === ts.SyntaxKind.ExclamationToken)
    || (ts.isCallExpression(subject) && subject.expression.getText(source) === 'Boolean'));
  return Boolean(booleanCoercion && call.arguments[0]?.kind === ts.SyntaxKind.TrueKeyword);
}

/** Narrow AST checks for supported C6 patterns; strings/comments are never scanned as code. */
export function testQualityFindings(tests, productionFiles) {
  const production = new Set(productionFiles.map((file) => file.path));
  const findings = [];
  for (const file of tests.filter((item) => SCRIPT_LANGUAGE.test(item.language))) {
    const source = parseSource(file);
    const roots = mockRoots(source);
    function add(rule, node) {
      findings.push({ rule, path: file.path, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        evidence: node.getText(source), identity: normalizedNode(node, source) });
    }
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const target = member(node.expression);
        let module = node.arguments[0];
        if (module && ts.isCallExpression(module) && module.expression.kind === ts.SyntaxKind.ImportKeyword) module = module.arguments[0];
        if (target?.name === 'mock' && roots.has(target.object.getText(source))
          && module && ts.isStringLiteralLike(module) && internalModule(module.text, file.path, production)) {
          // Retain the baseline key, but measure every call rather than one per file.
          add('internalMockFiles', node);
        }
        if (positiveExistence(node, source)) add('existenceAssertions', node);
        if (file.path.startsWith('tests-e2e/') && target?.name === 'waitForTimeout') add('fixedSleeps', node);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return findings;
}
