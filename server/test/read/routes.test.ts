/**
 * Route smoke tests over a fully wired server (real engine, fastify inject).
 * Covers the auth gates, the folder-scan/metadata/binary/thumbnail routes,
 * and the strict read-only console validator.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { InjectOptions, InjectPayload } from 'light-my-request';
import type { FolderScanResult } from '@metadesk/shared';
import { loadConfig } from '../../src/config.js';
import { buildServer, type BuildServerResult } from '../../src/index.js';
import { makeReadFixture, type ReadFixture } from './fixtures.js';

let fixture: ReadFixture;
let server: BuildServerResult;
let app: FastifyInstance;
let port: number;
let host: string;

beforeAll(async () => {
  fixture = await makeReadFixture('metadesk-routes-');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'metadesk-routes-data-'));
  server = await buildServer({
    config: {
      ...loadTestConfig(),
      dataDir,
      thumbsDir: path.join(dataDir, 'thumbs'),
      portfilePath: path.join(dataDir, 'portfile.json'),
    },
    token: 'test-token-123',
    sseHeartbeatMs: 250,
  });
  app = server.app;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
  host = `127.0.0.1:${port}`;
}, 90_000);

afterAll(async () => {
  await app.close();
});

function loadTestConfig() {
  return loadConfig();
}

function injectOptions(
  url: string,
  options: {
    method?: 'GET' | 'POST';
    token?: string | null;
    origin?: string | null;
    hostOverride?: string;
    body?: unknown;
  } = {},
): InjectOptions {
  const headers: Record<string, string> = { host: options.hostOverride ?? host };
  if (options.token !== null) headers['x-metadesk-token'] = options.token ?? 'test-token-123';
  if (options.origin !== undefined && options.origin !== null) headers.origin = options.origin;
  const result: InjectOptions = {
    url,
    method: options.method ?? 'GET',
    headers,
  };
  if (options.body !== undefined) result.payload = options.body as InjectPayload;
  return result;
}

describe('auth gates', () => {
  it('serves /api/health without a token (launcher handshake)', async () => {
    const response = await app.inject(injectOptions('/api/health', { token: null }));
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.version).toMatch(/^\d+\.\d+$/);
    expect(body.readOnlyFallback).toBe(false);
  });

  it('rejects data routes without a token with 401', async () => {
    const response = await app.inject(
      injectOptions('/api/files/scan', { token: null, method: 'POST', body: { folder: fixture.dir } }),
    );
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('bad_request');
  });

  it('rejects a wrong token with 401', async () => {
    const response = await app.inject(injectOptions('/api/health', { token: 'wrong' }));
    expect(response.statusCode).toBe(200); // health stays open
    const scan = await app.inject(injectOptions('/api/thumbnail?path=x', { token: 'wrong' }));
    expect(scan.statusCode).toBe(401);
  });

  it('rejects cross-origin requests with 403', async () => {
    const response = await app.inject(
      injectOptions('/api/health', { token: null, origin: 'http://evil.example' }),
    );
    expect(response.statusCode).toBe(403);
  });

  it('accepts same-origin requests', async () => {
    const response = await app.inject(
      injectOptions('/api/health', { token: null, origin: `http://127.0.0.1:${port}` }),
    );
    expect(response.statusCode).toBe(200);
  });

  it('rejects spoofed Host headers (DNS-rebinding guard)', async () => {
    const evil = await app.inject(injectOptions('/api/health', { token: null, hostOverride: 'evil.example' }));
    expect(evil.statusCode).toBe(403);
    const wrongPort = await app.inject(
      injectOptions('/api/health', { token: null, hostOverride: '127.0.0.1:1' }),
    );
    expect(wrongPort.statusCode).toBe(403);
  });
});

describe('scan route', () => {
  it('scans the fixture folder with the token', async () => {
    const response = await app.inject(
      injectOptions('/api/files/scan', { method: 'POST', body: { folder: fixture.dir, recursive: false } }),
    );
    expect(response.statusCode).toBe(200);
    const result = response.json() as FolderScanResult;
    expect(result.totalFiles).toBe(fixture.expectedNames.length);
    const names = result.entries.map((e) => e.name);
    for (const expected of fixture.expectedNames) expect(names).toContain(expected);
  });

  it('rejects a relative folder with the typed error envelope', async () => {
    const response = await app.inject(
      injectOptions('/api/files/scan', { method: 'POST', body: { folder: 'relative/path' } }),
    );
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'path_rejected' });
  });

  it('rejects traversal with the typed error envelope', async () => {
    const response = await app.inject(
      injectOptions('/api/files/scan', {
        method: 'POST',
        body: { folder: `${fixture.dir}\\..\\elsewhere` },
      }),
    );
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('path_rejected');
  });
});

describe('metadata routes', () => {
  it('returns a simple-tier payload for the fixture JPEG', async () => {
    const url = `/api/file/metadata?path=${encodeURIComponent(fixture.photoJpg)}&depth=simple`;
    const response = await app.inject(injectOptions(url));
    expect(response.statusCode).toBe(200);
    expect(response.json().simple.creator).toBe('Mike');
  });

  it('validates depth and paths', async () => {
    const badDepth = await app.inject(
      injectOptions(`/api/file/metadata?path=${encodeURIComponent(fixture.photoJpg)}&depth=huge`),
    );
    expect(badDepth.statusCode).toBe(400);
    const badPath = await app.inject(injectOptions('/api/file/metadata?path=relative.png&depth=all'));
    expect(badPath.statusCode).toBe(400);
    expect(badPath.json().code).toBe('path_rejected');
  });

  it('batch-reads a folder view in one call', async () => {
    const response = await app.inject(
      injectOptions('/api/metadata', {
        method: 'POST',
        body: { paths: [fixture.photoJpg, fixture.plainPng], depth: 'all' },
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().payloads).toHaveLength(2);
  });
});

describe('binary + thumbnail routes', () => {
  it('streams the embedded ThumbnailImage as JPEG bytes', async () => {
    const url = `/api/file/binary?path=${encodeURIComponent(fixture.photoJpg)}&tag=ThumbnailImage`;
    const response = await app.inject(injectOptions(url));
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/jpeg');
    const bytes = response.rawPayload;
    expect(bytes?.[0]).toBe(0xff);
    expect(bytes?.[1]).toBe(0xd8);
  });

  it('refuses non-whitelisted binary tags', async () => {
    const url = `/api/file/binary?path=${encodeURIComponent(fixture.photoJpg)}&tag=EvilTag`;
    const response = await app.inject(injectOptions(url));
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('unsafe_tag');
  });

  it('serves the cached thumbnail route with image/jpeg', async () => {
    const url = `/api/thumbnail?path=${encodeURIComponent(fixture.photoJpg)}`;
    const response = await app.inject(injectOptions(url));
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/jpeg');
    expect(response.headers['etag']).toBeDefined();
  });

  it('404s the thumbnail for a file without an embedded preview', async () => {
    const url = `/api/thumbnail?path=${encodeURIComponent(fixture.plainPng)}`;
    const response = await app.inject(injectOptions(url));
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('not_found');
  });
});

describe('read-only console', () => {
  it('runs a read command and returns the exact argv as commandPreview', async () => {
    const args = ['-j', '-G1', '-n', fixture.photoJpg];
    const response = await app.inject(
      injectOptions('/api/console/run', { method: 'POST', body: { args } }),
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.commandPreview).toEqual(args);
    expect(body.json.length).toBeGreaterThan(0);
    expect(body.json[0].SourceFile).toMatch(/photo\.jpg$/);
  });

  it('rejects every write-shaped argument list', async () => {
    const writeAttempts: string[][] = [
      ['-All='],
      ['-XMP-dc:Title=hello', fixture.photoJpg],
      ['-overwrite_original', fixture.photoJpg],
      ['-o', 'C:\\out\\dir', fixture.photoJpg],
      ['-tagsFromFile', fixture.photoJpg, fixture.plainPng],
      ['-geotag', 'C:\\tracks\\gpx.gpx', fixture.photoJpg],
      ['-config', 'C:\\x\\config.pl', fixture.photoJpg],
      ['-stay_open', 'False'],
      ['-charset', 'filename=UTF8'],
      ['-use', 'MWG'],
      ['-ThumbnailImage<=C:\\tmp\\x.jpg', fixture.photoJpg],
      ['-execute'],
      ['-common_args'],
    ];
    const failures: string[] = [];
    for (const args of writeAttempts) {
      const response = await app.inject(
        injectOptions('/api/console/run', { method: 'POST', body: { args } }),
      );
      const ok = response.statusCode === 400 && response.json().code === 'unsafe_tag';
      if (!ok) failures.push(`${JSON.stringify(args)} -> ${response.statusCode} ${response.body.slice(0, 120)}`);
    }
    expect(failures).toEqual([]);
  });

  it('rejects relative file arguments with path_rejected', async () => {
    const response = await app.inject(
      injectOptions('/api/console/run', { method: 'POST', body: { args: ['-j', 'photo.jpg'] } }),
    );
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('path_rejected');
  });

  it('allows wildcard tag reads and value flags', async () => {
    const ok = await app.inject(
      injectOptions('/api/console/run', {
        method: 'POST',
        body: { args: ['-j', '-G1', '-ext', 'png', '-*opyright*', fixture.dir] },
      }),
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.json().commandPreview).toContain('-*opyright*');
  });

  it('rejects a bad -ext value', async () => {
    const bad = await app.inject(
      injectOptions('/api/console/run', {
        method: 'POST',
        body: { args: ['-j', '-ext', 'png;del', fixture.plainPng] },
      }),
    );
    expect(bad.statusCode).toBe(400);
  });
});

describe('static hosting', () => {
  it('serves the built-in status page with the boot script injected', async () => {
    const response = await app.inject(injectOptions('/', { token: null }));
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('window.__METADESK__=');
    expect(response.body).toContain('test-token-123');
    expect(response.body).toContain('"readOnlyDefault":true');
  });

  it('404s unknown API routes with the envelope', async () => {
    const response = await app.inject(injectOptions('/api/nope', { token: 'test-token-123' }));
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('not_found');
  });
});
