import ts from 'typescript';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { sourceFiles } from './inventory.mjs';

export const CONTRACT_RULES = ['process-shell', 'process-shell-unspecified', 'process-argv', 'process-command',
  'ui-transport', 'ui-write-bypass', 'ui-persist', 'launch-runtime-import', 'contract-parse'];
const JS = /^\.(?:[cm]?[jt]s|[jt]sx)$/;
const PROCESS_CALLS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
const WRITES = new Set(['executeWrite', 'scrubExecute', 'confirmUndo']);
const TRANSPORTS = new Set(['fetch', 'EventSource', 'XMLHttpRequest']);
const PERSISTED = new Set(['recents', 'theme', 'density', 'consoleHistory']);
const CLIENT = 'ui/src/api/client.ts';
const RUNNER = 'ui/src/write/useWriteRun.tsx';

function unwrap(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
    || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression;
  return node;
}

function importedModule(node) {
  while (node && !ts.isImportDeclaration(node)) node = node.parent;
  return node && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
}

function moduleName(module, file) {
  if (!module.startsWith('.')) return module.replace(/^node:/, '');
  return path.posix.normalize(path.posix.join(path.posix.dirname(file), module)).replace(/\.(?:[cm]?[jt]sx?)$/, '');
}

function analysis(file) {
  const ast = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true,
    /\.[jt]sx$/.test(file.language) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(file.language) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const host = { getSourceFile: (name) => name === file.path ? ast : undefined, getDefaultLibFileName: () => '',
    writeFile() {}, getCurrentDirectory: () => '', getDirectories: () => [], fileExists: (name) => name === file.path,
    readFile: (name) => name === file.path ? file.text : undefined, getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true, getNewLine: () => '\n' };
  const checker = ts.createProgram([file.path], { noLib: true, noResolve: true, allowJs: true }, host).getTypeChecker();
  const declaration = (node) => checker.getSymbolAtLocation(node)?.declarations?.[0];
  const propertyName = (node) => ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : null;
  function origin(expression, seen = new Set()) {
    const node = unwrap(expression);
    if (!node || seen.has(node)) return null;
    seen.add(node);
    if (ts.isIdentifier(node)) {
      const decl = declaration(node);
      if (!decl) return { module: 'global', name: node.text };
      if (ts.isImportSpecifier(decl)) return { module: moduleName(importedModule(decl), file.path), name: (decl.propertyName ?? decl.name).text };
      if (ts.isNamespaceImport(decl)) return { module: moduleName(importedModule(decl), file.path), name: '*' };
      if (ts.isImportClause(decl)) return { module: moduleName(importedModule(decl), file.path), name: 'default' };
      if (ts.isVariableDeclaration(decl)) return origin(decl.initializer, seen);
      if (ts.isBindingElement(decl) && ts.isVariableDeclaration(decl.parent.parent)) {
        const parent = origin(decl.parent.parent.initializer, seen);
        return parent ? { module: parent.module, name: propertyName(decl.propertyName ?? decl.name) } : null;
      }
      return null;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const left = origin(node.expression, seen);
      const name = ts.isPropertyAccessExpression(node) ? node.name.text : propertyName(node.argumentExpression);
      if (left?.module === 'global' && ['globalThis', 'window', 'self'].includes(left.name)) return { module: 'global', name };
      if (left) return { module: left.module, name };
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require'
      && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
      return { module: moduleName(node.arguments[0].text, file.path), name: '*' };
    }
    return null;
  }
  function resolved(expression, seen = new Set()) {
    const node = unwrap(expression);
    if (!node || seen.has(node)) return node;
    seen.add(node);
    if (ts.isIdentifier(node)) {
      const decl = declaration(node);
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) return resolved(decl.initializer, seen);
    }
    return node;
  }
  function arrayShape(expression, seen = new Set()) {
    const node = unwrap(expression);
    if (!node || seen.has(node)) return false;
    seen.add(node);
    if (ts.isArrayLiteralExpression(node)) return true;
    if (ts.isIdentifier(node)) {
      const decl = declaration(node);
      if (decl && (ts.isParameter(decl) || ts.isVariableDeclaration(decl))) {
        if (decl.type && (ts.isArrayTypeNode(decl.type) || (ts.isTypeOperatorNode(decl.type) && ts.isArrayTypeNode(decl.type.type))
          || (ts.isTypeReferenceNode(decl.type) && ['Array', 'ReadonlyArray'].includes(decl.type.typeName.getText(ast))))) return true;
        return arrayShape(decl.initializer, seen);
      }
    }
    if (ts.isConditionalExpression(node)) return arrayShape(node.whenTrue, new Set(seen)) && arrayShape(node.whenFalse, new Set(seen));
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ['concat', 'slice', 'map', 'filter', 'flat', 'flatMap'].includes(node.expression.name.text)) return arrayShape(node.expression.expression, seen);
    return false;
  }
  function objectProperties(expression, seen = new Set()) {
    const node = resolved(expression);
    if (!node || seen.has(node) || !ts.isObjectLiteralExpression(node)) return null;
    seen.add(node);
    const props = new Map();
    for (const prop of node.properties) {
      if (ts.isSpreadAssignment(prop)) {
        const nested = objectProperties(prop.expression, new Set(seen));
        if (!nested) props.set('*unresolved-spread*', prop);
        else for (const [key, value] of nested) props.set(key, value);
      } else {
        const key = propertyName(prop.name);
        props.set(key ?? '*computed*', ts.isPropertyAssignment(prop) ? prop.initializer : prop);
      }
    }
    return props;
  }
  return { ast, origin, resolved, arrayShape, objectProperties };
}

