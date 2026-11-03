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
 *   node app/scripts/verify-desktop.mjs matrix            (gate G1, leaf 2.1.2)
 *       Builds the shell once, then runs the four-case LIFECYCLE KILL MATRIX,
 *       each case in its own temp data dir:
 *         1. X-close graceful    healthy app -> WM_CLOSE -> exit 0, engine pids
 *                                gone, portfile/lock swept (the ladder, 3-5);
 *         2. hard-kill backstop  taskkill /F /PID <our shell pid> -> the shell
 *                                dies violently and the node.exe engine (plus
 *                                its exiftool) die with it within the settle
 *                                window — the Job Object, not the ladder;
 *         3. stale portfile      a seeded portfile naming a DEAD pid is swept
 *                                by the launch sweep (image-path checked) and
 *                                the app boots clean;
 *         4. slow-boot single    a second launch inside the first instance's
 *                                boot window exits 0 promptly and starts no
 *                                second server.
 *       Marker (first stdout line, success only): `desktop lifecycle matrix verification passed`
 *
 * Process counting is MACHINE-WIDE (baseline vs after), exactly like
 * verify-launch.mjs — never run this concurrently with `npm test`,
 * verify-launch.mjs, or the other desktop gate. The orphan check compares pid
 * SETS (not just counts), so unrelated process churn elsewhere on the machine
 * is not misread as an orphan; anything NEW is named and fails the gate, with
 * one retry after a settle window before giving up.
 *
 * The wrapped app's window appears on the desktop for a few seconds while the
 * shell/matrix gates run. That is expected; it is not suppressed.
 *
 * Node built-ins only. Windows-only by design (tasklist / pwsh).
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { pollPortfile } from './lib/portfile.mjs';
import {
  assertNoNewProcesses,
  listProcesses,
  processPids,
  processTree,
  waitForQuietMachine,
} from './lib/processes.mjs';
import {
  bootAndProve,
  engineNodeOf,
  fetchJson,
  launchTarget,
  pidAlive,
  pollFor,
  proveLive,
  proveStopped,
} from './lib/bootAndProve.mjs';

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
const MATRIX_MODE = 'matrix';

