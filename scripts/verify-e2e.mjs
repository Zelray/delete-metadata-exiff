#!/usr/bin/env node
/**
 * E2E verification gate (leaf 1.2.1) — the oracles for root GATES G3 and G4.
 *
 * Subcommands (run from the repo root: node app/scripts/verify-e2e.mjs <name>):
 *
 *   unit      the server Vitest suite AND the ui Vitest suite, both green
 *   roundtrip ROOT GATE G3: boot the REAL stack the way verify-launch.mjs does
 *             (launcher metadesk.mjs --no-browser, temp METADESK_DATA_DIR),
 *             then over HTTP with the portfile token: scan a fixture folder,
 *             read metadata, preview a small edit set on ONE fixture file
 *             (old -> new diff), execute, verify EXTERNALLY with the vendored
 *             `exiftool -j` that the tag carries the new value, undo the
 *             batch, and assert sha256(after) === sha256(before).
 *   scrub     ROOT GATE G4: a synthetic SD-style PNG (PNG:Parameters,
 *             PNG:Software, EXIF:UserComment planted through the engine, plus
 *             REAL ComfyUI-style Prompt/Workflow tEXt chunks the engine
 *             cannot write or remove — recorded in the expectation), scan,
 *             execute behind the REMOVE AI METADATA phrase, verify externally
 *             that the removable tags are GONE and the unremovable chunk is
 *             honestly still there, assert the sidecar export holds the
 *             original values, undo restores sha256-identical bytes.
 *   gps       C10 evidence, same pattern: a GPS-bearing JPEG, the
 *             {destructive:{scope:"gps"}} preview, the typed-phrase execute,
 *             an external read proving zero GPS keys, then a byte-identical
 *             undo.
 *   evidence  LEAF 2.3.1 G2: the evidence snapshot is consistent —
 *             app/tests-e2e/__evidence-snapshot__/ is byte-identical to
 *             app/evidence/ file-by-file (sha256, exactly the 10 frames of
 *             record on both sides) and MANIFEST.txt lists EVERY frame with
 *             its capture date and the claim it proves, the three leaf-2.3.1
 *             retakes (01/09/10) marked `retaken`. No app boot, no browser.
 *   all       unit + roundtrip + scrub + gps + the Playwright matrix
 *             (app/tests-e2e/matrix.mjs: real launcher + built UI bundle +
 *             screenshots) + the same evidence-snapshot check, and prints the
 *             overall marker.
 *
 *   all --packaged   (leaf 2.2.2) the same suite, but the Playwright matrix
 *             boots the EXTRACTED PACKAGE's MetaDesk.exe (from
 *             app/dist-desktop/metadesk-*-portable-win-x64.zip, extracted to
 *             a temp dir) with a temp data dir instead of the dev launcher —
 *             boot seam only; the flows, assertions and evidence handling are
 *             byte-for-byte the same run. `--packaged` is only valid with
 *             "all" and must come after the subcommand.
 *
 * Success markers, printed EXACTLY as the FIRST line of stdout:
 *
 *   e2e roundtrip verification passed
 *   e2e AI-scrub verification passed
 *   e2e gps-strip verification passed
 *   e2e unit verification passed
 *   evidence snapshot verification passed
 *   all e2e verifications passed
 *
 * Any failure prints diagnostics and exits 1. Node built-ins only; every
 * child process is an argv-array spawn with shell:false (no shell strings).
 * Do not run this concurrently with other node-heavy jobs — the matrix counts
 * processes and boots real servers.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER = path.join(APP_ROOT, 'bin', 'metadesk.mjs');
const EXE = path.join(APP_ROOT, 'vendor', 'exiftool', 'exiftool.exe');
const SERVER_DIR = path.join(APP_ROOT, 'server');
const UI_DIR = path.join(APP_ROOT, 'ui');
const TESTS_E2E_DIR = path.join(APP_ROOT, 'tests-e2e');
const UI_DIST_INDEX = path.join(UI_DIR, 'dist', 'index.html');

const SUBCOMMANDS = new Set(['unit', 'roundtrip', 'scrub', 'gps', 'evidence', 'all']);
const requested = process.argv[2] ?? 'all';
if (!SUBCOMMANDS.has(requested)) {
  process.stdout.write(
    `e2e verification FAILED\n\nunknown subcommand "${requested}" — expected one of: unit, roundtrip, scrub, gps, evidence, all\n`,
  );
  process.exit(1);
}

/** leaf 2.2.2: `--packaged` after the subcommand runs the matrix on the package. */
const PACKAGED_FLAG = process.argv.slice(3).includes('--packaged');
const unknownArgs = process.argv.slice(3).filter((arg) => arg !== '--packaged');
if (unknownArgs.length > 0 || (PACKAGED_FLAG && requested !== 'all')) {
  process.stdout.write(
    'e2e verification FAILED\n\nusage: node app/scripts/verify-e2e.mjs <unit|roundtrip|scrub|gps|evidence|all> [--packaged]  (--packaged is only valid with "all")\n',
  );
  process.exit(1);
}

const watchdogDelay = (requested === 'all' ? (PACKAGED_FLAG ? 12 : 10) : 6) * 60 * 1000;
const watchdog = setTimeout(() => {
  process.stdout.write(`e2e verification FAILED\n\noverall watchdog fired (${watchdogDelay / 60000} min)\n`);
  process.exit(1);
}, watchdogDelay);
watchdog.unref();

// ---- progress goes to STDERR so the success marker is stdout-FIRST ----------

const steps = [];
function step(name, detail = '') {
  steps.push({ name, detail });
  process.stderr.write(`  ok  ${name}${detail === '' ? '' : ` - ${detail}`}\n`);
}

let exitCode = 0;
let scratch = '';

function finish(marker) {
  // The marker goes FIRST on stdout; the step log follows (progress was on stderr).
  process.stdout.write(`${marker}\n`);
  for (const s of steps) {
    process.stdout.write(`  ok  ${s.name}${s.detail === '' ? '' : ` - ${s.detail}`}\n`);
  }
}

function fail(message) {
  throw new Error(message);
}

// ---- shared fixture + engine helpers (Node built-ins, argv-array spawns) ----

/** The pinned 1x1 RGBA PNG (app/server/test/helpers.ts). */
const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000d4944415478da63fccfc0500f000485018084a98c210000000049454e44ae426082',
  'hex',
);
const IEND = Buffer.from('0000000049454e44ae426082', 'hex');
const SCRUB_PHRASE = 'REMOVE AI METADATA';
const GPS_PHRASE = 'REMOVE GPS DATA';

