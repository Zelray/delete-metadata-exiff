#!/usr/bin/env node
/**
 * Server smoke verification gate (leaf 1.1.2).
 *
 * Node built-ins only. Boots the REAL server (tsx, random free port, token in
 * the portfile), then runs the smoke sequence from the gate ledger:
 *
 *   health with/without token, token rejection, cross-origin 403, Host-spoof
 *   403, folder scan over a hostile-name fixture, metadata tiers, thumbnail
 *   bytes with JPEG magic, binary endpoint, SSE hello + heartbeat +
 *   folder-changed, console read OK + write attempts rejected, path-guard
 *   rejections, static status page with the boot script injected.
 *
 * Then it shuts the server down through its stdin channel (the Windows
 * graceful stop), asserts NO ORPHAN exiftool processes remain, and prints
 * EXACTLY
 *
 *     server smoke verification passed
 *
 * as the first line of stdout on success. Any failure prints diagnostics and
 * exits 1. Run from the repo root: node app/scripts/verify-server.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = path.join(APP_ROOT, 'server', 'src', 'index.ts');
const EXE = path.join(APP_ROOT, 'vendor', 'exiftool', 'exiftool.exe');
const TSX_ENTRY = path.join(APP_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const OVERALL_TIMEOUT_MS = 5 * 60 * 1000;

const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000d4944415478da63fccfc0500f000485018084a98c210000000049454e44ae426082',
  'hex',
);
const HOSTILE_NAMES = ['--All=', '-comment=x.jpg', '50%#off=.png', "a'b c.png", '照片 中文 (1).png', 'café ☕.png'];

const watchdog = setTimeout(() => {
  process.stdout.write('server smoke verification FAILED\n\noverall watchdog fired (5 min)\n');
  process.exit(1);
}, OVERALL_TIMEOUT_MS);
watchdog.unref();

// ---- orchestration state (declared before the run so helpers can close over them) ----
const steps = [];
let diag = '';
let scratch = '';
let child = null;
let serverStdout = '';
let serverStderr = '';

function step(name, detail = '') {
  steps.push({ name, detail });
}

function bail(message) {
  diag =
    serverStdout.length > 0 || serverStderr.length > 0
      ? `--- server stdout ---\n${tail(serverStdout)}\n--- server stderr ---\n${tail(serverStderr)}`
      : diag;
  throw new Error(message);
}

let exitCode = 0;
try {
  await run();
  // On success `run` has printed nothing; the marker goes FIRST.
  process.stdout.write('server smoke verification passed\n');
  for (const s of steps) process.stdout.write(`  ok  ${s.name}${s.detail === '' ? '' : ` - ${s.detail}`}\n`);
} catch (error) {
  exitCode = 1;
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`server smoke verification FAILED\n\n${message}\n`);
  if (diag.trim().length > 0) process.stdout.write(`\n${diag.trim()}\n`);
} finally {
  if (child !== null && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  if (scratch !== '') await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}
process.exit(exitCode);

async function run() {
  if (!existsSync(EXE)) throw new Error(`Vendored engine missing: ${EXE}`);
  if (!existsSync(SERVER_ENTRY)) throw new Error(`Server entry missing: ${SERVER_ENTRY}`);
  if (!existsSync(TSX_ENTRY)) {
    throw new Error(`tsx is not installed (expected ${TSX_ENTRY}). Run "npm install" in app/.`);
  }
  const exiftoolBaseline = await countExiftool();

  // ---- fixture -----------------------------------------------------------------
  scratch = await mkdtemp(path.join(tmpdir(), 'metadesk-verify-'));
  const fixtureDir = path.join(scratch, 'fixture');
  const dataDir = path.join(scratch, 'data');
  mkdirSync(fixtureDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  for (const name of ['plain.png', ...HOSTILE_NAMES]) {
    writeFileSync(path.join(fixtureDir, name), PNG_1X1);
  }
  const photoJpg = path.join(fixtureDir, 'photo.jpg');
  await generateJpeg(photoJpg);
  await writeFixtureMetadata(photoJpg);
  step('fixture', `hostile names + thumbnail JPEG in ${path.basename(fixtureDir)}`);

  // ---- boot the real server ------------------------------------------------------
  child = spawn(process.execPath, [TSX_ENTRY, SERVER_ENTRY], {
    cwd: APP_ROOT,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      METADESK_DATA_DIR: dataDir,
      METADESK_PORT: '0',
      METADESK_SSE_HEARTBEAT_MS: '2000',
    },
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    serverStdout += c;
  });
  child.stderr.on('data', (c) => {
    serverStderr += c;
  });

  const portfile = await pollPortfile(child, dataDir, 45_000);
  const base = `http://127.0.0.1:${portfile.port}`;
  const token = portfile.token;
  if (typeof token !== 'string' || token.length < 16) {
    bail(`The portfile token is missing or too short: ${JSON.stringify(portfile)}`);
  }
  step('boot+portfile', `${base} (token ${token.length} chars)`);

  // ---- 1+2. health with and without the token --------------------------------------
  const healthNoToken = await fetchJson(`${base}/api/health`);
  if (healthNoToken.status !== 200 || healthNoToken.body.ok !== true) {
    bail(`GET /api/health without token -> ${healthNoToken.status} ${JSON.stringify(healthNoToken.body).slice(0, 300)}`);
  }
  step('health-no-token', `engine ${healthNoToken.body.version}`);

  const health = await fetchJson(`${base}/api/health`, {
    headers: { 'x-metadesk-token': token },
  });
  if (health.status !== 200 || health.body.executablePath !== EXE) {
    bail(`GET /api/health with token -> ${health.status} ${JSON.stringify(health.body).slice(0, 300)}`);
  }
  step('health-with-token');

  // ---- 3. token enforcement on data routes -------------------------------------------
  const scanNoToken = await fetchJson(`${base}/api/files/scan`, {
    method: 'POST',
    body: { folder: fixtureDir },
  });
  if (scanNoToken.status !== 401) {
    bail(`POST /api/files/scan without token -> ${scanNoToken.status} (expected 401)`);
  }
  step('token-required', 'data routes 401 without the per-launch token');

  // ---- 4. cross-origin rejection --------------------------------------------------------
  const crossOrigin = await fetchJson(`${base}/api/health`, {
    headers: { origin: 'https://evil.example' },
  });
  if (crossOrigin.status !== 403) {
    bail(`Cross-origin /api/health -> ${crossOrigin.status} (expected 403)`);
  }
  step('cross-origin-403');

  // ---- 5. Host-spoof rejection (DNS-rebinding guard; fetch forbids Host, node:http does not)
  const hostSpoof = await rawGet(base, '/api/health', { host: 'evil.example' });
  if (hostSpoof.status !== 403) {
    bail(`Host-spoofed /api/health -> ${hostSpoof.status} (expected 403)`);
  }
  step('host-spoof-403');

  // ---- 6. folder scan over the hostile fixture ---------------------------------------------
  const scan = await fetchJson(`${base}/api/files/scan`, {
    method: 'POST',
    headers: { 'x-metadesk-token': token },
    body: { folder: fixtureDir, recursive: false },
  });
  if (scan.status !== 200) bail(`POST /api/files/scan -> ${scan.status} ${JSON.stringify(scan.body).slice(0, 400)}`);
  const names = scan.body.entries.map((e) => e.name);
  for (const expected of ['plain.png', ...HOSTILE_NAMES, 'photo.jpg']) {
    if (!names.includes(expected)) bail(`Scan is missing "${expected}"; entries: ${JSON.stringify(names)}`);
  }
  if (!(scan.body.totalBytes > 0) || !(scan.body.freeBytes > 0)) {
    bail(`Scan preflight did not report sizes: ${JSON.stringify(scan.body).slice(0, 300)}`);
  }
  const photoEntry = scan.body.entries.find((e) => e.name === 'photo.jpg');
  if (!/badge:gps-present/.test(photoEntry?.warnings.join(' ') ?? '')) {
    bail(`photo.jpg is missing the gps badge: ${JSON.stringify(photoEntry?.warnings)}`);
  }
  step('scan', `${scan.body.totalFiles} files incl. hostile names; preflight sizes ok`);

  // ---- 7. metadata tiers -----------------------------------------------------------------------
  const simple = await fetchJson(
    `${base}/api/file/metadata?path=${encodeURIComponent(photoJpg)}&depth=simple`,
    { headers: { 'x-metadesk-token': token } },
  );
  if (simple.status !== 200 || simple.body.simple?.creator !== 'Mike') {
    bail(`metadata simple -> ${simple.status} ${JSON.stringify(simple.body).slice(0, 400)}`);
  }
  const all = await fetchJson(`${base}/api/file/metadata?path=${encodeURIComponent(photoJpg)}&depth=all`, {
    headers: { 'x-metadesk-token': token },
  });
  if (all.status !== 200 || Object.keys(all.body.all ?? {}).length < 20) {
    bail(`metadata all -> ${all.status} ${JSON.stringify(all.body).slice(0, 300)}`);
  }
  const raw = await fetchJson(`${base}/api/file/metadata?path=${encodeURIComponent(photoJpg)}&depth=raw`, {
    headers: { 'x-metadesk-token': token },
  });
  const dateTag = (raw.body.raw ?? []).find((t) => t.name === 'DateTimeOriginal');
  if (raw.status !== 200 || dateTag?.id !== '36867') {
    bail(`metadata raw -> ${raw.status}; DateTimeOriginal id=${JSON.stringify(dateTag?.id)} (expected "36867")`);
  }
  step('metadata-tiers', 'simple creator/copyright/GPS; all >= 20 tags; raw id=36867');

  // ---- 8. thumbnail with JPEG magic ----------------------------------------------------------------
  const thumb = await fetch(`${base}/api/thumbnail?path=${encodeURIComponent(photoJpg)}`, {
    headers: { 'x-metadesk-token': token },
  });
  const thumbBytes = Buffer.from(await thumb.arrayBuffer());
  if (thumb.status !== 200 || thumb.headers.get('content-type') !== 'image/jpeg') {
    bail(`GET /api/thumbnail -> ${thumb.status} ${thumb.headers.get('content-type')}`);
  }
  if (thumbBytes[0] !== 0xff || thumbBytes[1] !== 0xd8) {
    bail('Thumbnail bytes are not JPEG (missing FFD8 magic)');
  }
  step('thumbnail', `${thumbBytes.length} bytes with JPEG magic, image/jpeg`);

  // ---- 9. binary endpoint ------------------------------------------------------------------------------
  const binary = await fetch(
    `${base}/api/file/binary?path=${encodeURIComponent(photoJpg)}&tag=ThumbnailImage`,
    { headers: { 'x-metadesk-token': token } },
  );
  const binaryBytes = Buffer.from(await binary.arrayBuffer());
  if (binary.status !== 200 || binaryBytes[0] !== 0xff || binaryBytes[1] !== 0xd8) {
    bail(`GET /api/file/binary -> ${binary.status} (${binaryBytes.length} bytes)`);
  }
  const binaryDenied = await fetch(
    `${base}/api/file/binary?path=${encodeURIComponent(photoJpg)}&tag=NotAllowed`,
    { headers: { 'x-metadesk-token': token } },
  );
  if (binaryDenied.status !== 400) bail(`binary with unknown tag -> ${binaryDenied.status} (expected 400)`);
  const thumbPng = await fetch(
    `${base}/api/thumbnail?path=${encodeURIComponent(path.join(fixtureDir, 'plain.png'))}`,
    { headers: { 'x-metadesk-token': token } },
  );
  if (thumbPng.status !== 404) bail(`thumbnail of preview-less PNG -> ${thumbPng.status} (expected 404)`);
  step('binary-endpoint', 'JPEG bytes; unknown tag 400; preview-less file 404');

  // ---- 10. SSE: hello + heartbeat + folder-changed -----------------------------------------------------------
  const sseEvents = await openSse(base, token);
  const hello = sseEvents.find((e) => e.type === 'hello');
  if (hello === undefined) bail(`SSE stream never sent hello; frames: ${JSON.stringify(sseEvents).slice(0, 400)}`);
  const heartbeat = sseEvents.find((e) => e.type === 'heartbeat');
  if (heartbeat === undefined) bail('SSE stream never sent a heartbeat (2s cadence)');
  const seqs = sseEvents.map((e) => e.seq);
  if (seqs.some((s, i) => s !== i + 1)) bail(`SSE seq has gaps: ${seqs.join(',')}`);

  const addedPath = path.join(fixtureDir, 'added-by-verify.png');
  await writeFile(addedPath, PNG_1X1);
  const folderChanged = await awaitFolderChanged(base, token, 15_000);
  if (folderChanged === null) bail('SSE stream never sent folder-changed after a file was added');
  const changes = folderChanged.changes ?? [];
  if (!changes.some((c) => String(c.path).endsWith('added-by-verify.png'))) {
    bail(`folder-changed payload lacks the added file: ${JSON.stringify(changes).slice(0, 300)}`);
  }
  step('sse', `hello(seq 1) + heartbeat@2s + folder-changed (${changes.length} changes)`);

  // ---- 11. console: read OK, writes rejected -------------------------------------------------------------------
  const readArgs = ['-j', '-G1', '-n', photoJpg];
  const consoleRead = await fetchJson(`${base}/api/console/run`, {
    method: 'POST',
    headers: { 'x-metadesk-token': token },
    body: { args: readArgs },
  });
  if (
    consoleRead.status !== 200 ||
    !Array.isArray(consoleRead.body.json) ||
    consoleRead.body.json.length === 0 ||
    JSON.stringify(consoleRead.body.commandPreview) !== JSON.stringify(readArgs)
  ) {
    bail(`console read -> ${consoleRead.status} ${JSON.stringify(consoleRead.body).slice(0, 400)}`);
  }
  const writeAttempts = [
    ['-All='],
    ['-XMP-dc:Title=nope', photoJpg],
    ['-overwrite_original', photoJpg],
    ['-o', 'C:\\temp', photoJpg],
    ['-tagsFromFile', photoJpg],
    ['-geotag', 'C:\\tracks\\gpx.gpx', photoJpg],
    ['-config', 'C:\\x\\cfg.pl'],
    ['-stay_open', 'False'],
    ['-csv=x.csv'],
    ['relative\\photo.jpg'],
  ];
  for (const args of writeAttempts) {
    const attempt = await fetchJson(`${base}/api/console/run`, {
      method: 'POST',
      headers: { 'x-metadesk-token': token },
      body: { args },
    });
    if (attempt.status !== 400) {
      bail(`console write attempt ${JSON.stringify(args)} -> ${attempt.status} (expected 400)`);
    }
  }
  step('console', `read OK with commandPreview; ${writeAttempts.length} write attempts rejected`);

  // ---- 12. path guard rejections ---------------------------------------------------------------------------------
  const relativeScan = await fetchJson(`${base}/api/files/scan`, {
    method: 'POST',
    headers: { 'x-metadesk-token': token },
    body: { folder: 'relative\\folder' },
  });
  if (relativeScan.status !== 400 || relativeScan.body.code !== 'path_rejected') {
    bail(`scan with relative folder -> ${relativeScan.status} ${JSON.stringify(relativeScan.body)}`);
  }
  const traversalScan = await fetchJson(`${base}/api/files/scan`, {
    method: 'POST',
    headers: { 'x-metadesk-token': token },
    body: { folder: `${fixtureDir}\\..\\..\\windows` },
  });
  if (traversalScan.status !== 400 || traversalScan.body.code !== 'path_rejected') {
    bail(`scan with traversal -> ${traversalScan.status} ${JSON.stringify(traversalScan.body)}`);
  }
  step('path-guard', 'relative + traversal rejected with human messages');

  // ---- 13. static status page with the boot script -----------------------------------------------------------------
  const index = await fetch(`${base}/`);
  const indexHtml = await index.text();
  if (index.status !== 200 || !indexHtml.includes('window.__METADESK__=')) {
    bail(`GET / -> ${index.status}; boot script missing from page`);
  }
  if (!indexHtml.includes(token)) bail('Served page does not carry the session token for the UI');
  step('static-ui', 'status page with __METADESK__ boot script + token');

  // ---- 14. graceful shutdown, no orphans ------------------------------------------------------------------------------
  child.stdin.end();
  const exited = await waitForExit(child, 20_000);
  if (!exited) bail('Server did not exit after stdin closed');
  const exiftoolAfter = await countExiftool();
  if (exiftoolAfter !== exiftoolBaseline) {
    bail(`Orphan exiftool processes: baseline ${exiftoolBaseline}, now ${exiftoolAfter}`);
  }
  step('shutdown', `exit ${child.exitCode}, no orphan exiftool (${exiftoolAfter} running)`);
}

// ---- helpers ---------------------------------------------------------------------------------------------------------

/** Generate a real JPEG via PowerShell System.Drawing (argv array, no shell). */
function generateJpeg(targetPath) {
  const escaped = targetPath.replace(/'/g, "''");
  const script =
    "$ErrorActionPreference='Stop'; " +
    'Add-Type -AssemblyName System.Drawing; ' +
    '$bmp = New-Object System.Drawing.Bitmap 32,32; ' +
    '$g = [System.Drawing.Graphics]::FromImage($bmp); ' +
    "$g.Clear([System.Drawing.Color]::SteelBlue); $g.Dispose(); " +
    `$bmp.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Jpeg); ` +
    '$bmp.Dispose(); Write-Output JPEGENC-OK';
  return new Promise((resolve, reject) => {
    const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.stderr.on('data', (c) => {
      err += c;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0 && out.includes('JPEGENC-OK')) resolve();
      else reject(new Error(`JPEG generation failed: ${err || out}`));
    });
  });
}