const mode = process.argv[2];
if (mode !== BUNDLE_MODE && mode !== SHELL_MODE && mode !== MATRIX_MODE) {
  process.stdout.write(
    [
      'Usage: node app/scripts/verify-desktop.mjs <bundle|shell|matrix>',
      '',
      '  bundle  build + boot the staged server bundle (leaf 2.1.1 gate G2)',
      '  shell   build + drive the wrapped MetaDesk.exe end to end',
      '  matrix  build + run the lifecycle kill matrix (leaf 2.1.2 gate G1)',
      '',
      'Never run this concurrently with npm test, verify-launch.mjs or the other',
      'desktop gate: the orphan assertions count node.exe/exiftool.exe machine-wide.',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

const OVERALL_TIMEOUT_MS = (mode === BUNDLE_MODE ? 5 : 20) * 60 * 1000;
const watchdog = setTimeout(() => {
  process.stdout.write(`desktop ${mode} verification FAILED\n\noverall watchdog fired\n`);
  process.exit(1);
}, OVERALL_TIMEOUT_MS);
watchdog.unref();

const steps = [];
/** Extra diagnostics printed with a failure; refreshed as the run progresses. */
let diagOf = () => '';
/** Scratch roots to remove at the end (the matrix uses one per case). */
const scratchDirs = [];
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

// Issue #19: every shell boot (runShell + the matrix cases) feeds ONE output
// accumulator, so a failure always shows the app's own tail no matter which
// case was running when it died.
let shellOutput = '';
const trackShellOutput = (text) => {
  shellOutput += text;
};
const noteShellExit = (code, pid) => note(`MetaDesk.exe (pid ${pid}) exited with code ${code}`);

let exitCode = 0;
try {
  if (mode === BUNDLE_MODE) await runBundle();
  else if (mode === SHELL_MODE) await runShell();
  else await runMatrix();
  process.stdout.write(
    mode === BUNDLE_MODE
      ? 'server bundle verification passed\n'
      : mode === SHELL_MODE
        ? 'desktop shell verification passed\n'
        : 'desktop lifecycle matrix verification passed\n',
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
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
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
    // Issue #17: field rules live in scripts/lib/portfile.mjs.
    const portfile = await pollPortfile(portfilePath, {
      timeoutMs: 60_000,
      abort: () => (engine.exitCode !== null ? `the staged server exited early with code ${engine.exitCode}` : null),
    });
    if (portfile === null) throw new Error('the staged server never wrote a portfile');
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

  await assertNoNewProcesses({ node: nodeBaseline, exiftool: exifBaseline }, { onNote: note });
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
  await waitForQuietMachine({ onNote: note });
  const before = { node: await processPids('node.exe'), exiftool: await processPids('exiftool.exe') };
  step('baselines', `${before.node.size} node.exe, ${before.exiftool.size} exiftool.exe before the run`);

  const dataDir = path.join(makeScratch(), 'data');
  const env = { ...process.env, METADESK_DATA_DIR: dataDir };

  // Issue #19: the boot -> prove -> close narrative lives ONCE in
  // scripts/lib/bootAndProve.mjs (spawn-tree, health, served page, the
  // one-listener rule, WM_CLOSE, teardown, residue). This gate's delta:
  // `singleInstance` (the second-launch probe) and the machine-wide orphan
  // gate after the close. onChild registers every spawned child — first AND
  // second launch — with the failure-path cleanup BEFORE anything can fail.
  diagOf = () => `--- MetaDesk.exe output (tail) ---\n${tailOf(shellOutput)}`;
  await bootAndProve({
    exe: SHELL_EXE,
    cwd: path.dirname(SHELL_EXE),
    env,
    packageRoot,
    dataDir,
    label: 'the wrapped app',
    singleInstance: true,
    onChild: (child) => {
      if (shellChild === null) shellChild = child;
      else secondShellChild = child;
    },
    onStep: step,
    onNote: note,
    onOutput: trackShellOutput,
    onExit: noteShellExit,
  });

  await assertNoNewProcesses(before, { onNote: note });
  step('no-orphans', 'node + exiftool back to the machine-wide baseline');
}

// ---------------------------------------------------------------------------
// G1 (leaf 2.1.2) — the lifecycle kill matrix
// ---------------------------------------------------------------------------

async function runMatrix() {
  // ---- build once, before any counting (the toolchain spawns its own processes)
  await stageEverything();
  step('stage', `${STAGE}`);
  await buildShell();
  step('build-shell', `${SHELL_EXE}`);
  if (!existsSync(SHELL_EXE)) throw new Error(`The Tauri build produced no ${SHELL_EXE}`);
  const packageRoot = path.dirname(SHELL_EXE);
  assertPinnedLayout(packageRoot);
  await assertResourceContent(packageRoot);
  step('resource-layout', 'the exe folder matches the pinned package layout');

  await waitForQuietMachine({ onNote: note });
  const before = { node: await processPids('node.exe'), exiftool: await processPids('exiftool.exe') };
  step('baselines', `${before.node.size} node.exe, ${before.exiftool.size} exiftool.exe before the run`);

  await matrixCase1CloseGraceful(packageRoot);
  await assertNoNewProcesses(before, { onNote: note });

  await matrixCase2HardKillBackstop(packageRoot);
  await assertNoNewProcesses(before, { onNote: note });

  await matrixCase3StalePortfileSweep(packageRoot);
  await assertNoNewProcesses(before, { onNote: note });

  await matrixCase4SlowBootSingleInstance(packageRoot);
  await assertNoNewProcesses(before, { onNote: note });
}

/**
 * One bootAndProve call per matrix case, with the case name prefixed onto the
 * routine's canonical step names (boot / spawn-tree / health / served-ui /
 * one-listener / close / teardown / residue). Every case's launch looks the
 * same except its data dir — the deltas live in what each case DOES around
 * the shared proof.
 */
function shellBootFor(packageRoot, dataDir, { onChild, onStep, accept = null, stop = 'window' }) {
  return bootAndProve({
    exe: SHELL_EXE,
    cwd: packageRoot,
    env: { ...process.env, METADESK_DATA_DIR: dataDir },
    packageRoot,
    dataDir,
    label: 'the wrapped app',
    accept,
    stop,
    onChild,
    onStep,
    onNote: note,
    onOutput: trackShellOutput,
    onExit: noteShellExit,
  });
}

/** Case 1 — the baseline: X-close runs the graceful ladder (steps 3-5). */
async function matrixCase1CloseGraceful(packageRoot) {
  const dataDir = path.join(makeScratch(), 'data');
  const caseStep = (name, detail) => step(`case1-${name}`, detail);
  // The full proof IS the case: healthy boot (spawn-tree / health / served-ui
  // / one-listener) then WM_CLOSE -> exit 0, engine pids gone, dir swept.
  await shellBootFor(packageRoot, dataDir, {
    onChild: (child) => {
      shellChild = child;
    },
    onStep: caseStep,
  });
}

/**
 * Case 2 — the backstop: a VIOLENT shell death (taskkill /F on our exact pid,
 * no ladder, no cleanup code) must still take the whole engine tree down via
 * the Job Object's KILL_ON_JOB_CLOSE, and leave no orphan exiftool.
 */
async function matrixCase2HardKillBackstop(packageRoot) {
  const dataDir = path.join(makeScratch(), 'data');
  const caseStep = (name, detail) => step(`case2-${name}`, detail);
  // Issue #19: the routine proves the boot live, then hands back — `stop:
  // null` because this case's SUBJECT is a violent death; the routine itself
  // never kills, and the case performs its own taskkill below.
  const boot = await shellBootFor(packageRoot, dataDir, {
    stop: null,
    onChild: (child) => {
      shellChild = child;
    },
    onStep: caseStep,
  });
  const engineNode = boot.engineNode;
  const exifPids = boot.tree
    .filter((proc) => proc.name.toLowerCase() === 'exiftool.exe')
    .map((proc) => proc.pid);
  step(
    'case2-targets',
    `shell ${boot.child.pid}, engine ${engineNode.pid}${
      exifPids.length > 0 ? `, exiftool ${exifPids.join(', ')}` : ''
    }`,
  );

  // Kill ONLY our shell (its exact pid — never /IM, which would sweep every
  // MetaDesk.exe on the machine). argv array, no shell string.
  const killedAt = Date.now();
  await new Promise((resolve, reject) => {
    const taskkill = spawn('taskkill', ['/PID', String(boot.child.pid), '/F'], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    taskkill.stderr.on('data', (chunk) => {
      err += String(chunk);
    });
    taskkill.on('error', reject);
    taskkill.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`taskkill /PID ${boot.child.pid} /F exited ${code}: ${tailOf(err, 5)}`));
    });
  });

  await pollFor(
    () => (boot.child.exitCode !== null ? true : null),
    15_000,
    'the shell pid did not die from taskkill /F',
  );

  // Nothing of ours ran — the kernel closed the Job handle, which is the kill.
  await pollFor(
    () =>
      !pidAlive(engineNode.pid) && exifPids.every((pid) => !pidAlive(pid)) ? true : null,
    20_000,
    'the engine tree survived a violent shell kill (Job Object backstop failed)',
  );
  const elapsedMs = Date.now() - killedAt;
  step(
    'case2-backstop',
    `taskkill /F /PID ${boot.child.pid} -> shell dead, engine ${engineNode.pid} + exiftool dead in ${(elapsedMs / 1000).toFixed(1)} s (Job Object, no ladder)`,
  );

  // A violent death leaves the portfile behind — nothing ran the ladder. That
  // residue is exactly what step 0 of the NEXT launch owns (case 3 proves it).
  if (!existsSync(boot.portfilePath)) {
    throw new Error('expected the violent death to leave the portfile behind');
  }
  step('case2-residue', 'portfile intentionally left behind; the next launch sweep owns it');
}

/**
 * Case 3 — step 0 of the ladder: a portfile naming a DEAD pid is swept before
 * anything spawns, and the app boots clean on a fresh engine.
 */
async function matrixCase3StalePortfileSweep(packageRoot) {
  const dataDir = path.join(makeScratch(), 'data');
  mkdirSync(dataDir, { recursive: true });
  const portfilePath = path.join(dataDir, 'portfile.json');

  // A genuinely dead pid: start a throwaway process, let it exit, and re-check
  // it is still dead right before the launch (a recycled pid would defeat the
  // point — pick another corpse instead of asserting on a moving target).
  let deadPid = null;
  for (let attempt = 0; attempt < 3 && deadPid === null; attempt += 1) {
    const candidate = await spawnAndExitPid();
    await sleep(250);
    if (!pidAlive(candidate)) deadPid = candidate;
  }
  if (deadPid === null) throw new Error('could not obtain a dead pid for the stale portfile');
  writeFileSync(
    portfilePath,
    `${JSON.stringify(
      {
        port: 1,
        token: 'stale-token-from-the-matrix',
        pid: deadPid,
        startedAt: new Date(0).toISOString(),
        engine: '',
        url: 'http://127.0.0.1:1/',
      },
      null,
      2,
    )}\n`,
  );
  step('case3-seed', `stale portfile seeded with dead pid ${deadPid}`);

  // The seed names port 1 and a dead pid; only the boot's OWN portfile counts
  // (`accept` is the routine's admission filter for exactly this).
  const caseStep = (name, detail) => step(`case3-${name}`, detail);
  await shellBootFor(packageRoot, dataDir, {
    accept: (candidate) => candidate.pid !== deadPid && candidate.port !== 1,
    onChild: (child) => {
      shellChild = child;
    },
    onStep: caseStep,
  });

  // The sweep line proves WHICH branch handled it (dead pid -> unlink, never a
  // kill) — the safety property behind the never-kill-a-foreign-process rule.
  // Read AFTER the close: the sweep happened at launch (step 0), the graceful
  // close only appends, so the line's presence does not depend on when we look.
  const log = readFileSync(path.join(dataDir, 'metadesk-shell.log'), 'utf8');
  if (!log.includes(`stale portfile (pid ${deadPid} is dead)`)) {
    throw new Error(
      `the shell log shows no stale-portfile sweep for pid ${deadPid}:\n${tailOf(log, 25)}`,
    );
  }
  step('case3-sweep', `launch sweep removed the stale portfile (dead pid ${deadPid}) before spawning`);
}

/** A short-lived process whose pid is guaranteed gone when this resolves. */
async function spawnAndExitPid() {
  return new Promise((resolve, reject) => {
    const corpse = spawn('cmd.exe', ['/d', '/c', 'exit', '0'], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    corpse.on('error', reject);
    corpse.on('exit', () => resolve(corpse.pid));
  });
}

/**
 * Case 4 — a second launch INSIDE the first instance's boot window: it must
 * exit 0 promptly and start no second server.
 */
async function matrixCase4SlowBootSingleInstance(packageRoot) {
  const dataDir = path.join(makeScratch(), 'data');
  const caseStep = (name, detail) => step(`case4-${name}`, detail);
  const launchInstance = () =>
    launchTarget({
      exe: SHELL_EXE,
      cwd: packageRoot,
      env: { ...process.env, METADESK_DATA_DIR: dataDir },
      onOutput: trackShellOutput,
      onExit: noteShellExit,
    });

  const first = launchInstance();
  shellChild = first; // the failure-path cleanup must always know the live child
  // Mid-boot means: past the single-instance registration (the FIRST plugin)
  // and past the engine spawn, but before the window is up. Waiting for the
  // engine node child pins the moment deterministically.
  await pollFor(async () => {
    const tree = await processTree(first.pid);
    return engineNodeOf(packageRoot, tree) ? true : null;
  }, 30_000, 'instance 1 never started its engine inside the boot window');
  step('case4-midboot', `instance 1 (pid ${first.pid}) is mid-boot: engine spawned, window not up yet`);

  const secondStartedAt = Date.now();
  secondShellChild = launchInstance();
  const secondExit = await pollFor(
    () => (secondShellChild.exitCode !== null ? secondShellChild.exitCode : null),
    40_000,
    'the mid-boot second launch did not exit within 40 s (single-instance is not working)',
  );
  if (secondExit !== 0) throw new Error(`the mid-boot second launch exited ${secondExit} (expected 0)`);
  const secondElapsedMs = Date.now() - secondStartedAt;

  // Exactly one server — machine-wide, not just inside instance 1's tree.
  const everything = await listProcesses();
  const servers = everything.filter((proc) => {
    const cmdline = (proc.cmdline || '').toLowerCase();
    return (
      proc.name.toLowerCase() === 'node.exe' &&
      cmdline.includes('server.mjs') &&
      cmdline.includes(packageRoot.toLowerCase())
    );
  });
  if (servers.length !== 1) {
    throw new Error(`expected exactly 1 staged server after the mid-boot second launch, found ${servers.length}`);
  }
  step(
    'case4-single',
    `second launch exited 0 after ${(secondElapsedMs / 1000).toFixed(1)} s; exactly 1 staged server machine-wide`,
  );

  // Instance 1 finishes its boot normally and owns the one portfile — and the
  // full LIVE proof runs now that the boot window has closed (issue #19: the
  // phase exports let a bespoke choreography reuse the exact assertions).
  if (first.exitCode !== null) throw new Error('instance 1 did not survive the second launch');
  const live = await proveLive({
    child: first,
    packageRoot,
    dataDir,
    label: 'instance 1',
    onStep: caseStep,
  });
  await proveStopped({
    child: first,
    portfile: live.portfile,
    dataDir,
    enginePid: live.engineNode.pid,
    onStep: caseStep,
    onNote: note,
  });
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

function execFileSyncSafe(file, args) {
  return execFileSync(file, args, { shell: false, windowsHide: true, encoding: 'utf8' });
}

function makeScratch() {
  const dir = mkdtempSync(path.join(tmpdir(), `metadesk-verify-desktop-${mode}-`));
  scratchDirs.push(dir);
  return dir;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
