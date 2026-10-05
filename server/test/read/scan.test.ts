/**
 * Folder-scan smoke tests against a real fixture folder and the real engine:
 * hostile names found, artifacts excluded, badges flagged, preflight sane,
 * and hostile request paths rejected without taking the scan down.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXE_PATH } from '../helpers.js';
import { makeReadFixture, type ReadFixture } from './fixtures.js';
import { ExifToolSession } from '../../src/engine/exiftoolSession.js';
import { ScanError, scanFolder } from '../../src/services/scan.js';

let fixture: ReadFixture;
let engine: ExifToolSession;

beforeAll(async () => {
  fixture = await makeReadFixture('metadesk-scan-');
  engine = new ExifToolSession({ executablePath: EXE_PATH });
  await engine.start();
}, 60_000);

afterAll(async () => {
  await engine.shutdown();
});

describe('scanFolder (real fs + engine)', () => {
  it('finds every creatable file, hostile names included', async () => {
    const result = await scanFolder(
      { folder: fixture.dir, recursive: false },
      { engine },
    );
    const names = result.entries.map((e) => e.name).sort();
    for (const expected of fixture.expectedNames) {
      expect(names, expected).toContain(expected);
    }
    expect(result.totalFiles).toBe(fixture.expectedNames.length);
    expect(result.totalBytes).toBeGreaterThan(0);
    expect(result.freeBytes).toBeGreaterThan(0);
    expect(result.scanId).toMatch(/^scan-/);
    expect(result.rejectedPaths).toEqual([]);
    expect(result.unreadableDirectories).toEqual([]);
  });

  it('flags odd names as warnings without failing the scan', async () => {
    const result = await scanFolder({ folder: fixture.dir, recursive: false }, { engine });
    const byName = new Map(result.entries.map((e) => [e.name, e]));
    expect(byName.get('--All=')?.warnings.join(' ')).toMatch(/odd-name/);
    expect(byName.get('50%#off=.png')?.warnings.join(' ')).toMatch(/%, # or =/);
    expect(byName.get('plain.png')?.warnings.join(' ')).not.toMatch(/odd-name/);
  });

  it('flags GPS/copyright badges on the metadata-rich JPEG', async () => {
    const result = await scanFolder({ folder: fixture.dir, recursive: false }, { engine });
    const photo = result.entries.find((e) => e.name === 'photo.jpg');
    expect(photo).toBeDefined();
    expect(photo?.warnings.join(' ')).toMatch(/badge:gps-present/);
    expect(photo?.warnings.join(' ')).toMatch(/badge:copyright-present/);
    expect(photo?.warnings.join(' ')).toMatch(/badge:editor-present/);
    const plain = result.entries.find((e) => e.name === 'plain.png');
    expect(plain?.warnings.join(' ')).not.toMatch(/badge:gps-present/);
  });

  it('excludes exiftool artifacts by default', async () => {
    const result = await scanFolder({ folder: fixture.dir, recursive: false }, { engine });
    // makeThumbnailJpeg writes in default backup mode, so photo.jpg_original
    // exists on disk; backup hygiene keeps it out of the listing.
    const names = result.entries.map((e) => e.name);
    expect(names).not.toContain('photo.jpg_original');
    expect(names).toContain('photo.jpg');
  });

  it('honors the extension filter chips', async () => {
    const result = await scanFolder(
      { folder: fixture.dir, recursive: false, extensions: ['png'] },
      { engine },
    );
    expect(result.entries.every((e) => e.extension === 'png')).toBe(true);
    expect(result.entries.length).toBeGreaterThan(0);
  });

  it('classifies kinds for badges and safety gating', async () => {
    const result = await scanFolder({ folder: fixture.dir, recursive: false }, { engine });
    const byName = new Map(result.entries.map((e) => [e.name, e]));
    expect(byName.get('photo.jpg')?.kind).toBe('jpeg');
    expect(byName.get('plain.png')?.kind).toBe('png');
    expect(byName.get('-comment=x.jpg')?.kind).toBe('jpeg');
  });

  it('emits progress callbacks through the whole scan', async () => {
    const progress: Array<{ filesScanned: number; currentDirectory?: string }> = [];
    let completed = 0;
    await scanFolder({ folder: fixture.dir, recursive: false }, {
      engine,
      onScanProgress: (event) => progress.push(event),
      onScanComplete: () => {
        completed += 1;
      },
    });
    expect(progress.length).toBe(fixture.expectedNames.length);
    expect(completed).toBe(1);
  });

  it('degrades to fs-only when the engine is unavailable', async () => {
    const result = await scanFolder({ folder: fixture.dir, recursive: false }, { engine: null });
    expect(result.totalFiles).toBe(fixture.expectedNames.length);
    expect(result.warnings.join(' ')).toMatch(/engine unavailable/);
  });
});

describe('scanFolder rejects hostile requests', () => {
  it('rejects relative folders with path_rejected', async () => {
    await expect(scanFolder({ folder: 'relative\\folder', recursive: false }, { engine })).rejects.toMatchObject({
      code: 'path_rejected',
    });
  });

  it('rejects traversal', async () => {
    await expect(
      scanFolder({ folder: `${fixture.dir}\\..\\..`, recursive: false }, { engine }),
    ).rejects.toMatchObject({ code: 'path_rejected' });
  });

  it('reports a missing folder as not_found', async () => {
    await expect(
      scanFolder({ folder: 'C:\\definitely\\not\\a\\folder\\here', recursive: false }, { engine }),
    ).rejects.toBeInstanceOf(ScanError);
  });
});
