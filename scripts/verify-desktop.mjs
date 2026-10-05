#!/usr/bin/env node
/**
 * Desktop-wrap verification gates (leaf 2.1.1).
 *
 *   node app/scripts/verify-desktop.mjs bundle
 *       Builds the esbuild bundle + the pinned stage, then boots the EXACT
 *       staged artifact (`<stage>/node/node.exe <stage>/server/dist/server.mjs`)
 *       with a temp METADESK_DATA_DIR: /api/health answers ok, the served page
 *       injects window.__METADESK__ (the "UI bundle missing" status page is a
 *       FAILURE), the staged exiftool is the engine of record, and a stdin
 *       close stops it with no orphan processes beyond the machine-wide
 *       baseline.
 *       Marker (first stdout line, success only): `server bundle verification passed`
 *
 *   node app/scripts/verify-desktop.mjs shell
 *       Builds the Tauri shell (release) and drives the REAL wrapped app end
 *       to end with a temp data dir: resource layout == pinned package layout,
 *       MetaDesk.exe is the parent of exactly one node.exe running OUR staged
 *       server.mjs, health + injected page, exactly ONE LISTEN socket on
 *       127.0.0.1 owned by node.exe in the spawn tree, a second launch exits
 *       promptly WITHOUT starting a second server, and closing the window tears
 *       the whole tree down with no portfile/lock residue.
 *       Marker (first stdout line, success only): `desktop shell verification passed`
 *
 * Process counting is MACHINE-WIDE (baseline vs after), exactly like
 * verify-launch.mjs — never run this concurrently with `npm test`,
 * verify-launch.mjs, or the other desktop gate. The orphan check compares pid
 * SETS (not just counts), so unrelated process churn elsewhere on the machine
 * is not misread as an orphan; anything NEW is named and fails the gate, with
 * one retry after a settle window before giving up.
 *
 * The wrapped app's window appears on the desktop for a few seconds while the
 * shell gate runs. That is expected; it is not suppressed.
 *
 * Node built-ins only. Windows-only by design (tasklist / pwsh).
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = path.join(APP_ROOT, 'dist-desktop', 'stage');
const STAGE_NODE = path.join(STAGE, 'node', 'node.exe');
const STAGE_BUNDLE = path.join(STAGE, 'server', 'dist', 'server.mjs');
const BUILD_SCRIPT = path.join(APP_ROOT, 'scripts', 'build-server-bundle.mjs');
const TAURI_DIR = path.join(APP_ROOT, 'tauri');
const TAURI_CLI = path.join(APP_ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const TAURI_TARGET = path.join(TAURI_DIR, 'src-tauri', 'target');
const SHELL_EXE = path.join(TAURI_TARGET, 'release', 'MetaDesk.exe');
const BUNDLE_MODE = 'bundle';
const SHELL_MODE = 'shell';

const mode = process.argv[2];
if (mode !== BUNDLE_MODE && mode !== SHELL_MODE) {
  process.stdout.write(
    [
      'Usage: node app/scripts/verify-desktop.mjs <bundle|shell>',
      '',
      '  bundle  build + boot the staged server bundle (gate G2)',
      '  shell   build + drive the wrapped MetaDesk.exe (gates G3/G4)',
      '',
      'Never run this concurrently with npm test, verify-launch.mjs or the other',
      'desktop gate: the orphan assertions count node.exe/exiftool.exe machine-wide.',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

const OVERALL_TIMEOUT_MS = (mode === SHELL_MODE ? 20 : 5) * 60 * 1000;
const watchdog = setTimeout(() => {
  process.stdout.write(`desktop ${mode} verification FAILED\n\noverall watchdog fired\n`);
  process.exit(1);
}, OVERALL_TIMEOUT_MS);
watchdog.unref();

const steps = [];
/** Extra diagnostics printed with a failure; refreshed as the run progresses. */
let diagOf = () => '';
let scratch = '';
let shellChild = null;
let secondShellChild = null;

function step(name, detail = '') {
  steps.push({ name, detail });
  process.stderr.write(`  · ${name}${detail === '' ? '' : ` - ${detail}`}\n`);
}

function note(message) {
  process.stderr.write(`[verify-desktop:${mode}] ${message}\n`);
}

function tailOf(text, count = 40) {
  if (!text || text.trim().length === 0) return '';
  return text.split(/\r?\n/).slice(-count).join('\n');
}

