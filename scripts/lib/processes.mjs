/**
 * The ONE machine-wide process-accounting + window-teardown kit for the
 * heavyweight gates (issue #18, arch-review Candidate 5). Before this module,
 * ~250 lines lived as three hand-mirrored copies in verify-desktop,
 * verify-package, and run-clean-machine, and the copies had already drifted:
 * each gate's busy-job list knew only SOME of its sibling gates, so the
 * gates' own never-run-concurrently rule (MD19) did not hold between them,
 * and verify-desktop closed ANY window named MetaDesk instead of its own
 * instance's window. The fixes travel once, here.
 *
 * Node builtins only (project rule MD6). READ-ONLY over the machine:
 * enumeration and WM_CLOSE only — never a kill path (teardown belongs to the
 * product's own stop channels; the gates observe, they do not execute).
 *
 * Notes mid-flight (chatter like "waiting for a quiet machine") go through
 * the `onNote` callback option so each gate keeps its own output format.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

/**
 * The ONE canonical busy-sibling pattern: node-heavy jobs whose presence
 * makes machine-wide counts flaky. The union of every gate's own list — this
 * is the fix for the drift where verify-desktop would not wait out a running
 * verify-package or run-clean-machine (and vice versa). A NEW gate adds its
 * marker HERE, not in its own copy.
 */
export const SIBLING_JOB_PATTERN = 'vitest|npm test|npm run test|verify-launch|verify-desktop|verify-package|build-portable|run-clean-machine';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** All pids for one image name, machine-wide (tasklist). */
export async function processPids(imageName) {
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
export async function processTree(rootPid) {
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

export async function listProcesses() {
  // Control characters in some process's command line (seen live: a raw
  // U+001A in an unrelated agent's command line) are NOT escaped by
  // ConvertTo-Json and are illegal inside a JSON string literal, so the whole
  // listing fails to parse. The gates only match names and ASCII substrings,
  // so flatten them — belt and braces: once in PowerShell (the common case,
  // keeps the payload honest) and once here on the decoded text
  // (deterministic, catches whatever transient encoding artifact a machine
  // can produce). (`\\x00` in JS -> `\x00` in PowerShell: a regex class.)
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

export async function listeningSockets() {
  const json = await runPowerShell(
    `
    Get-NetTCPConnection -State Listen |
      Select-Object LocalAddress, LocalPort, OwningProcess |
      ConvertTo-Json -Compress -Depth 2
  `,
    'listening-sockets',
  );
  const parsed = JSON.parse(json || '[]');
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => ({
    address: String(row.LocalAddress ?? ''),
    port: Number(row.LocalPort ?? 0),
    pid: Number(row.OwningProcess ?? 0),
  }));
}

/**
 * PostMessage(hwnd, WM_CLOSE) to OUR pid's main window, falling back to any
 * window named MetaDesk (the product's own close channel — never a kill).
 * The pid-first order is deliberate: with a second instance briefly alive
 * (the single-instance cases), a name-only close could hit the wrong one.
 * Resolves true when a window received the close; `onNote` carries the
 * raw NOWINDOW/CLOSED line for the gate's chatter.
 */
export async function closeMainWindow(pid, { onNote = null } = {}) {
  const out = await runPowerShell(
    `
    Add-Type -Namespace MetaDeskKit -Name Native -MemberDefinition '
      [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    '
    $window = $null
    if (${Number(pid)} -gt 0) {
      $window = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } |
        Select-Object -First 1
    }
    if ($null -eq $window) {
      $window = Get-Process -Name MetaDesk -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } |
        Select-Object -First 1
    }
    if ($null -eq $window) { Write-Output 'NOWINDOW' }
    else {
      [MetaDeskKit.Native]::PostMessage($window.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
      Write-Output ('CLOSED ' + $window.Id)
    }
  `,
    'close-window',
  );
  if (onNote !== null) onNote(`closeMainWindow: ${out.trim()}`);
  return out.includes('CLOSED');
}

/**
 * The orphan gate: no NEW node.exe / exiftool.exe pids beyond the baseline,
 * retried once after a settle window, naming whatever survived.
 */
export async function assertNoNewProcesses(before, { onNote = null } = {}) {
  const attempt = async () => ({
    node: await processPids('node.exe'),
    exiftool: await processPids('exiftool.exe'),
  });

  let now = await attempt();
  if (newPids(before, now) === null) return;

  if (onNote !== null) onNote('process churn detected; settling 10 s and recounting once');
  await sleep(10_000);
  now = await attempt();
  const newOnes = newPids(before, now);
  if (newOnes === null) return;

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

/**
 * Refuse to start counting while another node-heavy sibling job runs (see
 * SIBLING_JOB_PATTERN — the ONE list every gate shares). Waits up to a
 * minute, then warns rather than fails: the counts being flaky is a
 * diagnostic, not a gate verdict.
 */
export async function waitForQuietMachine({ onNote = null } = {}) {
  const deadline = Date.now() + 60_000;
  let busy = await busyProcesses();
  while (busy.length > 0 && Date.now() < deadline) {
    if (onNote !== null) onNote(`waiting for a quiet machine (other node jobs running: ${busy.length})`);
    await sleep(5_000);
    busy = await busyProcesses();
  }
  if (busy.length > 0 && onNote !== null) {
    onNote('WARNING: other node jobs are still running; the machine-wide counts may be flaky');
  }
}

/** node.exe processes running a SIBLING gate job (never this process). */
export async function busyProcesses() {
  const processes = await listProcesses();
  return processes.filter(
    (proc) =>
      proc.name.toLowerCase() === 'node.exe' &&
      proc.pid !== process.pid &&
      new RegExp(SIBLING_JOB_PATTERN, 'i').test(proc.cmdline),
  );
}

/** Double single quotes for safe single-quoted PowerShell literals. */
export function pwsq(text) {
  return String(text).replace(/'/g, "''");
}

export function runCapture(file, args) {
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
export function runPowerShell(script, label = 'pwsh') {
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
      reject(new Error(`pwsh (${label}) exited ${code}: ${err.split(/\r?\n/).filter((l) => l.trim().length > 0).slice(-10).join('\n')}`));
    });
  });
}
