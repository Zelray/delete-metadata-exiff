#!/usr/bin/env node
/**
 * Portable package + NSIS installer build (leaf 2.2.2).
 *
 *   node app/scripts/build-portable.mjs --all
 *
 * One script, one run:
 *   1. stage the pinned package layout          (scripts/build-server-bundle.mjs)
 *   2. build the shell WITH the NSIS bundle     (`tauri build`; conf bundle.targets
 *      = ["nsis"], so the setup exe lands under
 *      tauri/src-tauri/target/release/bundle/nsis/)
 *   3. assemble the portable folder from the EXPLICIT INCLUDE list below —
 *      the pinned stage plus MetaDesk.exe at the folder root. Never a folder
 *      dump: the include list IS the pinned package layout (BUILD-NOTES
 *      "Packaging invariants"), and a junk audit fails the build if any dev
 *      junk class (node_modules, .git, data contents, evidence, ts sources,
 *      test fixtures, portfile/lock residue) appears anywhere in the folder.
 *   4. zip it: dist-desktop/metadesk-<v>-portable-win-x64.zip (a `MetaDesk/`
 *      top-level folder inside the zip — extract and run)
 *   5. emit the SHA-256 manifest of the zip's CONTENT files (one hash per
 *      file, so zip timestamp churn cannot invalidate the manifest) and the
 *      provenance record (pinned node version + hash, exiftool -ver from the
 *      staged copy, MetaDesk.exe + NSIS setup sha256/size/Authenticode
 *      status — expected NotSigned, recorded honestly).
 *
 * Artifacts (all under app/dist-desktop/, gitignored):
 *   metadesk-<v>-portable-win-x64.zip   the portable package
 *   portable-manifest-<v>.json          sha256 per zip content file
 *   provenance-<v>.txt                  build provenance (leaf 2.2.3 consumes it)
 *
 * Marker (first stdout line, success only): `portable build completed`.
 * Progress goes to stderr. Node built-ins only; every child process is an
 * argv-array spawn with shell:false (house rule). Windows-only by design.
 *
 * NEVER run this concurrently with `npm test`, verify-launch.mjs,
 * verify-desktop.mjs or verify-package.mjs: they count node.exe/exiftool.exe
 * machine-wide, and this script's toolchain spawns its own processes.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = path.join(APP_ROOT, 'dist-desktop', 'stage');
const OUT_DIR = path.join(APP_ROOT, 'dist-desktop');
const PORTABLE_ROOT = path.join(OUT_DIR, 'portable');
const PACKAGE_DIR = path.join(PORTABLE_ROOT, 'MetaDesk'); // the folder that ships
const TAURI_DIR = path.join(APP_ROOT, 'tauri');
const TAURI_CLI = path.join(APP_ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const TAURI_TARGET = path.join(TAURI_DIR, 'src-tauri', 'target');
const SHELL_EXE = path.join(TAURI_TARGET, 'release', 'MetaDesk.exe');
const NSIS_DIR = path.join(TAURI_TARGET, 'release', 'bundle', 'nsis');
const BUILD_BUNDLE_SCRIPT = path.join(APP_ROOT, 'scripts', 'build-server-bundle.mjs');
const FETCH_NODE_SCRIPT = path.join(APP_ROOT, 'scripts', 'fetch-node.mjs');
const APP_PACKAGE_JSON = path.join(APP_ROOT, 'package.json');
const TAURI_CONF = path.join(TAURI_DIR, 'src-tauri', 'tauri.conf.json');
const CARGO_TOML = path.join(TAURI_DIR, 'src-tauri', 'Cargo.toml');

/**
 * The explicit INCLUDE list — the pinned package layout (BUILD-NOTES "The
 * wrapped shape"). Files are copied individually; trees are copied wholesale
 * but only these two trees, by name. Everything else in the stage is NOT
 * shipped, and anything in the folder that is not on this list fails the
 * junk audit below.
 */
const INCLUDE_FILES = ['package.json', 'node/node.exe', 'server/dist/server.mjs', 'scripts/selfcheck.mjs'];
const INCLUDE_TREES = ['ui/dist', 'vendor/exiftool'];