/** Write metadata + embedded thumbnail onto the fixture JPEG (DEFAULT backup mode). */
function writeFixtureMetadata(targetPath) {
  const args = [
    `-ThumbnailImage<=${targetPath}`,
    '-XMP-dc:Rights=Copyright 2026, Mike',
    '-XMP-dc:Creator=Mike',
    '-XMP-xmp:CreatorTool=MetaDesk Fixture 1.0',
    '-EXIF:DateTimeOriginal=2026:05:01 12:00:00',
    '-GPSLatitude=37.5',
    '-GPSLatitudeRef=N',
    '-GPSLongitude=122.1',
    '-GPSLongitudeRef=W',
    targetPath,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(EXE, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.stderr.on('data', (c) => {
      err += c;
    });
    child.on('error', reject);
    child.on('exit', () => {
      if (/1 image files? updated/.test(out)) resolve();
      else reject(new Error(`fixture metadata write failed: ${out.trim()} ${err.trim()}`));
    });
  });
}

async function pollPortfile(child, dataDir, timeoutMs) {
  const portfilePath = path.join(dataDir, 'portfile.json');
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      bail(`Server exited during startup (code ${child.exitCode})`);
    }
    try {
      const parsed = JSON.parse(await readFile(portfilePath, 'utf8'));
      // The dataDir is a fresh temp dir only this server instance writes to,
      // so presence of {port, token} proves ownership. (The pid in the file is
      // the real server process; under tsx it is a child of our spawn, so we
      // deliberately do not require pid equality here.)
      if (Number.isInteger(parsed.port) && typeof parsed.token === 'string' && parsed.token.length > 0) {
        return parsed;
      }
    } catch {
      /* not written yet */
    }
    await sleep(250);
  }
  bail('The server never wrote a portfile with {port, token, pid}');
}