async function newScratch(label) {
  scratch = await mkdtemp(path.join(tmpdir(), `metadesk-e2e-${label}-`));
  return scratch;
}
async function cleanupScratch() {
  if (scratch !== '') await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}


/** Run the vendored exiftool once (argv array). */
function exifRun(args) {
  const result = spawnSync(EXE, args, { shell: false, encoding: 'utf8', windowsHide: true });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** `-j -G1 -a -struct` read, parsed. */
function exifJson(paths) {
  const result = exifRun(['-j', '-G1', '-a', '-struct', ...paths]);
  if (result.status !== 0) fail(`exiftool read failed (${result.status}): ${result.stderr.slice(0, 300)}`);
  return JSON.parse(result.stdout);
}

function exifDocFor(docs, filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  return docs.find((doc) => doc['SourceFile'] === normalized);
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** A PNG tEXt chunk (keyword\0 + text + CRC32) — ComfyUI's storage format. */
function textChunk(keyword, text) {
  const body = Buffer.concat([Buffer.from(`${keyword}\0`, 'latin1'), Buffer.from(text, 'latin1')]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const type = Buffer.from('tEXt', 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([type, body])) >>> 0, 0);
  return Buffer.concat([length, type, body, crc]);
}

/** PNG_1X1 with real ComfyUI-style tEXt chunks injected before IEND. */
function pngWithChunks(chunks) {
  const head = PNG_1X1.subarray(0, PNG_1X1.length - IEND.length);
  return Buffer.concat([head, ...chunks.map(({ keyword, text }) => textChunk(keyword, text)), IEND]);
}

/** Generate a small valid JPEG via PowerShell System.Drawing (argv array). */
function generateJpeg(targetPath) {
  const escaped = targetPath.replace(/'/g, "''");
  const script =
    "$ErrorActionPreference='Stop'; " +
    'Add-Type -AssemblyName System.Drawing; ' +
    '$bmp = New-Object System.Drawing.Bitmap 320,200; ' +
    '$g = [System.Drawing.Graphics]::FromImage($bmp); ' +
    "$g.Clear([System.Drawing.Color]::SteelBlue); $g.Dispose(); " +
    `$bmp.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Jpeg); ` +
    '$bmp.Dispose(); Write-Output JPEGENC-OK';
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    shell: false,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0 || !(result.stdout ?? '').includes('JPEGENC-OK')) {
    fail(`JPEG fixture generation failed: ${result.stderr || result.stdout}`);
  }
}

/** exiftool must report exactly "1 image files updated" (in-band truth). */
function exifUpdateOrDie(args, what) {
  const result = exifRun(args);
  if (!/1 image files? updated/.test(result.stdout + result.stderr)) {
    fail(`${what} failed: ${(result.stdout + result.stderr).slice(0, 300)}`);
  }
}

async function dropFile(filePath, contents) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
}

// ---- the real-stack boot (verify-launch.mjs's pattern) -----------------------

/**
 * Boot the launcher with a temp METADESK_DATA_DIR, poll the portfile, check
 * /api/health, run `fn({base, token})`, then stop through the launcher's own
 * channel and wait for the server pid to die.
 */
async function withStack(dataDir, fn) {
  const portfilePath = path.join(dataDir, 'portfile.json');
  const cleanEnv = { ...process.env };
  for (const key of ['METADESK_DATA_DIR', 'METADESK_PORT', 'METADESK_TOKEN', 'METADESK_EXIFTOOL', 'METADESK_SSE_HEARTBEAT_MS']) {
    delete cleanEnv[key];
  }
  cleanEnv['METADESK_DATA_DIR'] = dataDir;

  const child = spawn(process.execPath, [LAUNCHER, '--no-browser'], {
    cwd: APP_ROOT,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: cleanEnv,
  });
  let launcherOutput = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => (launcherOutput += c));
  child.stderr.on('data', (c) => (launcherOutput += c));

  try {
    const portfile = await pollPortfile(portfilePath, child, () => launcherOutput, 60_000);
    const base = `http://127.0.0.1:${portfile.port}`;
    const token = portfile.token;
    if (typeof token !== 'string' || token.length < 16) fail('The portfile token is missing or too short');
    if (!Number.isInteger(portfile.pid) || portfile.pid <= 0) fail('The portfile pid is not a real pid');
    const health = await apiJson(base, '/api/health');
    if (health.status !== 200 || health.body?.ok !== true) {
      fail(`GET /api/health -> ${health.status} ${JSON.stringify(health.body).slice(0, 200)}`);
    }
    step('boot', `${base} (server pid ${portfile.pid}, engine ${health.body.version}, mode ${health.body.mode ?? 'read-only'})`);
    return await fn({ base, token, serverPid: portfile.pid });
  } finally {
    await stopStack(child, () => launcherOutput);
  }
}

async function pollPortfile(portfilePath, child, launcherOutput, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      fail(`Launcher exited during startup (code ${child.exitCode}):\n${launcherOutput().slice(-1200)}`);
    }
    try {
      const parsed = JSON.parse(readFileSync(portfilePath, 'utf8'));
      if (Number.isInteger(parsed.port) && typeof parsed.token === 'string') return parsed;
    } catch {
      /* not written yet */
    }
    await sleep(250);
  }
  fail(`The server never wrote a portfile at ${portfilePath}\nlauncher output:\n${launcherOutput().slice(-1200)}`);
}