/**
 * Dev junk classes that must be absent from the shipped folder. Deliberate
 * non-hits, so nobody "fixes" them later: `lib/Test` and `lib/Data` inside
 * vendor/exiftool are the UNMODIFIED vendored engine's own Perl module dirs
 * (never modify vendor/**), and ui/dist's .js.map is part of the built bundle
 * vite emitted — build output, not dev junk.
 */
const FORBIDDEN_DIRS = new Set([
  'node_modules',
  '.git',
  '.github',
  '.vscode',
  '.idea',
  'data', // exact case: the runtime state dir the server creates at boot (Perl's lib/Data is exempt)
  'evidence',
  'fixtures',
  '__tests__',
  '__mocks__',
  '__evidence-snapshot__',
  'coverage',
]);
const FORBIDDEN_EXTENSIONS = new Set(['.ts', '.tsx', '.log', '.bak', '.tmp']);
const FORBIDDEN_FILES = new Set(['portfile.json', 'instance.lock', 'stop.request']);

if (process.argv[2] !== '--all' || process.argv.length > 3) {
  process.stdout.write(
    [
      'Usage: node app/scripts/build-portable.mjs --all',
      '',
      'Stages, builds the shell + NSIS installer, assembles the portable folder',
      'from the explicit include list, and emits the zip + content manifest +',
      'provenance under app/dist-desktop/.',
      '',
      'Never run this concurrently with npm test, verify-launch.mjs,',
      'verify-desktop.mjs or verify-package.mjs (machine-wide process counting).',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

const OVERALL_TIMEOUT_MS = 30 * 60 * 1000; // first run downloads the NSIS toolchain
const watchdog = setTimeout(() => {
  process.stdout.write('portable build FAILED\n\noverall watchdog fired\n');
  process.exit(1);
}, OVERALL_TIMEOUT_MS);
watchdog.unref();

const steps = [];
function step(name, detail = '') {
  steps.push({ name, detail });
  process.stderr.write(`  · ${name}${detail === '' ? '' : ` - ${detail}`}\n`);
}

function note(message) {
  process.stderr.write(`[build-portable] ${message}\n`);
}

let exitCode = 0;
try {
  await buildAll();
  process.stdout.write('portable build completed\n');
  for (const s of steps) {
    process.stdout.write(`  ok  ${s.name}${s.detail === '' ? '' : ` - ${s.detail}`}\n`);
  }
} catch (error) {
  exitCode = 1;
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write('portable build FAILED\n\n' + message + '\n');
} finally {
  clearTimeout(watchdog);
}
process.exit(exitCode);

// ---------------------------------------------------------------------------

async function buildAll() {
  const version = assertReleaseVersionStamp();

  // ---- 1. the pinned stage -------------------------------------------------
  note('staging the pinned package layout (build-server-bundle.mjs)');
  await runNode([BUILD_BUNDLE_SCRIPT], APP_ROOT, 'build-server-bundle');
  step('stage', path.relative(APP_ROOT, STAGE));

  // ---- 2. the shell + NSIS bundle -------------------------------------------
  note('building the Tauri shell with the NSIS bundle (first run downloads the NSIS toolchain)');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TAURI_CLI, 'build'], {
      cwd: TAURI_DIR,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      out += String(chunk);
      process.stderr.write(`  ${String(chunk).trimEnd()}\n`);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`tauri build exited ${code}\n${tailOf(out, 60)}`));
    });
  });
  if (!existsSync(SHELL_EXE)) throw new Error(`The Tauri build produced no ${SHELL_EXE}`);
  const setupExe = findSetupExe(version);
  step('build-shell', `${path.relative(APP_ROOT, SHELL_EXE)} + ${path.relative(APP_ROOT, setupExe)}`);

  // ---- 3. assemble the portable folder from the include list ----------------
  const stageExiftool = path.join(STAGE, 'vendor', 'exiftool', 'exiftool.exe');
  if (!existsSync(stageExiftool)) throw new Error(`The stage has no vendored engine: ${stageExiftool}`);
  rmSync(PORTABLE_ROOT, { recursive: true, force: true });
  mkdirSync(PACKAGE_DIR, { recursive: true });
  for (const relative of INCLUDE_FILES) {
    const from = path.join(STAGE, ...relative.split('/'));
    if (!existsSync(from)) throw new Error(`Include-list source missing from the stage: ${relative}`);
    copyInto(from, path.join(PACKAGE_DIR, ...relative.split('/')));
  }
  for (const relative of INCLUDE_TREES) {
    const from = path.join(STAGE, ...relative.split('/'));
    if (!existsSync(from)) throw new Error(`Include-list tree missing from the stage: ${relative}`);
    cpSync(from, path.join(PACKAGE_DIR, ...relative.split('/')), { recursive: true });
  }
  copyInto(SHELL_EXE, path.join(PACKAGE_DIR, 'MetaDesk.exe'));
  step('assemble', `${INCLUDE_FILES.length} files + ${INCLUDE_TREES.length} trees + MetaDesk.exe`);

  await assertShippedCopiesMatchStage();
  step('byte-identity', 'shipped server.mjs / package.json / node.exe / exiftool.exe / ui index.html match the stage');

  assertNoDevJunk(PACKAGE_DIR);
  const fileCount = listFiles(PACKAGE_DIR).length;
  step('junk-audit', `${fileCount} files, no dev junk classes present`);

  // ---- 4. the zip -----------------------------------------------------------
  const zipPath = path.join(OUT_DIR, `metadesk-${version}-portable-win-x64.zip`);
  rmSync(zipPath, { force: true });
  const entryNames = await createZip(PACKAGE_DIR, zipPath);
  if (entryNames.length !== fileCount) {
    throw new Error(`The zip holds ${entryNames.length} entries but the folder has ${fileCount} files`);
  }
  step('zip', `${path.basename(zipPath)} (${formatBytes(statSync(zipPath).size)}, ${entryNames.length} entries, MetaDesk/ root)`);

  // ---- 5. the content manifest + provenance ---------------------------------
  const manifestPath = path.join(OUT_DIR, `portable-manifest-${version}.json`);
  const manifest = { version, zip: path.basename(zipPath), rootInZip: 'MetaDesk/', generatedAt: new Date().toISOString(), fileCount, files: [] };
  for (const file of listFiles(PACKAGE_DIR)) {
    const relative = path.relative(PACKAGE_DIR, file).split(path.sep).join('/');
    manifest.files.push({ path: `MetaDesk/${relative}`, sha256: sha256File(file), bytes: statSync(file).size });
  }
  manifest.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  step('manifest', `${path.basename(manifestPath)} (${manifest.files.length} sha256 entries)`);

  const provenancePath = await writeProvenance({ version, zipPath, entryNames, manifestPath, setupExe });
  step('provenance', `${path.relative(APP_ROOT, provenancePath)}`);
}