async function fetchJson(url, options = {}) {
  try {
    const response = await fetch(url, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = { raw: (await response.text()).slice(0, 300) };
    }
    return { status: response.status, body };
  } catch (error) {
    return { status: 0, body: { error: String(error) } };
  }
}

/** GET with an overridden Host header (fetch forbids that; node:http does not). */
function rawGet(base, requestPath, headers) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: url.hostname, port: url.port, path: requestPath, headers, agent: false },
      (response) => {
        response.resume();
        response.on('end', () => resolve({ status: response.statusCode }));
      },
    );
    request.on('error', reject);
    request.setTimeout(10_000, () => {
      request.destroy(new Error('host-spoof probe timed out'));
    });
  });
}

/** Minimal SSE reader: connects and collects frames until a heartbeat arrives. */
async function openSse(base, token) {
  const response = await fetch(`${base}/api/events?token=${encodeURIComponent(token)}`, {
    headers: { origin: base },
  });
  if (response.status !== 200) bail(`GET /api/events -> ${response.status} (expected 200)`);
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    bail(`SSE content-type is "${contentType}" (expected text/event-stream)`);
  }
  return await readSseUntil(response.body, 10_000, (event) => event.type === 'heartbeat');
}

async function awaitFolderChanged(base, token, timeoutMs) {
  const response = await fetch(`${base}/api/events?token=${encodeURIComponent(token)}`, {
    headers: { origin: base },
  });
  if (response.status !== 200) bail(`second SSE connection -> ${response.status}`);
  const events = await readSseUntil(response.body, timeoutMs, (event) => event.type === 'folder-changed');
  const match = [...events].reverse().find((e) => e.type === 'folder-changed');
  return match ?? null;
}

