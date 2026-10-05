#!/usr/bin/env node
/**
 * Engine layer verification gate.
 *
 * Node built-ins only. Spawns the server workspace's Vitest run (cwd
 * app/server), requires exit code 0, and prints EXACTLY
 *
 *     engine layer verification passed
 *
 * as the first line of stdout on success. On failure it prints diagnostics
 * and exits 1. The orchestrator's gate check runs this script from the repo
 * root: node app/scripts/verify-engine.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = path.join(APP_ROOT, 'server');
const TIMEOUT_MS = 15 * 60 * 1000;

function fail(message, extra = '') {
  process.stdout.write(`engine layer verification FAILED\n\n${message}\n`);
  if (extra.trim().length > 0) process.stdout.write(`\n${extra.trim()}\n`);
  process.exit(1);
}

// Resolve the Vitest entry directly (no shell, no npx resolution ambiguity).
const vitestCandidates = [
  path.join(SERVER_DIR, 'node_modules', 'vitest', 'vitest.mjs'),
  path.join(APP_ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
];
const vitestEntry = vitestCandidates.find((candidate) => existsSync(candidate));
if (vitestEntry === undefined) {
  fail(
    'Vitest is not installed. Run "npm install" in app/ first, then re-run this script.',
  );
}

if (!existsSync(path.join(APP_ROOT, 'vendor', 'exiftool', 'exiftool.exe'))) {
  fail(
    `The vendored engine is missing. Expected ${path.join(APP_ROOT, 'vendor', 'exiftool', 'exiftool.exe')} (copy, never move, from repo-root vendor/exiftool/).`,
  );
}

const child = spawn(process.execPath, [vitestEntry, 'run'], {
  cwd: SERVER_DIR,
  shell: false,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, METADESK_VERIFY: '1' },
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

const watchdog = setTimeout(() => {
  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  fail(`Vitest did not finish within ${TIMEOUT_MS / 1000}s.`, tail(stdout) + tail(stderr));
}, TIMEOUT_MS);

child.on('error', (error) => {
  clearTimeout(watchdog);
  fail(`Could not spawn the test runner: ${error.message}`);
});

child.on('exit', (code) => {
  clearTimeout(watchdog);
  if (code !== 0) {
    fail(
      `The engine test suite did not pass (vitest exit code ${code === null ? 'killed' : code}).`,
      tail(stdout) + tail(stderr),
    );
  }
  // Success: the marker line MUST be first, then the suite summary.
  const summary = lastLines(stripAnsi(stdout), 14);
  process.stdout.write(`engine layer verification passed\n${summary}\n`);
  process.exit(0);
});

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*m/g, '');
}

function lastLines(text, count) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.slice(-count).join('\n');
}

function tail(text, count = 80) {
  return stripAnsi(text).split(/\r?\n/).slice(-count).join('\n');
}
