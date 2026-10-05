/**
 * Single-writer lock: in-process mutual exclusion, cross-process lockfile
 * with live-pid refusal and stale takeover, and the foreign *_exiftool_tmp
 * refusal that guards against writing into a folder with interrupted
 * transaction debris.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findForeignTempFiles, isPidAlive, WriteLock } from '../../src/services/lock.js';

let root: string;
let lockDir: string;
let picsDir: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'metadesk-lock-'));
  lockDir = path.join(root, 'journal');
  picsDir = path.join(root, 'pics');
  await mkdir(lockDir, { recursive: true });
  await mkdir(picsDir, { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

describe('in-process mutual exclusion', () => {
  it('allows one batch and refuses a second until release', async () => {
    const lock = new WriteLock({ lockDir });
    const handle = await lock.acquire([picsDir], 'batch-1');
    expect(lock.held).toBe(true);
    expect(lock.heldByBatch).toBe('batch-1');

    await expect(lock.acquire([picsDir], 'batch-2')).rejects.toMatchObject({
      name: 'WriteLockError',
      code: 'batch-in-progress',
    });

    await handle.release();
    expect(lock.held).toBe(false);
    const again = await lock.acquire([picsDir], 'batch-3');
    await again.release();
  });

  it('refuses across two lock instances keyed to the same lock dir', async () => {
    const lockA = new WriteLock({ lockDir });
    const lockB = new WriteLock({ lockDir });
    const handle = await lockA.acquire([picsDir], 'batch-a');
    await expect(lockB.acquire([picsDir], 'batch-b')).rejects.toMatchObject({
      code: 'batch-in-progress',
    });
    await handle.release();
  });
});

describe('cross-process lockfile', () => {
  it('refuses while a foreign live pid holds the lockfile, takes over a stale one', async () => {
    // A live process that is not this test: a short-lived node child.
    const foreign = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], {
      windowsHide: true,
      shell: false,
      stdio: 'ignore',
    });
    try {
      const lock = new WriteLock({ lockDir });
      await writeFile(
        path.join(lockDir, 'writer.lock'),
        JSON.stringify({ pid: foreign.pid, batchId: 'ghost', folders: [], acquiredAt: new Date().toISOString() }),
        'utf8',
      );
      await expect(lock.acquire([picsDir], 'batch-x')).rejects.toMatchObject({
        code: 'another-writer-process',
      });

      // Stale: dead pid (negative numbers never exist) -> takeover allowed.
      await writeFile(
        path.join(lockDir, 'writer.lock'),
        JSON.stringify({ pid: -7, batchId: 'dead', folders: [], acquiredAt: new Date().toISOString() }),
        'utf8',
      );
      const handle = await lock.acquire([picsDir], 'batch-takeover');
      const raw = JSON.parse(await readFile(path.join(lockDir, 'writer.lock'), 'utf8')) as {
        pid: number;
        batchId: string;
      };
      expect(raw.pid).toBe(process.pid);
      expect(raw.batchId).toBe('batch-takeover');
      await handle.release();
      await expect(readFile(path.join(lockDir, 'writer.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      foreign.kill('SIGKILL');
    }
  });

  it('isPidAlive rejects nonsense pids and accepts the current process', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(process.pid)).toBe(true);
  });
});

describe('foreign temp files', () => {
  it('finds *_exiftool_tmp debris in the target folder', async () => {
    await writeFile(path.join(picsDir, 'photo.png_exiftool_tmp'), 'junk');
    await writeFile(path.join(picsDir, 'photo2.png'), 'x');
    const found = await findForeignTempFiles([picsDir]);
    expect(found).toEqual([path.join(picsDir, 'photo.png_exiftool_tmp')]);
  });

  it('acquire refuses while foreign temp files exist, and succeeds after cleanup', async () => {
    const lock = new WriteLock({ lockDir });
    await expect(lock.acquire([picsDir], 'batch-y')).rejects.toMatchObject({
      code: 'foreign-temp-files',
    });
    await rm(path.join(picsDir, 'photo.png_exiftool_tmp'), { force: true });
    const handle = await lock.acquire([picsDir], 'batch-y');
    await handle.release();
  });
});
