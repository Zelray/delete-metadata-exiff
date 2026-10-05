/**
 * Fixture builders for the leaf-1.2.1 Playwright matrix. Node built-ins only;
 * every child process is an argv-array spawn with shell:false (house rule).
 *
 * The bytes and patterns mirror app/server/test/helpers.ts + fixtures.ts:
 *  - PNG_1X1 is the pinned 1x1 RGBA PNG (hand-rolled PNGs that are not exactly
 *    well-formed make exiftool report "Invalid PNG chunk size");
 *  - JPEGs come from PowerShell System.Drawing (a real encoder), then the
 *    VENDORED exiftool writes the metadata in default backup mode;
 *  - the SD-style PNG gets real ComfyUI-style `Prompt`/`Workflow` tEXt chunks
 *    injected by hand (exiftool EXTRACTS those arbitrary chunks but refuses to
 *    WRITE them by name — CRC32 via node:zlib), and the removable A1111 tags
 *    (PNG:Parameters, PNG:Software, EXIF:UserComment) written via exiftool.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXE_PATH = path.join(APP_ROOT, 'vendor', 'exiftool', 'exiftool.exe');
export const LAUNCHER = path.join(APP_ROOT, 'bin', 'metadesk.mjs');
export const UI_DIST = path.join(APP_ROOT, 'ui', 'dist');

/** The pinned 1x1 RGBA PNG fixture (app/server/test/helpers.ts). */
export const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000d4944415478da63fccfc0500f000485018084a98c210000000049454e44ae426082',
  'hex',
);

const IEND = Buffer.from('0000000049454e44ae426082', 'hex');

/** A PNG tEXt chunk (keyword\0text + CRC32) — how ComfyUI stores prompt/workflow. */
function textChunk(keyword, text) {
  const body = Buffer.concat([
    Buffer.from(`${keyword}\0`, 'latin1'),
    Buffer.from(text, 'latin1'),
  ]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const type = Buffer.from('tEXt', 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([type, body])) >>> 0, 0);
  return Buffer.concat([length, type, body, crc]);
}

/**
 * PNG_1X1 with arbitrary tEXt chunks inserted before IEND. exiftool reads
 * these as PNG:<Keyword> (verified live) but cannot delete them by name —
 * exactly the honest cannot-remove case the scrub reports.
 */
export function pngWithTextChunks(chunks) {
  const head = PNG_1X1.subarray(0, PNG_1X1.length - IEND.length);
  return Buffer.concat([
    head,
    ...chunks.map(({ keyword, text }) => textChunk(keyword, text)),
    IEND,
  ]);
}

/** Run the vendored exiftool once (argv array). Returns {status, stdout, stderr}. */
export function exifRun(args) {
  return spawnSync(EXE_PATH, args, { shell: false, encoding: 'utf8', windowsHide: true });
}

/** `-j -G1 -a -struct` read of the given paths, parsed. */
export function exifJson(paths) {
  const result = exifRun(['-j', '-G1', '-a', '-struct', ...paths]);
  if (result.status !== 0) {
    throw new Error(`exiftool read failed (${result.status}): ${result.stderr.slice(0, 300)}`);
  }
  return JSON.parse(result.stdout);
}

/** First doc for one path, normalized to forward slashes like exiftool reports. */
export function exifDocFor(docs, filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  return docs.find((doc) => doc['SourceFile'] === normalized);
}

export function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** A temp fixture dir with a put() helper (mirrors server/test/helpers.ts). */
export async function makeFixtureDir(prefix = 'metadesk-e2e-') {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  return {
    dir,
    pathOf: (name) => path.join(dir, name),
    put: async (name, contents) => {
      const full = path.join(dir, name);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, contents ?? PNG_1X1);
      return full;
    },
  };
}

/** Generate a small valid JPEG via PowerShell System.Drawing (argv array). */
export function generateJpeg(targetPath) {
  const escaped = targetPath.replace(/'/g, "''");
  const script =
    "$ErrorActionPreference='Stop'; " +
    'Add-Type -AssemblyName System.Drawing; ' +
    '$bmp = New-Object System.Drawing.Bitmap 320,200; ' +
    '$g = [System.Drawing.Graphics]::FromImage($bmp); ' +
    "$g.Clear([System.Drawing.Color]::SteelBlue); $g.Dispose(); " +
    `$bmp.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Jpeg); ` +
    '$bmp.Dispose(); Write-Output JPEGENC-OK';
  return new Promise((resolve, reject) => {
    const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0 && stdout.includes('JPEGENC-OK')) resolve(targetPath);
      else reject(new Error(`JPEG fixture generation failed: ${stderr || stdout}`));
    });
  });
}

