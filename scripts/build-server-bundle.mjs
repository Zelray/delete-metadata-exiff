#!/usr/bin/env node
/**
 * Server bundle + portable stage assembly (leaf 2.1.1, decisions D1-D3).
 *
 * One script, one explicit include list (BUILD-NOTES "Packaging invariants":
 * include list, never an exclude list), producing the PINNED package layout at
 * `app/dist-desktop/stage/` — the stage root IS the package root:
 *
 *   package.json            copy of app/package.json (config.ts reads the version)
 *   node\node.exe           pinned portable Node (scripts/fetch-node.mjs, D3)
 *   server\dist\server.mjs  esbuild ESM single-file bundle (D1)
 *   ui\dist\**              built React bundle (built here when missing/stale)
 *   vendor\exiftool\**      COPY of app/vendor/exiftool — copy, never move (D2)
 *   scripts\selfcheck.mjs   layout self-check the stage carries
 *
 * Because `server\dist\server.mjs` sits two levels below the stage root, the
 * frozen server's own two-levels-up APP_ROOT math (config.ts:15) lands on the
 * stage root, so ui/dist, vendor/exiftool and data/ all hit their config
 * defaults with ZERO server changes; and ENTRY_DIRECT (index.ts:377) fires
 * because the shell passes the bundle's absolute path as argv[1].
 *
 * Bundle notes (D1): `--platform=node --format=esm` keeps `import.meta.url`
 * live — APP_ROOT and ENTRY_DIRECT both hang off it; CJS output would empty
 * it. `@metadesk/shared` publishes TS source, so the bundler compiles it in
 * place and no workspace node_modules is shipped. The CJS dependency tree
 * (fastify/avvio/...) keeps its runtime `require('node:events')` calls, which
 * esbuild's ESM shim cannot answer — a top-level `createRequire(import.meta.url)`
 * banner supplies one without changing the module system.
 *
 * Marker: `server bundle built` (first stdout line on success); progress on
 * stderr. The boot assertion for the exact staged artifact lives in
 * verify-desktop.mjs (`server bundle verification passed`) — this script only
 * builds. Standalone: `npm run build:server-bundle`.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, cpSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = path.join(APP_ROOT, 'dist-desktop', 'stage');
const SERVER_ENTRY = path.join(APP_ROOT, 'server', 'src', 'index.ts');
const UI_SRC = path.join(APP_ROOT, 'ui');
const UI_DIST = path.join(UI_SRC, 'dist');
const UI_DIST_INDEX = path.join(UI_DIST, 'index.html');
const VENDOR_EXIFTOOL = path.join(APP_ROOT, 'vendor', 'exiftool');
const NODE_EXE = path.join(APP_ROOT, 'vendor', 'node', 'node.exe');
const STAGE_BUNDLE = path.join(STAGE, 'server', 'dist', 'server.mjs');

function note(message) {
  process.stderr.write(`[server-bundle] ${message}\n`);
}

function marker(message) {
  process.stdout.write(`${message}\n`);
}

async function main() {
  if (!existsSync(SERVER_ENTRY)) throw new Error(`Server entry missing: ${SERVER_ENTRY}`);
  if (!existsSync(VENDOR_EXIFTOOL)) {
    throw new Error(`Vendored engine missing: ${VENDOR_EXIFTOOL} (copy, never move)`);
  }

  // ---- include item: node\node.exe (pinned version, sha256-verified) ------------
  note('checking the pinned portable node.exe');
  await runNode([path.join(APP_ROOT, 'scripts', 'fetch-node.mjs')], APP_ROOT);
  if (!existsSync(NODE_EXE)) throw new Error(`fetch-node did not produce ${NODE_EXE}`);

  // ---- include item: ui\dist\** (built here when missing or stale) ---------------
  if (!existsSync(UI_DIST_INDEX) || isStale(UI_SRC, statSync(UI_DIST_INDEX).mtimeMs)) {
    note('ui/dist is missing or stale; building the UI workspace');
    await runNode([path.join(APP_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-b'], UI_SRC);
    await runNode([path.join(APP_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], UI_SRC);
  } else {
    note('ui/dist is fresh; skipping the UI build');
  }
  if (!existsSync(UI_DIST_INDEX)) throw new Error(`UI build produced no index.html at ${UI_DIST_INDEX}`);

  // ---- fresh stage ----------------------------------------------------------------
  note(`restaging ${STAGE}`);
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(path.dirname(STAGE_BUNDLE), { recursive: true });

  // ---- include item: server\dist\server.mjs (the bundle, D1) ----------------------
  const esbuild = await import('esbuild');
  const result = await esbuild.build(bundleOptions());
  for (const warning of result.warnings) note(`esbuild warning: ${formatMessage(warning)}`);
  if (!existsSync(STAGE_BUNDLE)) throw new Error(`esbuild produced no bundle at ${STAGE_BUNDLE}`);

  // D1 guard: the bundle must keep a live import.meta.url or both APP_ROOT and
  // ENTRY_DIRECT silently break (CJS output would empty it).
  const bundleSource = readFileSync(STAGE_BUNDLE, 'utf8');
  if (!bundleSource.includes('import.meta.url')) {
    throw new Error(
      'The bundle lost import.meta.url - APP_ROOT and ENTRY_DIRECT would both break. Refusing to stage it (D1).',
    );
  }

  // ---- the rest of the include list ------------------------------------------------
  copyFile(path.join(APP_ROOT, 'package.json'), path.join(STAGE, 'package.json'));
  copyFile(NODE_EXE, path.join(STAGE, 'node', 'node.exe'));
  note('copying ui/dist -> stage/ui/dist (copy, never move)');
  cpSync(UI_DIST, path.join(STAGE, 'ui', 'dist'), { recursive: true });
  note('copying vendor/exiftool -> stage/vendor/exiftool (copy, never move)');
  cpSync(VENDOR_EXIFTOOL, path.join(STAGE, 'vendor', 'exiftool'), { recursive: true });
  mkdirSync(path.join(STAGE, 'scripts'), { recursive: true });
  writeFileSync(path.join(STAGE, 'scripts', 'selfcheck.mjs'), SELFCHECK_SOURCE, 'utf8');

  // ---- report -----------------------------------------------------------------------
  const files = listFiles(STAGE);
  const bytes = files.reduce((sum, file) => sum + statSync(file).size, 0);
  note(`${files.length} files, ${(bytes / 1048576).toFixed(1)} MiB total`);
  note(`bundle ${(statSync(STAGE_BUNDLE).size / 1048576).toFixed(2)} MiB at ${path.relative(APP_ROOT, STAGE_BUNDLE)}`);
  marker('server bundle built');
}

/** esbuild options, in one place so the standalone and staged runs are identical. */
function bundleOptions() {
  return {
    entryPoints: [SERVER_ENTRY],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: STAGE_BUNDLE,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'silent',
    banner: {
      js: [
        "import { createRequire as __metadeskCreateRequire } from 'node:module';",
        'const require = __metadeskCreateRequire(import.meta.url);',
      ].join('\n'),
    },
  };
}

