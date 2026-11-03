#!/usr/bin/env node
/**
 * Package self-sufficiency gate (leaf 2.2.2).
 *
 *   node app/scripts/verify-package.mjs
 *
 * Takes the artifacts build-portable.mjs emitted under app/dist-desktop/ and
 * proves the SHIPPED thing works with nothing but what is inside the zip:
 *
 *   1. locate zip + content manifest + provenance (all three required);
 *      the zip's sha256 must match the provenance record
 *   2. extract the zip to a temp dir (Expand-Archive — the Windows-blessed
 *      extractor, so the zip is proven readable by the tool a user runs)
 *   3. verify the content manifest: every file present, every hash matching,
 *      and NOTHING extra — the manifest set is exactly the extracted set
 *   4. dev junk absence (node_modules, .git, data contents, evidence, ts
 *      sources, test fixtures, portfile/lock residue) — asserted here
 *      independently of the build's own audit
 *   5. `node\node.exe --version` and `vendor\exiftool\exiftool.exe -ver` run
 *      FROM the extracted folder
 *   6. node.exe PE header machine type is x64 (0x8664) — and MetaDesk.exe too
 *   7. `node\node.exe scripts\selfcheck.mjs` from the extracted folder passes
 *   8. boot the extracted MetaDesk.exe with a temp data dir: /api/health ok,
 *      the served page carries window.__METADESK__ (the "UI bundle missing"
 *      status page is a FAILURE), exactly ONE LISTEN socket on 127.0.0.1
 *      owned by node.exe inside the spawn tree; then close it and assert the
 *      tree teardown, no portfile/lock residue, and no new node.exe /
 *      exiftool.exe pids against the machine-wide baseline.
 *
 * Marker (first stdout line, success only): `package verification passed`.
 * Progress goes to stderr. Node built-ins only; every child process is an
 * argv-array spawn with shell:false. Windows-only by design.
 *
 * Process counting is MACHINE-WIDE (baseline vs after, pid SETS with one
 * settle+retry), exactly like verify-desktop.mjs — never run this
 * concurrently with `npm test`, verify-launch.mjs, verify-desktop.mjs or a
 * build. The packaged app's window appears on the desktop for a few seconds
 * while the boot check runs; that is expected and not suppressed.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  assertNoNewProcesses,
  processPids,
  pwsq,
  runCapture,
  runPowerShell,
  waitForQuietMachine,
} from './lib/processes.mjs';
import { bootAndProve } from './lib/bootAndProve.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(APP_ROOT, 'dist-desktop');
const PE_MACHINE_X64 = 0x8664;

if (process.argv.length > 2) {
  process.stdout.write(
    [
      'Usage: node app/scripts/verify-package.mjs',
      '',
      'Extracts the portable zip built by build-portable.mjs and proves it is',
      'self-sufficient (manifest, junk-free, node/exiftool run from inside, PE',
      'x64, selfcheck, real boot + teardown).',
      '',
      'Never run this concurrently with npm test, verify-launch.mjs,',
      'verify-desktop.mjs or build-portable.mjs: the orphan assertions count',
      'node.exe/exiftool.exe machine-wide.',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

const OVERALL_TIMEOUT_MS = 15 * 60 * 1000;
const watchdog = setTimeout(() => {
  process.stdout.write('package verification FAILED\n\noverall watchdog fired\n');
  process.exit(1);
}, OVERALL_TIMEOUT_MS);
watchdog.unref();

const steps = [];
/** Extra diagnostics printed with a failure; refreshed as the run progresses. */
let diagOf = () => '';
const scratchDirs = [];
let appChild = null;

function step(name, detail = '') {
  steps.push({ name, detail });
  process.stderr.write(`  · ${name}${detail === '' ? '' : ` - ${detail}`}\n`);
}

function note(message) {
  process.stderr.write(`[verify-package] ${message}\n`);
}

function tailOf(text, count = 40) {
  if (!text || text.trim().length === 0) return '';
  return text.split(/\r?\n/).slice(-count).join('\n');
}

let exitCode = 0;
try {
  await verifyPackage();
  process.stdout.write('package verification passed\n');
  for (const s of steps) {
    process.stdout.write(`  ok  ${s.name}${s.detail === '' ? '' : ` - ${s.detail}`}\n`);
  }
} catch (error) {
  exitCode = 1;
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write('package verification FAILED\n\n' + message + '\n');
  const extra = diagOf();
  if (extra.trim().length > 0) process.stdout.write('\n' + extra.trim() + '\n');
} finally {
  if (appChild && appChild.exitCode === null && appChild.signalCode === null) {
    try {
      appChild.kill();
    } catch {
      /* already gone */
    }
  }
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  clearTimeout(watchdog);
}
process.exit(exitCode);

