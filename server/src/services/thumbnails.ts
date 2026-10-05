/**
 * Embedded-preview thumbnails with a content-addressed disk cache.
 *
 * Cache key: sha256(absolute path + mtimeMs + size) — any change to the file
 * produces a new key, so a cached entry can never go stale, and responses can
 * be marked immutable.
 *
 * Extraction walks the usual preview chain (ThumbnailImage -> PreviewImage ->
 * JpgFromRaw) with one binary-safe one-shot engine call per attempt.
 *
 * `runOnceBinary` exists because the engine layer's `runOnce` is text-only
 * (it collects stdout as utf8, which would corrupt image bytes). It keeps the
 * engine layer's exact safety posture: argv array, `shell: false`,
 * `windowsHide`, absolute paths, and `assertArgsSafe` at the boundary. No
 * shell string exists anywhere in this module.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertArgsSafe } from '../engine/engineArgs.js';
import { isUncPath, probeReadable } from './pathGuard.js';
import type { MetaDeskConfig } from '../config.js';

/** Binary tags the API will extract, in preference order. */
export const THUMBNAIL_SOURCE_TAGS: readonly string[] = [
  'ThumbnailImage',
  'PreviewImage',
  'JpgFromRaw',
];

/** Tags the binary endpoint may be asked for, beyond the preview chain. */
export const BINARY_TAG_WHITELIST: ReadonlySet<string> = new Set([
  ...THUMBNAIL_SOURCE_TAGS,
  'OtherImage',
  'ICC_Profile',
]);

export interface Thumbnail {
  /** Decoded image bytes (JPEG for every tag in the preview chain). */
  bytes: Buffer;
  /** Which embedded image the bytes came from. */
  source: 'thumbnail' | 'preview' | 'jpg-from-raw';
  /** Cache key (also the ETag). */
  hash: string;
  /** true when the bytes came from the disk cache. */
  cached: boolean;
}

export class ThumbnailService {
  constructor(private readonly config: MetaDeskConfig) {}

  /**
   * Extract (or fetch from cache) the best embedded preview for a file.
   * Returns null when the file carries no embedded preview — the route maps
   * that to a 404 so the UI can show a placeholder.
   */
  async get(filePath: string): Promise<Thumbnail | null> {
    const resolved = path.normalize(filePath);
    if (isUncPath(resolved)) await probeReadable(resolved, { isUnc: true });
    const fileStat = await stat(resolved);
    if (!fileStat.isFile()) return null;

    const hash = cacheKey(resolved, fileStat.mtimeMs, fileStat.size);
    const cachePath = path.join(this.config.thumbsDir, `${hash}.jpg`);

    const cachedBytes = await readFileIfExists(cachePath);
    if (cachedBytes !== null && cachedBytes.length > 0) {
      return { bytes: cachedBytes, source: 'thumbnail', hash, cached: true };
    }

    for (const [index, tag] of THUMBNAIL_SOURCE_TAGS.entries()) {
      const bytes = await runOnceBinary(this.config.executablePath, [
        '-s3',
        '-b',
        `-${tag}`,
        resolved,
      ]);
      if (bytes.length > 0) {
        await mkdir(this.config.thumbsDir, { recursive: true });
        await writeFile(cachePath, bytes);
        return { bytes, source: sourceForIndex(index), hash, cached: false };
      }
    }
    return null;
  }

  /**
   * Extract one whitelisted binary tag as raw bytes (no cache — the binary
   * endpoint streams these straight through).
   */
  async extractBinaryTag(filePath: string, tag: string): Promise<Buffer | null> {
    const resolved = path.normalize(filePath);
    if (!BINARY_TAG_WHITELIST.has(tag)) return null;
    if (isUncPath(resolved)) await probeReadable(resolved, { isUnc: true });
    const bytes = await runOnceBinary(this.config.executablePath, ['-s3', '-b', `-${tag}`, resolved]);
    return bytes.length > 0 ? bytes : null;
  }
}

function sourceForIndex(index: number): Thumbnail['source'] {
  if (index === 0) return 'thumbnail';
  if (index === 1) return 'preview';
  return 'jpg-from-raw';
}

function cacheKey(resolved: string, mtimeMs: number, size: number): string {
  return createHash('sha256').update(`${resolved}\0${mtimeMs}\0${size}`).digest('hex').slice(0, 32);
}

async function readFileIfExists(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch {
    return null;
  }
}

/**
 * Binary-safe one-shot engine call: spawns exiftool with an ARGV ARRAY
 * (never a shell string), collects stdout as raw Buffers, waits for exit.
 * Exit codes are not treated as proof — an empty result is simply empty.
 */
export function runOnceBinary(
  executablePath: string,
  args: readonly string[],
  timeoutMs = 30_000,
): Promise<Buffer> {
  assertArgsSafe(args);
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(executablePath, [...args], {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let settled = false;

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => {
      /* diagnostics only; empty output decides the fallback */
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      reject(new Error(`binary extraction timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('exit', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
  });
}
