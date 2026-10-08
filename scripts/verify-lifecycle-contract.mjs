#!/usr/bin/env node
/**
 * verify-lifecycle-contract.mjs — leaf 1.7 (arch-v11 candidate 7).
 *
 * Static cross-check of the launcher <-> server <-> shell lifecycle contract:
 * it parses the fenced JSON pin table in app/docs/lifecycle-contract.md as its
 * EXPECTATION SOURCE and asserts each adapter against its OWN contract row.
 * Adapter-vs-adapter parity is asserted NOWHERE, by design (the two adapters
 * deliberately disagree — see the contract's accepted-asymmetries register).
 *
 * Families (per .unlazy/arch-v11/BUILD-NOTES.md §"Leaf 1.7" decision item 2):
 *   C1  per-adapter timing VALUE pins (name + value at the named anchor)
 *   C2  portfile reader/writer subsets (exact sets; superset direction pinned)
 *   C3  instance.lock: writeLock fields, launcherPid byte-agreement with the
 *       Rust serde rename, shell-writes-nothing, the two deleters
 *   C4  stop.request: zero references under the Rust crate src and server src
 *   C5  stop-channel anchors incl. the about:blank -> SOCKET_SETTLE TEXTUAL
 *       ORDER inside the begin_quit slice (never line numbers)
 *   C6  env: the server's METADESK_* read-set and the shell's env_remove list,
 *       both exact (KNOWN-GAP-1 carried green-but-named; further drift is red)
 *   C7  backstop asymmetry: KILL_ON_JOB_CLOSE in engine.rs, absent from the dev
 *       launcher
 *   C8  launch_sweep image guard: every taskkill_tree inside the launch_sweep
 *       slice is preceded by process_image_path (static-asserted-only; the
 *       unguarded wait_for_exit_or_escalate escalation is correct-by-design and
 *       is NEVER asserted against)
 *
 * Extraction traps honored (P9): comments are stripped before any matching; the
 * launcher's portfile reader set collects ALL THREE access aliases (portfile.x,
 * portfile?.x, and the instance.x alias in the second-launch focus path) and is
 * asserted as the EXACT NON-EMPTY expected set; the server env read-set anchors
 * real process.env accesses (bracket AND dot forms) so window.__METADESK__ and
 * METADESK_PLACEHOLDER can never count; underscore literals (45_000) are
 * normalized; Rust struct fields are parsed serde-attribute-aware (attributes
 * sit on the line above) and comment-tolerant inside struct blocks.
 *
 * Fail-closed: any missing/moved anchor prints
 * "contract anchor moved — update verify-lifecycle-contract.mjs" with the row
 * name and exits 1. Node built-ins only; spawns nothing; counts nothing;
 * deterministic; runs from the repo root (root is derived from this file's own
 * location, so the CWD cannot skew a path).
 *
 * Output discipline: "lifecycle contract verification passed" is the FIRST (and
 * only) stdout line, on success only; all progress and failures go to stderr.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = 'lifecycle contract verification passed';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTRACT_REL = 'app/docs/lifecycle-contract.md';

const failures = [];

function fail(message) {
  failures.push(message);
}

function progress(message) {
  process.stderr.write(`[verify-lifecycle-contract] ${message}\n`);
}

function anchorMoved(row, file, hint) {
  fail(
    `contract anchor moved — update verify-lifecycle-contract.mjs (row: ${row}; file: ${file}` +
      (hint ? `; expected: ${hint}` : '') +
      ')',
  );
}

// ---------------------------------------------------------------------------
// comment / literal stripping (P9 trap 1: strip comments BEFORE any matching)
// ---------------------------------------------------------------------------

/** Strip // and slash-star comments from JS/TS, string-literal aware
 * (single, double, and template literals never start a comment). */