async function stopStack(child, launcherOutput) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // The established Windows stop channel: end the launcher's stdin and the
  // graceful ladder runs (server stdin end -> engine session shutdown).
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    child.stdin.end();
  } catch {
    /* already closed */
  }
  const timeout = new Promise((resolve) => setTimeout(resolve, 45_000));
  await Promise.race([exited, timeout]);
  if (child.exitCode === null) {
    // The launcher's own --stop, then a last-resort hard kill of the LAUNCHER
    // (never a hand-rolled kill of the server or the engine).
    const stop = spawn(process.execPath, [LAUNCHER, '--stop'], {
      cwd: APP_ROOT,
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    await new Promise((resolve) => stop.once('exit', resolve));
    if (child.exitCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      fail(`The launcher did not stop after stdin end + --stop:\n${launcherOutput().slice(-800)}`);
    }
  }
  step('stop', 'launcher exited 0; server + engine shut down through the graceful ladder');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** JSON fetch with the token header; returns {status, body}. */
async function apiJson(base, apiPath, { method = 'GET', body, token } = {}) {
  const headers = { Accept: 'application/json' };
  if (token !== undefined) headers['X-MetaDesk-Token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    const response = await fetch(`${base}${apiPath}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      parsed = { raw: text.slice(0, 300) };
    }
    return { status: response.status, body: parsed };
  } catch (error) {
    return { status: 0, body: { error: String(error) } };
  }
}

/** Unlock writing for the session (the deliberate, session-scoped gate). */
async function unlockSession(base, token) {
  const unlock = await apiJson(base, '/api/session/unlock', { method: 'POST', body: {}, token });
  if (unlock.status !== 200 || unlock.body?.writeUnlocked !== true) {
    fail(`POST /api/session/unlock failed: ${unlock.status} ${JSON.stringify(unlock.body).slice(0, 200)}`);
  }
  step('unlock', 'session write-unlocked (every write still needs a preview + backup + journal)');
}

// ---- subcommand: unit ---------------------------------------------------------

async function runUnit() {
  await runVitest(SERVER_DIR, 'server suite');
  await runVitest(UI_DIR, 'ui suite');
}

async function runVitest(workspaceDir, label) {
  const vitestEntry = [path.join(workspaceDir, 'node_modules', 'vitest', 'vitest.mjs'), path.join(APP_ROOT, 'node_modules', 'vitest', 'vitest.mjs')].find(
    (candidate) => existsSync(candidate),
  );
  if (vitestEntry === undefined) {
    fail(`vitest is not installed (looked in ${workspaceDir}/node_modules and app/node_modules). Run "npm install" in app/.`);
  }
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [vitestEntry, 'run'], {
      cwd: workspaceDir,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', (error) => resolve({ code: -1, out: '', err: String(error) }));
    child.on('exit', (code) => resolve({ code, out, err }));
  });
  if (result.code !== 0) {
    const lines = `${result.err}\n${result.out}`.split(/\r?\n/).filter((l) => l.trim().length > 0);
    fail(`The ${label} did not pass (vitest exit ${result.code}):\n${lines.slice(-60).join('\n')}`);
  }
  const summary = result.out.split(/\r?\n/).filter((l) => /Tests\s+\d+ passed/.test(l)).pop() ?? 'tests passed';
  step(`unit ${label}`, summary.trim());
}

// ---- subcommand: roundtrip (ROOT GATE G3) -------------------------------------

