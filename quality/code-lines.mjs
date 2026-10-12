import ts from 'typescript';

const scriptKinds = { '.ts': ts.ScriptKind.TS, '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS, '.jsx': ts.ScriptKind.JSX, '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS, '.mts': ts.ScriptKind.TS, '.cts': ts.ScriptKind.TS };

export function parseSource(file) {
  const kind = scriptKinds[file.language];
  if (kind === undefined) throw new Error(`unsupported script language: ${file.language}`);
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, kind);
  if (source.parseDiagnostics.length) {
    const diagnostic = source.parseDiagnostics[0];
    throw new Error(`${file.path}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
  }
  return source;
}

function tokenSpans(source, root = source) {
  const spans = [];
  function visit(node) {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(source);
    if (children.length) children.forEach(visit);
    else if (node.kind !== ts.SyntaxKind.EndOfFileToken) {
      spans.push([node.getStart(source), node.end]);
    }
  }
  visit(root);
  return spans;
}

/** Comment-free tokens preserve literal contents and ignore formatting between tokens. */
export function normalizedNode(node, source) {
  const spans = tokenSpans(source, node);
  return JSON.stringify(spans.map(([start, end]) => source.text.slice(start, end)));
}

function quotedEnd(text, start, quote, escape, doubled = false) {
  let at = start + 1;
  while (at < text.length) {
    if (text[at] === escape) { at += 2; continue; }
    if (text[at] === quote) {
      if (doubled && text[at + 1] === quote) { at += 2; continue; }
      return at + 1;
    }
    at += 1;
  }
  throw new Error(`unterminated ${quote} string`);
}

function blockEnd(text, start, open, close, nested) {
  let depth = 1;
  let at = start + open.length;
  while (at < text.length) {
    if (nested && text.startsWith(open, at)) { depth += 1; at += open.length; }
    else if (text.startsWith(close, at)) {
      depth -= 1;
      at += close.length;
      if (depth === 0) return at;
    } else at += 1;
  }
  throw new Error('unterminated block comment');
}

function lineCommentEnd(text, start, carriageReturn) {
  let at = start;
  while (at < text.length && text[at] !== '\n' && !(carriageReturn && text[at] === '\r')) at += 1;
  return at;
}

/** Rust lexical approximation: nested comments, raw/byte strings, chars and lifetimes. */
function rustSpans(text) {
  const spans = [];
  for (let at = 0; at < text.length;) {
    if (/\s/.test(text[at])) { at += 1; continue; }
    // Rust line comments terminate at LF; CRLF has the same LF boundary.
    if (text.startsWith('//', at)) { at = lineCommentEnd(text, at, false); continue; }
    if (text.startsWith('/*', at)) { at = blockEnd(text, at, '/*', '*/', true); continue; }
    const raw = /^(?:br|cr|r)(#*)"/.exec(text.slice(at));
    if (raw) {
      const closing = `"${raw[1]}`;
      const end = text.indexOf(closing, at + raw[0].length);
      if (end < 0) throw new Error('unterminated Rust raw string');
      spans.push([at, end + closing.length]);
      at = end + closing.length;
    } else if (text[at] === '"') {
      const end = quotedEnd(text, at, '"', '\\');
      spans.push([at, end]); at = end;
    } else if (text[at] === "'" && /^'(?:\\(?:u\{[^}]+\}|x[\da-fA-F]{2}|.)|[^'\\\r\n])'/u.test(text.slice(at))) {
      const end = quotedEnd(text, at, "'", '\\');
      spans.push([at, end]); at = end;
    } else { spans.push([at, at + 1]); at += 1; }
  }
  return spans;
}

/** PowerShell lexical approximation: line/block comments, strings and here-strings. */
function powershellSpans(text) {
  const spans = [];
  for (let at = 0; at < text.length;) {
    if (/\s/.test(text[at])) { at += 1; continue; }
    if (text.startsWith('<#', at)) { at = blockEnd(text, at, '<#', '#>', false); continue; }
    if (text[at] === '#') { at = lineCommentEnd(text, at, true); continue; }
    const here = /^@(["'])[ \t]*(?:\r\n|\r|\n)/.exec(text.slice(at));
    if (here) {
      // Use PowerShell CR/LF boundaries, not JavaScript's Unicode line anchors.
      const closing = new RegExp(`(?:^|[\\r\\n])${here[1]}@(?=\\s|$)`);
      const rest = text.slice(at + here[0].length);
      const match = closing.exec(rest);
      if (!match) throw new Error('unterminated PowerShell here-string');
      const end = at + here[0].length + match.index + match[0].length;
      spans.push([at, end]); at = end;
    } else if (text[at] === '"' || text[at] === "'") {
      const quote = text[at];
      const end = quotedEnd(text, at, quote, quote === '"' ? '`' : null, true);
      spans.push([at, end]); at = end;
    } else if (text[at] === '`' && at + 1 < text.length) {
      spans.push([at, at + 2]); at += 2;
    } else { spans.push([at, at + 1]); at += 1; }
  }
  return spans;
}

export function codeLineCount(file) {
  if (typeof file.text !== 'string') throw new Error(`${file.path}: missing source text`);
  let spans;
  let lineStarts;
  if (scriptKinds[file.language] !== undefined) {
    const source = parseSource(file);
    spans = tokenSpans(source);
    // Compiler semantics: LF, CR, CRLF, U+2028 and U+2029.
    lineStarts = source.getLineStarts();
  } else if (file.language === '.rs' || file.language === '.ps1') {
    spans = file.language === '.rs' ? rustSpans(file.text) : powershellSpans(file.text);
    lineStarts = [0];
    for (let at = 0; at < file.text.length; at += 1) {
      if (file.text[at] === '\n') lineStarts.push(at + 1);
      else if (file.language === '.ps1' && file.text[at] === '\r') {
        if (file.text[at + 1] === '\n') at += 1;
        lineStarts.push(at + 1);
      }
    }
  } else throw new Error(`${file.path}: unsupported code-line language ${file.language}`);
  const lines = new Set();
  let line = 0;
  for (const [start, end] of spans.sort((a, b) => a[0] - b[0])) {
    for (let at = start; at < end; at += 1) {
      while (line + 1 < lineStarts.length && at >= lineStarts[line + 1]) line += 1;
      if (!/\s/.test(file.text[at])) lines.add(line);
    }
  }
  return lines.size;
}
