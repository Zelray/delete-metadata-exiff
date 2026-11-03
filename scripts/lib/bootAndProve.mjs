/**
 * The ONE boot-and-prove kit for the heavyweight gates (issue #19,
 * arch-review Candidate 6). Before this module, "boot the shipped thing and
 * prove the lifecycle contract" was re-authored as ~120-line narratives in
 * four places — verify-package's bootAndTeardown, run-clean-machine's clean
 * and update boots, and verify-desktop's runShell (plus its compact
 * bootShell/closeAndAssertSwept copies for the matrix cases). Each gate knew
 * only SOME of the product truths: the token-on-page check lived in one
 * gate, the served-version check in one, the exactly-one-listener check in
 * two of four, exit-0-on-close in three of four. The truths live HERE now,
 * once.
 *
 * The narrative has three phases, and the gates contribute only their deltas
 * (what happens before the boot, between the phases, or after the close):
 *
 *   launchTarget  — the argv-array GUI spawn (shell:false, windowsHide:false;
 *                   the window is the point). Output flows back through
 *                   callbacks so every gate keeps its own chatter format.
 *   proveLive     — the app is up and serving the REAL thing: portfile →
 *                   spawn-tree (the shipped server.mjs as a DIRECT child) →
 *                   health 13.x → the injected page (boot script, token, never
 *                   the "UI bundle missing" status page) → exactly one
 *                   loopback LISTEN socket owned by node.exe in the tree.
 *   proveStopped  — the app goes down through ITS OWN close channel
 *                   (WM_CLOSE via the C5 kit — never a kill): exit 0, engine
 *                   pids gone, the data dir swept of runtime residue.
 *
 * bootAndProve() composes all three into one call for the plain narratives;
 * the matrix cases that need mid-boot choreography call the phases directly.
 * A source-scan test (quality/bootAndProve.test.mjs) pins the no-kill
 * contract: taskkill appears only in verify-desktop's matrix case 2, where
 * the violent death is the thing under test.
 *
 * Consumes the C4 portfile reader (scripts/lib/portfile.mjs) and the C5
 * process kit (scripts/lib/processes.mjs). Node builtins + first-party libs
 * only (MD6 as amended — no new launch runtime dependency). Windows-only by
 * design.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { pollPortfile, readPortfile } from './portfile.mjs';
import { closeMainWindow, listeningSockets, processTree } from './processes.mjs';

/**
 * Spawn the app the way a user's double-click does: argv array, shell:false,
 * a visible window (windowsHide:false — the window IS the lifecycle under
 * test), stdout/stderr captured through `onOutput(text)` and exits noted
 * through `onExit(code, pid)`. Returns the child immediately — the caller
 * registers it with its failure-diagnostic / cleanup wiring BEFORE any await
 * that can fail, exactly like the inline spawns this module replaced.
 */
export function launchTarget({ exe, args = [], cwd, env, onOutput = null, onExit = null }) {
  const child = spawn(exe, args, {
    cwd,
    shell: false,
    windowsHide: false, // the packaged app is a GUI; its window is the point
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  if (onOutput !== null) {
    child.stdout.on('data', (chunk) => onOutput(String(chunk)));
    child.stderr.on('data', (chunk) => onOutput(String(chunk)));
  }
  if (onExit !== null) {
    child.on('exit', (code) => onExit(code, child.pid));
  }
  return child;
}

/**
 * The engine of record: OUR node.exe running the SHIPPED server.mjs from
 * inside `packageRoot`. One finder for every gate — this exact predicate used
 * to exist four times (three inline, one helper).
 */
export function engineNodeOf(packageRoot, tree) {
  return tree.find(
    (proc) =>
      proc.name.toLowerCase() === 'node.exe' &&
      proc.cmdline &&
      proc.cmdline.toLowerCase().includes('server.mjs') &&
      proc.cmdline.toLowerCase().includes(packageRoot.toLowerCase()),
  );
}

/**
 * The runtime-state files a graceful close must sweep. One address for the
 * residue set (portfile / instance.lock / stop.request) — the four copies of
 * this list are now this function.
 */
export function assertNoResidue(dataDir) {
  const residue = ['portfile.json', 'instance.lock', 'stop.request']
    .map((name) => path.join(dataDir, name))
    .filter(existsSync);
  if (residue.length > 0) {
    throw new Error(`Residue left in the data dir: ${residue.map((p) => path.basename(p)).join(', ')}`);
  }
}

/**
 * Liveness by signal-0 probe: true when the pid exists (EPERM = exists but
 * owned by someone else), false when the OS says it is gone. The dead-pid
 * answer is what "teardown worked" means.
 */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error !== null && typeof error === 'object' && error.code === 'EPERM';
  }
}

