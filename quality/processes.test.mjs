/**
 * The one process-accounting kit (issue #18, arch-review Candidate 5):
 * machine-wide enumeration, the canonical sibling-job list, and the
 * PowerShell runner — behaviour tests against REAL Windows, kept light.
 * Runs under quality/gates.mjs's framework-test lane.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { processPids, processTree, listProcesses, busyProcesses, pwsq } from '../scripts/lib/processes.mjs';

test('processPids finds our own node.exe machine-wide', async () => {
  const pids = await processPids('node.exe');
  assert.ok(pids instanceof Set);
  assert.ok(pids.has(process.pid), 'our own pid must be in the machine-wide node.exe set');
});

test('processPids returns an empty set for an image that does not exist', async () => {
  const pids = await processPids('metadesk-no-such-image.exe');
  assert.ok(pids instanceof Set);
  assert.equal(pids.size, 0);
});

test('processTree below our pid finds a spawned child', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    // Give Windows a beat to register the child under our pid.
    let tree = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      tree = await processTree(process.pid);
      if (tree.some((proc) => proc.pid === child.pid)) break;
      await sleep(250);
    }
    assert.ok(
      tree.some((proc) => proc.pid === child.pid),
      `the spawned child pid ${child.pid} must appear in our tree (got ${tree.length} rows)`,
    );
    for (const proc of tree) {
      assert.equal(typeof proc.pid, 'number');
      assert.equal(typeof proc.ppid, 'number');
      assert.equal(typeof proc.name, 'string');
      assert.equal(typeof proc.cmdline, 'string');
    }
  } finally {
    child.kill();
  }
});

test('listProcesses reports the machine in the kit row shape', async () => {
  const rows = await listProcesses();
  assert.ok(Array.isArray(rows) && rows.length > 10, 'a real machine has processes');
  const self = rows.find((row) => row.pid === process.pid);
  assert.ok(self !== undefined, 'our own process must be listed');
  assert.match(self.name, /node/i);
});

test('the CANONICAL sibling list catches a verify-package-marked node (the live bug)', async () => {
  // The old verify-desktop copy knew only verify-launch|verify-desktop, so a
  // running verify-package or run-clean-machine was invisible to it. The one
  // canonical list must catch every sibling job's marker.
  const child = spawn(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 15000) /* verify-package gate job marker */'],
    { stdio: 'ignore', windowsHide: true },
  );
  try {
    let busy = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      busy = await busyProcesses();
      if (busy.some((proc) => proc.pid === child.pid)) break;
      await sleep(250);
    }
    assert.ok(
      busy.some((proc) => proc.pid === child.pid),
      'a node process with a verify-package marker in its command line must count as a busy sibling job',
    );
    assert.ok(
      busy.every((proc) => proc.pid !== process.pid),
      'busyProcesses must never report the caller itself',
    );
  } finally {
    child.kill();
  }
});

test('pwsq doubles single quotes for safe single-quoted PowerShell literals', () => {
  assert.equal(pwsq("it's"), "it''s");
  assert.equal(pwsq('plain'), 'plain');
});
