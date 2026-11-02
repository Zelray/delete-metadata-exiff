/**
 * The one Node-side portfile reader (issue #17, arch-review Candidate 4):
 * field rules and the tsx-hop pid caveat as behaviour, not per-script
 * comments. Runs under quality/gates.mjs's framework-test lane.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readPortfile, pollPortfile } from '../scripts/lib/portfile.mjs';

const VALID = {
  port: 8765,
  token: 'tok-abc123',
  pid: 4242,
  startedAt: '2026-11-02T21:00:00.000Z',
  engine: '13.59',
  url: 'http://127.0.0.1:8765',
};

const dir = mkdtempSync(path.join(tmpdir(), 'metadesk-portfile-'));
const filePath = path.join(dir, 'portfile.json');
const write = (body) => writeFileSync(filePath, typeof body === 'string' ? body : JSON.stringify(body));

test.after(() => rmSync(dir, { recursive: true, force: true }));

test('readPortfile accepts the server payload and preserves extra fields', () => {
  write(VALID);
  const parsed = readPortfile(filePath);
  assert.equal(parsed.port, 8765);
  assert.equal(parsed.token, 'tok-abc123');
  assert.equal(parsed.pid, 4242);
  assert.equal(parsed.url, 'http://127.0.0.1:8765');
  assert.equal(parsed.engine, '13.59'); // informational fields ride along
});

test('readPortfile refuses missing, malformed, and non-object files', () => {
  assert.equal(readPortfile(path.join(dir, 'nope.json')), null);
  write('{not json');
  assert.equal(readPortfile(filePath), null);
  write('"just a string"');
  assert.equal(readPortfile(filePath), null);
  write('null');
  assert.equal(readPortfile(filePath), null);
});

test('readPortfile field rules: port/token/pid/url must be real', () => {
  for (const [label, patch] of [
    ['port zero', { port: 0 }],
    ['port non-integer', { port: 8765.5 }],
    ['port missing', { port: undefined }],
    ['token empty', { token: '' }],
    ['token non-string', { token: 42 }],
    ['pid zero', { pid: 0 }],
    ['pid non-integer', { pid: -1 }],
    ['url empty', { url: '' }],
    ['url missing', { url: undefined }],
  ]) {
    write({ ...VALID, ...patch });
    assert.equal(readPortfile(filePath), null, `must refuse: ${label}`);
  }
});

test('pollPortfile resolves the first valid portfile', async () => {
  write(VALID);
  const parsed = await pollPortfile(filePath, { timeoutMs: 2_000, intervalMs: 10 });
  assert.equal(parsed.port, 8765);
});

test('pollPortfile keeps polling until the file becomes valid, then resolves', async () => {
  rmSync(filePath, { force: true });
  write('{not json');
  const late = setTimeout(() => write(VALID), 120);
  try {
    const parsed = await pollPortfile(filePath, { timeoutMs: 5_000, intervalMs: 25 });
    assert.equal(parsed.token, 'tok-abc123');
  } finally {
    clearTimeout(late);
  }
});

test('pollPortfile returns null on a quiet timeout', async () => {
  rmSync(filePath, { force: true });
  const startedAt = Date.now();
  const parsed = await pollPortfile(filePath, { timeoutMs: 150, intervalMs: 25 });
  assert.equal(parsed, null);
  assert.ok(Date.now() - startedAt < 5_000);
});

test('pollPortfile aborts immediately with the abort reason (child exited)', async () => {
  rmSync(filePath, { force: true });
  await assert.rejects(
    pollPortfile(filePath, { timeoutMs: 30_000, intervalMs: 25, abort: () => 'Launcher exited during startup' }),
    /Launcher exited during startup/,
  );
});

test('pollPortfile honours an accept filter (a stale seeded portfile is skipped)', async () => {
  // Case 3 of verify-desktop seeds a stale portfile first; the boot must
  // keep polling until one the filter accepts appears.
  write({ ...VALID, token: 'stale-seed' });
  const late = setTimeout(() => write(VALID), 120);
  try {
    const parsed = await pollPortfile(filePath, {
      timeoutMs: 5_000,
      intervalMs: 25,
      accept: (candidate) => candidate.token !== 'stale-seed',
    });
    assert.equal(parsed.token, 'tok-abc123');
  } finally {
    clearTimeout(late);
  }
});