function identity(text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const tokens = [];
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) tokens.push(scanner.getTokenText());
  return tokens.join(' ');
}

/** Syntactic findings only. Unknown process arguments/options require review and are ratcheted. */
export function contractFindings(files = sourceFiles()) {
  const findings = [];
  for (const file of files.filter((entry) => JS.test(entry.language))) {
    const { ast, origin, resolved, arrayShape, objectProperties } = analysis(file);
    function add(rule, node, detail) {
      const evidence = node.getText(ast);
      findings.push({ rule, path: file.path, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
        evidence: `${detail}: ${evidence}`, identity: identity(evidence) });
    }
    for (const error of ast.parseDiagnostics) add('contract-parse', ast, ts.flattenDiagnosticMessageText(error.messageText, '\n'));
    function visit(node) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const module = node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
        if (module && /^(bin|scripts)\//.test(file.path) && !isBuiltin(module)) add('launch-runtime-import', node, 'launch modules import Node builtins only');
        const names = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause;
        if (module && moduleName(module, file.path) === 'ui/src/api/client' && file.path !== RUNNER
          && names && (ts.isNamedImports(names) || ts.isNamedExports(names))) {
          for (const entry of names.elements) if (WRITES.has((entry.propertyName ?? entry.name).text)) add('ui-write-bypass', entry, 'write entry point outside consent runner');
        }
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const target = origin(node.expression);
        const args = node.arguments ?? [];
        if (target?.module === 'child_process' && PROCESS_CALLS.has(target.name)) {
          if (['exec', 'execSync'].includes(target.name)) add('process-command', node, 'shell command API forbidden');
          else if (!arrayShape(args[1])) add('process-argv', node, 'argument array not statically resolved; review required');
          const options = objectProperties(args[2]);
          const shell = options?.get('shell');
          if (shell && resolved(shell)?.kind !== ts.SyntaxKind.FalseKeyword) add('process-shell', node, 'shell option is not literal false');
          if (!shell || options.has('*unresolved-spread*') || options.has('*computed*')) add('process-shell-unspecified', node, 'explicit shell false cannot be established; review required');
          if (args[0] && ts.isBinaryExpression(unwrap(args[0])) && unwrap(args[0]).operatorToken.kind === ts.SyntaxKind.PlusToken) add('process-command', node, 'concatenated executable expression requires review');
        }
        if (file.path.startsWith('ui/src/')) {
          const transport = target && ((target.module === 'global' && TRANSPORTS.has(target.name)) || target.module === 'axios');
          if (transport && !(file.path === CLIENT && target.module === 'global' && target.name === 'fetch'
            && insideFunction(node, 'send'))) add('ui-transport', node, 'network transport outside send');
          if (target?.module === 'ui/src/api/client' && WRITES.has(target.name) && file.path !== RUNNER) add('ui-write-bypass', node, 'write firing outside consent runner');
          if (target?.module === 'zustand/middleware' && target.name === 'persist') {
            const options = objectProperties(args[1]);
            const partialize = resolved(options?.get('partialize'));
            const returns = partialize && (ts.isArrowFunction(partialize) || ts.isFunctionExpression(partialize))
              ? returnedExpressions(partialize) : [];
            if (!returns.length || options?.has('*unresolved-spread*')) add('ui-persist', node, 'persistence whitelist not statically resolved');
            for (const expression of returns) {
              const props = objectProperties(expression);
              if (!props || [...props.keys()].some((key) => !PERSISTED.has(key))) add('ui-persist', expression, 'only recents/theme/density/consoleHistory may persist');
            }
          }
        }
        if (/^(bin|scripts)\//.test(file.path) && ((ts.isIdentifier(node.expression) && node.expression.text === 'require')
          || node.expression.kind === ts.SyntaxKind.ImportKeyword)) {
          if (!args[0] || !ts.isStringLiteralLike(args[0]) || !isBuiltin(args[0].text)) add('launch-runtime-import', node, 'runtime import must resolve to a Node builtin');
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  return findings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule));
}

function insideFunction(node, name) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isArrowFunction(current)) return current.name?.text === name;
  }
  return false;
}

function returnedExpressions(fn) {
  if (!ts.isBlock(fn.body)) return [fn.body];
  const out = [];
  function visit(node) {
    if (ts.isReturnStatement(node) && node.expression) out.push(node.expression);
    else if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
  }
  visit(fn.body);
  return out;
}

export function partitionContractFindings(findings) {
  const isRatchet = (finding) => finding.rule.startsWith('process-') || finding.rule === 'launch-runtime-import';
  return { clean: findings.filter((finding) => !isRatchet(finding)), ratcheted: findings.filter(isRatchet) };
}