function stripJsComments(src) {
  let out = '';
  let mode = 'code'; // code | line | block | sq | dq | template
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (mode === 'code') {
      if (ch === '/' && next === '/') { mode = 'line'; i++; out += '  '; continue; }
      if (ch === '/' && next === '*') { mode = 'block'; i++; out += '  '; continue; }
      if (ch === "'") { mode = 'sq'; out += ch; continue; }
      if (ch === '"') { mode = 'dq'; out += ch; continue; }
      if (ch === '`') { mode = 'template'; out += ch; continue; }
      out += ch; continue;
    }
    if (mode === 'line') {
      if (ch === '\n') { mode = 'code'; out += ch; } else { out += ' '; }
      continue;
    }
    if (mode === 'block') {
      if (ch === '*' && next === '/') { mode = 'code'; i++; out += '  '; } else { out += ch === '\n' ? '\n' : ' '; }
      continue;
    }
    // inside a string literal: escapes skip one char, comments never start here
    if (ch === '\\') { out += ch + (next ?? ''); i++; continue; }
    if ((mode === 'sq' && ch === "'") || (mode === 'dq' && ch === '"') || (mode === 'template' && ch === '`')) {
      mode = 'code';
    }
    out += ch;
  }
  return out;
}

/** Strip // and slash-star comments from Rust, string- and char-literal aware.
 * Char literals are only entered on a complete 'x' / backslash-n shape, so
 * lifetime annotations (for<'de>) never open a phantom string state. */
function stripRustComments(src) {
  let out = '';
  let mode = 'code'; // code | line | block | dq
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (mode === 'code') {
      if (ch === '/' && next === '/') { mode = 'line'; i++; out += '  '; continue; }
      if (ch === '/' && next === '*') { mode = 'block'; i++; out += '  '; continue; }
      if (ch === '"') { mode = 'dq'; out += ch; continue; }
      if (ch === "'") {
        const span = src.slice(i, i + 6);
        const m = /'(?:[^'\\]|\\.)'/.exec(span);
        if (m && m.index === 0) {
          out += m[0];
          i += m[0].length - 1;
          continue;
        }
        out += ch; continue;
      }
      out += ch; continue;
    }
    if (mode === 'line') {
      if (ch === '\n') { mode = 'code'; out += ch; } else { out += ' '; }
      continue;
    }
    if (mode === 'block') {
      if (ch === '*' && next === '/') { mode = 'code'; i++; out += '  '; } else { out += ch === '\n' ? '\n' : ' '; }
      continue;
    }
    // dq string body
    if (ch === '\\') { out += ch + (next ?? ''); i++; continue; }
    if (ch === '"') mode = 'code';
    out += ch;
  }
  return out;
}

/** Remove '...' / "..." contents; keep only the ${...} expressions of templates.
 * Used ONLY for the launcher member-access sweep, so the string 'portfile.json'
 * can never donate the phantom member "json" (P9 trap 1). */
function stripJsStringsKeepInterpolations(src) {
  let out = '';
  let mode = 'code'; // code | sq | dq | template | templateExpr
  let braceDepth = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (mode === 'code') {
      if (ch === "'") { mode = 'sq'; out += ' '; continue; }
      if (ch === '"') { mode = 'dq'; out += ' '; continue; }
      if (ch === '`') { mode = 'template'; out += ' '; continue; }
      out += ch; continue;
    }
    if (mode === 'sq' || mode === 'dq') {
      if (ch === '\\') { i++; continue; }
      if ((mode === 'sq' && ch === "'") || (mode === 'dq' && ch === '"')) mode = 'code';
      out += ' '; continue;
    }
    if (mode === 'template') {
      if (ch === '\\') { i++; out += ' '; continue; }
      if (ch === '`') { mode = 'code'; out += ' '; continue; }
      if (ch === '$' && next === '{') { mode = 'templateExpr'; braceDepth = 1; i++; out += ' '; continue; }
      out += ' '; continue;
    }
    // templateExpr: copy the real expression, brace-aware
    if (ch === '{') braceDepth++;
    if (ch === '}') {
      braceDepth--;
      if (braceDepth === 0) { mode = 'template'; out += ' '; continue; }
    }
    out += ch;
  }
  return out;
}