/**
 * Poll until `produce` returns something truthy, else throw `failure` at the
 * deadline. `extraFailure` short-circuits with a better cause the moment one
 * is known ("(child exited early)") — knowing WHY beats waiting out the
 * clock. Same semantics as the three gate-local copies this replaces.
 */
export async function pollFor(produce, timeoutMs, failure, extraFailure = null) {
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
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${failure}${extraNote === '' ? '' : ` (${extraNote})`}`);
}

/**
 * GET a JSON endpoint without ever throwing: {status, body} with body as the
 * parsed object, or {raw} when the body is not JSON, or {error} when the
 * request itself refused (status 0). The gates branch on status, so a
 * refused connection must be data, not an exception.
 */
export async function fetchJson(url) {
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

/**
 * The version the served page announces to the UI, from the boot script
 * (window.__METADESK__ = {"token":"…","version":"…",…}); undefined when the
 * page carries no boot script.
 */
export function servedVersionOf(html) {
  return html.match(/window\.__METADESK__=\{"token":"[^"]*","version":"([^"]+)"/)?.[1];
}

/**
 * THE LIVE PROOF: the app just booted and is serving the real thing, not a
 * shell of itself. Every assertion here is a product truth that used to be
 * hand-copied (incompletely) across four gates:
 *
 *   boot        the portfile appeared (field rules via the C4 reader; the
 *               poll aborts early if the child died — a dead child will
 *               never write the file). `accept` lets a caller ignore
 *               portfiles it knows are not this boot's (the matrix's
 *               stale-seed case).
 *   spawn-tree  the engine is OUR node.exe running the SHIPPED server.mjs,
 *               a DIRECT child of the shell, with the portfile naming an
 *               engine inside packageRoot — the app must run its own folder,
 *               never a PATH-borne rescue.
 *   health      200 ok with a 13.x exiftool handshake.
 *   served-ui   GET / is 200 with the boot script and the per-launch token —
 *               and never the "UI bundle missing" status page. With
 *               `expectedVersion`, the version announced to the UI must be
 *               exactly the shipped one.
 *   one-listener exactly ONE LISTEN socket in the tree, loopback-only, owned
 *               by node.exe (single-instance means one server; a second
 *               listener would mean a second server or a foreign port).
 *
 * onStep(name, detail) carries the canonical step names (boot / spawn-tree /
 * health / served-ui / one-listener) so gates keep their own step lists.
 */
export async function proveLive({
  child,
  packageRoot,
  dataDir,
  label = 'the app',
  expectedVersion = null,
  accept = null,
  oneListener = true,
  onStep = () => {},
}) {
  const portfilePath = path.join(dataDir, 'portfile.json');
  // Issue #17: field rules live in scripts/lib/portfile.mjs.
  const portfile = await pollPortfile(portfilePath, {
    timeoutMs: 60_000,
    accept,
    abort: () => (child.exitCode !== null ? `MetaDesk.exe exited early with code ${child.exitCode}` : null),
  }).catch((abortError) => {
    throw new Error(`${label} never wrote a portfile (${abortError.message})`);
  });
  if (portfile === null) throw new Error(`${label} never wrote a portfile`);
  onStep('boot', `${portfile.url} (server pid ${portfile.pid})`);

  const tree = await processTree(child.pid);
  const engineNode = engineNodeOf(packageRoot, tree);
  if (!engineNode) {
    throw new Error(`MetaDesk.exe has no node.exe child running the shipped server.mjs. Tree: ${JSON.stringify(tree)}`);
  }
  if (engineNode.ppid !== child.pid) {
    throw new Error(`The engine node.exe (pid ${engineNode.pid}) is not a DIRECT child of MetaDesk.exe`);
  }
  if (!portfile.engine || path.relative(packageRoot, portfile.engine).startsWith('..')) {
    throw new Error(`The app is not using the engine shipped in its own folder: ${portfile.engine}`);
  }
  onStep('spawn-tree', `MetaDesk.exe ${child.pid} -> node.exe ${engineNode.pid} (shipped server.mjs)`);

  const health = await fetchJson(`${portfile.url.replace(/\/$/, '')}/api/health`);
  if (health.status !== 200 || health.body.ok !== true) {
    throw new Error(`GET /api/health -> ${health.status} ${JSON.stringify(health.body).slice(0, 300)}`);
  }
  if (!health.body.version.startsWith('13.')) {
    throw new Error(`The engine handshake is not a 13.x exiftool: ${health.body.version}`);
  }
  onStep('health', `engine ${health.body.version}, mode ${health.body.mode ?? 'read-only'}`);

  const page = await fetch(portfile.url);
  const html = await page.text();
  if (page.status !== 200) throw new Error(`GET / -> ${page.status}`);
  if (!html.includes('window.__METADESK__=')) {
    throw new Error('The served page lacks the __METADESK__ boot script');
  }
  if (html.includes('UI bundle is not built yet')) {
    throw new Error(`${label} served the "UI bundle missing" status page, not the app (FAILURE)`);
  }
  if (!html.includes(portfile.token)) {
    throw new Error('The served page does not carry the per-launch token');
  }
  if (expectedVersion !== null) {
    const servedVersion = servedVersionOf(html);
    if (servedVersion !== expectedVersion) {
      throw new Error(`The served page announces version ${JSON.stringify(servedVersion)}, expected ${expectedVersion}`);
    }
  }
  onStep(
    'served-ui',
    `GET / 200 with boot script + token${expectedVersion === null ? '' : ` + version ${expectedVersion}`} (${html.length} bytes)`,
  );

  if (oneListener) {
    const listeners = await listeningSockets();
    const treePids = new Set([child.pid, ...tree.map((proc) => proc.pid)]);
    const ours = listeners.filter((socket) => treePids.has(socket.pid));
    if (ours.length !== 1) {
      throw new Error(`Expected exactly 1 LISTEN socket in the app's tree, found ${ours.length}: ${JSON.stringify(listeners)}`);
    }
    const only = ours[0];
    if (only.address !== '127.0.0.1') throw new Error(`The listener is not loopback-only: ${JSON.stringify(only)}`);
    const owner = tree.find((proc) => proc.pid === only.pid);
    if (!owner || owner.name.toLowerCase() !== 'node.exe') {
      throw new Error(`The listener is not owned by node.exe: ${JSON.stringify({ socket: only, tree })}`);
    }
    onStep('one-listener', `127.0.0.1:${only.port} LISTEN, owned by node.exe ${only.pid}`);
  }

  return { child, portfile, portfilePath, tree, engineNode };
}