// ---------------------------------------------------------------------------

async function verifyPackage() {
  // ---- 1. the artifacts -------------------------------------------------------
  const zipPath = await requireArtifacts();
  const manifest = readJson(path.join(OUT_DIR, manifestNameFor(zipPath)));
  if (manifest === null) throw new Error(`The content manifest is missing or unreadable: ${manifestNameFor(zipPath)}`);
  if (manifest.version !== versionOf(zipPath)) {
    throw new Error(`The manifest version ${manifest.version} does not match the zip ${path.basename(zipPath)}`);
  }
  step('artifacts', `${path.basename(zipPath)} + ${path.basename(provenanceNameFor(zipPath))}`);

  // ---- machine-wide baselines BEFORE anything runs ----------------------------
  await waitForQuietMachine({ onNote: note });
  const before = { node: await processPids('node.exe'), exiftool: await processPids('exiftool.exe') };
  step('baselines', `${before.node.size} node.exe, ${before.exiftool.size} exiftool.exe before the run`);

  // ---- 2. extract with the extractor a user runs ------------------------------
  const scratch = makeScratch();
  const extractDir = path.join(scratch, 'extracted');
  await runPowerShell(
    `Expand-Archive -LiteralPath '${pwsq(zipPath)}' -DestinationPath '${pwsq(extractDir)}' -Force; ` +
      `Write-Output EXTRACT-OK`,
    'extract',
  );
  const packageRoot = path.join(extractDir, 'MetaDesk');
  if (!existsSync(packageRoot)) {
    throw new Error(`The zip did not extract to a MetaDesk/ folder: ${extractDir}`);
  }
  step('extract', `${path.basename(zipPath)} -> ${path.relative(APP_ROOT, packageRoot)}`);

  // ---- 3. the content manifest is exactly the extracted set -------------------
  verifyManifest(packageRoot, manifest);
  step('manifest', `all ${manifest.files.length} files present, sha256 matching, nothing extra`);

  // ---- 4. dev junk absence ----------------------------------------------------
  assertNoDevJunk(packageRoot);
  step('junk-absence', 'no node_modules / .git / data contents / evidence / ts / test fixtures / runtime residue');

  // ---- 5. the version stamp rode along ----------------------------------------
  const shippedVersion = readJson(path.join(packageRoot, 'package.json'))?.version;
  if (shippedVersion !== manifest.version) {
    throw new Error(`The shipped package.json says version ${JSON.stringify(shippedVersion)}, expected ${manifest.version}`);
  }
  step('version', `shipped package.json version ${shippedVersion}`);

  // ---- 6. the tools run FROM the extracted folder ------------------------------
  const nodeExe = path.join(packageRoot, 'node', 'node.exe');
  const exiftoolExe = path.join(packageRoot, 'vendor', 'exiftool', 'exiftool.exe');
  const nodeVersion = (await runCapture(nodeExe, ['--version'])).trim();
  if (!nodeVersion.startsWith('v22.')) throw new Error(`The shipped node.exe is not 22.x: ${nodeVersion}`);
  step('node-runtime', `${nodeVersion} (ran from inside the extracted folder)`);

  const exifVersion = (await runCapture(exiftoolExe, ['-ver'])).trim();
  if (!/^\d+\.\d+/.test(exifVersion)) throw new Error(`The shipped exiftool did not answer -ver: ${exifVersion}`);
  step('engine', `exiftool ${exifVersion} (ran from inside the extracted folder)`);

  // ---- 7. PE machine types ------------------------------------------------------
  for (const [label, exePath] of [['node.exe', nodeExe], ['MetaDesk.exe', path.join(packageRoot, 'MetaDesk.exe')]]) {
    const machine = peMachine(exePath);
    if (machine !== PE_MACHINE_X64) {
      throw new Error(`The shipped ${label} PE machine type is 0x${machine.toString(16)}, expected x64 (0x8664)`);
    }
    step('pe-machine', `${label} is x64 (0x8664)`);
  }

  // ---- 8. the layout self-check the package carries ----------------------------
  const selfcheck = await runCaptureExit(nodeExe, [path.join('scripts', 'selfcheck.mjs')], packageRoot);
  if (selfcheck.code !== 0) {
    throw new Error(`scripts\\selfcheck.mjs failed inside the extracted folder (exit ${selfcheck.code}):\n${tailOf(selfcheck.out, 20)}`);
  }
  if (!selfcheck.out.includes('package layout self-check passed')) {
    throw new Error(`selfcheck.mjs did not print its pass marker:\n${tailOf(selfcheck.out, 20)}`);
  }
  if (!selfcheck.out.includes(`version: ${manifest.version}`)) {
    throw new Error(`selfcheck.mjs did not report version ${manifest.version}:\n${tailOf(selfcheck.out, 20)}`);
  }
  step('selfcheck', 'node\\node.exe scripts\\selfcheck.mjs passed from the extracted folder');

  // ---- 9. boot the extracted app and prove the lifecycle contract ---------------
  // Issue #19: boot -> portfile -> spawn-tree -> health -> served page ->
  // one-listener -> WM_CLOSE -> teardown -> residue lives ONCE in
  // scripts/lib/bootAndProve.mjs. This gate contributes its delta (the
  // served page must announce the SHIPPED version) and keeps the machine-wide
  // orphan gate, which owns the before-baseline taken above.
  const dataDir = path.join(makeScratch(), 'data');
  let appOutput = '';
  diagOf = () => `--- MetaDesk.exe output (tail) ---\n${tailOf(appOutput)}`;
  await bootAndProve({
    exe: path.join(packageRoot, 'MetaDesk.exe'),
    cwd: packageRoot,
    env: { ...process.env, METADESK_DATA_DIR: dataDir },
    packageRoot,
    dataDir,
    label: 'the extracted app',
    expectedVersion: manifest.version,
    onChild: (child) => {
      appChild = child; // the failure path and cleanup must always know the child
    },
    onStep: step,
    onNote: note,
    onOutput: (text) => {
      appOutput += text;
    },
  });
  await assertNoNewProcesses(before, { onNote: note });
  step('no-orphans', 'node + exiftool back to the machine-wide baseline');
}