// ---------------------------------------------------------------------------
// small parsing helpers
// ---------------------------------------------------------------------------

/** Slice from `head` to the next closing brace at column 0 (JS fn, TS
 * interface, Rust fn/struct — every anchor here terminates that way). */
function fnSlice(src, head) {
  const start = src.indexOf(head);
  if (start < 0) return null;
  const end = src.indexOf('\n}', start);
  if (end < 0) return null;
  return src.slice(start, end + 2);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function setDiff(expected, found) {
  const e = [...new Set(expected)].sort();
  const f = [...new Set(found)].sort();
  return {
    missing: e.filter((x) => !f.includes(x)),
    extra: f.filter((x) => !e.includes(x)),
  };
}

function expectSetEqual(row, label, expected, found, file) {
  const { missing, extra } = setDiff(expected, found);
  if (missing.length === 0 && extra.length === 0) return true;
  fail(
    `FAIL [${row}] ${label}: set mismatch in ${file} —` +
      (missing.length ? ` missing-from-source: ${missing.join(', ')};` : '') +
      (extra.length ? ` unexpected-in-source: ${extra.join(', ')};` : '') +
      ` contract=[${[...expected].sort().join(', ')}] source=[${[...found].sort().join(', ')}]`,
  );
  return false;
}

function walkFiles(relDir, extensions) {
  const abs = path.join(ROOT, relDir);
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    const rel = path.join(relDir, entry.name);
    if (entry.isDirectory()) found.push(...walkFiles(rel, extensions));
    else if (extensions.includes(path.extname(entry.name))) found.push(rel);
  }
  return found;
}

// ---------------------------------------------------------------------------
// load the contract pin table (the gate's expectation source) and the sources
// ---------------------------------------------------------------------------

const contractRaw = readFileSync(path.join(ROOT, CONTRACT_REL), 'utf8');
const fence = /```json\s*\n([\s\S]*?)\n```/.exec(contractRaw);
if (!fence) {
  process.stderr.write('[verify-lifecycle-contract] contract pin table missing or unparsable — update app/docs/lifecycle-contract.md\n');
  process.exit(1);
}
let pin;
try {
  pin = JSON.parse(fence[1]);
} catch (error) {
  process.stderr.write(`[verify-lifecycle-contract] contract pin table is not valid JSON — update app/docs/lifecycle-contract.md (${error.message})\n`);
  process.exit(1);
}

const SRC = {};
for (const [key, rel] of Object.entries(pin.sources)) {
  try {
    SRC[key] = readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    process.stderr.write(`[verify-lifecycle-contract] contract source missing — update verify-lifecycle-contract.mjs (source: ${rel})\n`);
    process.exit(1);
  }
}
const js = {
  launcher: stripJsComments(SRC.launcher),
  serverIndex: stripJsComments(SRC.serverIndex),
  serverConfig: stripJsComments(SRC.serverConfig),
};
const rust = {
  engine: stripRustComments(SRC.engine),
  main: stripRustComments(SRC.main),
};
// comment-stripped AND string-stripped: the launcher member-access sweep runs here
const launcherForMembers = stripJsStringsKeepInterpolations(js.launcher);

// ---------------------------------------------------------------------------
// C1 — per-adapter timing VALUE pins (no cross-adapter comparison, ever)
// ---------------------------------------------------------------------------

