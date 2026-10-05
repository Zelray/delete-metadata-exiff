/**
 * Metadata-tier smoke tests: simple/all/raw reads over the real engine, plus
 * the thumbnail extraction chain with its disk cache.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.js';
import { ExifToolSession } from '../../src/engine/exiftoolSession.js';
import { MetadataService } from '../../src/services/metadata.js';
import { ThumbnailService } from '../../src/services/thumbnails.js';
import { EXE_PATH } from '../helpers.js';
import { makeReadFixture, type ReadFixture } from './fixtures.js';

let fixture: ReadFixture;
let engine: ExifToolSession;
let metadata: MetadataService;
let thumbnails: ThumbnailService;

beforeAll(async () => {
  fixture = await makeReadFixture('metadesk-meta-');
  engine = new ExifToolSession({ executablePath: EXE_PATH });
  await engine.start();
  const config = loadConfig();
  const thumbsDir = mkdtempSync(path.join(tmpdir(), 'metadesk-thumbs-'));
  metadata = new MetadataService(engine, () => loadCatalog(config.dataDir));
  thumbnails = new ThumbnailService({ ...config, thumbsDir });
}, 90_000);

afterAll(async () => {
  await engine.shutdown();
});

// The catalog loader is created once and memoized inside MetadataService; give
// it the app data dir so the on-disk cache persists across suite runs.
import { loadTagCatalog } from '../../src/engine/tagDatabase.js';
function loadCatalog(cacheDir: string): Promise<import('@metadesk/shared').TagCatalog | null> {
  return loadTagCatalog({ executablePath: EXE_PATH, cacheDir })
    .then((r) => r.catalog)
    .catch(() => null);
}

describe('metadata tiers (real engine)', () => {
  it('simple tier: curated human fields from the fixture JPEG', async () => {
    const payloads = await metadata.read([fixture.photoJpg], 'simple');
    const payload = payloads.get(fixture.photoJpg);
    expect(payload).toBeDefined();
    expect(payload?.depth).toBe('simple');
    expect(payload?.simple.creator).toBe('Mike');
    expect(payload?.simple.copyright).toBe('Copyright 2026, Mike');
    expect(payload?.simple.dateTaken).toMatch(/^2026-05-01T12:00:00/);
    expect(payload?.simple.dateTakenRaw).toBe('2026:05:01 12:00:00');
    expect(payload?.simple.gps).toMatchObject({ latitude: 37.5, longitude: -122.1 });
    expect(payload?.simple.width).toBeGreaterThan(0);
    // `all`/`raw` tiers are not populated for simple depth.
    expect(Object.keys(payload?.all ?? {})).toEqual([]);
    expect(payload?.raw).toEqual([]);
  });

  it('simple tier on a plain PNG returns an empty-but-valid payload', async () => {
    const payloads = await metadata.read([fixture.plainPng], 'simple');
    const payload = payloads.get(fixture.plainPng);
    expect(payload).toBeDefined();
    expect(payload?.errors).toEqual([]);
    expect(payload?.simple.keywords).toEqual([]);
  });

  it('all tier: every tag keyed GROUP:Tag', async () => {
    const payloads = await metadata.read([fixture.photoJpg], 'all');
    const payload = payloads.get(fixture.photoJpg);
    expect(payload?.depth).toBe('all');
    const all = payload?.all ?? {};
    expect(Object.keys(all).length).toBeGreaterThan(20);
    expect(all['File:FileType']).toBe('JPEG');
    expect(all['XMP-dc:Rights']).toBe('Copyright 2026, Mike');
  });

  it('raw tier: raw machine values and numeric tag ids', async () => {
    const payloads = await metadata.read([fixture.photoJpg], 'raw');
    const payload = payloads.get(fixture.photoJpg);
    expect(payload?.depth).toBe('raw');
    const dateTag = payload?.raw.find((t) => t.group === 'ExifIFD' && t.name === 'DateTimeOriginal');
    expect(dateTag).toBeDefined();
    expect(dateTag?.value).toBe('2026:05:01 12:00:00');
    expect(dateTag?.raw).toBe('2026:05:01 12:00:00');
    expect(dateTag?.id).toBe('36867'); // 0x9003 DateTimeOriginal
    const thumbnailTag = payload?.raw.find((t) => t.name === 'ThumbnailImage');
    expect(thumbnailTag?.binary).toBe(true);
    // Writable flags come from the -listx catalog when it loads.
    const withWritable = payload?.raw.filter((t) => t.writable === true) ?? [];
    expect(withWritable.length).toBeGreaterThan(0);
  }, 120_000);

  it('batch reads: one call covers several files', async () => {
    const payloads = await metadata.read([fixture.photoJpg, fixture.plainPng], 'all');
    expect(payloads.size).toBe(2);
    expect(payloads.get(fixture.plainPng)?.all['File:FileType']).toBe('PNG');
  });
});

describe('thumbnail extraction (real engine)', () => {
  it('extracts the embedded JPEG thumbnail with caching', async () => {
    const first = await thumbnails.get(fixture.photoJpg);
    expect(first).not.toBeNull();
    expect(first?.source).toBe('thumbnail');
    expect(first?.cached).toBe(false);
    expect(first?.bytes[0]).toBe(0xff);
    expect(first?.bytes[1]).toBe(0xd8);

    const second = await thumbnails.get(fixture.photoJpg);
    expect(second?.cached).toBe(true);
    expect(second?.hash).toBe(first?.hash);
  });

  it('returns null for a file with no embedded preview (404 fallback)', async () => {
    const none = await thumbnails.get(fixture.plainPng);
    expect(none).toBeNull();
  });

  it('extractBinaryTag serves whitelisted tags only', async () => {
    const bytes = await thumbnails.extractBinaryTag(fixture.photoJpg, 'ThumbnailImage');
    expect(bytes?.[0]).toBe(0xff);
    expect(await thumbnails.extractBinaryTag(fixture.photoJpg, 'All')).toBeNull();
  });
});