let exitCode = 0;
try {
  if (mode === BUNDLE_MODE) await runBundle();
  else await runShell();
  process.stdout.write(
    mode === BUNDLE_MODE ? 'server bundle verification passed\n' : 'desktop shell verification passed\n',
  );
  for (const s of steps) {
    process.stdout.write(`  ok  ${s.name}${s.detail === '' ? '' : ` - ${s.detail}`}\n`);
  }
} catch (error) {
  exitCode = 1;
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`desktop ${mode} verification FAILED\n\n${message}\n`);
  const extra = diagOf();
  if (extra.trim().length > 0) process.stdout.write(`\n${extra.trim()}\n`);
} finally {
  for (const child of [shellChild, secondShellChild]) {
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  }
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
}
process.exit(exitCode);

// ---------------------------------------------------------------------------
// G2 — the bundle is the real server
// ---------------------------------------------------------------------------

async function runBundle() {
  const exifBaseline = await processPids('exiftool.exe');
  const nodeBaseline = await processPids('node.exe');
  step('baselines', `${nodeBaseline.size} node.exe, ${exifBaseline.size} exiftool.exe before the run`);

  await stageEverything();
  step('stage', `${STAGE}`);

  if (!existsSync(STAGE_NODE)) throw new Error(`Staged node.exe missing: ${STAGE_NODE}`);
  if (!existsSync(STAGE_BUNDLE)) throw new Error(`Staged bundle missing: ${STAGE_BUNDLE}`);
  const version = execFileSyncSafe(STAGE_NODE, ['--version']);
  if (!version.startsWith('v22.')) throw new Error(`Staged node is not 22.x: ${version}`);
  step('node', `${version.trim()} (pinned win-x64, sha256 verified at fetch time)`);

  const dataDir = path.join(makeScratch(), 'data');
  const portfilePath = path.join(dataDir, 'portfile.json');
  const engine = spawn(STAGE_NODE, [STAGE_BUNDLE], {
    cwd: STAGE,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, METADESK_DATA_DIR: dataDir },
  });
  let output = '';
  engine.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  engine.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  diagOf = () => `--- staged server output (tail) ---\n${tailOf(output)}`;

  try {
    const portfile = await pollFor(
      () => readJsonSafe(portfilePath),
      60_000,
      'the staged server never wrote a portfile',
      () => {
        if (engine.exitCode !== null) {
          return `the staged server exited early with code ${engine.exitCode}`;
        }
        return null;
      },
    );
    step('boot', `${portfile.url} (pid ${portfile.pid})`);

    const health = await fetchJson(`${portfile.url.replace(/\/$/, '')}/api/health`);
    if (health.status !== 200 || health.body.ok !== true) {
      throw new Error(`GET /api/health -> ${health.status} ${JSON.stringify(health.body).slice(0, 300)}`);
    }
    step('health', `engine ${health.body.version}, mode ${health.body.mode ?? 'read-only'}`);

    // The engine of record must be the STAGED copy, not a dev-tree fallback.
    if (!portfile.engine || path.relative(STAGE, portfile.engine).startsWith('..')) {
      throw new Error(
        `The server is not using the staged engine: portfile.engine = ${portfile.engine} (expected under ${STAGE})`,
      );
    }
    step('engine-path', `${path.relative(STAGE, portfile.engine)}`);

    const page = await fetch(portfile.url);
    const html = await page.text();
    if (page.status !== 200) throw new Error(`GET / -> ${page.status}`);
    if (!html.includes('window.__METADESK__=')) {
      throw new Error('The served page lacks the __METADESK__ boot script');
    }
    if (html.includes('UI bundle is not built yet')) {
      throw new Error('The served page is the "UI bundle missing" status page, not the app (FAILURE per D1)');
    }
    if (!html.includes(portfile.token)) {
      throw new Error('The served page does not carry the per-launch token');
    }
    step('served-ui', `GET / 200 with boot script + token (${html.length} bytes)`);

    // The pinned stop channel: close the stdin pipe.
    engine.stdin.end();
    const stopped = await pollFor(
      () => (engine.exitCode !== null ? engine.exitCode : null),
      20_000,
      `the staged server ignored the stdin-close stop (still running after 20 s)`,
    );
    if (stopped !== 0) throw new Error(`The staged server exited ${stopped} on stdin close (expected 0)`);
    if (pidAlive(portfile.pid)) throw new Error(`The staged server pid ${portfile.pid} is still alive after exit`);
    step('stop', `stdin close -> exit 0 (the Windows stop channel), pid ${portfile.pid} gone`);
  } finally {
    if (engine.exitCode === null && engine.signalCode === null) {
      try {
        engine.kill();
      } catch {
        /* already gone */
      }
    }
  }

  await assertNoNewProcesses({ node: nodeBaseline, exiftool: exifBaseline });
  step('no-orphans', 'node + exiftool back to the machine-wide baseline');
}