async function runRoundtrip() {
  if (!existsSync(EXE)) fail(`Vendored engine missing: ${EXE}`);
  if (!existsSync(LAUNCHER)) fail(`Launcher missing: ${LAUNCHER}`);

  const scratchDir = await newScratch('roundtrip');
  const dataDir = path.join(scratchDir, 'data');
  const photosDir = path.join(scratchDir, 'photos');
  await mkdir(photosDir, { recursive: true });

  // Fixture folder: the roundtrip PNG (with an existing title so the preview
  // shows a real old -> new CHANGE) + a metadata-rich JPEG for scan/metadata.
  const pngPath = path.join(photosDir, 'roundtrip.png');
  await dropFile(pngPath, PNG_1X1);
  exifUpdateOrDie(['-XMP-dc:Title=Roundtrip Original Title', pngPath], 'planting the old title');
  await rm(`${pngPath}_original`, { force: true });
  const shaBefore = sha256File(pngPath);

  const jpgPath = path.join(photosDir, 'photo.jpg');
  generateJpeg(jpgPath);
  exifUpdateOrDie(
    [
      `-ThumbnailImage<=${jpgPath}`,
      '-XMP-dc:Title=Fixture photo',
      '-EXIF:DateTimeOriginal=2026:05:01 12:00:00',
      '-GPSLatitude=37.8097',
      '-GPSLatitudeRef=N',
      '-GPSLongitude=122.4783',
      '-GPSLongitudeRef=W',
      jpgPath,
    ],
    'planting the photo JPEG metadata',
  );
  await rm(`${jpgPath}_original`, { force: true });
  const OLD_TITLE = 'Roundtrip Original Title';
  const NEW_TITLE = 'Roundtrip Updated by MetaDesk';

  await withStack(dataDir, async ({ base, token }) => {
    // 1. Scan over HTTP.
    const scan = await apiJson(base, '/api/files/scan', {
      method: 'POST',
      token,
      body: { folder: photosDir, recursive: false },
    });
    if (scan.status !== 200) fail(`POST /api/files/scan -> ${scan.status} ${JSON.stringify(scan.body).slice(0, 200)}`);
    const names = (scan.body?.entries ?? []).map((e) => e.name).sort();
    if (!names.includes('roundtrip.png') || !names.includes('photo.jpg')) {
      fail(`The scan missed the fixtures: ${JSON.stringify(names)}`);
    }
    const photoEntry = scan.body.entries.find((e) => e.name === 'photo.jpg');
    if (!photoEntry?.warnings?.includes('badge:gps-present')) {
      fail(`The GPS badge did not ride in FileEntry.warnings: ${JSON.stringify(photoEntry)}`);
    }
    step('scan', `${names.length} files; GPS badge present on photo.jpg`);

    // 2. Read metadata through the app engine.
    const meta = await apiJson(
      base,
      `/api/file/metadata?path=${encodeURIComponent(pngPath)}&depth=all`,
      { token },
    );
    if (meta.status !== 200) fail(`GET /api/file/metadata -> ${meta.status} ${JSON.stringify(meta.body).slice(0, 200)}`);
    if (meta.body?.all?.['XMP-dc:Title'] !== OLD_TITLE) {
      fail(`The all-tier read did not show the old title: ${JSON.stringify(meta.body?.all?.['XMP-dc:Title'])}`);
    }
    step('metadata', `all-tier read carries XMP-dc:Title="${OLD_TITLE}"`);

    // 3. The read-only default is real: execute refuses before unlock.
    const earlyPreview = await apiJson(base, '/api/write/preview', {
      method: 'POST',
      token,
      body: { files: [pngPath], edits: [{ tag: 'XMP-dc:Title', op: 'set', value: NEW_TITLE }] },
    });
    if (earlyPreview.status !== 200) fail(`POST /api/write/preview -> ${earlyPreview.status} ${JSON.stringify(earlyPreview.body).slice(0, 200)}`);
    const preview = earlyPreview.body;
    if (preview.writeUnlocked !== false) fail('The preview claims the session was already unlocked');
    const earlyExecute = await apiJson(base, '/api/write/execute', {
      method: 'POST',
      token,
      body: { previewId: preview.preview.previewId },
    });
    if (earlyExecute.status !== 403 || earlyExecute.body?.code !== 'read_only_mode') {
      fail(`Execute before unlock was not refused with read_only_mode (got ${earlyExecute.status} ${JSON.stringify(earlyExecute.body).slice(0, 200)})`);
    }
    step('read-only-gate', 'execute refused 403 read_only_mode before the unlock');

    // 4. The preview shows the old -> new diff, argv only, no `--` ever.
    const diffFile = preview.preview.files.find((f) => f.filePath === pngPath);
    const change = (diffFile?.diffs ?? []).find((d) => d.tag === 'XMP-dc:Title');
    if (change?.kind !== 'change' || change.before !== OLD_TITLE || change.after !== NEW_TITLE) {
      fail(`The preview diff is not the expected old->new change: ${JSON.stringify(diffFile?.diffs)}`);
    }
    if (diffFile.noop === true) fail('The preview flagged itself noop for a real change');
    if (preview.preview.blockers.length > 0) fail(`Unexpected preview blockers: ${JSON.stringify(preview.preview.blockers)}`);
    const commandPreview = preview.commandPreview;
    if (!Array.isArray(commandPreview) || commandPreview.some((t) => typeof t !== 'string')) {
      fail('commandPreview is not an argv array');
    }
    if (commandPreview.includes('--')) fail('commandPreview contains the forbidden `--` separator (BUILD-NOTES fact #1)');
    if (!commandPreview.some((arg) => arg === `-XMP-dc:Title=${NEW_TITLE}`)) {
      fail(`commandPreview does not carry the edit: ${JSON.stringify(commandPreview)}`);
    }
    step('preview', `old->new diff frozen with exact argv (${commandPreview.length} args)`);

    // 5. Unlock, then execute the preview exactly once.
    await unlockSession(base, token);
    const execute = await apiJson(base, '/api/write/execute', {
      method: 'POST',
      token,
      body: { previewId: preview.preview.previewId },
    });
    if (execute.status !== 200) fail(`POST /api/write/execute -> ${execute.status} ${JSON.stringify(execute.body).slice(0, 300)}`);
    const outcome = execute.body?.outcome;
    const fileOutcome = outcome?.files?.find((f) => f.filePath === pngPath);
    if (fileOutcome?.status !== 'updated' || fileOutcome?.verified !== true) {
      fail(`The write did not update+verify: ${JSON.stringify(fileOutcome).slice(0, 300)}`);
    }
    if (outcome.allVerified !== true) fail('The batch is not allVerified');
    step('execute', `batch ${outcome.batchId}: updated+verified (backup hashed, re-read matched)`);

    // 6. EXTERNAL truth: the vendored exiftool reads the new value back.
    const externalDoc = exifDocFor(exifJson([pngPath]), pngPath);
    if (externalDoc?.['XMP-dc:Title'] !== NEW_TITLE) {
      fail(`External exiftool read does not carry the new title: ${JSON.stringify(externalDoc?.['XMP-dc:Title'])}`);
    }
    step('external-verify', 'vendored exiftool -j reads XMP-dc:Title = new value');

    // 7. Undo: two-step (plan, then confirm), then byte-identical.
    const undoPlan = await apiJson(base, '/api/write/undo', {
      method: 'POST',
      token,
      body: { batchId: outcome.batchId },
    });
    if (undoPlan.status !== 200 || undoPlan.body?.requiresConfirmation !== true) {
      fail(`Undo step 1 failed: ${undoPlan.status} ${JSON.stringify(undoPlan.body).slice(0, 200)}`);
    }
    const undoDiff = undoPlan.body.undoPreview.files.find((f) => f.filePath === pngPath);
    const reverse = (undoDiff?.diffs ?? []).find((d) => d.tag === 'XMP-dc:Title');
    if (reverse?.after !== OLD_TITLE) {
      fail(`The undo preview does not restore the old title: ${JSON.stringify(undoDiff?.diffs)}`);
    }
    const undoRun = await apiJson(base, '/api/write/undo', {
      method: 'POST',
      token,
      body: { batchId: outcome.batchId, confirm: true },
    });
    if (undoRun.status !== 200 || undoRun.body?.undone !== true) {
      fail(`Undo step 2 failed: ${undoRun.status} ${JSON.stringify(undoRun.body).slice(0, 300)}`);
    }
    const shaAfter = sha256File(pngPath);
    if (shaAfter !== shaBefore) {
      fail(`Undo did not restore the original bytes.\n  before ${shaBefore}\n  after  ${shaAfter}`);
    }
    step('undo', `sha256 identical after undo (${shaBefore.slice(0, 16)}...)`);

    // 8. The journal history is the durable record with verified backups.
    const history = await apiJson(base, '/api/write/history?limit=20', { token });
    const historyBatch = (history.body?.batches ?? []).find((b) => b.batchId === outcome.batchId);
    if (historyBatch === undefined) fail('The executed batch is missing from /api/write/history');
    const backupRow = (historyBatch.backups ?? []).find((row) => row.filePath === pngPath);
    if (backupRow?.verified !== true) fail('The history entry does not show a hash-verified backup');
    step('history', 'journal records the batch with a verified backup');

    // 9. Double-undo is refused (the safety contract's already_undone).
    const doubleUndo = await apiJson(base, '/api/write/undo', {
      method: 'POST',
      token,
      body: { batchId: outcome.batchId, confirm: true },
    });
    if (doubleUndo.status !== 400 || doubleUndo.body?.code !== 'bad_request') {
      fail(`A double undo was not refused (got ${doubleUndo.status} ${JSON.stringify(doubleUndo.body).slice(0, 200)})`);
    }
    step('double-undo-refused', 'undoing twice is refused by design');
  });
}

// ---- subcommand: scrub (ROOT GATE G4) ------------------------------------------

const SD_PROMPT = 'a lighthouse at dusk, cinematic, highly detailed';