/**
 * The self-check the stage carries. Written as source text (not copied from
 * another file) so the package's only self-check is generated from the one
 * build script that owns the layout. It resolves every pinned path from its
 * own location and exits non-zero listing what is missing.
 */
const SELFCHECK_SOURCE = `#!/usr/bin/env node
/**
 * Package layout self-check — carried inside the portable package at
 * scripts\\\\selfcheck.mjs (leaf 2.1.1). Resolves every pinned layout path from
 * THIS file's location (the package root is one level up) and exits 0 when the
 * package is complete, 1 with the missing list when it is not.
 *
 * Run from inside an extracted package folder:
 *   node\\\\node.exe scripts\\\\selfcheck.mjs
 * Node built-ins only.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The pinned package layout (BUILD-NOTES "The wrapped shape"). */
const REQUIRED = [
  'package.json',
  'node/node.exe',
  'server/dist/server.mjs',
  'ui/dist/index.html',
  'vendor/exiftool/exiftool.exe',
  'vendor/exiftool/exiftool_files',
  'scripts/selfcheck.mjs',
];

const missing = [];
for (const relative of REQUIRED) {
  const target = path.join(PACKAGE_ROOT, ...relative.split('/'));
  if (!existsSync(target)) missing.push(relative);
  else if (statSync(target).isFile() && statSync(target).size === 0) missing.push(relative + ' (0 bytes)');
}

if (missing.length > 0) {
  process.stdout.write('package layout self-check FAILED\\n');
  for (const item of missing) process.stdout.write('  missing: ' + item + '\\n');
  process.stdout.write('  package root: ' + PACKAGE_ROOT + '\\n');
  process.exit(1);
}

let version = 'unknown';
try {
  const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  if (typeof pkg.version === 'string') version = pkg.version;
} catch {
  /* reported as unknown; never fatal here */
}
process.stdout.write('package layout self-check passed\\n');
process.stdout.write('  package root: ' + PACKAGE_ROOT + '\\n');
process.stdout.write('  version: ' + version + '\\n');
`;

/** Newest source mtime under a tree, compared against a build output's mtime. */
function isStale(sourceDir, builtMtimeMs) {
  let newest = 0;
  const skip = new Set(['node_modules', 'dist', '.vite', 'coverage']);
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const mtime = statSync(full).mtimeMs;
      if (mtime > newest) newest = mtime;
    }
  };
  walk(sourceDir);
  return newest > builtMtimeMs;
}

function copyFile(from, to) {
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to);
  note(`copied ${path.relative(APP_ROOT, from)} -> ${path.relative(APP_ROOT, to)}`);
}

function listFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** argv-array spawn of a node script; never a shell string (house rule). */
function runNode(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stdout.on('data', (chunk) => process.stderr.write(`  ${String(chunk).trimEnd()}\n`));
    child.stderr.on('data', (chunk) => {
      err += String(chunk);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${path.basename(args[0] ?? 'node')} exited ${code}\n${err.trim()}`));
    });
  });
}

function formatMessage(message) {
  if (typeof message === 'string') return message;
  return [message.location?.file, message.text].filter(Boolean).join(': ');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  marker('server bundle FAILED');
  process.stderr.write(`[server-bundle] ${message}\n`);
  process.exit(1);
});
