#!/usr/bin/env node
/**
 * UI verification gate (leaf 1.1.3).
 *
 * Node built-ins only. Runs, in order:
 *   1. `tsc -b` in app/ui  (strict TypeScript across app + node configs)
 *   2. `vite build` in app/ui
 *   3. asserts app/ui/dist/index.html exists
 *
 * On success the FIRST stdout line is EXACTLY:
 *
 *     ui build verification passed
 *
 * Any failure prints diagnostics and exits 1. Run from the repo root:
 * node app/scripts/verify-ui.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI_DIR = path.join(APP_ROOT, 'ui');
const TIMEOUT_MS = 10 * 60 * 1000;

function fail(message, extra = '') {
  process.stdout.write(`ui build verification FAILED\n\n${message}\n`);
  if (extra.trim().length > 0) process.stdout.write(`\n${extra.trim()}\n`);
  process.exit(1);
}

function resolveTool(relativeCandidates, label) {
  for (const candidate of relativeCandidates) {
    const abs = path.join(APP_ROOT, candidate);
    if (existsSync(abs)) return abs;
  }
  fail(
    `Could not locate ${label}. Run "npm install" in app/ first (the @metadesk/ui workspace ships these devDependencies), then re-run this script.`,
  );
}

const TSC = resolveTool(
  [
    path.join('node_modules', 'typescript', 'bin', 'tsc'),
    path.join('ui', 'node_modules', 'typescript', 'bin', 'tsc'),
  ],
  'typescript (tsc)',
);
const VITE = resolveTool(
  [
    path.join('ui', 'node_modules', 'vite', 'bin', 'vite.js'),
    path.join('node_modules', 'vite', 'bin', 'vite.js'),
  ],
  'vite',
);

function runStep(name, entryArgs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, entryArgs, {
      cwd: UI_DIR,
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(`${name} timed out after ${TIMEOUT_MS / 1000}s.`, err || out);
    }, TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      err += String(chunk);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ name, code, out, err });
    });
    child.on('error', (err2) => {
      clearTimeout(timer);
      fail(`Could not start ${name}: ${String(err2)}`);
    });
  });
}

const steps = [
  { name: 'tsc -b (strict TypeScript)', entryArgs: [TSC, '-b', '--force'] },
  { name: 'vite build', entryArgs: [VITE, 'build'] },
];

let lastOutput = '';
for (const step of steps) {
  process.stdout.write(`[verify-ui] running ${step.name} …\n`);
  const result = await runStep(step.name, step.entryArgs);
  lastOutput = `${result.out}\n${result.err}`.trim();
  if (result.code !== 0) {
    fail(`${step.name} exited with code ${result.code}.`, lastOutput);
  }
}

const distIndex = path.join(UI_DIR, 'dist', 'index.html');
if (!existsSync(distIndex)) {
  fail(
    'vite build reported success but app/ui/dist/index.html does not exist.',
    lastOutput,
  );
}
const size = statSync(distIndex).size;
if (size < 200) {
  fail(`app/ui/dist/index.html exists but is suspiciously small (${size} bytes).`, lastOutput);
}

process.stdout.write('ui build verification passed\n');
process.stdout.write(
  `\n  tsc -b:        strict TypeScript clean (app + node configs)\n` +
    `  vite build:    production bundle emitted\n` +
    `  dist/index.html: ${size} bytes\n` +
    `\nNext: leaf 1.1.3 G2 (screens match artifacts/ux-spec.json) is reviewed against the running app.\n`,
);