/**
 * A photo JPEG with an embedded thumbnail, title, copyright and GPS — the
 * grid-thumbnail + badge fixture. Written by the vendored engine in default
 * backup mode; the first-generation _original is removed so the app starts
 * from first contact (our own scratch dir, not the vendor tree).
 */
export async function makePhotoJpeg(targetPath) {
  await generateJpeg(targetPath);
  const write = exifRun([
    `-ThumbnailImage<=${targetPath}`,
    '-XMP-dc:Title=Golden Gate at dusk',
    '-XMP-dc:Rights=Copyright 2026, Mike',
    '-EXIF:DateTimeOriginal=2026:05:01 12:00:00',
    '-GPSLatitude=37.8097',
    '-GPSLatitudeRef=N',
    '-GPSLongitude=122.4783',
    '-GPSLongitudeRef=W',
    targetPath,
  ]);
  if (!/1 image files? updated/.test(write.stdout + write.stderr)) {
    throw new Error(`photo JPEG metadata write failed: ${write.stdout} ${write.stderr}`);
  }
  await rm(targetPath + '_original');
  return targetPath;
}

/**
 * The SD-style AI-metadata fixture: real ComfyUI-style Prompt/Workflow tEXt
 * chunks (injected — the engine refuses to write them by name) plus the
 * removable A1111 tags planted through exiftool. RGBA color type keeps the
 * honest hidden-alpha warning in play.
 */
export async function makeSdPng(targetPath) {
  const promptJson = JSON.stringify({
    prompt: 'a lighthouse at dusk, cinematic, highly detailed',
    negative_prompt: 'blurry, low quality',
    steps: 20,
    sampler: 'Euler a',
    seed: 1234567,
  });
  const workflowJson = JSON.stringify({ nodes: [{ id: 1, type: 'CheckpointLoader' }], links: [] });
  await writeFile(targetPath, pngWithTextChunks([
    { keyword: 'Prompt', text: promptJson },
    { keyword: 'Workflow', text: workflowJson },
  ]));
  const write = exifRun([
    // Single line, ASCII only: argv values may not carry line breaks (the
    // engine refuses them, which would block an undo's value restore), and
    // non-ASCII command-line text reaches exiftool as "Malformed UTF-8".
    '-PNG:Parameters=Steps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1234567, Size: 512x512, Model: sd15; Negative prompt: blurry, low quality',
    '-PNG:Software=automatic1111',
    '-EXIF:UserComment=Steps: 20, Sampler: Euler a, Seed: 1234567 - generated with Stable Diffusion',
    targetPath,
  ]);
  if (!/1 image files? updated/.test(write.stdout + write.stderr)) {
    throw new Error(`SD PNG metadata write failed: ${write.stdout} ${write.stderr}`);
  }
  await rm(targetPath + '_original');
  return targetPath;
}

/**
 * Hold a file open with share-mode NONE (a real Windows lock) so a write to
 * it must fail per-file. Returns the pwsh child; the caller MUST .kill() it.
 */
export function lockFileForWrite(filePath) {
  const escaped = filePath.replace(/'/g, "''");
  const child = spawn(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$f = [System.IO.File]::Open('${escaped}','Open','Read','None'); Write-Output LOCKED; Start-Sleep -Seconds 90; $f.Dispose()`,
    ],
    { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  child.stdout.setEncoding('utf8');
  return child;
}

/** Wait until the lock child prints its LOCKED sentinel. */
export function waitForLock(child, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the lock child never reported LOCKED')), timeoutMs);
    const onData = (chunk) => {
      if (chunk.includes('LOCKED')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('the lock child exited before locking'));
    });
  });
}

/** Assert the built UI bundle exists (the launcher serves it). */
export function assertUiBuilt() {
  if (!existsSync(path.join(UI_DIST, 'index.html'))) {
    throw new Error(
      `The UI bundle is not built (${UI_DIST} missing). Run: node node_modules/typescript/bin/tsc -b --force && node node_modules/vite/bin/vite.js build (in app/ui) — or run verify-e2e.mjs all, which builds it.`,
    );
  }
}
