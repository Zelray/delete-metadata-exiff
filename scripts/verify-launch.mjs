#!/usr/bin/env node
/**
 * Launch-lifecycle verification gate (leaf 1.1.6).
 *
 * Node built-ins only. Drives the REAL launcher (app/bin/metadesk.mjs) the
 * way a human and a second console would:
 *
 *   1. clean start with a temp METADESK_DATA_DIR -> server healthy on
 *      127.0.0.1, health handshake OK, served UI reachable with the boot
 *      script + per-launch token injected;
 *   2. single-instance enforcement: a second launch exits 0 WITHOUT starting
 *      a second server (same server pid before and after);
 *   3. --stop from a separate process -> graceful stdin-close stop;
 *   4. launcher exits 0, the server process is gone, the exiftool and node
 *      process counts return to their pre-run baselines (no orphans), and
 *      the portfile/lock residue is cleaned up.
 *
 * It prints EXACTLY
 *
 *     launcher verification passed
 *
 * as the first line of stdout on success. Any failure prints diagnostics and
 * exits 1. Run from the repo root: node app/scripts/verify-launch.mjs
 * (Do not run it concurrently with `npm test` - the shutdown assertions count
 * processes machine-wide.)
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER = path.join(APP_ROOT, 'bin', 'metadesk.mjs');
const SERVER_ENTRY = path.join(APP_ROOT, 'server', 'src', 'index.ts');
const TSX_ENTRY = path.join(APP_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const EXE = path.join(APP_ROOT, 'vendor', 'exiftool', 'exiftool.exe');
const OVERALL_TIMEOUT_MS = 4 * 60 * 1000;

const watchdog = setTimeout(() => {
  process.stdout.write('launcher verification FAILED\n\noverall watchdog fired (4 min)\n');
  process.exit(1);
}, OVERALL_TIMEOUT_MS);
watchdog.unref();

// ---- orchestration state (declared before the run so helpers close over them) ----
const steps = [];
const captures = { launcher: '', second: '', stop: '' };
let diag = '';
let scratch = '';
let launcherChild = null;

function step(name, detail = '') {
  steps.push({ name, detail });
}

function tailOf(which, count = 30) {
  const text = captures[which];
  if (text.trim().length === 0) return '';
  return `--- ${which} output (tail) ---\n${text.split(/\r?\n/).slice(-count).join('\n')}`;
}

function fail(message) {
  diag = ['launcher', 'second', 'stop']
    .map(tailOf)
    .filter((block) => block.length > 0)
    .join('\n\n');
  throw new Error(message);
}

let exitCode = 0;
try {
  await run();
  // On success `run` has printed nothing; the marker goes FIRST.
  process.stdout.write('launcher verification passed\n');
  for (const s of steps) process.stdout.write(`  ok  ${s.name}${s.detail === '' ? '' : ` - ${s.detail}`}\n`);
} catch (error) {
  exitCode = 1;
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`launcher verification FAILED\n\n${message}\n`);
  if (diag.trim().length > 0) process.stdout.write(`\n${diag.trim()}\n`);
} finally {
  if (launcherChild !== null && launcherChild.exitCode === null && launcherChild.signalCode === null) {
    try {
      launcherChild.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  if (scratch !== '') await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}
process.exit(exitCode);

async function run() {
  if (!existsSync(EXE)) throw new Error(`Vendored engine missing: ${EXE}`);
  if (!existsSync(LAUNCHER)) throw new Error(`Launcher missing: ${LAUNCHER}`);
  if (!existsSync(SERVER_ENTRY)) throw new Error(`Server entry missing: ${SERVER_ENTRY}`);
  if (!existsSync(TSX_ENTRY)) {
    throw new Error(`tsx is not installed (expected ${TSX_ENTRY}). Run "npm install" in app/.`);
  }
  const exiftoolBaseline = await countProcesses('exiftool.exe');
  const nodeBaseline = await countProcesses('node.exe');
  step('baselines', `${nodeBaseline} node.exe, ${exiftoolBaseline} exiftool.exe running before the test`);

  // ---- fixture: clean env + temp data dir ---------------------------------------
  scratch = mkdtempSync(path.join(tmpdir(), 'metadesk-verify-launch-'));
  const dataDir = path.join(scratch, 'data');
  const portfilePath = path.join(dataDir, 'portfile.json');
  const lockPath = path.join(dataDir, 'instance.lock');
  const stopRequestPath = path.join(dataDir, 'stop.request');
  const cleanEnv = { ...process.env };
  for (const key of ['METADESK_DATA_DIR', 'METADESK_PORT', 'METADESK_TOKEN', 'METADESK_EXIFTOOL', 'METADESK_SSE_HEARTBEAT_MS']) {
    delete cleanEnv[key];
  }
  cleanEnv['METADESK_DATA_DIR'] = dataDir;

  /** Spawn one launcher invocation; captures its output; drains its pipes. */
  function spawnLauncher(args, which) {
    const child = spawn(process.execPath, [LAUNCHER, ...args], {
      cwd: APP_ROOT,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanEnv,
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      captures[which] += chunk;
    });
    child.stderr.on('data', (chunk) => {
      captures[which] += chunk;
    });
    return child;
  }

  const waitForExit = (child, timeoutMs) =>
    new Promise((resolve) => {
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

  // ---- 1. clean start -------------------------------------------------------------
  launcherChild = spawnLauncher(['--no-browser'], 'launcher');
  const portfile = await pollPortfile(portfilePath, launcherChild, 60_000);
  const base = `http://127.0.0.1:${portfile.port}`;
  const token = portfile.token;
  if (typeof token !== 'string' || token.length < 16) {
    fail(`The portfile token is missing or too short: ${JSON.stringify({ ...portfile, token: undefined })}`);
  }
  if (!Number.isInteger(portfile.pid) || portfile.pid <= 0) {
    fail(`The portfile pid is not a real pid: ${JSON.stringify(portfile.pid)}`);
  }
  const serverPid = portfile.pid;
  if (portfile.port < 1024) fail(`The launcher did not pick a free high port: ${portfile.port}`);
  step('boot+portfile', `${base} (server pid ${serverPid}, token ${token.length} chars)`);

  const lock = readJsonSafe(lockPath);
  if (lock === null || lock.launcherPid !== launcherChild.pid || !Number.isInteger(lock.serverPid)) {
    fail(`instance.lock was not written with the live launcher pid: ${JSON.stringify(lock)}`);
  }
  step('instance-lock', `launcher pid ${lock.launcherPid}, server pid ${lock.serverPid}`);

  // ---- 2. health handshake (token-exempt, pinned launcher contract) ---------------
  const health = await fetchJson(`${base}/api/health`);
  if (health.status !== 200 || health.body.ok !== true) {
    fail(`GET /api/health -> ${health.status} ${JSON.stringify(health.body).slice(0, 300)}`);
  }
  step('health', `engine ${health.body.version}, mode ${health.body.mode ?? 'read-only'}`);

  // ---- 3. served UI reachable -------------------------------------------------------
  const page = await fetch(`${base}/`);
  const html = await page.text();
  if (page.status !== 200) fail(`GET / -> ${page.status}`);
  if (!html.includes('window.__METADESK__=')) fail('Served page lacks the __METADESK__ boot script');
  if (!html.includes(token)) fail('Served page does not carry the per-launch token');
  step('served-ui', `GET / 200 with boot script + token (${existsSync(path.join(APP_ROOT, 'ui', 'dist')) ? 'app bundle' : 'status page'})`);

  // ---- 4. single-instance enforcement --------------------------------------------------
  const before = { ...portfile };
  const second = spawnLauncher(['--no-browser'], 'second');
  const secondExited = await waitForExit(second, 40_000);
  if (!secondExited || second.exitCode !== 0) {
    fail(`Second launch did not exit 0 (exit ${second.exitCode}); output:\n${tailOf('second')}`);
  }
  if (!/already running/i.test(captures.second)) {
    fail(`Second launch did not report the running instance; output:\n${tailOf('second')}`);
  }
  const afterSecond = readJsonSafe(portfilePath);
  if (afterSecond === null || afterSecond.pid !== before.pid || afterSecond.port !== before.port) {
    fail(`Second launch disturbed the running instance: ${JSON.stringify(afterSecond)}`);
  }
  const healthAfterSecond = await fetchJson(`${base}/api/health`);
  if (healthAfterSecond.status !== 200 || healthAfterSecond.body.ok !== true) {
    fail('The running server stopped answering after the second launch');
  }
  step('single-instance', 'second launch exited 0, focused the existing URL, server pid unchanged');

  // ---- 5. --stop from a separate process (the graceful stdin-close channel) --------------
  const stopRequest = spawnLauncher(['--stop'], 'stop');
  const stopExited = await waitForExit(stopRequest, 40_000);
  if (!stopExited || stopRequest.exitCode !== 0) {
    fail(`--stop did not exit 0 (exit ${stopRequest.exitCode}); output:\n${tailOf('stop')}`);
  }
  if (!/instance stopped/i.test(captures.stop)) {
    fail(`--stop did not report a stopped instance; output:\n${tailOf('stop')}`);
  }

  const launcherExited = await waitForExit(launcherChild, 40_000);
  if (!launcherExited || launcherChild.exitCode !== 0) {
    fail(`The first launcher did not exit 0 after the stop (exit ${launcherChild.exitCode}); output:\n${tailOf('launcher')}`);
  }
  step('stop', `--stop exited 0; launcher exited ${launcherChild.exitCode} after the stdin-close stop`);

  // ---- 6. no residue, no orphans ----------------------------------------------------------
  if (pidAlive(serverPid)) fail(`Server pid ${serverPid} is still alive after the stop`);
  const residueDeadline = Date.now() + 15_000;
  let residue = [portfilePath, lockPath, stopRequestPath].filter(existsSync);
  while (residue.length > 0 && Date.now() < residueDeadline) {
    await sleep(500);
    residue = [portfilePath, lockPath, stopRequestPath].filter(existsSync);
  }
  if (residue.length > 0) fail(`Portfile/lock residue left behind: ${residue.map((p) => path.basename(p)).join(', ')}`);
  step('residue', 'portfile, instance.lock and stop.request all cleaned up');

  const orphanDeadline = Date.now() + 20_000;
  let exiftoolNow = await countProcesses('exiftool.exe');
  let nodeNow = await countProcesses('node.exe');
  while ((exiftoolNow !== exiftoolBaseline || nodeNow !== nodeBaseline) && Date.now() < orphanDeadline) {
    await sleep(1_000);
    exiftoolNow = await countProcesses('exiftool.exe');
    nodeNow = await countProcesses('node.exe');
  }
  if (exiftoolNow !== exiftoolBaseline) {
    fail(`Orphan exiftool processes: baseline ${exiftoolBaseline}, now ${exiftoolNow}`);
  }
  if (nodeNow !== nodeBaseline) {
    fail(`Orphan node processes: baseline ${nodeBaseline}, now ${nodeNow} (is something else starting node concurrently?)`);
  }
  step('no-orphans', `node ${nodeNow}/${nodeBaseline}, exiftool ${exiftoolNow}/${exiftoolBaseline} (after/before)`);
}

// ---- helpers ---------------------------------------------------------------------------

/** Poll until the server's portfile appears with {port, token, pid}. */
async function pollPortfile(portfilePath, child, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      fail(`Launcher exited during startup (code ${child.exitCode}); output:\n${tailOf('launcher')}`);
    }
    const parsed = readJsonSafe(portfilePath);
    if (parsed !== null && Number.isInteger(parsed.port) && typeof parsed.token === 'string') {
      return parsed;
    }
    await sleep(250);
  }
  fail(`The server never wrote a portfile with {port, token, pid} at ${portfilePath}`);
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function fetchJson(url) {
  try {
    const response = await fetch(url);
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

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error !== null && typeof error === 'object' && error.code === 'EPERM';
  }
}

function countProcesses(imageName) {
  return new Promise((resolve, reject) => {
    const child = spawn('tasklist', ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'], {
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