async function runScrub() {
  const scratchDir = await newScratch('scrub');
  const dataDir = path.join(scratchDir, 'data');
  const photosDir = path.join(scratchDir, 'photos');
  await mkdir(photosDir, { recursive: true });

  // The SD-style fixture: real ComfyUI-style Prompt/Workflow tEXt chunks
  // injected by hand (the engine refuses to WRITE those unlisted chunks, so
  // the expectation records them as detected-but-cannot-remove), plus the
  // removable A1111 tags planted through the engine itself.
  const sdPng = path.join(photosDir, 'ai-art.png');
  await dropFile(
    sdPng,
    pngWithChunks([
      { keyword: 'Prompt', text: JSON.stringify({ prompt: SD_PROMPT, steps: 20, sampler: 'Euler a', seed: 1234567 }) },
      { keyword: 'Workflow', text: JSON.stringify({ nodes: [{ id: 1, type: 'CheckpointLoader' }], links: [] }) },
    ]),
  );
  exifUpdateOrDie(
    [
      // Single line, ASCII only: argv values may not carry line breaks (the
      // engine refuses them, which would block the undo's value restore), and
      // non-ASCII command-line text reaches exiftool as Malformed UTF-8.
      '-PNG:Parameters=Steps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1234567, Size: 512x512, Model: sd15; Negative prompt: blurry, low quality',
      '-PNG:Software=automatic1111',
      '-EXIF:UserComment=Steps: 20, Sampler: Euler a, Seed: 1234567 - generated with Stable Diffusion',
      sdPng,
    ],
    'planting the A1111 tags',
  );
  await rm(`${sdPng}_original`, { force: true });
  const shaBefore = sha256File(sdPng);

  // A clean control file: detection must call it clean, the wipe must not
  // touch it.
  const plainPng = path.join(photosDir, 'clean.png');
  await dropFile(plainPng, PNG_1X1);

  // External pre-check: the planted tags are really there before anything.
  const beforeDoc = exifDocFor(exifJson([sdPng]), sdPng);
  if (typeof beforeDoc?.['PNG:Parameters'] !== 'string' || !beforeDoc['PNG:Parameters'].includes('Seed: 1234567')) {
    fail('The PNG:Parameters fixture tag was not planted');
  }
  if (beforeDoc?.['PNG:Prompt'] === undefined || beforeDoc?.['PNG:Workflow'] === undefined) {
    fail('The injected ComfyUI-style Prompt/Workflow chunks were not readable');
  }
  step('fixture', 'SD-style PNG planted (removable tags + unremovable chunks) + a clean control');

  await withStack(dataDir, async ({ base, token }) => {
    await unlockSession(base, token);

    // 1. Detection (read-only).
    const detect = await apiJson(base, '/api/scrub/preview', {
      method: 'POST',
      token,
      body: { files: [sdPng, plainPng] },
    });
    if (detect.status !== 200) fail(`POST /api/scrub/preview -> ${detect.status} ${JSON.stringify(detect.body).slice(0, 200)}`);
    const report = detect.body?.report;
    if (report?.confirmationPhrase !== SCRUB_PHRASE) fail('The detection did not demand the typed phrase');
    const sdFinding = report.files.find((f) => f.filePath === sdPng);
    if (sdFinding === undefined) fail('The SD fixture is missing from the detection report');
    const removableTags = new Set(sdFinding.tags.filter((t) => t.removable).map((t) => t.tag));
    if (!removableTags.has('PNG:Parameters')) fail(`PNG:Parameters was not detected as removable: ${JSON.stringify([...removableTags])}`);
    if (![...removableTags].some((t) => /:software$/i.test(t))) fail('PNG:Software was not detected as removable');
    if (![...removableTags].some((t) => /usercomment$/i.test(t))) fail('EXIF:UserComment was not detected as removable');
    const unremovable = sdFinding.tags.filter((t) => !t.removable).map((t) => t.tag);
    if (!unremovable.includes('PNG:Prompt') || !unremovable.includes('PNG:Workflow')) {
      fail(`The ComfyUI chunks were not flagged as cannot-remove: ${JSON.stringify(unremovable)}`);
    }
    if (sdFinding.possibleHiddenAlphaData !== true || typeof sdFinding.hiddenAlphaNote !== 'string') {
      fail('The honest hidden-alpha warning is missing on the RGBA fixture');
    }
    if (!report.cleanFilePaths.includes(plainPng)) fail('The clean control file was not classified clean');
    const affected = report.affectedTags.filter((row) => row.filePath === sdPng);
    if (affected.length < 3) fail(`Detection found fewer removable tags than planted: ${JSON.stringify(affected)}`);
    step('detect', `${affected.length} removable tag(s); Prompt/Workflow + hidden-alpha flagged honestly`);

    // 2. The typed-phrase gate refuses everything less than the exact phrase.
    const wrongCase = await apiJson(base, '/api/scrub/execute', {
      method: 'POST',
      token,
      body: { files: [sdPng], confirm: 'remove ai metadata' },
    });
    if (wrongCase.status !== 403) {
      fail(`The scrub ran WITHOUT the exact typed phrase (got ${wrongCase.status})`);
    }
    if (sha256File(sdPng) !== shaBefore) fail('The phrase-gated scrub changed the file anyway');
    step('phrase-gate', 'wrong-case phrase refused 403; bytes untouched');

    // 3. The gated wipe.
    const wipe = await apiJson(base, '/api/scrub/execute', {
      method: 'POST',
      token,
      body: { files: [sdPng, plainPng], confirm: SCRUB_PHRASE },
    });
    if (wipe.status !== 200) fail(`POST /api/scrub/execute -> ${wipe.status} ${JSON.stringify(wipe.body).slice(0, 300)}`);
    const outcome = wipe.body?.outcome;
    const sdOutcome = outcome?.files?.find((f) => f.filePath === sdPng);
    if (sdOutcome?.status !== 'updated' || sdOutcome?.verified !== true) {
      fail(`The scrub did not update+verify the fixture: ${JSON.stringify(sdOutcome).slice(0, 300)}`);
    }
    // The clean control has nothing removable, so the wipe batch never
    // includes it (no removable tags -> no targets) — it must be untouched.
    if (outcome.files.some((f) => f.filePath === plainPng)) {
      fail('The clean control was written to despite having nothing removable');
    }
    if (sha256File(plainPng) !== sha256File(path.join(photosDir, 'clean.png'))) {
      fail('The clean control file changed during the scrub');
    }
    step('wipe', `batch ${outcome.batchId}: updated+verified; the clean control was not touched`);

    // 4. The mandatory pre-write sidecar export holds the original values.
    const exportPath = wipe.body?.exportedValuesPath;
    if (typeof exportPath !== 'string' || !existsSync(exportPath)) {
      fail(`The scrub sidecar export is missing: ${String(exportPath)}`);
    }
    const exported = JSON.parse(await readFile(exportPath, 'utf8'));
    const exportedValues = exported.values ?? [];
    const parametersRow = exportedValues.find((row) => row.tag === 'PNG:Parameters');
    if (parametersRow === undefined || !String(parametersRow.value).includes('Seed: 1234567')) {
      fail('The sidecar export lost the original PNG:Parameters value');
    }
    if (exported.confirmationPhrase !== SCRUB_PHRASE) fail('The sidecar export lost its confirmation record');
    step('sidecar-export', `${exportedValues.length} original value(s) exported before the wipe`);

    // 5. EXTERNAL truth: the removable tags are gone; the unremovable chunk
    // is honestly still present.
    const afterDoc = exifDocFor(exifJson([sdPng]), sdPng);
    for (const key of Object.keys(afterDoc ?? {})) {
      if (/^(PNG:(Parameters|Software|Comment|Description)|ExifIFD:UserComment|IFD0:Software)$/i.test(key)) {
        fail(`Removable tag survived the scrub: ${key}`);
      }
    }
    if (afterDoc?.['PNG:Prompt'] === undefined || afterDoc?.['PNG:Workflow'] === undefined) {
      fail('The unremovable ComfyUI chunks vanished — the honesty contract broke');
    }
    const notRemoved = wipe.body?.notRemoved ?? [];
    if (!notRemoved.some((row) => row.tag === 'PNG:Prompt')) {
      fail('The response did not restate PNG:Prompt under cannot-be-removed');
    }
    step('external-verify', 'vendored exiftool -j: removable tags GONE, Prompt/Workflow honestly still there');

    // 6. Undo restores the original bytes.
    const undoRun = await apiJson(base, '/api/write/undo', {
      method: 'POST',
      token,
      body: { batchId: outcome.batchId, confirm: true },
    });
    if (undoRun.status !== 200 || undoRun.body?.undone !== true) {
      fail(`Scrub undo failed: ${undoRun.status} ${JSON.stringify(undoRun.body).slice(0, 300)}`);
    }
    if (sha256File(sdPng) !== shaBefore) {
      fail(`Scrub undo did not restore the original bytes.\n  before ${shaBefore}\n  after  ${sha256File(sdPng)}`);
    }
    const restoredDoc = exifDocFor(exifJson([sdPng]), sdPng);
    if (restoredDoc?.['PNG:Parameters'] === undefined) fail('The undo removed the scrub from history but not from disk');
    step('undo', 'sha256 identical after undo; the planted tags are back');
  });
}