progress(
  `C1 timing VALUE pins (each side against its own row; parity forbidden): ` +
    `${pin.timings.launcher.length} launcher rows, ${pin.timings.shell.length} shell rows`,
);
for (const row of pin.timings.launcher) {
  const match = new RegExp(`(?:const|let)\\s+${row.name}\\s*=\\s*([0-9][0-9_]*)\\s*;`).exec(js.launcher);
  if (!match) {
    anchorMoved(row.row, pin.sources.launcher, `${row.name} = ${row.valueMs}`);
    continue;
  }
  // underscore literals are normalized (45_000 -> 45000)
  const found = Number.parseInt(match[1].replace(/_/g, ''), 10);
  if (found !== row.valueMs) {
    fail(`FAIL [C1] ${row.row}: expected ${row.valueMs} ms, found ${found} ms (${pin.sources.launcher})`);
  }
}
for (const row of pin.timings.shell) {
  const fileRel = pin.sources[row.file];
  const match = new RegExp(
    `(?:pub\\s+)?const\\s+${row.name}\\s*:\\s*Duration\\s*=\\s*Duration::from_(secs|millis)\\(\\s*([0-9_]+)\\s*\\)`,
  ).exec(rust[row.file]);
  if (!match) {
    anchorMoved(row.row, fileRel, `${row.name}: Duration = Duration::from_secs/millis(${row.valueMs})`);
    continue;
  }
  const raw = Number.parseInt(match[2].replace(/_/g, ''), 10);
  const found = match[1] === 'secs' ? raw * 1000 : raw;
  if (found !== row.valueMs) {
    fail(`FAIL [C1] ${row.row}: expected ${row.valueMs} ms, found ${found} ms (${fileRel})`);
  }
}

// ---------------------------------------------------------------------------
// C2 — portfile writer/reader subsets (exact sets, superset direction pinned)
// ---------------------------------------------------------------------------

function tsInterfaceFields(text, interfaceHead) {
  const slice = fnSlice(text, interfaceHead);
  if (slice === null) return null;
  const names = [];
  for (const line of slice.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*[?:]/.exec(trimmed);
    if (m) names.push(m[1]);
  }
  return names;
}

/** Serde-attribute-aware Rust struct field extraction: a #[serde(rename = "X")]
 * on the line above renames the field; blank lines and comments inside the
 * struct block are skipped, so a no-op comment can never perturb the set. */
function rustStructExternalFields(text, structHead) {
  const slice = fnSlice(text, structHead);
  if (slice === null) return null;
  const names = [];
  let pendingRename = null;
  let seenHead = false;
  for (const line of slice.split('\n')) {
    const trimmed = line.trim();
    if (!seenHead) {
      if (trimmed.startsWith(structHead)) seenHead = true;
      continue;
    }
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    if (trimmed.startsWith('#[')) {
      const rename = /rename\s*=\s*"([^"]+)"/.exec(trimmed);
      pendingRename = rename ? rename[1] : null;
      continue;
    }
    const field = /^pub\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(trimmed);
    if (field) {
      names.push(pendingRename ?? field[1]);
      pendingRename = null;
      continue;
    }
    pendingRename = null;
  }
  return names;
}

progress('C2 portfile reader/writer subsets (exact, non-empty, superset pinned)');
// launcher portfile reader set FIRST: ALL THREE access aliases (P9 trap 2) —
// portfile.x, portfile?.x, AND the instance.x alias in the second-launch focus
// path — swept on comment- AND string-stripped source, exact non-empty set.
const launcherPortfileReads = [];
for (const alias of pin.portfile.launcherReads.aliases) {
  const re = new RegExp(`\\b${escapeRegExp(alias)}(\\w+)`, 'g');
  let m;
  while ((m = re.exec(launcherForMembers)) !== null) launcherPortfileReads.push(m[1]);
}
if (launcherPortfileReads.length === 0) {
  anchorMoved(pin.portfile.launcherReads.row, pin.sources.launcher, pin.portfile.launcherReads.aliases.join(' / '));
} else {
  expectSetEqual(
    pin.portfile.launcherReads.row,
    'launcher portfile read subset (all three aliases)',
    pin.portfile.launcherReads.fields,
    launcherPortfileReads,
    pin.sources.launcher,
  );
}