/**
 * 1.0.0 must read the same everywhere it shows: app/package.json (the staged
 * copy + the UI handshake version), tauri.conf.json (exe metadata) and
 * Cargo.toml (crate version). One source of truth check, here, before
 * anything is built; the artifact filenames derive from it.
 */
function assertReleaseVersionStamp() {
  const appVersion = readJson(APP_PACKAGE_JSON)?.version;
  const confVersion = readJson(TAURI_CONF)?.version;
  const cargo = readFileSync(CARGO_TOML, 'utf8');
  const cargoMatch = cargo.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);
  const cargoVersion = cargoMatch === null ? null : cargoMatch[1];
  const stamps = { 'app/package.json': appVersion, 'tauri.conf.json': confVersion, 'Cargo.toml': cargoVersion };
  for (const [where, found] of Object.entries(stamps)) {
    if (typeof found !== 'string' || !/^\d+\.\d+\.\d+$/.test(found)) {
      throw new Error(`${where} has no usable release version: ${JSON.stringify(found)}`);
    }
    if (found !== appVersion) {
      throw new Error(`Version stamps disagree: app/package.json says ${appVersion} but ${where} says ${found}`);
    }
  }
  step('version-stamp', `all three say ${appVersion}`);
  return appVersion;
}

function findSetupExe(version) {
  if (!existsSync(NSIS_DIR)) throw new Error(`The NSIS bundle directory is missing: ${NSIS_DIR}`);
  const exes = readdirSync(NSIS_DIR).filter((name) => name.toLowerCase().endsWith('.exe'));
  if (exes.length !== 1) {
    throw new Error(`Expected exactly one setup exe under ${path.relative(APP_ROOT, NSIS_DIR)}, found: ${exes.join(', ') || '(none)'}`);
  }
  const setup = path.join(NSIS_DIR, exes[0]);
  if (!exes[0].includes(version)) {
    throw new Error(`The NSIS setup exe name does not carry the version ${version}: ${exes[0]}`);
  }
  return setup;
}