// ---------------------------------------------------------------------------
// G3/G4 — the wrapped shell
// ---------------------------------------------------------------------------

async function runShell() {
  // ---- build (before any counting: the toolchain spawns its own processes) ----
  await stageEverything();
  step('stage', `${STAGE}`);
  await buildShell();
  step('build-shell', `${SHELL_EXE}`);
  if (!existsSync(SHELL_EXE)) throw new Error(`The Tauri build produced no ${SHELL_EXE}`);

  // The resources must land next to the exe AS the pinned package layout: the
  // exe's folder IS the package root on Windows.
  const packageRoot = path.dirname(SHELL_EXE);
  assertPinnedLayout(packageRoot);
  step('resource-layout', 'the exe folder matches the pinned package layout');
  // ...and the copies must be the CURRENT stage, not whatever a previous build
  // left behind (a stale resource copy would silently ship yesterday's bundle).
  await assertResourceContent(packageRoot);
  step('resource-content', 'server.mjs / package.json / ui index.html byte-identical to the stage');

  // ---- baselines + clean environment ------------------------------------------
  await waitForQuietMachine();
  const before = { node: await processPids('node.exe'), exiftool: await processPids('exiftool.exe') };
  step('baselines', `${before.node.size} node.exe, ${before.exiftool.size} exiftool.exe before the run`);

  const dataDir = path.join(makeScratch(), 'data');
  const portfilePath = path.join(dataDir, 'portfile.json');
  const env = { ...process.env, METADESK_DATA_DIR: dataDir };

  const launch = () =>
    spawn(SHELL_EXE, [], {
      cwd: path.dirname(SHELL_EXE),
      shell: false,
      windowsHide: false, // the wrapped app is a GUI; its window is the point
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
  let shellOutput = '';

  shellChild = launch();
  const capture = (child, which) => {
    child.stdout.on('data', (chunk) => {
      shellOutput += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      shellOutput += String(chunk);
    });
    child.on('exit', (code) => {
      note(`${which} exited with code ${code}`);
    });
  };
  capture(shellChild, 'shell');

  const portfile = await pollFor(
    () => readJsonSafe(portfilePath),
    60_000,
    'the wrapped app never wrote a portfile',
    () => (shellChild.exitCode !== null ? `MetaDesk.exe exited early with code ${shellChild.exitCode}` : null),
  );
  step('boot', `${portfile.url} (server pid ${portfile.pid})`);
  diagOf = () => `--- shell stderr (tail) ---\n${tailOf(shellOutput)}`;

  // ---- the spawn tree: MetaDesk.exe -> our node.exe -> (exiftool.exe) ---------
  const tree = await processTree(shellChild.pid);
  const engineNode = tree.find(
    (proc) =>
      proc.name.toLowerCase() === 'node.exe' &&
      proc.cmdline &&
      proc.cmdline.toLowerCase().includes('server.mjs') &&
      proc.cmdline.toLowerCase().includes(path.dirname(SHELL_EXE).toLowerCase()),
  );
  if (!engineNode) {
    throw new Error(
      `MetaDesk.exe has no direct node.exe child running our staged server.mjs. Tree: ${JSON.stringify(tree)}`,
    );
  }
  if (engineNode.ppid !== shellChild.pid) {
    throw new Error(
      `The engine node.exe (pid ${engineNode.pid}) is not a DIRECT child of MetaDesk.exe (parent ${engineNode.ppid})`,
    );
  }
  if (!portfile.engine || path.relative(packageRoot, portfile.engine).startsWith('..')) {
    throw new Error(
      `The wrapped app is not using the engine shipped next to its exe: ${portfile.engine} (expected under ${packageRoot})`,
    );
  }
  step(
    'spawn-tree',
    `MetaDesk.exe ${shellChild.pid} -> node.exe ${engineNode.pid} (staged server.mjs) -> exiftool 13.59`,
  );

  // ---- health + injected page --------------------------------------------------
  const health = await fetchJson(`${portfile.url.replace(/\/$/, '')}/api/health`);
  if (health.status !== 200 || health.body.ok !== true) {
    throw new Error(`GET /api/health -> ${health.status} ${JSON.stringify(health.body).slice(0, 300)}`);
  }
  if (!health.body.version.startsWith('13.')) {
    throw new Error(`The engine handshake is not a 13.x exiftool: ${health.body.version}`);
  }
  step('health', `engine ${health.body.version}, mode ${health.body.mode ?? 'read-only'}`);

  const page = await fetch(portfile.url);
  const html = await page.text();
  if (page.status !== 200) throw new Error(`GET / -> ${page.status}`);
  if (!html.includes('window.__METADESK__=')) throw new Error('The served page lacks the __METADESK__ boot script');
  if (html.includes('UI bundle is not built yet')) {
    throw new Error('The wrapped app served the status page, not the app bundle');
  }
  step('served-ui', `GET / 200 with boot script + token (${html.length} bytes)`);

  // ---- exactly ONE listener, on loopback, owned by node.exe in OUR tree --------
  const listeners = await listeningSockets();
  const treePids = new Set([shellChild.pid, ...tree.map((proc) => proc.pid)]);
  const ours = listeners.filter((socket) => treePids.has(socket.pid));
  if (ours.length !== 1) {
    throw new Error(
      `Expected exactly 1 LISTEN socket in the MetaDesk tree, found ${ours.length}: ${JSON.stringify(listeners)}`,
    );
  }
  const only = ours[0];
  if (only.address !== '127.0.0.1') throw new Error(`The listener is not loopback-only: ${JSON.stringify(only)}`);
  const owner = tree.find((proc) => proc.pid === only.pid);
  if (!owner || owner.name.toLowerCase() !== 'node.exe') {
    throw new Error(`The listener is not owned by node.exe: ${JSON.stringify({ socket: only, tree })}`);
  }
  step('one-listener', `127.0.0.1:${only.port} LISTEN, owned by node.exe ${only.pid}`);

  // ---- second launch: focus, not a second server --------------------------------
  const pidBefore = portfile.pid;
  const secondStartedAt = Date.now();
  secondShellChild = launch();
  const secondExit = await pollFor(
    () => (secondShellChild.exitCode !== null ? secondShellChild.exitCode : null),
    40_000,
    'the second launch did not exit within 40 s (single-instance is not working)',
  );
  if (secondExit !== 0) throw new Error(`The second launch exited ${secondExit} (expected 0)`);
  const secondElapsedMs = Date.now() - secondStartedAt;
  const after = await processTree(shellChild.pid);
  const nodeCount = after.filter((proc) => proc.name.toLowerCase() === 'node.exe').length;
  if (nodeCount !== 1) throw new Error(`After the second launch the tree has ${nodeCount} node.exe processes`);
  const portfileAfter = readJsonSafe(portfilePath);
  if (!portfileAfter || portfileAfter.pid !== pidBefore) {
    throw new Error(`The second launch disturbed the running server: ${JSON.stringify(portfileAfter)}`);
  }
  const healthAfter = await fetchJson(`${portfile.url.replace(/\/$/, '')}/api/health`);
  if (healthAfter.status !== 200 || healthAfter.body.ok !== true) {
    throw new Error('The running server stopped answering after the second launch');
  }
  step('single-instance', `second launch exited 0 after ${(secondElapsedMs / 1000).toFixed(1)} s, server pid unchanged`);

  // ---- close the window: the whole tree must go ---------------------------------
  const closed = await closeMainWindow();
  if (!closed) throw new Error('Could not find the MetaDesk main window to close (WM_CLOSE)');

  const exited = await pollFor(
    () => (shellChild.exitCode !== null ? shellChild.exitCode : null),
    40_000,
    'MetaDesk.exe did not exit within 40 s of WM_CLOSE',
  );
  step('close', `WM_CLOSE -> MetaDesk.exe exited ${exited}`);

  await pollFor(
    () => (!pidAlive(pidBefore) && !pidAlive(engineNode.pid) ? true : null),
    20_000,
    'the engine processes survived the window close',
  );
  step('teardown', 'server pid and node pid are gone');

  const residue = [portfilePath, path.join(dataDir, 'instance.lock'), path.join(dataDir, 'stop.request')].filter(
    existsSync,
  );
  if (residue.length > 0) {
    throw new Error(`Residue left in the data dir: ${residue.map((p) => path.basename(p)).join(', ')}`);
  }
  step('residue', 'portfile / instance.lock / stop.request all swept');

  await assertNoNewProcesses(before);
  step('no-orphans', 'node + exiftool back to the machine-wide baseline');
}

// ---------------------------------------------------------------------------
// build steps
// ---------------------------------------------------------------------------

async function stageEverything() {
  await runNode([BUILD_SCRIPT], APP_ROOT, 'build-server-bundle');
}

async function buildShell() {
  note('building the Tauri shell (release) - the first build downloads ~200 crates');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TAURI_CLI, 'build', '--no-bundle'], {
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
}

/** The pinned package layout, verified wherever the package root is. */
function assertPinnedLayout(packageRoot) {
  const required = [
    'node/node.exe',
    'server/dist/server.mjs',
    'ui/dist/index.html',
    'vendor/exiftool/exiftool.exe',
    'vendor/exiftool/exiftool_files',
    'scripts/selfcheck.mjs',
    'package.json',
  ];
  const missing = required.filter((relative) => !existsSync(path.join(packageRoot, ...relative.split('/'))));
  if (missing.length > 0) {
    throw new Error(
      `The built app folder does not match the pinned package layout. Missing next to the exe:\n  ${missing.join('\n  ')}\n(root: ${packageRoot})`,
    );
  }
}

/**
 * The copies next to the exe must be the stage we just built, not residue from
 * an earlier build with different sources.
 */
async function assertResourceContent(packageRoot) {
  const compared = [
    ['server/dist/server.mjs', STAGE_BUNDLE],
    ['package.json', path.join(STAGE, 'package.json')],
    ['ui/dist/index.html', path.join(STAGE, 'ui', 'dist', 'index.html')],
  ];
  for (const [relative, stagePath] of compared) {
    const shipped = path.join(packageRoot, ...relative.split('/'));
    const shippedHash = createHash('sha256').update(readFileSync(shipped)).digest('hex');
    const stageHash = createHash('sha256').update(readFileSync(stagePath)).digest('hex');
    if (shippedHash !== stageHash) {
      throw new Error(
        `The bundled resource ${relative} is stale (sha256 ${shippedHash.slice(0, 12)}… != stage ${stageHash.slice(0, 12)}…). Rebuild the shell.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// machine-wide process accounting (mirrors verify-launch.mjs, pid-set based)
// ---------------------------------------------------------------------------

/** All pids for one image name, machine-wide (tasklist). */
async function processPids(imageName) {
  const out = await runCapture('tasklist', ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH']);
  if (/info: no tasks/i.test(out)) return new Set();
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    const columns = line.split('","');
    const pid = Number.parseInt((columns[1] ?? '').replace(/"/g, ''), 10);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return pids;
}

/** Process tree below `rootPid`, via Get-CimInstance Win32_Process. */
async function processTree(rootPid) {
  const all = await listProcesses();
  const byParent = new Map();
  for (const proc of all) {
    if (!byParent.has(proc.ppid)) byParent.set(proc.ppid, []);
    byParent.get(proc.ppid).push(proc);
  }
  const tree = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    for (const child of byParent.get(pid) ?? []) {
      tree.push(child);
      queue.push(child.pid);
    }
  }
  return tree;
}

async function listProcesses() {
  const json = await runPowerShell(`
    Get-CimInstance Win32_Process |
      Select-Object ProcessId, ParentProcessId, Name, CommandLine |
      ConvertTo-Json -Compress -Depth 2
  `);
  const parsed = JSON.parse(json || '[]');
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => ({
    pid: Number(row.ProcessId),
    ppid: Number(row.ParentProcessId),
    name: String(row.Name ?? ''),
    cmdline: String(row.CommandLine ?? ''),
  }));
}

async function listeningSockets() {
  const json = await runPowerShell(`
    Get-NetTCPConnection -State Listen |
      Select-Object LocalAddress, LocalPort, OwningProcess |
      ConvertTo-Json -Compress -Depth 2
  `);
  const parsed = JSON.parse(json || '[]');
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => ({
    address: String(row.LocalAddress ?? ''),
    port: Number(row.LocalPort ?? 0),
    pid: Number(row.OwningProcess ?? 0),
  }));
}

/** PostMessage(hwnd, WM_CLOSE) to the wrapped app's main window. */
async function closeMainWindow() {
  const out = await runPowerShell(`
    Add-Type -Namespace MetaDesk -Name Native -MemberDefinition '
      [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    '
    $window = Get-Process -Name MetaDesk -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 } |
      Select-Object -First 1
    if ($null -eq $window) { Write-Output 'NOWINDOW' }
    else {
      [MetaDesk.Native]::PostMessage($window.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
      Write-Output ('CLOSED ' + $window.Id)
    }
  `);
  note(`closeMainWindow: ${out.trim()}`);
  return out.includes('CLOSED');
}

/**
 * The orphan gate: no NEW node.exe / exiftool.exe pids beyond the baseline,
 * retried once after a settle window, naming whatever survived.
 */
async function assertNoNewProcesses(before) {
  const attempt = async () => ({
    node: await processPids('node.exe'),
    exiftool: await processPids('exiftool.exe'),
  });

  let now = await attempt();
  if (!newPids(before, now)) return;

  note('process churn detected; settling 10 s and recounting once');
  await sleep(10_000);
  now = await attempt();
  const newOnes = newPids(before, now);
  if (!newOnes) return;

  const names = await listProcesses();
  const describe = (pid) => {
    const proc = names.find((candidate) => candidate.pid === pid);
    return proc ? `${proc.name} (pid ${pid}) ${proc.cmdline.slice(0, 120)}` : `pid ${pid}`;
  };
  throw new Error(
    [
      'Orphan processes survived the run:',
      ...[...newOnes.node].map((pid) => `  node.exe: ${describe(pid)}`),
      ...[...newOnes.exiftool].map((pid) => `  exiftool.exe: ${describe(pid)}`),
      `(baseline: node ${before.node.size}, exiftool ${before.exiftool.size}; now: node ${now.node.size}, exiftool ${now.exiftool.size})`,
    ].join('\n'),
  );
}

function newPids(before, now) {
  const node = [...now.node].filter((pid) => !before.node.has(pid));
  const exiftool = [...now.exiftool].filter((pid) => !before.exiftool.has(pid));
  if (node.length === 0 && exiftool.length === 0) return null;
  return { node: new Set(node), exiftool: new Set(exiftool) };
}

/** Refuse to start counting while another node-heavy job (vitest, npm test) runs. */
async function waitForQuietMachine() {
  const deadline = Date.now() + 60_000;
  let busy = await busyProcesses();
  while (busy.length > 0 && Date.now() < deadline) {
    note(`waiting for a quiet machine (other node jobs running: ${busy.length})`);
    await sleep(5_000);
    busy = await busyProcesses();
  }
  if (busy.length > 0) {
    note('WARNING: other node jobs are still running; the machine-wide counts may be flaky');
  }
}

async function busyProcesses() {
  const processes = await listProcesses();
  return processes.filter(
    (proc) =>
      proc.name.toLowerCase() === 'node.exe' &&
      proc.pid !== process.pid &&
      /vitest|npm test|npm run test|verify-launch|verify-desktop/i.test(proc.cmdline),
  );
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

async function runNode(args, cwd, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
      process.stderr.write(`  ${String(chunk).trimEnd()}\n`);
    });
    child.stderr.on('data', (chunk) => {
      out += String(chunk);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve(out);
        return;
      }
      reject(new Error(`${label} exited ${code}\n${tailOf(out, 40)}`));
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
    child.on('exit', () => resolve(out));
  });
}

/** argv-array spawn of pwsh with a readable (non-base64) script argument. */
function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', script],
      { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
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

function execFileSyncSafe(file, args) {
  return execFileSync(file, args, { shell: false, windowsHide: true, encoding: 'utf8' });
}

async function pollFor(produce, timeoutMs, failure, extraFailure = null) {
  const startedAt = Date.now();
  let extraNote = '';
  while (Date.now() - startedAt < timeoutMs) {
    const extra = extraFailure === null ? null : extraFailure();
    if (extra !== null && extra !== undefined) {
      extraNote = extra;
      break;
    }
    const value = await produce();
    if (value !== null && value !== undefined && value !== false) return value;
    await sleep(250);
  }
  throw new Error(`${failure}${extraNote === '' ? '' : ` (${extraNote})`}`);
}

async function fetchJson(url) {
  try {
    const response = await fetch(url);
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = { raw: (await response.text()).slice(0, 200) };
    }
    return { status: response.status, body };
  } catch (error) {
    return { status: 0, body: { error: String(error) } };
  }
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
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

function makeScratch() {
  scratch = mkdtempSync(path.join(tmpdir(), `metadesk-verify-desktop-${mode}-`));
  return scratch;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
