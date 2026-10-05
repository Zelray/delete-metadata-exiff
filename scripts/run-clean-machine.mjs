#!/usr/bin/env node
/**
 * Clean-machine smoke drill + update rehearsal (leaf 2.2.3).
 *
 *   node app/scripts/run-clean-machine.mjs            # clean-machine drill
 *   node app/scripts/run-clean-machine.mjs update     # update rehearsal
 *
 * clean — the packaged app on a machine with NO dev tools:
 *   1. locate the one portable zip under app/dist-desktop/
 *   2. machine-wide node.exe / exiftool.exe pid-SET baseline (quiet-machine wait)
 *   3. extract the zip to a temp dir with Expand-Archive (the extractor a user
 *      runs — same mechanics as verify-package.mjs)
 *   4. prove the sanitized environment really strips the toolchain: where.exe,
 *      run UNDER the sanitized environment, cannot find node / git / cargo / pwsh
 *   5. launch the extracted MetaDesk.exe with PATH stripped to the bare Windows
 *      system set (C:\Windows\system32;C:\Windows;C:\Windows\System32\Wbem —
 *      no node, cargo, git or pwsh reachable) and a temp METADESK_DATA_DIR.
 *      The sanitized environment applies to THE APP CHILD ONLY: every helper
 *      this script spawns (pwsh, tasklist, where) runs in the normal
 *      environment, and is done before or after that child lives.
 *   6. assert: portfile appears -> /api/health ok -> the served page carries
 *      window.__METADESK__ (the "UI bundle missing" status page is a FAILURE),
 *      and the engine node.exe is MetaDesk.exe's DIRECT child running the
 *      SHIPPED server.mjs from inside the extracted folder
 *   7. close the window: exit 0, engine tree gone, data dir swept, and no new
 *      node.exe / exiftool.exe pids against the machine-wide baseline.
 *
 *   Marker (first stdout line, success only): `clean-machine drill passed`
 *
 * update — the documented update story ("download the new zip, extract it over
 * the old folder; your data lives in the data subfolder and survives"):
 *   1. assert the zip ships NO data/ entries at all — the content manifest is
 *      the zip's exact file set (verify-package.mjs proves set equality), so
 *      data\ survives an extract-over by construction
 *   2. extract into dir A (the "old install"), then simulate use: seed
 *      data\journal\batches\<id>.jsonl (a journal record line), a
 *      settings-style JSON file, and the engine-version cache; record sha256
 *   3. simulate the v1.0.1 upgrade: extract the SAME zip over dir A (-Force)
 *   4. assert every seeded data file survived byte-identical
 *   5. boot the upgraded folder the portable way — NO METADESK_DATA_DIR, so the
 *      app uses its own data\ subfolder, exactly like a user's upgraded
 *      install — assert health + injected page, close cleanly, assert the
 *      journal + settings files STILL byte-identical after the run, no residue,
 *      no new pids machine-wide.
 *
 *   Marker (first stdout line, success only): `update rehearsal passed`
 *
 * NEVER run this concurrently with `npm test`, verify-launch.mjs,
 * verify-desktop.mjs, verify-package.mjs or build-portable.mjs: the teardown
 * assertions count node.exe/exiftool.exe MACHINE-WIDE (baseline vs after, pid
 * sets, one settle+retry). The packaged app's window appears on the desktop for
 * a few seconds during either mode; that is expected and not suppressed.
 *
 * Node built-ins only; every child process is an argv-array spawn with
 * shell:false (house rule). Windows-only by design (tasklist / pwsh / where).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(APP_ROOT, 'dist-desktop');
const CLEAN_MODE = 'clean';
const UPDATE_MODE = 'update';

/** The bare Windows system PATH — a machine with no dev tools installed. */
const SANITIZED_PATH = 'C:\\Windows\\system32;C:\\Windows;C:\\Windows\\System32\\Wbem';

/**
 * Non-PATH environment entries a Windows GUI app needs to boot (the same set
 * any double-clicked process gets). Everything else in this shell's
 * environment — every dev-tool path, every tool-specific variable — is NOT
 * carried into the sanitized child.
 */