// ---- subcommand: gps (C10 evidence) ---------------------------------------------

async function runGps() {
  const scratchDir = await newScratch('gps');
  const dataDir = path.join(scratchDir, 'data');
  const photosDir = path.join(scratchDir, 'photos');
  await mkdir(photosDir, { recursive: true });

  const jpgPath = path.join(photosDir, 'vacation.jpg');
  generateJpeg(jpgPath);
  exifUpdateOrDie(
    [
      '-GPSLatitude=37.8097',
      '-GPSLatitudeRef=N',
      '-GPSLongitude=122.4783',
      '-GPSLongitudeRef=W',
      '-GPSAltitude=15',
      '-GPSSatellites=8',
      '-GPSMapDatum=WGS-84',
      jpgPath,
    ],
    'planting GPS metadata',
  );
  await rm(`${jpgPath}_original`, { force: true });
  const shaBefore = sha256File(jpgPath);
  const beforeKeys = Object.keys(exifDocFor(exifJson([jpgPath]), jpgPath) ?? {}).filter((k) => /gps/i.test(k));
  if (beforeKeys.length < 5) fail(`The GPS fixture is not planted: ${JSON.stringify(beforeKeys)}`);
  step('fixture', `GPS-bearing JPEG with ${beforeKeys.length} GPS key(s)`);

  await withStack(dataDir, async ({ base, token }) => {
    await unlockSession(base, token);

    // 1. The destructive GPS-strip preview: server-curated whitelist only.
    const preview = await apiJson(base, '/api/write/preview', {
      method: 'POST',
      token,
      body: { files: [jpgPath], destructive: { scope: 'gps' } },
    });
    if (preview.status !== 200) fail(`GPS preview -> ${preview.status} ${JSON.stringify(preview.body).slice(0, 200)}`);
    if (preview.body?.destructive?.scope !== 'gps' || preview.body.destructive?.confirmationPhrase !== GPS_PHRASE) {
      fail('The GPS preview did not demand its typed phrase');
    }
    const gpsDeletes = preview.body.preview.files
      .find((f) => f.filePath === jpgPath)
      ?.diffs.filter((d) => d.kind === 'delete')
      .map((d) => d.tag);
    if (!Array.isArray(gpsDeletes) || !gpsDeletes.some((t) => /GPSLatitude$/i.test(t))) {
      fail(`The GPS preview has no GPS delete diffs: ${JSON.stringify(gpsDeletes)}`);
    }
    if (!gpsDeletes.some((t) => /GPSLongitude$/i.test(t))) fail('The GPS preview does not delete the longitude');
    if (typeof preview.body.exportedValuesPath !== 'string' || !existsSync(preview.body.exportedValuesPath)) {
      fail('The GPS strip did not produce its mandatory pre-write sidecar export');
    }
    step('preview', `${gpsDeletes.length} GPS delete diff(s) + sidecar export written`);

    // 2. The phrase gate: anything but the exact phrase is refused, no write.
    const wrongPhrase = await apiJson(base, '/api/write/execute', {
      method: 'POST',
      token,
      body: { previewId: preview.body.preview.previewId, destructive: { confirmationPhrase: 'delete the gps' } },
    });
    if (wrongPhrase.status !== 403 || wrongPhrase.body?.code !== 'unsafe_tag') {
      fail(`The GPS strip ran without its typed phrase (got ${wrongPhrase.status} ${JSON.stringify(wrongPhrase.body).slice(0, 150)})`);
    }
    if (sha256File(jpgPath) !== shaBefore) fail('A wrong-phrase execute changed the file anyway');
    step('phrase-gate', 'wrong phrase refused 403 unsafe_tag; bytes untouched');

    // 3. The gated execute.
    const execute = await apiJson(base, '/api/write/execute', {
      method: 'POST',
      token,
      body: { previewId: preview.body.preview.previewId, destructive: { confirmationPhrase: GPS_PHRASE } },
    });
    if (execute.status !== 200) fail(`GPS execute -> ${execute.status} ${JSON.stringify(execute.body).slice(0, 300)}`);
    const outcome = execute.body?.outcome;
    const fileOutcome = outcome?.files?.find((f) => f.filePath === jpgPath);
    if (fileOutcome?.status !== 'updated' || fileOutcome?.verified !== true) {
      fail(`The GPS strip did not update+verify: ${JSON.stringify(fileOutcome).slice(0, 300)}`);
    }
    step('execute', `batch ${outcome.batchId}: strip updated+verified`);

    // 4. EXTERNAL truth: zero GPS keys remain.
    const afterKeys = Object.keys(exifDocFor(exifJson([jpgPath]), jpgPath) ?? {}).filter((k) => /gps/i.test(k));
    if (afterKeys.length > 0) fail(`GPS keys survived the strip: ${JSON.stringify(afterKeys)}`);
    step('external-verify', 'vendored exiftool -j: ZERO GPS keys remain');

    // 5. Undo restores the coordinates byte-identically.
    const undoRun = await apiJson(base, '/api/write/undo', {
      method: 'POST',
      token,
      body: { batchId: outcome.batchId, confirm: true },
    });
    if (undoRun.status !== 200 || undoRun.body?.undone !== true) {
      fail(`GPS undo failed: ${undoRun.status} ${JSON.stringify(undoRun.body).slice(0, 300)}`);
    }
    if (sha256File(jpgPath) !== shaBefore) {
      fail(`GPS undo did not restore the original bytes.\n  before ${shaBefore}\n  after  ${sha256File(jpgPath)}`);
    }
    const restoredKeys = Object.keys(exifDocFor(exifJson([jpgPath]), jpgPath) ?? {}).filter((k) => /gps/i.test(k));
    if (restoredKeys.length < beforeKeys.length) fail('The undo did not bring the GPS block back');
    step('undo', `sha256 identical after undo; ${restoredKeys.length} GPS key(s) restored`);
  });
}