function copyInto(from, to) {
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to);
}

/** The shipped copies must be the stage we just built (never stale residue). */
function assertShippedCopiesMatchStage() {
  const compared = [...INCLUDE_FILES, 'ui/dist/index.html', 'vendor/exiftool/exiftool.exe'];
  for (const relative of compared) {
    const shipped = path.join(PACKAGE_DIR, ...relative.split('/'));
    const staged = path.join(STAGE, ...relative.split('/'));
    const shippedHash = sha256File(shipped);
    if (shippedHash !== sha256File(staged)) {
      throw new Error(`The shipped ${relative} does not match the stage (${shippedHash.slice(0, 12)}…)`);
    }
  }
}

/** Fail the build if any dev junk class appears anywhere in the shipped folder. */
function assertNoDevJunk(packageDir) {
  const hits = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (FORBIDDEN_DIRS.has(entry.name)) hits.push(`directory ${path.relative(packageDir, full)}/`);
        else walk(full);
        continue;
      }
      if (FORBIDDEN_FILES.has(entry.name)) hits.push(`file ${path.relative(packageDir, full)}`);
      else if (FORBIDDEN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        hits.push(`file ${path.relative(packageDir, full)}`);
      }
    }
  };
  walk(packageDir);
  if (hits.length > 0) {
    throw new Error(`Dev junk found in the portable folder (include list leaked):\n  ${hits.join('\n  ')}`);
  }
}

/**
 * Zip the package folder (with its MetaDesk/ base directory) through pwsh's
 * .NET ZipFile — entry names come out forward-slashed on .NET 5+, which every
 * extractor reads. The entry list is returned so the build asserts what it
 * just wrote.
 */
async function createZip(packageDir, zipPath) {
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `[System.IO.Compression.ZipFile]::CreateFromDirectory('${pwsq(packageDir)}', '${pwsq(zipPath)}', [System.IO.Compression.CompressionLevel]::Optimal, $true)`,
    `$zip = [System.IO.Compression.ZipFile]::OpenRead('${pwsq(zipPath)}')`,
    '$zip.Entries | ForEach-Object { $_.FullName }',
    `$backslash = ($zip.Entries | Where-Object { $_.FullName.Contains('\\') } | Measure-Object).Count`,
    "if ($backslash -gt 0) { throw \"$backslash zip entry name(s) carry a backslash\" }",
    '$zip.Dispose()',
  ].join('; ');
  const out = await runPowerShell(script);
  const names = out.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const badRoot = names.filter((name) => !name.startsWith('MetaDesk/'));
  if (badRoot.length > 0) {
    throw new Error(`Zip entries outside the MetaDesk/ root: ${badRoot.slice(0, 5).join(', ')}`);
  }
  return names;
}

/**
 * The provenance record leaf 2.2.3 consumes for the release notes: pinned
 * node version + hash, exiftool -ver from the staged copy, the shell + setup
 * exe sha256/size/Authenticode status (expected NotSigned — recorded
 * honestly, not hidden), and the zip facts.
 */
