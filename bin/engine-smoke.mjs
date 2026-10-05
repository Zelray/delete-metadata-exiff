#!/usr/bin/env node
/**
 * Launcher-level engine smoke probe (Node built-ins only).
 *
 * Proves, from outside the test suite, that the vendored engine the app ships
 * with (app/vendor/exiftool/) answers `-ver`, speaks the documented
 * `-stay_open True -@ -` protocol with numbered -executeN / {readyN} framing
 * and `-charset filename=UTF8` first, writes a tag in default backup mode,
 * reads the value back, and shuts down cleanly with no orphan process.
 *
 * Exit 0 = healthy. Exit 1 = the engine is unusable; the app must run
 * read-only or not at all.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = path.join(APP_ROOT, 'vendor', 'exiftool', 'exiftool.exe');
const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000d4944415478da63fccfc0500f000485018084a98c210000000049454e44ae426082',
  'hex',
);

function emit(step, status, extra = {}) {
  process.stdout.write(`${JSON.stringify({ step, status, ...extra })}\n`);
}

function die(step, message) {
  emit(step, 'failed', { message });
  process.exit(1);
}

if (!existsSync(EXE)) die('engine-present', `exiftool.exe not found at ${EXE}`);

// ---- 1. One-shot -ver -------------------------------------------------------
const ver = await runOnce(['-ver']);
if (ver.code !== 0 || !/^\d+\.\d+$/.test(ver.stdout.trim())) {
  die('one-shot-ver', `exit=${ver.code} stdout=${JSON.stringify(ver.stdout.slice(0, 120))}`);
}
emit('one-shot-ver', 'ok', { version: ver.stdout.trim() });

// ---- 2. Persistent session over the documented protocol ---------------------
const session = spawn(
  EXE,
  ['-charset', 'filename=UTF8', '-stay_open', 'True', '-@', '-'],
  { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
);
session.stdout.setEncoding('utf8');
session.stderr.setEncoding('utf8');
let out = '';
const errChunks = [];
session.stdout.on('data', (c) => {
  out += c;
});
session.stderr.on('data', (c) => errChunks.push(c));
let childExit = null;
session.on('exit', (code, signal) => {
  childExit = { code, signal };
});

let executeNumber = 0;
function request(lines, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    executeNumber += 1;
    const token = `{ready${executeNumber}}`;
    out = '';
    session.stdin.write(`${lines.map((l) => `${l}\n`).join('')}-execute${executeNumber}\n`);
    const startedAt = Date.now();
    const poll = setInterval(() => {
      if (out.includes(token)) {
        clearInterval(poll);
        resolve(out.slice(0, out.indexOf(token)));
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(poll);
        reject(new Error(`no ${token} within ${timeoutMs}ms`));
      }
    }, 20);
  });
}

try {
  const warmup = await request(['-ver']);
  if (!/^\d+\.\d+$/.test(warmup.trim())) {
    die('session-warmup', `unexpected -ver payload ${JSON.stringify(warmup.slice(0, 120))}`);
  }
  emit('session-warmup', 'ok', { framing: '-executeN/{readyN}' });

  // ---- 3. Write + read-back on a throwaway fixture -------------------------
  const dir = mkdtempSync(path.join(tmpdir(), 'metadesk-smoke-'));
  const fixture = path.join(dir, 'smoke.png');
  writeFileSync(fixture, PNG_1X1);

  const write = await request(['-PNG:Parameters=launcher smoke test', fixture]);
  if (!/1 image files? updated/.test(write)) {
    die('write', write.trim().slice(0, 200) || errChunks.join('').slice(0, 200));
  }
  if (!existsSync(`${fixture}_original`)) {
    die('write', 'default backup mode did not create FILE_original');
  }
  emit('write', 'ok', { backup: 'FILE_original created' });

  const readBack = await request(['-j', '-PNG:Parameters', fixture]);
  if (!/launcher smoke test/.test(readBack)) {
    die('read-back', readBack.trim().slice(0, 200));
  }
  emit('read-back', 'ok');

  // ---- 4. Graceful shutdown -------------------------------------------------
  session.stdin.write('-stay_open\nFalse\n');
  const exited = await new Promise((resolve) => {
    const startedAt = Date.now();
    const poll = setInterval(() => {
      if (childExit !== null) {
        clearInterval(poll);
        resolve(true);
      } else if (Date.now() - startedAt > 5_000) {
        clearInterval(poll);
        resolve(false);
      }
    }, 25);
  });
  if (!exited) {
    try {
      session.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    die('shutdown', 'process did not exit after -stay_open False');
  }
  if (childExit.code !== 0) {
    die('shutdown', `exit code ${childExit.code} (expected 0)`);
  }
  emit('shutdown', 'ok', { exitCode: childExit.code, orphan: false });

  process.stdout.write('engine smoke passed\n');
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  try {
    session.stdin.write('-stay_open\nFalse\n');
  } catch {
    /* already gone */
  }
  die('session', message);
}

/** One-shot argv-array spawn that collects stdout/stderr and waits for exit. */
function runOnce(args, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(EXE, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* gone */
      }
      reject(new Error(`-ver timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