/**
 * THE STOPPED PROOF: the app goes down through its own close channel and
 * takes the whole engine tree with it. WM_CLOSE to OUR pid's window (the C5
 * kit; pid-first so a name-only close cannot hit a second instance), exit 0
 * within 40 s, both engine pids gone within 20 s, and the data dir swept of
 * the runtime residue triple. This module has no kill path — when a gate
 * needs to study a VIOLENT death it does its own (matrix case 2).
 */
export async function proveStopped({ child, portfile, dataDir, enginePid, onStep = () => {}, onNote = () => {} }) {
  const startedAt = Date.now();
  const closed = await closeMainWindow(child.pid, { onNote });
  if (!closed) throw new Error('Could not find the MetaDesk main window to close (WM_CLOSE)');
  const exitCodeSeen = await pollFor(
    () => (child.exitCode !== null ? child.exitCode : null),
    40_000,
    'MetaDesk.exe did not exit within 40 s of WM_CLOSE',
  );
  if (exitCodeSeen !== 0) throw new Error(`MetaDesk.exe exited ${exitCodeSeen} on WM_CLOSE (expected 0)`);
  onStep('close', `WM_CLOSE -> exit 0 in ${((Date.now() - startedAt) / 1000).toFixed(2)} s`);

  await pollFor(
    () => (!pidAlive(portfile.pid) && !pidAlive(enginePid) ? true : null),
    20_000,
    'the engine processes survived the window close',
  );
  onStep('teardown', `server pid ${portfile.pid} and engine pid ${enginePid} are gone`);

  assertNoResidue(dataDir);
  onStep('residue', 'portfile / instance.lock / stop.request all swept');
}