async function writeProvenance({ version, zipPath, entryNames, manifestPath, setupExe }) {
  const packageNode = path.join(PACKAGE_DIR, 'node', 'node.exe');
  const packageExiftool = path.join(PACKAGE_DIR, 'vendor', 'exiftool', 'exiftool.exe');
  const stagedExiftool = path.join(STAGE, 'vendor', 'exiftool', 'exiftool.exe');

  // The node pin, re-read from the fetch script that owns it (D3).
  const fetchSource = readFileSync(FETCH_NODE_SCRIPT, 'utf8');
  const pinVersion = fetchSource.match(/PINNED_NODE_VERSION\s*=\s*'([^']+)'/)?.[1] ?? 'unknown';
  const pinSha = fetchSource.match(/PINNED_NODE_EXE_SHA256\s*=\s*'([0-9a-f]{64})'/)?.[1] ?? 'unknown';

  const nodeVersion = (await runCapture(packageNode, ['--version'])).trim();
  const nodeSha = sha256File(packageNode);
  if (nodeSha !== pinSha) {
    throw new Error(`The shipped node.exe hash does not match the D3 pin: ${nodeSha} != ${pinSha}`);
  }
  const exiftoolVersion = (await runCapture(stagedExiftool, ['-ver'])).trim();
  const exiftoolSha = sha256File(packageExiftool);
  if (exiftoolSha !== sha256File(stagedExiftool)) {
    throw new Error('The packaged exiftool.exe does not match the staged copy');
  }

  const signatures = await signatureStatuses([SHELL_EXE, setupExe]);
  const lines = [
    `MetaDesk ${version} build provenance`,
    `generated: ${new Date().toISOString()}`,
    `built by: app/scripts/build-portable.mjs --all`,
    `package layout: pinned (BUILD-NOTES "The wrapped shape"); folder root = MetaDesk/`,
    '',
    `version stamp: app/package.json = tauri.conf.json = Cargo.toml = ${version}`,
    `zip: ${path.basename(zipPath)}`,
    `zip sha256: ${sha256File(zipPath)}`,
    `zip bytes: ${statSync(zipPath).size}`,
    `zip entries: ${entryNames.length} files under MetaDesk/`,
    `manifest: ${path.basename(manifestPath)} (sha256 per content file)`,
    '',
    `node pinned version: ${pinVersion}`,
    `node shipped sha256: ${nodeSha}`,
    `node shipped bytes: ${statSync(packageNode).size}`,
    `node --version (from the package): ${nodeVersion}`,
    `exiftool -ver (staged copy): ${exiftoolVersion}`,
    `exiftool shipped sha256: ${exiftoolSha}`,
    `exiftool shipped bytes: ${statSync(packageExiftool).size}`,
    '',
    ...signatures,
    '',
    'Authenticode note: the shell and the installer are unsigned for v1 (no cert purchased).',
    'First run shows SmartScreen "Windows protected your PC" -> More info -> Run anyway;',
    'release notes carry the SHA-256 values above for verification.',
  ];
  const provenancePath = path.join(OUT_DIR, `provenance-${version}.txt`);
  writeFileSync(provenancePath, lines.join('\n') + '\n', 'utf8');
  return provenancePath;
}

/** sha256 + bytes + Get-AuthenticodeSignature status + ProductVersion, per exe. */
async function signatureStatuses(exePaths) {
  const payload = exePaths.map((p) => `'${pwsq(p)}'`).join(', ');
  const json = await runPowerShell(`
    $out = @()
    foreach ($p in @(${payload})) {
      $sig = Get-AuthenticodeSignature -LiteralPath $p
      $item = Get-Item -LiteralPath $p
      $out += [pscustomobject]@{
        path = $p
        sha256 = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()
        bytes = $item.Length
        status = [string]$sig.Status
        statusMessage = [string]$sig.StatusMessage
        productVersion = [string]$item.VersionInfo.ProductVersion
      }
    }
    $out | ConvertTo-Json -Compress -Depth 3
  `);
  const parsed = JSON.parse(json || '[]');
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => [
    `${path.basename(row.path)}:`,
    `  sha256: ${row.sha256}`,
    `  bytes: ${row.bytes}`,
    `  authenticode: ${row.status} (${row.statusMessage})`,
    `  productVersion: ${row.productVersion}`,
  ].join('\n'));
}

// ---- small helpers -----------------------------------------------------------

function pwsq(text) {
  return String(text).replace(/'/g, "''");
}

function tailOf(text, count = 40) {
  if (!text || text.trim().length === 0) return '';
  return text.split(/\r?\n/).slice(-count).join('\n');
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
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
  return out.sort();
}

function formatBytes(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MiB`;
}

/** argv-array spawn of node with a script; never a shell string (house rule). */
function runNode(args, cwd, label) {
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
      reject(new Error(`${label} exited ${code}\n${tailOf(err, 40)}`));
    });
  });
}

function runCapture(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve(out);
        return;
      }
      reject(new Error(`${path.basename(file)} ${args.join(' ')} exited ${code}`));
    });
  });
}

/** argv-array spawn of pwsh with a readable (non-base64) script argument. */
function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', script], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      err += String(chunk);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve(out);
        return;
      }
      reject(new Error(`pwsh exited ${code}: ${tailOf(err, 10)}`));
    });
  });
}
