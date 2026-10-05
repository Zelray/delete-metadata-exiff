#!/usr/bin/env node
/**
 * Write-pipeline verification gate (leaf 1.1.4).
 *
 * Spawns `vitest run test/write` inside app/server (the write suite drives
 * the REAL vendored exiftool.exe end-to-end), requires exit code 0, and on
 * success prints EXACTLY
 *
 *     write pipeline verification passed
 *
 * as the first line of stdout. On failure it prints diagnostics (the tail of
 * the vitest output) and exits 1. Node built-ins only; argv-array spawn, no
 * shell strings.
 *
 * Run from the repo root: node app/scripts/verify-write.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = path.join(APP_ROOT, 'server');
const TEST_DIR = path.join(SERVER_DIR, 'test', 'write');
const OVERALL_TIMEOUT_MS = 10 * 60 * 1000;

const watchdog = setTimeout(() => {
  process.stdout.write('write pipeline verification FAILED\n\noverall watchdog fired (10 min)\n');
  process.exitCode = 1;
  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}, OVERALL_TIMEOUT_MS);
watchdog.unref();

function resolveVitest() {
  // Workspaces hoist vitest to the app root node_modules.
  const candidates = [
    path.join(SERVER_DIR, 'node_modules', 'vitest', 'vitest.mjs'),
    path.join(APP_ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const vitestEntry = resolveVitest();
if (vitestEntry === null) {
  process.stdout.write('write pipeline verification FAILED\n\nvitest is not installed (run "npm install" in app/).\n');
  process.exit(1);
}
if (!existsSync(TEST_DIR)) {
  process.stdout.write(`write pipeline verification FAILED\n\nwrite test suite missing: ${TEST_DIR}\n`);
  process.exit(1);
}

const args = [vitestEntry, 'run', 'test/write'];
const child = spawn(process.execPath, args, {
  cwd: SERVER_DIR,
  shell: false,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdout += chunk;
});
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

child.on('error', (error) => {
  process.stdout.write(`write pipeline verification FAILED\n\nfailed to spawn vitest: ${error.message}\n`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  clearTimeout(watchdog);
  if (code === 0) {
    // Marker FIRST on stdout, then the suite's own summary.
    process.stdout.write('write pipeline verification passed\n');
    const tail = (text) => text.split(/\r?\n/).filter((l) => l.trim().length > 0).slice(-12).join('\n');
    process.stdout.write(`\n${tail(stdout)}\n`);
    process.exit(0);
  }
  process.stdout.write('write pipeline verification FAILED\n\n');
  process.stdout.write(`vitest exit code: ${String(code)}${signal === null ? '' : ` (signal ${String(signal)})`}\n\n`);
  const combined = `${stderr}\n${stdout}`;
  const lines = combined.split(/\r?\n/).filter((l) => l.trim().length > 0);
  // Show the failure summary: vitest prints failed test names near the end.
  process.stdout.write(`${lines.slice(-120).join('\n')}\n`);
  process.exit(1);
});