/** Locate zip + provenance; assert the zip hash matches the provenance record. */
async function requireArtifacts() {
  const zips = readdirSync(OUT_DIR)
    .filter((name) => /^metadesk-\d+\.\d+\.\d+-portable-win-x64\.zip$/.test(name))
    .sort();
  if (zips.length !== 1) {
    throw new Error(`Expected exactly one portable zip under ${path.relative(APP_ROOT, OUT_DIR)}, found: ${zips.join(', ') || '(none)'}. Run build-portable.mjs --all first.`);
  }
  const zipPath = path.join(OUT_DIR, zips[0]);
  const provenancePath = path.join(OUT_DIR, provenanceNameFor(zipPath));
  if (!existsSync(provenancePath)) {
    throw new Error(`The provenance record is missing: ${provenancePath} (run build-portable.mjs --all)`);
  }
  const provenance = readFileSync(provenancePath, 'utf8');
  const recordedZipSha = provenance.match(/^zip sha256: ([0-9a-f]{64})$/m)?.[1];
  if (recordedZipSha === undefined) throw new Error('The provenance record has no "zip sha256:" line');
  const actualZipSha = sha256File(zipPath);
  if (actualZipSha !== recordedZipSha) {
    throw new Error(`The zip does not match the provenance record:\n  zip        ${actualZipSha}\n  provenance ${recordedZipSha}`);
  }
  const recordedSetupSha = provenanceSectionField(provenance, /-setup\.exe$/, 'sha256');
  if (recordedSetupSha === undefined) {
    throw new Error('The provenance record does not carry the NSIS setup exe sha256');
  }
  if (!/authenticode: NotSigned/i.test(provenance)) {
    throw new Error('The provenance record does not state the honest Authenticode status');
  }
  step('provenance', 'zip sha256 + NSIS setup sha256 + Authenticode status all recorded and matching');
  return zipPath;
}

function manifestNameFor(zipPath) {
  return `portable-manifest-${versionOf(zipPath)}.json`;
}

function provenanceNameFor(zipPath) {
  return `provenance-${versionOf(zipPath)}.txt`;
}

function versionOf(zipPath) {
  const match = path.basename(zipPath).match(/^metadesk-(\d+\.\d+\.\d+)-portable-win-x64\.zip$/);
  if (match === null) throw new Error(`Unreadable zip name: ${path.basename(zipPath)}`);
  return match[1];
}

