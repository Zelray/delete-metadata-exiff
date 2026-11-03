/**
 * The one boot-and-prove kit (issue #19, arch-review Candidate 6): the
 * "boot the shipped app and prove the lifecycle contract" narrative that
 * used to live as four ~120-line hand-mirrored stories in the heavyweight
 * gates. Behaviour tests against REAL Windows, kept light — no app boot
 * here; the heavyweight gates themselves are the end-to-end proof.
 * Runs under quality/gates.mjs's framework-test lane.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { processTree } from '../scripts/lib/processes.mjs';
import {
  assertNoResidue,
  engineNodeOf,
  fetchJson,
  pidAlive,
  pollFor,
  servedVersionOf,
} from '../scripts/lib/bootAndProve.mjs';

const MODULE_SOURCE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'lib', 'bootAndProve.mjs'),
  'utf8',
);

/** Spawn a node child that stays alive with `marker` visible in its command line. */
function spawnMarkedChild(marker) {
  return spawn(process.execPath, ['-e', `setTimeout(() => {}, 15000) /* ${marker} */`], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

/** A pid guaranteed dead when this resolves (spawn cmd, let it exit). */
async function spawnAndExitPid() {
  return new Promise((resolve, reject) => {
    const corpse = spawn('cmd.exe', ['/d', '/c', 'exit', '0'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    corpse.on('error', reject);
    corpse.on('exit', () => resolve(corpse.pid));
  });
}

test('engineNodeOf finds a spawned node.exe running a temp server.mjs', async () => {
  const packageRoot = mkdtempSync(path.join(tmpdir(), 'bootprove-engine-'));
  try {
    const scriptPath = path.join(packageRoot, 'server.mjs');
    writeFileSync(scriptPath, 'setTimeout(() => {}, 15000);\n', 'utf8');
    const child = spawn(process.execPath, [scriptPath], { stdio: 'ignore', windowsHide: true });
    try {
      let tree = [];
      for (let attempt = 0; attempt < 20; attempt += 1) {
        tree = await processTreeOfSelf();
        if (tree.some((proc) => proc.pid === child.pid)) break;
        await sleep(250);
      }
      const engine = engineNodeOf(packageRoot, tree);
      assert.ok(engine !== undefined, 'the node.exe running our temp server.mjs must be found in the tree');
      assert.equal(engine.pid, child.pid);
      assert.equal(engine.ppid, process.pid, 'the engine row carries its real parent pid');
    } finally {
      child.kill();
    }
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
  }
});

test('engineNodeOf returns undefined for a tree with no shipped-server node', async () => {
  const packageRoot = mkdtempSync(path.join(tmpdir(), 'bootprove-nomatch-'));
  try {
    const child = spawnMarkedChild('not-a-server');
    try {
      let tree = [];
      for (let attempt = 0; attempt < 20; attempt += 1) {
        tree = await processTreeOfSelf();
        if (tree.some((proc) => proc.pid === child.pid)) break;
        await sleep(250);
      }
      assert.equal(engineNodeOf(packageRoot, tree), undefined);
    } finally {
      child.kill();
    }
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
  }
});

test('pidAlive tells our own pid from a guaranteed-dead one', async () => {
  assert.equal(pidAlive(process.pid), true, 'our own pid is alive');
  const deadPid = await spawnAndExitPid();
  let dead = false;
  for (let attempt = 0; attempt < 10 && !dead; attempt += 1) {
    await sleep(250);
    dead = !pidAlive(deadPid);
  }
  assert.equal(dead, true, `the corpse pid ${deadPid} must read as dead`);
});

test('assertNoResidue passes a swept dir and names whatever survived', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'bootprove-residue-'));
  try {
    assertNoResidue(dataDir); // empty dir: nothing swept yet, nothing left behind
    writeFileSync(path.join(dataDir, 'portfile.json'), '{}', 'utf8');
    assert.throws(() => assertNoResidue(dataDir), /portfile\.json/);
    writeFileSync(path.join(dataDir, 'instance.lock'), 'x', 'utf8');
    assert.throws(() => assertNoResidue(dataDir), /instance\.lock/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('pollFor resolves the produced value, times out with its message, honors the extra failure', async () => {
  assert.equal(await pollFor(() => 'ready', 2_000, 'never thrown'), 'ready');
  await assert.rejects(
    () => pollFor(() => null, 150, 'the thing never happened'),
    /the thing never happened/,
  );
  await assert.rejects(
    () => pollFor(() => null, 5_000, 'never reached', () => 'a better cause appeared'),
    /never reached \(a better cause appeared\)/,
  );
});

test('fetchJson answers from a real loopback server and reports a refused one as status 0', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, version: '13.59' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const good = await fetchJson(`http://127.0.0.1:${port}/api/health`);
    assert.equal(good.status, 200);
    assert.equal(good.body.ok, true);
    assert.equal(good.body.version, '13.59');

    // Port 1 on loopback: nothing listens there (reserved; bind would need
    // privileges), so the fetch refuses and the helper must NOT throw — the
    // gates branch on status 0.
    const dead = await fetchJson('http://127.0.0.1:1/api/health');
    assert.equal(dead.status, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('servedVersionOf reads the version the page announces to the UI', () => {
  const page =
    '<html><script>window.__METADESK__={"token":"secret","version":"1.2.3","readOnlyDefault":true}</script></html>';
  assert.equal(servedVersionOf(page), '1.2.3');
  assert.equal(servedVersionOf('<html>no boot script here</html>'), undefined);
});

test('the kit has NO kill path — the product\'s own stop channels only', () => {
  // The review's hard constraint: the routine tears down through the
  // product's own channel (WM_CLOSE via the C5 kit). The one allowed
  // kill-shaped call is the signal-0 LIVENESS PROBE in pidAlive (asking a
  // pid "are you there?" — not a kill); anything else (.kill on a child,
  // taskkill) must stay out of the kit's executable code. Comments are
  // stripped first so this prose can name the contract without tripping it.
  const code = MODULE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const killUses = [...code.matchAll(/[\w.$]*\.kill\s*\([^)]*\)/g)].map((match) => match[0]);
  assert.deepEqual(
    killUses,
    ['process.kill(pid, 0)'],
    'the only kill-shaped call in the kit is the signal-0 liveness probe',
  );
  assert.doesNotMatch(code, /taskkill/i);
  assert.match(MODULE_SOURCE, /closeMainWindow/, 'teardown goes through the C5 closeMainWindow');
});

// -- local --------------------------------------------------------------------

/** processTree rooted at the test process itself. */
async function processTreeOfSelf() {
  return processTree(process.pid);
}