/**
 * The single-instance delta, as one opt-in check: a second launch must exit 0
 * promptly WITHOUT starting a second server — the tree still holds exactly
 * one node.exe, the portfile still names the same server pid, and that server
 * still answers health.
 */
async function proveSingleInstance({ child, portfile, portfilePath, launch, onStep }) {
  const pidBefore = portfile.pid;
  const startedAt = Date.now();
  const second = launch();
  const secondExit = await pollFor(
    () => (second.exitCode !== null ? second.exitCode : null),
    40_000,
    'the second launch did not exit within 40 s (single-instance is not working)',
  );
  if (secondExit !== 0) throw new Error(`The second launch exited ${secondExit} (expected 0)`);
  const elapsedMs = Date.now() - startedAt;
  const after = await processTree(child.pid);
  const nodeCount = after.filter((proc) => proc.name.toLowerCase() === 'node.exe').length;
  if (nodeCount !== 1) throw new Error(`After the second launch the tree has ${nodeCount} node.exe processes`);
  const portfileAfter = readPortfile(portfilePath);
  if (portfileAfter === null || portfileAfter.pid !== pidBefore) {
    throw new Error(`The second launch disturbed the running server: ${JSON.stringify(portfileAfter)}`);
  }
  const healthAfter = await fetchJson(`${portfile.url.replace(/\/$/, '')}/api/health`);
  if (healthAfter.status !== 200 || healthAfter.body.ok !== true) {
    throw new Error('The running server stopped answering after the second launch');
  }
  onStep('single-instance', `second launch exited 0 after ${(elapsedMs / 1000).toFixed(1)} s, server pid unchanged`);
}

/**
 * The whole narrative in one call: launchTarget -> proveLive -> [optional
 * single-instance probe] -> proveStopped. `stop: null` skips the close (the
 * matrix's violent-death case takes the live proof and does its own thing);
 * `onChild` hands every spawned child (first AND second launch) to the gate
 * BEFORE anything can fail, so the gate's cleanup wiring always knows about
 * it. Returns the live proof's facts ({child, portfile, portfilePath, tree,
 * engineNode}) for the gate's after-close deltas.
 */
export async function bootAndProve({
  exe,
  args = [],
  cwd,
  env,
  packageRoot,
  dataDir,
  label = 'the app',
  expectedVersion = null,
  accept = null,
  singleInstance = false,
  stop = 'window',
  onChild = null,
  onStep = () => {},
  onNote = () => {},
  onOutput = null,
  onExit = null,
}) {
  const launch = () => launchTarget({ exe, args, cwd, env, onOutput, onExit });
  const child = launch();
  if (onChild !== null) onChild(child);
  const live = await proveLive({ child, packageRoot, dataDir, label, expectedVersion, accept, onStep });
  if (singleInstance) {
    await proveSingleInstance({
      child,
      portfile: live.portfile,
      portfilePath: live.portfilePath,
      launch: () => {
        const second = launch();
        if (onChild !== null) onChild(second);
        return second;
      },
      onStep,
    });
  }
  if (stop === 'window') {
    await proveStopped({ child, portfile: live.portfile, dataDir, enginePid: live.engineNode.pid, onStep, onNote });
  }
  return live;
}