/** Find "sha256: <hash>" inside a provenance section like "MetaDesk_1.0.0_x64-setup.exe:". */
function provenanceSectionField(provenance, sectionPattern, field) {
  let inSection = false;
  for (const line of provenance.split(/\r?\n/)) {
    const header = line.match(/^(\S.*):$/);
    if (header !== null) {
      // header[1] carries the section name without its trailing colon.
      inSection = sectionPattern.test(header[1]);
      continue;
    }
    if (inSection) {
      const value = line.match(new RegExp(`^\\s+${field}: (.+)$`));
      if (value !== null) return value[1].trim();
    }
  }
  return undefined;
}

/** Every manifest file present with a matching hash, and NOTHING extra. */
function verifyManifest(packageRoot, manifest) {
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('The manifest lists no files');
  }
  const expected = new Map(manifest.files.map((row) => [row.path, row]));
  const actual = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const zipPath = `MetaDesk/${path.relative(packageRoot, full).split(path.sep).join('/')}`;
      actual.set(zipPath, full);
    }
  };
  walk(packageRoot);

  const missing = [...expected.keys()].filter((key) => !actual.has(key));
  const extra = [...actual.keys()].filter((key) => !expected.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      [
        'The extracted folder does not match the content manifest.',
        ...missing.slice(0, 10).map((key) => `  missing: ${key}`),
        ...extra.slice(0, 10).map((key) => `  extra:   ${key}`),
        `  (${expected.size} manifest entries, ${actual.size} extracted files)`,
      ].join('\n'),
    );
  }
  for (const [zipPath, row] of expected) {
    const file = actual.get(zipPath);
    const hash = sha256File(file);
    if (hash !== row.sha256) {
      throw new Error(`Manifest hash mismatch for ${zipPath}:\n  file     ${hash}\n  manifest ${row.sha256}`);
    }
    if (statSync(file).size !== row.bytes) {
      throw new Error(`Manifest size mismatch for ${zipPath}: ${statSync(file).size} != ${row.bytes}`);
    }
  }
}

/**
 * Dev junk classes that must be absent, re-asserted here independently of the
 * build's own audit (BUILD-NOTES "Packaging invariants"). Deliberate
 * non-hits: vendor/exiftool's own Perl `Test`/`Data` module dirs are the
 * UNMODIFIED vendored engine, and ui/dist's .js.map is built bundle output.
 */
function assertNoDevJunk(packageRoot) {
  const forbiddenDirs = new Set([
    'node_modules',
    '.git',
    '.github',
    '.vscode',
    '.idea',
    'data', // exact case: the runtime state dir the server creates at boot
    'evidence',
    'fixtures',
    '__tests__',
    '__mocks__',
    '__evidence-snapshot__',
    'coverage',
  ]);
  const forbiddenExtensions = new Set(['.ts', '.tsx', '.log', '.bak', '.tmp']);
  const forbiddenFiles = new Set(['portfile.json', 'instance.lock', 'stop.request']);
  const hits = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (forbiddenDirs.has(entry.name)) hits.push(`directory ${path.relative(packageRoot, full)}/`);
        else walk(full);
        continue;
      }
      if (forbiddenFiles.has(entry.name)) hits.push(`file ${path.relative(packageRoot, full)}`);
      else if (forbiddenExtensions.has(path.extname(entry.name).toLowerCase())) {
        hits.push(`file ${path.relative(packageRoot, full)}`);
      }
    }
  };
  walk(packageRoot);
  if (hits.length > 0) {
    throw new Error(`Dev junk inside the extracted package:\n  ${hits.join('\n  ')}`);
  }
}

/** DOS header MZ -> PE header -> COFF Machine field. */
function peMachine(exePath) {
  const buf = readFileSync(exePath);
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) {
    throw new Error(`${path.basename(exePath)} has no DOS header (not a PE file)`);
  }
  const peOffset = buf.readUInt32LE(0x3c);
  if (peOffset + 6 > buf.length || buf.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error(`${path.basename(exePath)} has no PE signature at 0x${peOffset.toString(16)}`);
  }
  return buf.readUInt16LE(peOffset + 4);
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** runCapture that also reports the exit code (for the selfcheck). */
function runCaptureExit(file, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
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
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, out }));
  });
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function makeScratch() {
  const dir = mkdtempSync(path.join(tmpdir(), 'metadesk-verify-package-'));
  scratchDirs.push(dir);
  return dir;
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}
