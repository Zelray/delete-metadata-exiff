/**
 * Shared test helpers: paths, the canonical 1x1 PNG fixture, temp fixture
 * directories, and exiftool process counting for the no-orphan assertion.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** app/ root (two levels up from app/server/test). */
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The vendored, non-pause exiftool.exe the engine drives. */
export const EXE_PATH = path.join(APP_ROOT, 'vendor', 'exiftool', 'exiftool.exe');

/**
 * Well-known valid 1x1 PNG (8-bit RGBA). Hand-rolled buffers that are not
 * exactly well-formed make exiftool report "Invalid PNG chunk size", so this
 * constant is the fixture for every read/write test.
 */
export const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000d4944415478da63fccfc0500f000485018084a98c210000000049454e44ae426082',
  'hex',
);

export interface FixtureDir {
  dir: string;
  /** Write a file into the fixture dir; defaults to the 1x1 PNG. */
  put(name: string, contents?: Buffer): Promise<string>;
  /** Absolute path for a name without writing it. */
  pathOf(name: string): string;
  names(): Promise<string[]>;
}

export async function makeFixtureDir(prefix = 'metadesk-test-'): Promise<FixtureDir> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  return {
    dir,
    pathOf: (name: string) => path.join(dir, name),
    put: async (name: string, contents?: Buffer) => {
      const full = path.join(dir, name);
      await writeFile(full, contents ?? PNG_1X1);
      return full;
    },
    names: () => readdir(dir),
  };
}

export async function readBytes(filePath: string): Promise<Buffer> {
  return readFile(filePath);
}

/**
 * exiftool reports `SourceFile` with forward slashes regardless of the path
 * separator used on the command line. Normalize before comparing.
 */
export function exifPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Count running exiftool.exe processes via tasklist (argv array, no shell). */
export function countExiftoolProcesses(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'tasklist',
      ['/FI', 'IMAGENAME eq exiftool.exe', '/FO', 'CSV', '/NH'],
      { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('error', reject);
    child.on('exit', () => {
      if (/info: no tasks/i.test(out)) {
        resolve(0);
        return;
      }
      const lines = out.split(/\r?\n/).filter((l) => l.trim().length > 0);
      resolve(lines.length);
    });
  });
}

/**
 * Hostile filename cases. `creatable` reflects what NTFS/Win32 actually
 * allows: `"` and control characters (including newlines) are illegal in
 * Windows filenames, so those are asserted at the argv level only.
 */
export interface HostileCase {
  name: string;
  label: string;
  creatable: boolean;
}

export const HOSTILE_NAMES: readonly HostileCase[] = [
  { name: '--All=', label: 'leading dashes + equals', creatable: true },
  { name: '-comment=x.jpg', label: 'option-shaped name', creatable: true },
  { name: '50%#off=.png', label: 'percent, hash, equals', creatable: true },
  { name: "a'b c.png", label: 'single quote + spaces', creatable: true },
  { name: '照片 中文 (1).png', label: 'CJK + parentheses', creatable: true },
  { name: 'café ☕.png', label: 'accents + emoji', creatable: true },
  { name: 'a"b.png', label: 'double quote (illegal on NTFS)', creatable: false },
  { name: 'a\nb.png', label: 'embedded newline (illegal on NTFS)', creatable: false },
];

/** Names Windows only creates through the \\?\ device path. */
export const WIN32_QUIRKY_NAMES: readonly string[] = ['trailing dot.', 'trailing space '];