function readSseUntil(body, timeoutMs, predicate) {
  return new Promise((resolve) => {
    const received = [];
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const deadline = Date.now() + timeoutMs;
    const finish = () => {
      reader
        .cancel()
        .catch(() => undefined)
        .finally(() => resolve(received));
    };
    const tick = async () => {
      for (;;) {
        const split = buffer.indexOf('\n\n');
        if (split < 0) break;
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
        if (dataLine === undefined) continue;
        try {
          const event = JSON.parse(dataLine.slice(6));
          received.push(event);
          if (predicate(event)) {
            finish();
            return;
          }
        } catch {
          /* partial frame */
        }
      }
      if (Date.now() > deadline) {
        finish();
        return;
      }
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish();
          return;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        await tick();
      } catch {
        finish();
      }
    };
    void tick();
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve(false);
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function countExiftool() {
  return new Promise((resolve, reject) => {
    const child = spawn('tasklist', ['/FI', 'IMAGENAME eq exiftool.exe', '/FO', 'CSV', '/NH'], {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.on('error', reject);
    child.on('exit', () => {
      if (/info: no tasks/i.test(out)) {
        resolve(0);
        return;
      }
      resolve(out.split(/\r?\n/).filter((l) => l.trim().length > 0).length);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tail(text, count = 40) {
  return text.split(/\r?\n/).slice(-count).join('\n');
}
