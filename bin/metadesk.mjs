#!/usr/bin/env node
/**
 * MetaDesk launcher — the real v1 lifecycle (leaf 1.1.6).
 *
 * One entry point that a human double-clicks (via bin/metadesk.cmd or
 * bin/metadesk-dev.cmd) and that the verify gate drives end to end:
 *
 *   1. Single-instance enforcement: app/data/instance.lock records the
 *      launcher pid (+ the server pid once known). A second launch sees a
 *      live pid, does NOT start a second server, and opens the running
 *      instance's URL instead. A lock whose pid is dead is stale and removed.
 *   2. Free-port pick on 127.0.0.1 (or --port N), handed to the server.
 *   3. Server start: node + tsx -> server/src/index.ts, argv-array spawn
 *      (never a shell string), stdin kept as a pipe.
 *   4. Health handshake: poll GET /api/health (token-exempt by pinned
 *      contract) until the server answers, then read the portfile it wrote
 *      for the authoritative {port, token, pid, url}.
 *   5. Browser: open the served URL in the default browser (rundll32,
 *      argv-array; cmd start as fallback) unless --no-browser.
 *   6. Graceful stop: closing the server's stdin pipe is the established
 *      Windows stop channel (the server shuts its Fastify instance and its
 *      exiftool session down through the graceful ladder). The launcher
 *      closes that pipe when its own console goes away (stdin end), on
 *      Ctrl+C, or when app/data/stop.request appears.
 *   7. --stop: a second invocation that writes stop.request, waits for the
 *      running instance to exit, removes the portfile/lock residue, and
 *      verifies no orphan exiftool processes remain. Only if the graceful
 *      window expires does it escalate to a process-tree taskkill.
 *   8. After every exit: verify the server pid is gone and the exiftool
 *      process count returned to its baseline; report loudly if not (the
 *      launcher never kills exiftool processes it does not own).
 *
 * Node built-ins only. Every child process is spawned with an argv array.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = path.join(APP_ROOT, 'server', 'src', 'index.ts');
const TSX_ENTRY = path.join(APP_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const EXE = path.join(APP_ROOT, 'vendor', 'exiftool', 'exiftool.exe');

const HEALTH_DEADLINE_MS = 45_000;
const PORTFILE_AFTER_HEALTH_MS = 10_000;
const SECOND_INSTANCE_PORTFILE_WAIT_MS = 20_000;
const GRACEFUL_EXIT_TIMEOUT_MS = 20_000;
const STOP_REQUEST_POLL_MS = 250;
const STOP_GRACE_WINDOW_MS = 20_000;
const STOP_TASKKILL_WINDOW_MS = 10_000;
const ORPHAN_SETTLE_MS = 10_000;

// ---- cli ---------------------------------------------------------------------

function usage() {
  process.stdout.write(
    [
      'MetaDesk launcher',
      '',
      'Usage: node bin/metadesk.mjs [options]',
      '  (no options)   start MetaDesk: pick a free port, start the server,',
      '                 health-check it, open the browser, stay up until stopped',
      '  --port N       use a specific port instead of a free one',
      '  --no-browser   do not open the default browser',
      '  --stop         stop a running MetaDesk instance gracefully',
      '  --data-dir DIR runtime data dir (default app/data, or METADESK_DATA_DIR)',
      '',
    ].join('\n'),
  );
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h') || argv.includes('/?')) {
  usage();
  process.exit(0);
}

function argValue(flag) {
  const index = argv.indexOf(flag);
  if (index >= 0 && argv[index + 1] !== undefined) return argv[index + 1];
  const prefixed = argv.find((a) => a.startsWith(`${flag}=`));
  return prefixed === undefined ? null : prefixed.slice(flag.length + 1);
}

const wantStop = argv.includes('--stop');
const noBrowser = argv.includes('--no-browser');
const portArg = argValue('--port');
const requestedPort = portArg !== null && /^\d+$/.test(portArg) ? Number.parseInt(portArg, 10) : null;

const dataDir =
  argValue('--data-dir') ?? process.env['METADESK_DATA_DIR'] ?? path.join(APP_ROOT, 'data');
const portfilePath = path.join(dataDir, 'portfile.json');
const lockPath = path.join(dataDir, 'instance.lock');
const stopRequestPath = path.join(dataDir, 'stop.request');

// ---- small helpers -------------------------------------------------------------

function log(tag, message) {
  const stamp = new Date().toISOString().slice(11, 19);
  process.stdout.write(`[${stamp}] launcher ${tag.padEnd(7)} ${message}\n`);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM'; // exists but owned by someone else
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function tryUnlink(filePath) {
  try {
    rmSync(filePath, { force: true });
  } catch {
    /* best effort */
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pick a free loopback port by binding port 0 and reading what the OS gave us. */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('the OS offered no port'))));
    });
  });
}