// ---- `all` only: the current UI bundle + the Playwright matrix ------------------

async function buildUiBundle() {
  if (!existsSync(path.join(APP_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'))) {
    fail('vite is not installed — run "npm install" in app/ first');
  }
  await runChild(process.execPath, [path.join(APP_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-b', '--force'], UI_DIR, 'ui typecheck+emit (tsc -b)');
  await runChild(process.execPath, [path.join(APP_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], UI_DIR, 'ui bundle (vite build)');
  if (!existsSync(UI_DIST_INDEX)) fail(`The UI build produced no bundle at ${UI_DIST_INDEX}`);
}

async function runMatrix() {
  const matrixEntry = path.join(TESTS_E2E_DIR, 'matrix.mjs');
  if (!existsSync(matrixEntry)) fail(`The Playwright matrix is missing: ${matrixEntry}`);
  if (!existsSync(path.join(APP_ROOT, 'node_modules', 'playwright', 'package.json')) &&
      !existsSync(path.join(TESTS_E2E_DIR, 'node_modules', 'playwright', 'package.json'))) {
    fail('playwright is not installed — run: npm install -D playwright -w @metadesk/tests-e2e && npx playwright install chromium');
  }
  // The matrix prints its own progress; its marker line must say "passed".
  const result = await runChild(process.execPath, [matrixEntry], TESTS_E2E_DIR, 'playwright matrix', { forwardStderr: true });
  assertMatrixPassed(result, 'playwright matrix');
}

/**
 * PACKAGED MODE (leaf 2.2.2): extract the portable zip to a temp dir and hand
 * the matrix the extracted MetaDesk.exe — the boot seam is the only
 * difference, so the identical flows + assertions run against the identical
 * packaged server + packaged UI bundle.
 */
async function runMatrixPackaged() {
  const matrixEntry = path.join(TESTS_E2E_DIR, 'matrix.mjs');
  if (!existsSync(matrixEntry)) fail(`The Playwright matrix is missing: ${matrixEntry}`);
  if (!existsSync(path.join(APP_ROOT, 'node_modules', 'playwright', 'package.json')) &&
      !existsSync(path.join(TESTS_E2E_DIR, 'node_modules', 'playwright', 'package.json'))) {
    fail('playwright is not installed — run: npm install -D playwright -w @metadesk/tests-e2e && npx playwright install chromium');
  }
  const zipPath = findPortableZip();
  const extractDir = await newScratch('packaged');
  await runChild(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-NoLogo',
      '-Command',
      `Expand-Archive -LiteralPath '${pwsq(zipPath)}' -DestinationPath '${pwsq(extractDir)}' -Force; Write-Output EXTRACT-OK`,
    ],
    APP_ROOT,
    'package extraction',
  );
  const exePath = path.join(extractDir, 'MetaDesk', 'MetaDesk.exe');
  if (!existsSync(exePath)) fail(`The extracted package has no MetaDesk.exe at ${exePath}`);
  const result = await runChild(
    process.execPath,
    [matrixEntry, '--packaged', exePath],
    TESTS_E2E_DIR,
    'playwright matrix (packaged)',
    { forwardStderr: true },
  );
  assertMatrixPassed(result, 'playwright matrix (packaged)');
}

function assertMatrixPassed(matrixOutput, label) {
  if (!/^e2e matrix passed$/m.test(matrixOutput)) {
    fail(`The ${label} did not report "e2e matrix passed"`);
  }
  // The matrix may pass while honestly reporting pre-existing product defects
  // it must not fix (outside this leaf's OWNS) — re-state them loudly.
  for (const line of matrixOutput.split(/\r?\n/)) {
    if (line.includes('KNOWN BUG')) process.stderr.write(`  !  ${line.trim()}\n`);
  }
}

/** The one portable zip build-portable.mjs emits (exactly one may exist). */
function findPortableZip() {
  const distDir = path.join(APP_ROOT, 'dist-desktop');
  if (!existsSync(distDir)) fail(`No build output directory at ${distDir} — run node app/scripts/build-portable.mjs --all first`);
  const zips = readdirSync(distDir).filter((name) => /^metadesk-\d+\.\d+\.\d+-portable-win-x64\.zip$/.test(name)).sort();
  if (zips.length !== 1) {
    fail(`Expected exactly one portable zip under app/dist-desktop, found: ${zips.join(', ') || '(none)'} — run node app/scripts/build-portable.mjs --all first`);
  }
  return path.join(distDir, zips[0]);
}

function pwsq(text) {
  return String(text).replace(/'/g, "''");
}

function runChild(command, args, cwd, label, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => {
      err += c;
      if (opts.forwardStderr) process.stderr.write(c);
    });
    child.on('error', (error) => reject(new Error(`${label} failed to spawn: ${String(error)}`)));
    child.on('exit', (code) => {
      if (code !== 0) {
        const lines = `${err}\n${out}`.split(/\r?\n/).filter((l) => l.trim().length > 0);
        reject(new Error(`${label} exited ${code}:\n${lines.slice(-60).join('\n')}`));
        return;
      }
      step(label);
      resolve(out);
    });
  });
}

// ---- subcommand: evidence (leaf 2.3.1 G2) ----------------------------------------

const EVIDENCE_DIR = path.join(APP_ROOT, 'evidence');
const EVIDENCE_SNAPSHOT_DIR = path.join(TESTS_E2E_DIR, '__evidence-snapshot__');
const EVIDENCE_MANIFEST = path.join(EVIDENCE_SNAPSHOT_DIR, 'MANIFEST.txt');
/** The frame set of record (matrix.mjs FRAME_CLAIMS order). */
const EVIDENCE_FRAMES = [
  '01-home.png',
  '02-grid.png',
  '03-detail.png',
  '04-save-review.png',
  '05-scrub-findings.png',
  '06-scrub-confirm.png',
  '07-results.png',
  '08-history.png',
  '09-console.png',
  '10-settings.png',
];
/** The frames the wave-6 Evidence Collector flagged; leaf 2.3.1 re-shot them. */
const RETAKEN_FRAMES = new Set(['01-home.png', '09-console.png', '10-settings.png']);

/**
 * The committed mirror must be byte-identical to app/evidence/ (file-by-file
 * sha256, exactly the frame set of record on both sides), and MANIFEST.txt
 * must list every frame with its capture date, its size and the claim it
 * proves — the retaken frames marked `retaken`. Pure file reads: no app boot.
 */
function verifyEvidenceSnapshot() {
  if (!existsSync(EVIDENCE_DIR)) fail(`The evidence directory is missing: ${EVIDENCE_DIR}`);
  if (!existsSync(EVIDENCE_SNAPSHOT_DIR)) fail(`The committed mirror is missing: ${EVIDENCE_SNAPSHOT_DIR}`);
  if (!existsSync(EVIDENCE_MANIFEST)) fail(`The capture manifest is missing: ${EVIDENCE_MANIFEST}`);

  const evidenceFiles = readdirSync(EVIDENCE_DIR).sort();
  const snapshotFiles = readdirSync(EVIDENCE_SNAPSHOT_DIR).sort();
  const expectedEvidence = [...EVIDENCE_FRAMES].sort();
  const expectedSnapshot = [...expectedEvidence, 'MANIFEST.txt'].sort();
  const listMismatch = (label, found, expected) =>
    `The ${label} does not hold exactly the frame set of record.\n  found:    ${found.join(', ')}\n  expected: ${expected.join(', ')}`;
  if (evidenceFiles.join(',') !== expectedEvidence.join(',')) {
    fail(listMismatch('evidence directory (app/evidence)', evidenceFiles, expectedEvidence));
  }
  if (snapshotFiles.join(',') !== expectedSnapshot.join(',')) {
    fail(listMismatch('committed mirror (__evidence-snapshot__)', snapshotFiles, expectedSnapshot));
  }

  // Byte-identical mirror, frame by frame.
  for (const frame of EVIDENCE_FRAMES) {
    const live = path.join(EVIDENCE_DIR, frame);
    const mirrored = path.join(EVIDENCE_SNAPSHOT_DIR, frame);
    const liveHash = sha256File(live);
    const mirroredHash = sha256File(mirrored);
    if (liveHash !== mirroredHash) {
      fail(`The mirror is not byte-identical for ${frame}\n  evidence ${liveHash}\n  mirror   ${mirroredHash}`);
    }
    if (readFileSync(live).length < 20_000) fail(`${frame} is suspiciously small (${readFileSync(live).length} bytes)`);
  }
  step('mirror', `all ${EVIDENCE_FRAMES.length} frames sha256-identical between app/evidence and the committed mirror`);

  // MANIFEST.txt: every frame with capture date + size + claim; retakes marked.
  const manifestText = readFileSync(EVIDENCE_MANIFEST, 'utf8');
  const isoDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
  const retakenSeen = [];
  for (const frame of EVIDENCE_FRAMES) {
    const actualBytes = readFileSync(path.join(EVIDENCE_SNAPSHOT_DIR, frame)).length;
    const line = manifestText.split(/\r?\n/).find((l) => l.startsWith(`${frame}  `));
    if (line === undefined) fail(`MANIFEST.txt has no entry for ${frame}`);
    const match = line.match(
      new RegExp(
        `^${frame.replace(/[.]/g, '\\.')}  (\\d+) bytes  captured (\\d{4}-\\d{2}-\\d{2})(  retaken (\\d{4}-\\d{2}-\\d{2}))?  proves: (.+)$`,
      ),
    );
    if (match === null) {
      fail(
        `MANIFEST.txt's ${frame} entry does not read "<file>  <bytes> bytes  captured <YYYY-MM-DD>[  retaken <YYYY-MM-DD>]  proves: <claim>":\n  ${line}`,
      );
    }
    const [, bytes, capturedDate, , retakenDate, claim] = match;
    if (Number.parseInt(bytes, 10) !== actualBytes) {
      fail(`MANIFEST.txt says ${frame} is ${bytes} bytes but the mirrored file is ${actualBytes} bytes`);
    }
    if (!isoDate(capturedDate)) fail(`MANIFEST.txt's ${frame} capture date is not a real date: ${capturedDate}`);
    if (claim.trim().length < 20) fail(`MANIFEST.txt's ${frame} claim is too thin to be the claim it proves: "${claim}"`);
    const mustBeRetaken = RETAKEN_FRAMES.has(frame);
    if (mustBeRetaken) {
      if (retakenDate === undefined) fail(`MANIFEST.txt does not mark the retaken frame ${frame} with a retaken date`);
      if (!isoDate(retakenDate)) fail(`MANIFEST.txt's ${frame} retaken date is not a real date: ${retakenDate}`);
      retakenSeen.push(`${frame} (captured ${capturedDate}, retaken ${retakenDate})`);
    } else if (retakenDate !== undefined) {
      fail(`MANIFEST.txt marks accepted frame ${frame} as retaken — only 01/09/10 were retaken`);
    }
  }
  step('manifest', `every frame listed with capture date + claim; retakes: ${retakenSeen.join('; ')}`);
}



// ---- dispatch (last: every declaration above must be initialized) --------------

try {
  if (requested === 'unit') {
    await runUnit();
    finish('e2e unit verification passed');
  } else if (requested === 'roundtrip') {
    await runRoundtrip();
    finish('e2e roundtrip verification passed');
  } else if (requested === 'scrub') {
    await runScrub();
    finish('e2e AI-scrub verification passed');
  } else if (requested === 'gps') {
    await runGps();
    finish('e2e gps-strip verification passed');
  } else if (requested === 'evidence') {
    verifyEvidenceSnapshot();
    finish('evidence snapshot verification passed');
  } else {
    await runUnit();
    await runRoundtrip();
    await runScrub();
    await runGps();
    if (PACKAGED_FLAG) {
      // PACKAGED MODE: the matrix boots the extracted package's MetaDesk.exe;
      // the packaged UI is baked into the package, so no dev UI rebuild here.
      await runMatrixPackaged();
    } else {
      await buildUiBundle();
      await runMatrix();
    }
    verifyEvidenceSnapshot();
    finish('all e2e verifications passed');
  }
} catch (error) {
  exitCode = 1;
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`e2e verification FAILED (${requested})\n\n${message}\n`);
} finally {
  await cleanupScratch();
}
process.exit(exitCode);
