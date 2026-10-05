#!/usr/bin/env node
/**
 * Diagnostics-bundle verification gate (leaf 2.2.1).
 *
 * Node built-ins only. Runs, in order:
 *   1. `vitest run test/diagnostics` in app/server  (route: token gate, zip
 *      response, bundle contents, on-disk copy, journal-tail truncation)
 *   2. `vitest run src/views/Settings` in app/ui    (Settings action end to end)
 *
 * The invocation mechanics mirror verify-write.mjs / verify-engine.mjs exactly:
 * the Vitest entry is resolved from the hoisted node_modules and spawned as an
 * argv array (shell: false). On success the FIRST stdout line is EXACTLY
 *
 *     diagnostics verification passed
 *
 * Any failure prints diagnostics and exits 1. Run from the repo root:
 * node app/scripts/verify-diagnostics.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = path.join(APP_ROOT, 'server');
const UI_DIR = path.join(APP_ROOT, 'ui');
const STEP_TIMEOUT_MS = 8 * 60 * 1000;

function fail(message, extra = '') {
  process.stdout.write(`diagnostics verification FAILED\n\n${message}\n`);
  if (extra.trim().length > 0) process.stdout.write(`\n${extra.trim()}\n`);
  process.exit(1);
}

// Progress goes to stderr so the FIRST stdout line on success is exactly the
// marker line (gate CHECK contract).
function progress(message) {
  process.stderr.write(`[verify-diagnostics] ${message}\n`);
}

function resolveVitest(cwd) {
  const candidates = [
    path.join(cwd, 'node_modules', 'vitest', 'vitest.mjs'),
    path.join(APP_ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  fail('Vitest is not installed. Run "npm install" in app/ first, then re-run this script.');
  return null;
}

function runStep(name, cwd, filter, extraEnv = {}) {
  const vitestEntry = resolveVitest(cwd);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [vitestEntry, 'run', filter], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv },
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ name, code: -1, out, err: `${err}\n${name} timed out after ${STEP_TIMEOUT_MS / 1000}s` });
    }, STEP_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ name, code: -1, out, err: `${err}\ncould not spawn vitest: ${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ name, code: code ?? -1, out, err });
    });
  });
}

progress('running the diagnostics server suite (app/server, test/diagnostics) …');
const serverStep = await runStep('server diagnostics suite', SERVER_DIR, 'test/diagnostics');
if (serverStep.code !== 0) {
  fail(
    `The diagnostics server suite did not pass (vitest exit code ${serverStep.code}).`,
    `${serverStep.err}\n${serverStep.out}`,
  );
}

progress('running the Settings UI suite (app/ui, src/views/Settings) …');
const uiStep = await runStep('ui Settings suite', UI_DIR, 'src/views/Settings', { NODE_ENV: 'test' });
if (uiStep.code !== 0) {
  fail(
    `The Settings UI suite did not pass (vitest exit code ${uiStep.code}).`,
    `${uiStep.err}\n${uiStep.out}`,
  );
}

// Success: marker FIRST on stdout, then a short honest summary.
process.stdout.write('diagnostics verification passed\n');
process.stderr.write(
  '  server: test/diagnostics green (token gate, zip bundle contents, on-disk copy)\n' +
    '  ui:     src/views/Settings green (button flow, saved path, honest copy)\n',
);
process.exit(0);