const writerFields = tsInterfaceFields(js.serverIndex, pin.portfile.writer.interface);
if (writerFields === null) {
  anchorMoved(pin.portfile.writer.row, pin.sources.serverIndex, pin.portfile.writer.interface);
} else {
  expectSetEqual(pin.portfile.writer.row, 'server PortfilePayload writer fields', pin.portfile.writer.fields, writerFields, pin.sources.serverIndex);
  for (const wo of pin.portfile.writer.writeOnly) {
    if (!writerFields.includes(wo)) {
      fail(`FAIL [C2] ${pin.portfile.writer.row}: write-only field ${wo} vanished from the writer (${pin.sources.serverIndex})`);
    }
  }

  const shellFields = rustStructExternalFields(rust.engine, pin.portfile.shellReads.struct);
  if (shellFields === null) {
    anchorMoved(pin.portfile.shellReads.row, pin.sources.engine, pin.portfile.shellReads.struct);
  } else {
    expectSetEqual(pin.portfile.shellReads.row, 'shell Portfile read subset', pin.portfile.shellReads.fields, shellFields, pin.sources.engine);
    for (const ignored of pin.portfile.shellReads.ignoredBy) {
      if (shellFields.includes(ignored)) {
        fail(`FAIL [C2] ${pin.portfile.shellReads.row}: field ${ignored} is contract-ignored by the shell but present in ${pin.portfile.shellReads.struct}`);
      }
    }
    const union = [...new Set([...shellFields, ...launcherPortfileReads])];
    const { missing } = setDiff(union, writerFields);
    if (missing.length > 0) {
      fail(`FAIL [C2] ${pin.portfile.writer.row}: writer fields do not cover every reader (missing: ${missing.join(', ')})`);
    }
  }
  for (const ignored of pin.portfile.shellReads.ignoredBy) {
    if (launcherPortfileReads.includes(ignored)) {
      fail(`FAIL [C2] ${pin.portfile.launcherReads.row}: field ${ignored} is contract-ignored by the launcher but was read in ${pin.sources.launcher}`);
    }
  }
}

// ---------------------------------------------------------------------------
// C3 — instance.lock: writer fields, launcherPid byte-agreement, shell writes
// nothing, two deleters, launcher lock reads
// ---------------------------------------------------------------------------

