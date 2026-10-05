/**
 * Read-route test fixtures: a temp folder containing the pinned 1x1 PNG under
 * hostile-but-legal NTFS names, plus a generated JPEG carrying an embedded
 * EXIF thumbnail and simple XMP/EXIF/GPS fields for the metadata and
 * thumbnail tiers.
 *
 * The JPEG is produced by PowerShell System.Drawing (a real encoder — hand-
 * rolled JPEG bytes are exactly the "not exactly well-formed" trap the engine
 * tests warn about), then exiftool writes the metadata in DEFAULT BACKUP MODE
 * on the throwaway copy.
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runOnce } from '../../src/engine/exiftoolSession.js';
import { EXE_PATH, PNG_1X1 } from '../helpers.js';

export interface ReadFixture {
  dir: string;
  /** The metadata-rich JPEG (embedded ThumbnailImage + XMP/EXIF/GPS fields). */
  photoJpg: string;
  /** Plain 1x1 PNG (no embedded preview). */
  plainPng: string;
  /** Every file the scan should find (hostile names included). */
  expectedNames: string[];
}

export async function makeReadFixture(prefix = 'metadesk-read-'): Promise<ReadFixture> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));

  const names = [
    'plain.png',
    '--All=',
    '-comment=x.jpg',
    '50%#off=.png',
    "a'b c.png",
    '照片 中文 (1).png',
    'café ☕.png',
  ];
  for (const name of names) {
    await writeFile(path.join(dir, name), PNG_1X1);
  }

  const photoJpg = await makeThumbnailJpeg(path.join(dir, 'photo.jpg'));
  return {
    dir,
    photoJpg,
    plainPng: path.join(dir, 'plain.png'),
    expectedNames: [...names, 'photo.jpg'],
  };
}

/** Generate a small valid JPEG at targetPath via PowerShell System.Drawing. */
export async function generateJpeg(targetPath: string): Promise<void> {
  const escaped = targetPath.replace(/'/g, "''");
  const script =
    "$ErrorActionPreference='Stop'; " +
    'Add-Type -AssemblyName System.Drawing; ' +
    '$bmp = New-Object System.Drawing.Bitmap 32,32; ' +
    '$g = [System.Drawing.Graphics]::FromImage($bmp); ' +
    "$g.Clear([System.Drawing.Color]::SteelBlue); $g.Dispose(); " +
    `$bmp.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Jpeg); ` +
    '$bmp.Dispose(); Write-Output JPEGENC-OK';
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        'pwsh',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c) => {
        stdout += c;
      });
      child.stderr.on('data', (c) => {
        stderr += c;
      });
      child.on('error', reject);
      child.on('exit', (code) => resolve({ code, stdout, stderr }));
    },
  );
  if (result.code !== 0 || !result.stdout.includes('JPEGENC-OK')) {
    throw new Error(`JPEG fixture generation failed: ${result.stderr || result.stdout}`);
  }
}

/** A JPEG with an embedded thumbnail plus creator/copyright/date/GPS fields. */
export async function makeThumbnailJpeg(targetPath: string): Promise<string> {
  await generateJpeg(targetPath);
  const write = await runOnce(EXE_PATH, [
    `-ThumbnailImage<=${targetPath}`,
    '-XMP-dc:Rights=Copyright 2026, Mike',
    '-XMP-dc:Creator=Mike',
    '-XMP-xmp:CreatorTool=MetaDesk Fixture 1.0',
    '-EXIF:DateTimeOriginal=2026:05:01 12:00:00',
    '-GPSLatitude=37.5',
    '-GPSLatitudeRef=N',
    '-GPSLongitude=122.1',
    '-GPSLongitudeRef=W',
    targetPath,
  ]);
  if (!/1 image files? updated/.test(write.stdout)) {
    throw new Error(
      `fixture JPEG metadata write failed: ${write.stdout.slice(0, 200)} ${write.stderr.slice(0, 200)}`,
    );
  }
  return targetPath;
}
