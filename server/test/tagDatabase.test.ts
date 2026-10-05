/**
 * Tag database tests: a real `-listx -f` run parsed into the catalog, cached
 * into a temp dir (hermetic; production caching writes app/data/, gitignored).
 */
import { describe, expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import path from 'node:path';
import {
  defaultCacheDir,
  loadTagCatalog,
  lookupTag,
  parseListxXml,
} from '../src/engine/tagDatabase.js';
import { APP_ROOT, EXE_PATH, makeFixtureDir } from './helpers.js';

describe('tag catalog (real exe)', () => {
  it('parses -listx -f into a large catalog with group, writability and list flags', async () => {
    const cache = await makeFixtureDir('metadesk-tags-');
    const result = await loadTagCatalog({
      executablePath: EXE_PATH,
      cacheDir: cache.dir,
      useCache: true,
    });

    expect(result.fromCache).toBe(false);
    expect(result.catalog.exiftoolVersion).toMatch(/^\d+\.\d+$/);
    expect(Object.keys(result.catalog.tags).length).toBeGreaterThan(10_000);
    expect(result.xmlBytes).toBeGreaterThan(1_000_000);

    // A known list-type, writable tag: IPTC Keywords.
    const keywords = lookupTag(result.catalog, 'IPTC:Keywords');
    expect(keywords).not.toBeNull();
    expect(keywords?.info.writable).toBe(true);
    expect(keywords?.info.list).toBe(true);

    // A protected tag needs an explicit group and is flagged as such.
    const someProtected = Object.values(result.catalog.tags).find((t) => t.protected);
    expect(someProtected).toBeDefined();

    // The name index resolves bare names too.
    expect(result.catalog.nameIndex['keywords']?.length).toBeGreaterThan(0);
    expect(result.catalog.nameIndex['datetimeoriginal']?.length).toBeGreaterThan(0);

    // The curated whitelist tags all resolve against the real database where
    // exiftool lists them (composite MWG tags are created on demand and are
    // legitimately absent from -listx).
    const pngParameters = lookupTag(result.catalog, 'PNG:Parameters');
    expect(pngParameters?.info.writable).toBe(true);
  }, 120_000);

  it('reuses the on-disk cache for the second load', async () => {
    const cache = await makeFixtureDir('metadesk-tags-cache-');
    const first = await loadTagCatalog({ executablePath: EXE_PATH, cacheDir: cache.dir });
    expect(first.cachePath).not.toBeNull();
    await access(first.cachePath as string);

    const second = await loadTagCatalog({ executablePath: EXE_PATH, cacheDir: cache.dir });
    expect(second.fromCache).toBe(true);
    expect(second.catalog.exiftoolVersion).toBe(first.catalog.exiftoolVersion);
    expect(Object.keys(second.catalog.tags).length).toBe(
      Object.keys(first.catalog.tags).length,
    );
  }, 120_000);

  it('rejects input that is not -listx output', () => {
    expect(() => parseListxXml('<html><body>nope</body></html>', '13.59')).toThrow(
      /does not look like exiftool -listx/,
    );
  });

  it('looks tags up with or without a group prefix and returns null for unknowns', async () => {
    const cache = await makeFixtureDir('metadesk-tags-lookup-');
    const { catalog } = await loadTagCatalog({ executablePath: EXE_PATH, cacheDir: cache.dir });

    expect(lookupTag(catalog, 'ExifIFD:DateTimeOriginal')?.info.writable).toBe(true);
    expect(lookupTag(catalog, 'datetimeoriginal')).not.toBeNull();
    expect(lookupTag(catalog, 'this-is-not-a-tag')).toBeNull();
    expect(lookupTag(catalog, '')).toBeNull();
  }, 120_000);

  it('defaults the cache directory to the gitignored app/data folder', () => {
    expect(defaultCacheDir()).toBe(path.join(APP_ROOT, 'data'));
  });
});