/** GET a local URL, resolving {status, body} without throwing. */
function httpGet(url, timeoutMs = 3_000) {
  return new Promise((resolve) => {
    const request = http.get(url, { agent: false }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 65_536) response.destroy();
      });
      response.on('end', () => {
        let body = raw;
        try {
          body = JSON.parse(raw);
        } catch {
          /* not JSON; keep text */
        }
        resolve({ status: response.statusCode ?? 0, body });
      });
      response.on('error', () => resolve({ status: 0, body: null }));
    });
    request.on('error', () => resolve({ status: 0, body: null }));
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      resolve({ status: 0, body: null });
    });
  });
}

/** Fire-and-forget process launch, argv array only. */
function spawnIgnored(file, args) {
  try {
    const child = spawn(file, args, { shell: false, windowsHide: true, stdio: 'ignore', detached: false });
    child.once('error', () => undefined);
    return child;
  } catch {
    return null;
  }
}

/** Open a URL with the default browser: rundll32, pure argv array, no shell. */
function openInBrowser(url) {
  spawnIgnored('rundll32', ['url.dll,FileProtocolHandler', url]);
}

/** tasklist count of one image name (0 when the filter matches nothing). */
function countProcesses(imageName) {
  return new Promise((resolve) => {
    const child = spawn('tasklist', ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.on('error', () => resolve(-1));
    child.on('exit', () => {
      if (/info: no tasks/i.test(out)) {
        resolve(0);
        return;
      }
      resolve(out.split(/\r?\n/).filter((line) => line.trim().length > 0).length);
    });
  });
}

/** Hard process-tree kill, used only after the graceful window expires. */
function taskkillTree(pid) {
  return spawnIgnored('taskkill', ['/PID', String(pid), '/T', '/F']) !== null;
}

// ---- shared lifecycle state -------------------------------------------------------

let stopping = false;
let serverChild = null;
let serverPid = null; // authoritative once the portfile names it
let exiftoolBaseline = null; // taken before our engine session exists

function markServerPid(pid) {
  if (Number.isInteger(pid) && pid > 0 && (serverPid === null || serverPid !== pid)) {
    serverPid = pid;
    writeLock();
  }
}

function writeLock() {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      lockPath,
      `${JSON.stringify(
        {
          launcherPid: process.pid,
          serverPid,
          port: requestedPort,
          startedAt: new Date().toISOString(),
          dataDir,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  } catch {
    /* the lock is an optimization, never a boot blocker */
  }
}

/** The graceful stop: end the server's stdin pipe and let its ladder run. */
function gracefulStop(reason) {
  if (stopping) return;
  stopping = true;
  log('stop   ', `${reason}; closing the server stdin pipe (Windows stop channel)`);
  try {
    serverChild?.stdin.end();
  } catch {
    /* already gone */
  }
}

/** Wait for the child to exit; escalate to a tree kill past the grace window. */
async function waitForServerExit() {
  const exited = await new Promise((resolve) => {
    if (serverChild === null || (serverChild.exitCode !== null || serverChild.signalCode !== null)) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), GRACEFUL_EXIT_TIMEOUT_MS);
    serverChild.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!exited && serverPid !== null && pidAlive(serverPid)) {
    log('WARN   ', `server pid ${serverPid} ignored the graceful stop; tree-killing`);
    taskkillTree(serverPid);
    await sleep(1_500);
  }
}

/** After exit: no residue, no orphans. Report-only for exiftool we do not own. */
async function finalVerification() {
  if (serverPid !== null && pidAlive(serverPid)) {
    log('WARN   ', `server pid ${serverPid} is STILL RUNNING after cleanup`);
  }
  const removed = [];
  const lock = readJson(lockPath);
  const weOwnInstance = lock !== null && lock.launcherPid === process.pid;
  const portfile = readJson(portfilePath);
  if (portfile !== null && (portfile.pid === serverPid || weOwnInstance)) {
    tryUnlink(portfilePath);
    removed.push('portfile');
  }
  if (weOwnInstance) {
    tryUnlink(lockPath);
    removed.push('lock');
  }
  tryUnlink(stopRequestPath);
  log('exit   ', `residue: ${removed.length === 0 ? 'none' : removed.join(' + ') + ' removed'}`);

  if (exiftoolBaseline === null) return;
  // The engine's shutdown ladder may still be reaping: allow a settle window.
  const deadline = Date.now() + ORPHAN_SETTLE_MS;
  let exiftoolNow = await countProcesses('exiftool.exe');
  while (exiftoolNow > exiftoolBaseline && Date.now() < deadline) {
    await sleep(500);
    exiftoolNow = await countProcesses('exiftool.exe');
  }
  if (exiftoolNow > exiftoolBaseline) {
    log(
      'WARN   ',
      `${exiftoolNow - exiftoolBaseline} exiftool process(es) survived the stop (baseline ${exiftoolBaseline}) - orphaned`,
    );
  } else {
    log('cleanup', `no orphan exiftool processes (${exiftoolNow} running)`);
  }
}

// ---- single-instance ----------------------------------------------------------------

/** True when a MetaDesk server is reachable and belongs to a live process. */
async function findRunningInstance() {
  const portfile = readJson(portfilePath);
  if (portfile === null || !Number.isInteger(portfile.port)) return null;
  if (!pidAlive(portfile.pid)) return null;
  const health = await httpGet(`http://127.0.0.1:${portfile.port}/api/health`);
  if (health.status !== 200) return null;
  return portfile;
}

async function focusExistingInstance() {
  log('single ', 'instance lock is live; not starting a second server');
  const deadline = Date.now() + SECOND_INSTANCE_PORTFILE_WAIT_MS;
  let instance = await findRunningInstance();
  while (instance === null && Date.now() < deadline) {
    await sleep(500);
    instance = await findRunningInstance();
  }
  if (instance === null) {
    log('single ', 'the first launcher is still starting and never published a URL; exiting');
    return 0;
  }
  const url = typeof instance.url === 'string' && instance.url.length > 0
    ? instance.url
    : `http://127.0.0.1:${instance.port}/`;
  log('single ', `already running at ${url} (server pid ${instance.pid})`);
  if (!noBrowser) {
    openInBrowser(url);
    log('ui     ', 'opened the existing instance in the default browser');
  }
  return 0;
}

// ---- stop switch ----------------------------------------------------------------------

async function runStop() {
  log('stop   ', `stop requested (data dir ${dataDir})`);
  const lock = readJson(lockPath);
  const portfile = readJson(portfilePath);
  const candidates = new Set();
  if (Number.isInteger(portfile?.pid)) candidates.add(portfile.pid);
  if (Number.isInteger(lock?.serverPid)) candidates.add(lock.serverPid);
  const live = [...candidates].filter(pidAlive);

  if (live.length === 0) {
    log('stop   ', 'no running MetaDesk instance found');
    // Sweep residue a crashed launcher may have left behind.
    if (portfile !== null && !pidAlive(portfile.pid)) tryUnlink(portfilePath);
    if (lock !== null && !pidAlive(lock.launcherPid)) tryUnlink(lockPath);
    tryUnlink(stopRequestPath);
    return 0;
  }

  const baselineExiftool = await countProcesses('exiftool.exe');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(stopRequestPath, `${JSON.stringify({ requestedAt: new Date().toISOString(), byPid: process.pid })}\n`, 'utf8');
  log('stop   ', `stop.request written; waiting up to ${STOP_GRACE_WINDOW_MS / 1000}s for pid ${live.join(', ')}`);

  const deadline = Date.now() + STOP_GRACE_WINDOW_MS;
  let survivors = live.filter(pidAlive);
  while (survivors.length > 0 && Date.now() < deadline) {
    await sleep(STOP_REQUEST_POLL_MS);
    survivors = survivors.filter(pidAlive);
  }

  if (survivors.length > 0) {
    log('WARN   ', `graceful window expired with pid ${survivors.join(', ')} alive; escalating to taskkill /T`);
    for (const pid of survivors) taskkillTree(pid);
    const killDeadline = Date.now() + STOP_TASKKILL_WINDOW_MS;
    let remaining = survivors.filter(pidAlive);
    while (remaining.length > 0 && Date.now() < killDeadline) {
      await sleep(500);
      remaining = remaining.filter(pidAlive);
    }
    if (remaining.length > 0) {
      log('FAILED ', `could not stop pid ${remaining.join(', ')}`);
      return 1;
    }
  }

  log('stop   ', 'instance stopped');
  const orphanWait = Date.now() + ORPHAN_SETTLE_MS;
  let exiftoolNow = await countProcesses('exiftool.exe');
  while (exiftoolNow > baselineExiftool && Date.now() < orphanWait) {
    await sleep(500);
    exiftoolNow = await countProcesses('exiftool.exe');
  }
  if (exiftoolNow > baselineExiftool) {
    log('WARN   ', `${exiftoolNow - baselineExiftool} exiftool process(es) survived the stop (baseline ${baselineExiftool})`);
  } else {
    log('cleanup', `no orphan exiftool processes (${exiftoolNow} running)`);
  }
  return 0;
}

// ---- start path ----------------------------------------------------------------------

async function runStart() {
  if (!existsSync(EXE)) {
    throw new Error(`Vendored engine missing: ${EXE} (copy, never move, from repo-root vendor/exiftool/)`);
  }
  if (!existsSync(SERVER_ENTRY)) throw new Error(`Server entry missing: ${SERVER_ENTRY}`);
  if (!existsSync(TSX_ENTRY)) {
    throw new Error(`tsx is not installed (expected ${TSX_ENTRY}). Run "npm install" in app/.`);
  }

  mkdirSync(dataDir, { recursive: true });

  // Single-instance: a live lock (or a live, answering portfile) wins.
  const lock = readJson(lockPath);
  if (lock !== null && Number.isInteger(lock.launcherPid) && lock.launcherPid !== process.pid && pidAlive(lock.launcherPid)) {
    return focusExistingInstance();
  }
  if (lock !== null && Number.isInteger(lock.launcherPid) && lock.launcherPid !== process.pid) {
    log('single ', `removing stale lock (launcher pid ${lock.launcherPid} is gone)`);
    tryUnlink(lockPath);
  }
  const already = await findRunningInstance();
  if (already !== null) return focusExistingInstance();

  writeLock();

  const port = requestedPort ?? (await getFreePort());
  log('port   ', `${port}${requestedPort !== null ? ' (requested)' : ' (free pick)'}`);

  const baselineExiftool = await countProcesses('exiftool.exe');
  if (baselineExiftool < 0) log('WARN   ', 'tasklist unavailable; orphan verification will be skipped');
  exiftoolBaseline = Math.max(baselineExiftool, 0);

  log('server ', 'starting server workspace (node + tsx, stdin pipe held)');
  serverChild = spawn(process.execPath, [TSX_ENTRY, SERVER_ENTRY, '--port', String(port)], {
    cwd: APP_ROOT,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, METADESK_DATA_DIR: dataDir },
  });
  serverChild.stdout.setEncoding('utf8');
  serverChild.stderr.setEncoding('utf8');
  serverChild.stdout.on('data', (chunk) => process.stdout.write(chunk));
  serverChild.stderr.on('data', (chunk) => process.stderr.write(chunk));
  serverChild.once('exit', (code, signal) => {
    log('server ', `server process exited (code ${code}${signal ? `, signal ${signal}` : ''})`);
  });
  markServerPid(serverChild.pid);

  // Stop triggers that do not involve this console:
  //   - our own stdin ends (window closed, parent died -> pipe handles close)
  //   - Ctrl+C / SIGTERM reaches this launcher
  //   - another process (metadesk.mjs --stop) drops stop.request
  if (!process.stdin.isTTY) {
    process.stdin.on('end', () => gracefulStop('stdin closed'));
    process.stdin.on('close', () => gracefulStop('stdin closed'));
    process.stdin.resume();
  }
  process.once('SIGINT', () => gracefulStop('Ctrl+C'));
  process.once('SIGTERM', () => gracefulStop('SIGTERM'));
  process.once('SIGBREAK', () => gracefulStop('console closing'));

  const healthUrl = `http://127.0.0.1:${port}/api/health`;
  log('health ', `polling ${healthUrl}`);
  const healthDeadline = Date.now() + HEALTH_DEADLINE_MS;
  let health = null;
  while (Date.now() < healthDeadline) {
    if (serverChild.exitCode !== null || serverChild.signalCode !== null) {
      if (stopping) break; // a deliberate stop landed during startup: clean exit below
      throw new Error(`Server exited during startup (code ${serverChild.exitCode}).`);
    }
    const attempt = await httpGet(healthUrl);
    if (attempt.status === 200) {
      health = attempt.body;
      break;
    }
    // A --stop landing mid-boot must still be honored.
    if (existsSync(stopRequestPath)) {
      gracefulStop('stop.request appeared during startup');
      break;
    }
    await sleep(400);
  }
  if (health === null) {
    if (stopping) {
      // A --stop landed during startup: honor it as a normal, clean exit.
      log('stop   ', 'stopped before becoming healthy');
      await waitForServerExit();
      await finalVerification();
      return 0;
    }
    await waitForServerExit();
    throw new Error(`Server never became healthy within ${HEALTH_DEADLINE_MS / 1000}s at ${healthUrl}.`);
  }
  if (health && health.ok === false) {
    log('WARN   ', `engine handshake failed (${health.reason ?? 'unknown'}); MetaDesk starts READ-ONLY - viewing works, editing stays locked`);
  } else {
    log('health ', `ok (engine ${health?.version ?? 'unknown'}, mode ${health?.mode ?? 'read-only'})`);
  }

  // The server owns the portfile ({port, token, pid, url}); read the
  // authoritative values back for the browser and the stop bookkeeping.
  const portfileDeadline = Date.now() + PORTFILE_AFTER_HEALTH_MS;
  let portfile = null;
  while (Date.now() < portfileDeadline) {
    portfile = readJson(portfilePath);
    if (portfile !== null && Number.isInteger(portfile.port)) break;
    await sleep(250);
  }
  const boundPort = Number.isInteger(portfile?.port) ? portfile.port : port;
  if (Number.isInteger(portfile?.pid)) markServerPid(portfile.pid);
  const url =
    typeof portfile?.url === 'string' && portfile.url.length > 0
      ? portfile.url
      : `http://127.0.0.1:${boundPort}/`;

  if (!noBrowser) {
    openInBrowser(url);
    log('ui     ', `opened ${url} in the default browser`);
  } else {
    log('ui     ', `serving ${url} (--no-browser)`);
  }
  log('ready  ', 'MetaDesk is running. Close this window or Ctrl+C to stop; metadesk.mjs --stop works from anywhere.');

  // Wait for the stop trigger, then walk the shutdown ladder.
  await new Promise((resolve) => {
    const poll = setInterval(() => {
      if (existsSync(stopRequestPath)) {
        gracefulStop('stop.request received');
      }
      if (serverChild.exitCode !== null || serverChild.signalCode !== null) {
        clearInterval(poll);
        resolve();
      }
    }, STOP_REQUEST_POLL_MS);
    serverChild.once('exit', () => {
      clearInterval(poll);
      resolve();
    });
  });

  await waitForServerExit();
  await finalVerification();
  return serverChild.exitCode === null ? 0 : serverChild.exitCode ?? 0;
}

// ---- entry ------------------------------------------------------------------------------

try {
  const code = wantStop ? await runStop() : await runStart();
  process.exit(code);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  log('FAILED', message);
  if (serverChild !== null && serverChild.exitCode === null && serverChild.signalCode === null) {
    gracefulStop('launcher failure');
    await waitForServerExit();
  }
  await finalVerification().catch(() => undefined);
  process.exit(1);
}
