/**
 * Write-suite helpers: fixture dirs with isolated data dirs, a pipeline
 * factory over the REAL engine, SD-style PNG fixture writers, and a
 * share-none file-lock holder (a real cross-process Windows lock, held by a
 * spawned PowerShell — the same hostile condition Explorer/AV/sync clients
 * create).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runOnce, ExifToolSession } from '../../src/engine/exiftoolSession.js';
import { WritePipeline } from '../../src/services/writePipeline.js';
import { EXE_PATH, PNG_1X1, type FixtureDir } from '../helpers.js';

export interface WriteFixture extends FixtureDir {
  /** Isolated app-state dir: journal, scratch, write temp files. */
  dataDir: string;
  cleanup(): Promise<void>;
}

export async function makeWriteFixture(prefix = 'metadesk-write-'): Promise<WriteFixture> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  const dataDir = path.join(dir, 'data');
  await mkdir(dataDir, { recursive: true });
  return {
    dir,
    dataDir,
    pathOf: (name: string) => path.join(dir, name),
    put: async (name: string, contents?: Buffer) => {
      const full = path.join(dir, name);
      await writeFile(full, contents ?? PNG_1X1);
      return full;
    },
    names: () => readdir(dir),
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export interface PipelineHarness {
  session: ExifToolSession;
  pipeline: WritePipeline;
  shutdown(): Promise<void>;
}

/** Session + pipeline over the real engine, pre-unlocked (server-side gate off). */
export async function makePipeline(
  fixture: WriteFixture,
  opts: { chunkSize?: number; unlocked?: boolean } = {},
): Promise<PipelineHarness> {
  const session = new ExifToolSession({ executablePath: EXE_PATH, requestTimeoutMs: 60_000 });
  await session.start();
  const pipeline = new WritePipeline({
    engine: session,
    dataDir: fixture.dataDir,
    chunkSize: opts.chunkSize,
    isWriteUnlocked: () => opts.unlocked ?? true,
  });
  return {
    session,
    pipeline,
    shutdown: async () => {
      await session.shutdown();
    },
  };
}

/** exiftool's normalized SourceFile form for map lookups. */
export function exifSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Independent single-process read of one file's tags (fresh exiftool run,
 * driven through the documented `-@ -` stdin argfile protocol — the same
 * route the engine uses, which is what makes CJK/emoji filenames reachable;
 * Windows argv one-shots cannot address them).
 */
export async function readTagsOnce(
  filePath: string,
  tags: readonly string[] = [],
): Promise<Record<string, unknown>> {
  const args = [
    '-charset',
    'filename=UTF8',
    '-j',
    '-G1',
    '-a',
    '-struct',
    ...tags.flatMap((t) => [`-${t}`]),
    '-@',
    '-',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(EXE_PATH, args, {
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', reject);
    child.on('exit', () => {
      try {
        const docs = JSON.parse(stdout || '[]') as Array<Record<string, unknown>>;
        resolve(docs[0] ?? {});
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stdin.end(`${filePath}\n`);
  });
}

/** Write a full SD-style metadata set onto a PNG the way the generators do. */
export async function writeSdMetadata(pngPath: string): Promise<void> {
  const result = await runOnce(
    EXE_PATH,
    [
      '-PNG:parameters=Steps: 20, Sampler: Euler a, CFG scale: 7, Seed: 42, Model: sd15',
      '-PNG:Comment={"seed":42,"sampler":"Euler a","steps":20}',
      '-PNG:Software=NovelAI 3.0',
      '-PNG:Description=a cozy cabin in the woods, generated art',
      '-EXIF:UserComment=prompt: a cozy cabin in the woods',
      '-EXIF:Software=automatic1111 webui',
      pngPath,
    ],
    { timeoutMs: 30_000 },
  );
  if (!/1 image files? updated/.test(result.stdout)) {
    throw new Error(`SD fixture write failed: ${result.stdout} ${result.stderr}`);
  }
}

/**
 * Hold a file open with FileShare::None from a separate process — the real
 * Windows file lock that breaks the engine's rename step. Resolves once the
 * lock is HELD (the child writes a .ready marker after opening).
 */
export interface FileLock {
  child: ChildProcess;
  release(): Promise<void>;
}

export async function holdFileOpen(filePath: string, markerPath: string): Promise<FileLock> {
  const escaped = filePath.replace(/'/g, "''");
  const markerEscaped = markerPath.replace(/'/g, "''");
  const script =
    "$ErrorActionPreference='Stop'; " +
    `$f=[System.IO.File]::Open('${escaped}','Open','Read','None'); ` +
    `Set-Content -Path '${markerEscaped}' -Value 'locked'; ` +
    'Start-Sleep -Seconds 45; ' +
    "$f.Close(); Write-Output LOCKHELD";
  const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.on('error', () => {
    /* surfaced by the marker timeout */
  });
  return {
    child,
    release: async () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
        setTimeout(() => resolve(), 3_000).unref();
      });
    },
  };
}

/** Poll until the marker file exists (the lock is held) or time out. */
export async function waitForMarker(markerPath: string, timeoutMs = 20_000): Promise<boolean> {
  const { stat } = await import('node:fs/promises');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const info = await stat(markerPath);
      if (info.isFile()) return true;
    } catch {
      /* not yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}
