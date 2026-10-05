#!/usr/bin/env node
/**
 * UI write-surface verification gate (leaf 1.1.5).
 *
 * Node built-ins only. Runs, in order:
 *   1. `tsc -b` in app/ui   (strict TypeScript across app + node configs)
 *   2. `vite build` in app/ui
 *   3. `vitest run` in app/ui  (jsdom component + unit tests, no live server)
 *   4. asserts app/ui/dist/index.html exists
 *
 * On success the FIRST stdout line is EXACTLY:
 *
 *     ui write surfaces verification passed
 *
 * Any failure prints diagnostics and exits 1. Run from the repo root:
 * node app/scripts/verify-ui-write.mjs
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
  process.stdout.write(`ui write surfaces verification FAILED\n\n${message}\n`);
  if (extra.trim().length > 0) process.stdout.write(`\n${extra.trim()}\n`);
  process.exit(1);
}

// Progress goes to stderr so the FIRST stdout line on success is exactly
// "ui write surfaces verification passed" (gate CHECK contract).
function progress(message) {
  process.stderr.write(`${message}\n`);
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
const VITEST = resolveTool(
  [
    path.join('ui', 'node_modules', 'vitest', 'vitest.mjs'),
    path.join('node_modules', 'vitest', 'vitest.mjs'),
  ],
  'vitest',
);

function runStep(name, entryArgs, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, entryArgs, {
      cwd: UI_DIR,
      env: { ...process.env, NODE_ENV: 'production', ...extraEnv },
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
  {
    name: 'vitest run (ui tests, jsdom, no live server)',
    entryArgs: [VITEST, 'run'],
    extraEnv: { NODE_ENV: 'test' },
  },
];

let lastOutput = '';
for (const step of steps) {
  progress(`[verify-ui-write] running ${step.name} …`);
  const result = await runStep(step.name, step.entryArgs, step.extraEnv ?? {});
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

process.stdout.write('ui write surfaces verification passed\n');
process.stderr.write(
  `\n  tsc -b:          strict TypeScript clean (app + node configs)\n` +
    `  vite build:      production bundle emitted\n` +
    `  vitest run:      ui suite green (read shell + write surfaces, jsdom, no live server)\n` +
    `  dist/index.html: ${size} bytes\n` +
    `\nNext: leaf 1.1.5 G2 (safety UX: no write without the Save Review diff; command preview on\n` +
    `every write; gated destructive flows; journal-backed undo; backup floors not disable-able) is\n` +
    `reviewed against the running app.\n`,
);
