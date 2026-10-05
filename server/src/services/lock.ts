/**
 * Single-writer lock (data-safety requirement #10).
 *
 * Two layers, both required before a batch may run:
 *
 *  1. In-process mutex keyed by the lock directory: a second concurrent batch
 *     inside this server process is refused (never run parallel write batches).
 *  2. A cross-process lockfile (`writer.lock` in the journal dir) recording
 *     the owning pid: a SECOND server instance pointed at the same data dir is
 *     refused while that pid is alive. A stale lock (dead pid, e.g. after a
 *     power loss) is taken over automatically — the recovery scanner is the
 *     tool that cleans up after a crash, not a permanent lock.
 *
 * Additionally, `acquire` refuses to run when a foreign `*_exiftool_tmp` file
 * exists in any target folder: a leftover temp means a previous writer died
 * mid-transaction, and every future write to those photos would fail with
 * "Temporary file already exists" until a human confirms cleanup (recovery.ts).
 */
import { mkdir, readdir, readFile, stat, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

export type LockRejection =
  | 'batch-in-progress'
  | 'another-writer-process'
  | 'foreign-temp-files';

export class WriteLockError extends Error {
  readonly code: LockRejection;
  /** Human-readable detail: the competing batch, pid, or temp files. */
  readonly detail: Record<string, unknown>;

  constructor(code: LockRejection, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'WriteLockError';
    this.code = code;
    this.detail = detail;
  }
}

export interface LockHandle {
  readonly batchId: string;
  readonly folders: string[];
  release(): Promise<void>;
}

export interface WriteLockOptions {
  /** The journal directory; the cross-process lockfile lives here. */
  lockDir: string;
}

interface LockfilePayload {
  pid: number;
  batchId: string;
  folders: string[];
  acquiredAt: string;
}

const LOCKFILE_NAME = 'writer.lock';
/** In-process locks, keyed by resolved lock dir so parallel instances of this
 *  class still see each other. */
const activeLocks = new Map<string, string>();

/** True when the given pid exists (signal 0 = existence probe). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM'; // exists but not ours to signal
  }
}

/** Names ending in the engine's transaction-temp suffix, sorted for stable UIs. */
export async function findForeignTempFiles(folders: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const folder of folders) {
    let entries: string[];
    try {
      entries = await readdir(folder);
    } catch {
      continue; // unreadable folder surfaces later as a per-file failure
    }
    for (const name of entries) {
      if (/_exiftool_tmp$/.test(name)) found.push(path.join(folder, name));
    }
  }
  return found.sort();
}

export class WriteLock {
  private readonly lockFilePath: string;

  constructor(options: WriteLockOptions) {
    const lockDir = path.resolve(options.lockDir);
    this.lockFilePath = path.join(lockDir, LOCKFILE_NAME);
  }

  get held(): boolean {
    return activeLocks.has(path.dirname(this.lockFilePath));
  }

  get heldByBatch(): string | null {
    return activeLocks.get(path.dirname(this.lockFilePath)) ?? null;
  }

  /**
   * Acquire the lock for one batch over the given target folders. Throws
   * {@link WriteLockError} with a machine code when refused.
   */
  async acquire(folders: readonly string[], batchId: string): Promise<LockHandle> {
    const key = path.dirname(this.lockFilePath);
    if (activeLocks.has(key)) {
      throw new WriteLockError(
        'batch-in-progress',
        'Another write batch is already running. Wait for it to finish before starting a new one.',
        { batchId: activeLocks.get(key) },
      );
    }

    const foreignTmp = await findForeignTempFiles(folders);
    if (foreignTmp.length > 0) {
      throw new WriteLockError(
        'foreign-temp-files',
        'Found leftover temporary files from an interrupted write. Run the recovery scan and confirm cleanup before writing to these folders.',
        { files: foreignTmp.slice(0, 20), count: foreignTmp.length },
      );
    }

    const existing = await this.readLockfile();
    if (existing !== null && existing.pid !== process.pid && isPidAlive(existing.pid)) {
      throw new WriteLockError(
        'another-writer-process',
        'Another MetaDesk writer process holds the write lock (a second app window or an older instance). Close it before writing.',
        { pid: existing.pid, batchId: existing.batchId, acquiredAt: existing.acquiredAt },
      );
    }

    const payload: LockfilePayload = {
      pid: process.pid,
      batchId,
      folders: [...folders],
      acquiredAt: new Date().toISOString(),
    };
    await mkdir(path.dirname(this.lockFilePath), { recursive: true });
    await writeFile(this.lockFilePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    activeLocks.set(key, batchId);

    let released = false;
    return {
      batchId,
      folders: [...folders],
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        if (activeLocks.get(key) === batchId) activeLocks.delete(key);
        try {
          await unlink(this.lockFilePath);
        } catch {
          /* best effort: a missing lockfile is the unlocked state */
        }
      },
    };
  }

  /** Read the current lockfile payload, or null when absent/unreadable. */
  async readLockfile(): Promise<LockfilePayload | null> {
    try {
      const raw = await readFile(this.lockFilePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<LockfilePayload>;
      if (typeof parsed.pid === 'number' && typeof parsed.batchId === 'string') {
        return parsed as LockfilePayload;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * True when the target folder looks writable: create and remove a probe
   * file. Used by the preview's filesystem warnings (read-only media, ACLs).
   */
  static async folderIsWritable(folder: string): Promise<boolean> {
    const probe = path.join(folder, `.metadesk-write-probe-${process.pid}`);
    try {
      await writeFile(probe, '');
      await unlink(probe);
      return true;
    } catch {
      return false;
    }
  }

  /** File size in bytes, or null when the file is missing. */
  static async fileSize(filePath: string): Promise<number | null> {
    try {
      const s = await stat(filePath);
      return s.isFile() ? s.size : null;
    } catch {
      return null;
    }
  }
}