progress('C3 instance.lock (writeLock fields, launcherPid byte-agreement, shell writes nothing, two deleters)');
const writeLockSlice = fnSlice(js.launcher, pin.instanceLock.launcherWrites.fn);
let lockKeys = null;
if (writeLockSlice === null) {
  anchorMoved(pin.instanceLock.launcherWrites.row, pin.sources.launcher, pin.instanceLock.launcherWrites.fn);
} else {
  const objStart = writeLockSlice.indexOf('JSON.stringify(');
  const braceStart = objStart >= 0 ? writeLockSlice.indexOf('{', objStart) : -1;
  if (braceStart < 0) {
    anchorMoved(pin.instanceLock.launcherWrites.row, pin.sources.launcher, 'JSON.stringify({ ... }) object literal');
  } else {
    let depth = 0;
    let end = -1;
    for (let i = braceStart; i < writeLockSlice.length; i++) {
      if (writeLockSlice[i] === '{') depth++;
      else if (writeLockSlice[i] === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    const objectText = end > 0 ? writeLockSlice.slice(braceStart, end + 1) : '';
    lockKeys = [];
    for (const line of objectText.split('\n').slice(1)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::|,|$)/.exec(line);
      if (m) lockKeys.push(m[1]);
    }
    if (expectSetEqual(pin.instanceLock.launcherWrites.row, 'launcher writeLock fields', pin.instanceLock.launcherWrites.fields, lockKeys, pin.sources.launcher)) {
      for (const wo of pin.instanceLock.launcherWrites.writeOnly) {
        if (!lockKeys.includes(wo)) {
          fail(`FAIL [C3] ${pin.instanceLock.launcherWrites.row}: write-only field ${wo} vanished from writeLock (${pin.sources.launcher})`);
        }
      }
      if (pin.instanceLock.launcherWrites.portIsNullInEveryDefaultLaunch && !lockKeys.includes('port')) {
        fail(`FAIL [C3] ${pin.instanceLock.launcherWrites.row}: the null-in-default-launch "port" field vanished from writeLock`);
      }
    }
  }
}

const shellLockFields = rustStructExternalFields(rust.engine, pin.instanceLock.shellReads.struct);
if (shellLockFields === null) {
  anchorMoved(pin.instanceLock.shellReads.row, pin.sources.engine, pin.instanceLock.shellReads.struct);
} else {
  // the shell reads ONLY launcherPid, under its serde rename (external name)
  expectSetEqual(pin.instanceLock.shellReads.row, 'shell InstanceLock read set', [pin.instanceLock.shellReads.serdeRename], shellLockFields, pin.sources.engine);

  // launcherPid byte-agreement: the launcher's written key vs the Rust serde
  // rename literal vs the contract row — three spellings, one string.
  const renameMatches = [...rust.engine.matchAll(/rename\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  if (lockKeys !== null) {
    const written = lockKeys.find((k) => pin.instanceLock.launcherWrites.fields.includes(k) && /[a-z][A-Z]/.test(k));
    if (
      renameMatches[0] !== pin.instanceLock.shellReads.serdeRename ||
      written !== pin.instanceLock.shellReads.serdeRename ||
      shellLockFields[0] !== pin.instanceLock.shellReads.serdeRename
    ) {
      fail(
        `FAIL [C3] ${pin.instanceLock.shellReads.row}: launcherPid key disagreement — launcher writes "${written ?? 'none'}", ` +
          `shell serde rename is "${renameMatches[0] ?? 'none'}", contract expects "${pin.instanceLock.shellReads.serdeRename}"`,
      );
    }
  }

  // shell writes NOTHING: Deserialize-only derive, and no fs::write in the crate
  const structIdx = rust.engine.indexOf(pin.instanceLock.shellReads.struct);
  if (structIdx < 0) {
    anchorMoved(pin.instanceLock.shellReads.row, pin.sources.engine, pin.instanceLock.shellReads.struct);
  } else {
    const deriveWindow = rust.engine.slice(Math.max(0, structIdx - 300), structIdx);
    const derives = [...deriveWindow.matchAll(/#\[derive\(([^\]]*)\)\]/g)];
    const deriveLine = derives.length > 0 ? derives[derives.length - 1][1] : null;
    if (!deriveLine || !/\bDeserialize\b/.test(deriveLine) || /\bSerialize\b/.test(deriveLine)) {
      fail(`FAIL [C3] ${pin.instanceLock.shellReads.row}: InstanceLock must derive Deserialize ONLY (the shell writes nothing) — found: ${deriveLine ?? 'no derive'}`);
    }
  }
  for (const rkey of Object.keys(rust)) {
    if (rust[rkey].includes('fs::write')) {
      fail(`FAIL [C3] ${pin.instanceLock.shellReads.row}: shell-writes-nothing violated — fs::write found in ${pin.sources[rkey]}`);
    }
  }
}

// two deleters, one per party (presence, not count)
for (const [fileRel, text, anchor] of [
  [pin.sources.launcher, js.launcher, pin.instanceLock.deleters.launcherAnchor],
  [pin.sources.engine, rust.engine, pin.instanceLock.deleters.shellAnchor],
]) {
  if (!text.includes(anchor)) anchorMoved(pin.instanceLock.deleters.row, fileRel, anchor);
}

// launcher lock reads of its OWN file: ownership check + --stop candidates
const launcherLockReads = [];
{
  const re = /\block\??\.(\w+)/g;
  let m;
  while ((m = re.exec(launcherForMembers)) !== null) launcherLockReads.push(m[1]);
}
expectSetEqual(pin.instanceLock.launcherReads.row, 'launcher instance.lock read set', pin.instanceLock.launcherReads.fields, launcherLockReads, pin.sources.launcher);

// ---------------------------------------------------------------------------
// C4 — stop.request is launcher-internal: zero references under the Rust crate
// src and the server src (product-file scoping: app/scripts may name it)
// ---------------------------------------------------------------------------

progress('C4 stop.request launcher-internal (zero refs in the Rust crate and the server)');
for (const dirGlob of pin.stopRequest.forbiddenIn) {
  const dir = dirGlob.replace('/**/*', '');
  const ext = path.extname(dirGlob);
  for (const fileRel of walkFiles(dir, [ext])) {
    const text = readFileSync(path.join(ROOT, fileRel), 'utf8');
    for (const token of pin.stopRequest.forbiddenTokens) {
      if (text.includes(token)) {
        fail(`FAIL [C4] ${pin.stopRequest.row}: "${token}" found in ${fileRel} (must stay launcher-internal)`);
      }
    }
  }
}
if (!js.launcher.includes(pin.stopRequest.positiveAnchor.text)) {
  anchorMoved(pin.stopRequest.row, pin.sources.launcher, pin.stopRequest.positiveAnchor.text);
}

// ---------------------------------------------------------------------------
// C5 — stop-channel anchors (incl. the TEXTUAL about:blank -> SOCKET_SETTLE order)
// ---------------------------------------------------------------------------

progress('C5 stop-channel anchors (server stdin EOF; launcher stdin.end(); shell ChildStdin held + dropped; begin_quit order)');
for (const row of pin.stopChannel.rows) {
  const text = row.file === 'launcher' || row.file.startsWith('server') ? js[row.file] : rust[row.file];
  const fileRel = pin.sources[row.file];
  if (row.fn) {
    const slice = fnSlice(text, row.fn);
    if (slice === null) {
      anchorMoved(row.row, fileRel, `${row.fn} slice`);
      continue;
    }
    for (const anchor of row.anchors ?? []) {
      if (!slice.includes(anchor)) anchorMoved(row.row, fileRel, `${anchor} inside ${row.fn}`);
    }
    if (row.textualOrder) {
      const positions = row.textualOrder.map((token) => slice.indexOf(token));
      if (positions.some((p) => p < 0)) {
        anchorMoved(row.row, fileRel, `${row.textualOrder.join(' then ')} inside ${row.fn}`);
      } else if (!(positions[0] < positions[1])) {
        fail(`FAIL [C5] ${row.row}: textual order violated in ${row.fn} — expected ${row.textualOrder.join(' -> ')}`);
      }
    }
  } else {
    for (const anchor of row.anchors ?? []) {
      if (!text.includes(anchor)) anchorMoved(row.row, fileRel, anchor);
    }
  }
}

// ---------------------------------------------------------------------------
// C6 — env: server read-set (bracket AND dot anchored) vs shell strip-list
// ---------------------------------------------------------------------------

/** Real process.env accesses only (P9 trap 3): window.__METADESK__ and
 * METADESK_PLACEHOLDER are not env knobs and can never match this anchor. */
function extractEnvKnobs(text) {
  const names = [];
  const re = /process\.env(?:\[\s*['"]([A-Za-z0-9_]+)['"]\s*\]|\.([A-Za-z0-9_]+))/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1] ?? m[2];
    if (name.startsWith('METADESK_')) names.push(name);
  }
  return names;
}

progress('C6 env read-set vs strip-list (KNOWN-GAP-1 carried green-but-named; further drift is red)');
{
  const pairKnobs = [...extractEnvKnobs(js.serverIndex), ...extractEnvKnobs(js.serverConfig)];
  expectSetEqual(
    pin.env.serverReads.row,
    'server METADESK_* env read-set',
    pin.env.serverReads.declared,
    pairKnobs,
    `${pin.sources.serverIndex} + ${pin.sources.serverConfig}`,
  );

  const wideKnobs = [];
  for (const fileRel of walkFiles('app/server/src', ['.ts'])) {
    wideKnobs.push(...extractEnvKnobs(stripJsComments(readFileSync(path.join(ROOT, fileRel), 'utf8'))));
  }
  const { extra } = setDiff(pin.env.serverReads.declared, wideKnobs);
  if (extra.length > 0) {
    fail(`FAIL [C6] ${pin.env.serverReads.row}: undeclared METADESK_* knob(s) under app/server/src: ${extra.join(', ')} — KNOWN-GAP-1 drift (a 7th knob must fail the gate)`);
  }

  const spawnSlice = fnSlice(rust.engine, pin.env.shellStrips.fn);
  if (spawnSlice === null) {
    anchorMoved(pin.env.shellStrips.row, pin.sources.engine, pin.env.shellStrips.fn);
  } else {
    const stripped = [...spawnSlice.matchAll(/\.env_remove\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]);
    expectSetEqual(pin.env.shellStrips.row, 'shell env_remove list', pin.env.shellStrips.declared, stripped, pin.sources.engine);
    if (!spawnSlice.includes(pin.env.dataDirSetters.shellAnchor)) {
      anchorMoved(pin.env.dataDirSetters.row, pin.sources.engine, pin.env.dataDirSetters.shellAnchor);
    }
  }
  if (!js.launcher.includes(pin.env.dataDirSetters.launcherAnchor)) {
    anchorMoved(pin.env.dataDirSetters.row, pin.sources.launcher, pin.env.dataDirSetters.launcherAnchor);
  }
}

// ---------------------------------------------------------------------------
// C7 — backstop asymmetry: Job Object in the shell, absent from the launcher
// ---------------------------------------------------------------------------

progress('C7 backstop asymmetry (Job Object: shell-only, by design)');
if (!rust.engine.includes(pin.backstop.presentIn.text)) {
  anchorMoved(pin.backstop.row, pin.sources.engine, pin.backstop.presentIn.text);
}
if (js.launcher.includes(pin.backstop.absentFrom.text)) {
  fail(`FAIL [C7] ${pin.backstop.row}: "${pin.backstop.absentFrom.text}" must stay absent from the dev launcher (the kernel backstop is shell-only)`);
}

// ---------------------------------------------------------------------------
// C8 — launch_sweep image guard (slice-scoped; static-asserted-only)
// ---------------------------------------------------------------------------

progress('C8 launch_sweep image guard (static-asserted-only; wait_for_exit_or_escalate is deliberately NOT asserted)');
{
  const slice = fnSlice(rust.engine, pin.sweepGuard.fn);
  if (slice === null) {
    anchorMoved(pin.sweepGuard.row, pin.sources.engine, pin.sweepGuard.fn);
  } else {
    const guardPositions = [...slice.matchAll(new RegExp(escapeRegExp(pin.sweepGuard.guardCall), 'g'))].map((m) => m.index);
    const killPositions = [...slice.matchAll(new RegExp(escapeRegExp(pin.sweepGuard.killCall), 'g'))].map((m) => m.index);
    if (guardPositions.length === 0 || killPositions.length === 0) {
      anchorMoved(pin.sweepGuard.row, pin.sources.engine, `${pin.sweepGuard.guardCall} before every ${pin.sweepGuard.killCall} inside ${pin.sweepGuard.fn}`);
    } else {
      for (const killIdx of killPositions) {
        if (!guardPositions.some((g) => g < killIdx)) {
          fail(`FAIL [C8] ${pin.sweepGuard.row}: ${pin.sweepGuard.killCall} at offset ${killIdx} of ${pin.sweepGuard.fn} has no preceding ${pin.sweepGuard.guardCall} (never kill without the image-path proof)`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// verdict
// ---------------------------------------------------------------------------

if (failures.length > 0) {
  for (const message of failures) process.stderr.write(message + '\n');
  process.stderr.write(`lifecycle contract verification FAILED (${failures.length} failure(s))\n`);
  process.exit(1);
}
process.stdout.write(MARKER + '\n');
process.exit(0);