const KEEP_ENV_KEYS = [
  'ALLUSERSPROFILE',
  'APPDATA',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMPUTERNAME',
  'COMSPEC',
  'DRIVERDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATHEXT',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'SESSIONNAME',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
];

const mode = process.argv[2] ?? CLEAN_MODE;
if (mode !== CLEAN_MODE && mode !== UPDATE_MODE || process.argv.length > 3) {
  process.stdout.write(
    [
      'Usage: node app/scripts/run-clean-machine.mjs [clean|update]',
      '',
      '  clean   extract the portable zip and boot MetaDesk.exe with a PATH',
      '          stripped to the bare Windows system set (no node/cargo/git/pwsh',
      '          reachable): the app must work from the folder alone.',
      '  update  seed a populated install\'s data dir, extract the same zip over',
      '          it (the documented update story), prove the data survived',
      '          byte-identical and the upgraded folder boots healthy.',
      '',
      'Never run this concurrently with npm test, verify-launch.mjs,',
      'verify-desktop.mjs, verify-package.mjs or build-portable.mjs: the orphan',
      'assertions count node.exe/exiftool.exe machine-wide.',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

const OVERALL_TIMEOUT_MS = 15 * 60 * 1000;
const watchdog = setTimeout(() => {
  process.stdout.write(`clean-machine ${mode} FAILED\n\noverall watchdog fired\n`);
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
  process.stderr.write(`[run-clean-machine:${mode}] ${message}\n`);
}

function tailOf(text, count = 40) {
  if (!text || text.trim().length === 0) return '';
  return text.split(/\r?\n/).slice(-count).join('\n');
}

let exitCode = 0;
try {
  if (mode === CLEAN_MODE) await runCleanMachine();
  else await runUpdateRehearsal();
  process.stdout.write(mode === CLEAN_MODE ? 'clean-machine drill passed\n' : 'update rehearsal passed\n');
  for (const s of steps) {
    process.stdout.write(`  ok  ${s.name}${s.detail === '' ? '' : ` - ${s.detail}`}\n`);
  }
} catch (error) {
  exitCode = 1;
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`clean-machine ${mode} FAILED\n\n${message}\n`);
  const extra = diagOf();
  if (extra.trim().length > 0) process.stdout.write(`\n${extra.trim()}\n`);
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
// clean — the sanitized-PATH drill
// ---------------------------------------------------------------------------

async function runCleanMachine() {
  const zipPath = requireZip();
  step('artifacts', path.basename(zipPath));

  await waitForQuietMachine();
  const before = { node: await processPids('node.exe'), exiftool: await processPids('exiftool.exe') };
  step('baselines', `${before.node.size} node.exe, ${before.exiftool.size} exiftool.exe before the run`);

  const extractDir = await extractZip(zipPath);
  const packageRoot = path.join(extractDir, 'MetaDesk'); // the zip carries the MetaDesk/ top folder
  if (!existsSync(packageRoot)) {
    throw new Error(`The zip did not extract to a MetaDesk/ folder: ${extractDir}`);
  }
  step('extract', `${path.basename(zipPath)} -> ${path.relative(APP_ROOT, packageRoot)}`);

  const dataDir = path.join(makeScratch(), 'data');
  const env = sanitizedEnv(dataDir);
  step('environment', `PATH="${env.PATH}"`);

  // The proof that the stripped PATH is real: run where.exe UNDER the sanitized
  // environment and expect it to find nothing. (where.exe itself lives in the
  // system set by absolute path, so it can start — it just finds no tools.)
  for (const tool of ['node', 'git', 'cargo', 'pwsh']) {
    const probe = await runCaptureExit(path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'where.exe'), [tool], {
      env,
      cwd: path.dirname(packageRoot),
    });
    if (probe.code === 0) {
      throw new Error(
        `The sanitized environment can still reach "${tool}" (where.exe found it):\n${tailOf(probe.out, 5)}\n` +
          'The drill would not be testing a clean machine.',
      );
    }
  }
  step('sanitation', 'under the sanitized env, where.exe finds no node / git / cargo / pwsh');

  const portfilePath = path.join(dataDir, 'portfile.json');
  const startedAt = Date.now();
  appChild = spawn(path.join(packageRoot, 'MetaDesk.exe'), [], {
    cwd: packageRoot,
    shell: false,
    windowsHide: false, // the packaged app is a GUI; its window is the point
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  let appOutput = '';
  appChild.stdout.on('data', (chunk) => {
    appOutput += String(chunk);
  });
  appChild.stderr.on('data', (chunk) => {
    appOutput += String(chunk);
  });
  diagOf = () =>
    `--- MetaDesk.exe output (tail) ---\n${tailOf(appOutput)}\n--- sanitized PATH ---\n${env.PATH}`;

  const portfile = await pollFor(
    () => readJsonSafe(portfilePath),
    60_000,
    'the app never wrote a portfile with the sanitized PATH',
    () => (appChild.exitCode !== null ? `MetaDesk.exe exited early with code ${appChild.exitCode}` : null),
  );
  const bootMs = Date.now() - startedAt;
  step('boot', `${portfile.url} (server pid ${portfile.pid}) in ${(bootMs / 1000).toFixed(1)} s`);

  // The engine must be the app's own child running the app's own bundle —
  // nothing about this boot may have been rescued by a PATH-borne tool.
  const tree = await processTree(appChild.pid);
  const engineNode = tree.find(
    (proc) =>
      proc.name.toLowerCase() === 'node.exe' &&
      proc.cmdline &&
      proc.cmdline.toLowerCase().includes('server.mjs') &&
      proc.cmdline.toLowerCase().includes(packageRoot.toLowerCase()),
  );
  if (!engineNode) {
    throw new Error(`MetaDesk.exe has no node.exe child running the shipped server.mjs. Tree: ${JSON.stringify(tree)}`);
  }
  if (engineNode.ppid !== appChild.pid) {
    throw new Error(`The engine node.exe (pid ${engineNode.pid}) is not a DIRECT child of MetaDesk.exe`);
  }
  if (!portfile.engine || path.relative(packageRoot, portfile.engine).startsWith('..')) {
    throw new Error(`The app is not using the engine shipped in its own folder: ${portfile.engine}`);
  }
  step('spawn-tree', `MetaDesk.exe ${appChild.pid} -> node.exe ${engineNode.pid} (shipped server.mjs)`);

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
  if (!html.includes('window.__METADESK__=')) {
    throw new Error('The served page lacks the __METADESK__ boot script');
  }
  if (html.includes('UI bundle is not built yet')) {
    throw new Error('The app served the "UI bundle missing" status page, not the app (FAILURE)');
  }
  step('served-ui', `GET / 200 with boot script + token (${html.length} bytes)`);

  await closeAndAssertTeardown({ portfile, enginePid: engineNode.pid, dataDir });

  await assertNoNewProcesses(before);
  step('no-orphans', 'node + exiftool back to the machine-wide baseline');
}

// ---------------------------------------------------------------------------
// update — extract the new zip over a populated install
// ---------------------------------------------------------------------------

async function runUpdateRehearsal() {
  const zipPath = requireZip();
  step('artifacts', path.basename(zipPath));

  // ---- data\ is not shipped: the manifest is the zip's exact content set -----
  const manifest = readJson(path.join(OUT_DIR, manifestNameFor(zipPath)));
  if (manifest === null) throw new Error(`The content manifest is missing: ${manifestNameFor(zipPath)}`);
  const dataEntries = (manifest.files ?? [])
    .map((row) => String(row.path))
    .filter((zipPathEntry) => zipPathEntry === 'MetaDesk/data' || zipPathEntry.startsWith('MetaDesk/data/'));
  if (dataEntries.length > 0) {
    throw new Error(`The package ships files inside data\\ — the update story would not preserve data:\n  ${dataEntries.join('\n  ')}`);
  }
  step('by-construction', `the manifest (${manifest.files.length} files) carries no data/ entries`);

  await waitForQuietMachine();
  const before = { node: await processPids('node.exe'), exiftool: await processPids('exiftool.exe') };
  step('baselines', `${before.node.size} node.exe, ${before.exiftool.size} exiftool.exe before the run`);

  // ---- the populated "old install" -------------------------------------------
  const scratch = makeScratch();
  const installDir = path.join(scratch, 'install');
  await extractZip(zipPath, installDir);
  const packageRoot = path.join(installDir, 'MetaDesk');
  if (!existsSync(packageRoot)) throw new Error(`The zip did not extract to a MetaDesk/ folder: ${installDir}`);
  const dataDir = path.join(packageRoot, 'data'); // the portable shape's default (config.ts dataDir)
  mkdirSync(path.join(dataDir, 'journal', 'batches'), { recursive: true });

  const seeded = [
    {
      relative: path.join('data', 'journal', 'batches', '20261005T120000-upd00l.jsonl'),
      content:
        '{"type":"batch-start","batchId":"20261005T120000-upd00l","startedAt":"2026-10-05T12:00:00.000Z",' +
        '"kind":"edit","files":["C:\\\\Users\\\\Mike\\\\Pictures\\\\shot_01.jpg"]}\n' +
        '{"type":"result","batchId":"20261005T120000-upd00l","filePath":"C:\\\\Users\\\\Mike\\\\Pictures\\\\shot_01.jpg",' +
        '"outcome":"updated","verified":true}\n',
    },
    {
      relative: path.join('data', 'metadesk-settings.json'),
      content:
        '{"version":1,"lastFolder":"C:\\\\Users\\\\Mike\\\\Pictures","sortField":"name","sortDirection":"asc"}\n',
    },
    {
      relative: path.join('data', 'engine-version.json'),
      content: `${JSON.stringify(
        {
          version: '13.59',
          checkedAt: '2026-10-05T12:00:00.000Z',
          executablePath: path.join(packageRoot, 'vendor', 'exiftool', 'exiftool.exe'),
        },
        null,
        2,
      )}\n`,
    },
  ];
  for (const file of seeded) {
    writeFileSync(path.join(packageRoot, ...file.relative.split(path.sep)), file.content, 'utf8');
  }
  const beforeHashes = new Map(seeded.map((file) => [file.relative, sha256File(path.join(packageRoot, ...file.relative.split(path.sep)))]));
  step('seed', `${seeded.length} data files written into the old install's data\\ (journal, settings, engine cache)`);

  // ---- the upgrade: extract the SAME zip over the folder ----------------------
  await extractZip(zipPath, installDir);
  step('upgrade', `${path.basename(zipPath)} extracted over the existing folder (-Force)`);

  const mismatches = seeded
    .filter((file) => sha256File(path.join(packageRoot, ...file.relative.split(path.sep))) !== beforeHashes.get(file.relative))
    .map((file) => file.relative);
  if (mismatches.length > 0) {
    throw new Error(`Data files did not survive the extract-over upgrade:\n  ${mismatches.join('\n  ')}`);
  }
  step('data-survived', `all ${seeded.length} data files byte-identical after the upgrade`);

  // ---- the upgraded folder boots the portable way -----------------------------
  const portfilePath = path.join(dataDir, 'portfile.json');
  const env = { ...process.env };
  delete env.METADESK_DATA_DIR; // no override: the app must use its own data\ subfolder
  appChild = spawn(path.join(packageRoot, 'MetaDesk.exe'), [], {
    cwd: packageRoot,
    shell: false,
    windowsHide: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  let appOutput = '';
  appChild.stdout.on('data', (chunk) => {
    appOutput += String(chunk);
  });
  appChild.stderr.on('data', (chunk) => {
    appOutput += String(chunk);
  });
  diagOf = () => `--- MetaDesk.exe output (tail) ---\n${tailOf(appOutput)}`;

  const portfile = await pollFor(
    () => readJsonSafe(portfilePath),
    60_000,
    'the upgraded app never wrote a portfile',
    () => (appChild.exitCode !== null ? `MetaDesk.exe exited early with code ${appChild.exitCode}` : null),
  );
  step('boot', `${portfile.url} (server pid ${portfile.pid}, data dir = the folder's own data\\)`);

  if (!portfile.engine || path.relative(packageRoot, portfile.engine).startsWith('..')) {
    throw new Error(`The upgraded app is not using the engine shipped in its own folder: ${portfile.engine}`);
  }
  const tree = await processTree(appChild.pid);
  const engineNode = tree.find(
    (proc) =>
      proc.name.toLowerCase() === 'node.exe' &&
      proc.cmdline &&
      proc.cmdline.toLowerCase().includes('server.mjs') &&
      proc.cmdline.toLowerCase().includes(packageRoot.toLowerCase()),
  );
  if (!engineNode) {
    throw new Error(`The upgraded app has no node.exe child running the shipped server.mjs. Tree: ${JSON.stringify(tree)}`);
  }

  const health = await fetchJson(`${portfile.url.replace(/\/$/, '')}/api/health`);
  if (health.status !== 200 || health.body.ok !== true) {
    throw new Error(`GET /api/health -> ${health.status} ${JSON.stringify(health.body).slice(0, 300)}`);
  }
  const page = await fetch(portfile.url);
  const html = await page.text();
  if (page.status !== 200 || !html.includes('window.__METADESK__=')) {
    throw new Error(`The upgraded app did not serve the app page (GET / -> ${page.status})`);
  }
  step('health', `engine ${health.body.version}, served page carries the boot script (${html.length} bytes)`);

  await closeAndAssertTeardown({ portfile, enginePid: engineNode.pid, dataDir });

  // The run itself must not have touched the user's files. engine-version.json
  // is the server's own cache and is expected to be refreshed at boot; the
  // journal and the settings-style file are the user's.
  const userFiles = seeded.filter((file) => !file.relative.endsWith('engine-version.json'));
  const clobbered = userFiles
    .filter((file) => sha256File(path.join(packageRoot, ...file.relative.split(path.sep))) !== beforeHashes.get(file.relative))
    .map((file) => file.relative);
  if (clobbered.length > 0) {
    throw new Error(`The app rewrote user data files during the run:\n  ${clobbered.join('\n  ')}`);
  }
  step('data-intact', 'journal + settings still byte-identical after a full boot/close cycle');

  await assertNoNewProcesses(before);
  step('no-orphans', 'node + exiftool back to the machine-wide baseline');
}

// ---------------------------------------------------------------------------
// shared: close the window, prove the tree is gone and the data dir is swept
// ---------------------------------------------------------------------------

async function closeAndAssertTeardown({ portfile, enginePid, dataDir }) {
  const closed = await closeMainWindow(appChild.pid);
  if (!closed) throw new Error('Could not find the MetaDesk main window to close (WM_CLOSE)');
  const startedAt = Date.now();
  const exitCodeSeen = await pollFor(
    () => (appChild.exitCode !== null ? appChild.exitCode : null),
    40_000,
    'MetaDesk.exe did not exit within 40 s of WM_CLOSE',
  );
  if (exitCodeSeen !== 0) throw new Error(`MetaDesk.exe exited ${exitCodeSeen} on WM_CLOSE (expected 0)`);
  step('close', `WM_CLOSE -> exit 0 in ${((Date.now() - startedAt) / 1000).toFixed(2)} s`);

  await pollFor(
    () => (!pidAlive(portfile.pid) && !pidAlive(enginePid) ? true : null),
    20_000,
    'the engine processes survived the window close',
  );
  step('teardown', `server pid ${portfile.pid} and engine pid ${enginePid} are gone`);

  const residue = ['portfile.json', 'instance.lock', 'stop.request']
    .map((name) => path.join(dataDir, name))
    .filter(existsSync);
  if (residue.length > 0) {
    throw new Error(`Residue left in the data dir: ${residue.map((p) => path.basename(p)).join(', ')}`);
  }
  step('residue', 'portfile / instance.lock / stop.request all swept');
  appChild = null;
}

// ---------------------------------------------------------------------------
// environment sanitation
// ---------------------------------------------------------------------------

/** A minimal Windows environment: the OS basics + the bare system PATH. */
function sanitizedEnv(dataDir) {
  const available = new Map(
    Object.keys(process.env)
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key.toUpperCase(), key]),
  );
  const env = {};
  for (const key of KEEP_ENV_KEYS) {
    const actual = available.get(key);
    if (actual !== undefined) env[actual] = process.env[actual];
  }
  env.PATH = SANITIZED_PATH;
  env.METADESK_DATA_DIR = dataDir;
  return env;
}

// ---------------------------------------------------------------------------
// zip + manifest helpers
// ---------------------------------------------------------------------------

function requireZip() {
  const zips = readdirSync(OUT_DIR)
    .filter((name) => /^metadesk-\d+\.\d+\.\d+-portable-win-x64\.zip$/.test(name))
    .sort();
  if (zips.length !== 1) {
    throw new Error(
      `Expected exactly one portable zip under ${path.relative(APP_ROOT, OUT_DIR)}, found: ${zips.join(', ') || '(none)'}. Run build-portable.mjs --all first.`,
    );
  }
  return path.join(OUT_DIR, zips[0]);
}

function manifestNameFor(zipPath) {
  return `portable-manifest-${versionOf(zipPath)}.json`;
}

function versionOf(zipPath) {
  const match = path.basename(zipPath).match(/^metadesk-(\d+\.\d+\.\d+)-portable-win-x64\.zip$/);
  if (match === null) throw new Error(`Unreadable zip name: ${path.basename(zipPath)}`);
  return match[1];
}

/** Expand-Archive into `<dest>/` (the zip carries the MetaDesk/ top folder). */
async function extractZip(zipPath, dest = path.join(makeScratch(), 'extracted')) {
  await runPowerShell(
    `Expand-Archive -LiteralPath '${pwsq(zipPath)}' -DestinationPath '${pwsq(dest)}' -Force; Write-Output EXTRACT-OK`,
    'extract',
  );
  return dest;
}

// ---------------------------------------------------------------------------
// machine-wide process accounting (mirrors verify-package.mjs, pid-set based)
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
  // Control characters in some process's command line are NOT escaped by
  // ConvertTo-Json and are illegal inside a JSON string literal (verify-desktop
  // lesson): flatten them in PowerShell AND on the decoded text here.
  const json = (
    await runPowerShell(
      `
    Get-CimInstance Win32_Process | ForEach-Object {
      [pscustomobject]@{
        ProcessId       = $_.ProcessId
        ParentProcessId = $_.ParentProcessId
        Name            = $_.Name
        CommandLine     = if ($null -eq $_.CommandLine) { $null } else { $_.CommandLine -replace '[\\x00-\\x1F]', ' ' }
      }
    } |
      ConvertTo-Json -Compress -Depth 2
  `,
      'list-processes',
    )
  ).replace(/[\u0000-\u001F]/g, ' ');
  const parsed = JSON.parse(json || '[]');
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => ({
    pid: Number(row.ProcessId),
    ppid: Number(row.ParentProcessId),
    name: String(row.Name ?? ''),
    cmdline: String(row.CommandLine ?? ''),
  }));
}

/** PostMessage(hwnd, WM_CLOSE) to OUR pid's main window (name-based fallback). */
async function closeMainWindow(pid) {
  const out = await runPowerShell(
    `
    Add-Type -Namespace MetaDeskClean -Name Native -MemberDefinition '
      [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    '
    $window = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 } |
      Select-Object -First 1
    if ($null -eq $window) {
      $window = Get-Process -Name MetaDesk -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } |
        Select-Object -First 1
    }
    if ($null -eq $window) { Write-Output 'NOWINDOW' }
    else {
      [MetaDeskClean.Native]::PostMessage($window.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
      Write-Output ('CLOSED ' + $window.Id)
    }
  `,
    'close-window',
  );
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
      /vitest|npm test|npm run test|verify-launch|verify-desktop|verify-package|build-portable|run-clean-machine/i.test(
        proc.cmdline,
      ),
  );
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function pwsq(text) {
  return String(text).replace(/'/g, "''");
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

/** runCapture with an explicit exit code + environment + cwd (where.exe). */
function runCaptureExit(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
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

/** argv-array spawn of pwsh with a readable (non-base64) script argument. */
function runPowerShell(script, label) {
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
      reject(new Error(`pwsh (${label}) exited ${code}: ${tailOf(err, 10)}`));
    });
  });
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

function readJson(filePath) {
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
  const dir = mkdtempSync(path.join(tmpdir(), `metadesk-clean-machine-${mode}-`));
  scratchDirs.push(dir);
  return dir;
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
