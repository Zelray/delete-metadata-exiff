/**
 * Write/recovery route surface over a fully wired app (real engine, fastify
 * inject): session unlock gate on every mutating route, preview -> execute,
 * the always-visible mode on /api/health, history Verified chips, scrub
 * routes, and recovery scan/fix.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type { InjectOptions, InjectPayload } from 'light-my-request';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { registerHealthRoute } from '../../src/routes/api.js';
import { registerWriteRoutes } from '../../src/routes/writes.js';
import { registerRecoveryRoutes } from '../../src/routes/recovery.js';
import { makePipeline, makeWriteFixture, writeSdMetadata, type PipelineHarness, type WriteFixture } from './helpers.js';
import { PNG_1X1 } from '../helpers.js';
import { SCRUB_CONFIRMATION_PHRASE } from '../../src/services/scrub.js';

let fixture: WriteFixture;
let harness: PipelineHarness;
let app: FastifyInstance;

const TOKEN = 'write-routes-test-token';

async function inject(
  url: string,
  options: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<{ statusCode: number; body: any }> {
  const injectOptions: InjectOptions = {
    url,
    method: options.method ?? 'GET',
    headers: { 'x-metadesk-token': TOKEN, host: '127.0.0.1' },
  };
  if (options.body !== undefined) injectOptions.payload = options.body as InjectPayload;
  const response = await app.inject(injectOptions);
  return { statusCode: response.statusCode, body: response.json() };
}

beforeAll(async () => {
  fixture = await makeWriteFixture('metadesk-write-routes-');
  harness = await makePipeline(fixture, { unlocked: false });

  app = Fastify({ logger: false });
  registerHealthRoute(app, {
    getHealth: async () => ({
      ok: true,
      version: '12.99',
      readOnlyFallback: false,
      executablePath: 'test',
      minimumVersion: '12.70',
    }),
    hub: {
      setHealth: () => undefined,
    } as never,
  });
  registerWriteRoutes(app, { engine: harness.session, dataDir: fixture.dataDir });
  registerRecoveryRoutes(app, { dataDir: fixture.dataDir });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.shutdown();
  await fixture?.cleanup();
});

describe('mode visibility', () => {
  it('reflects the write-unlock state in /api/health (additive fields)', async () => {
    const locked = await inject('/api/health');
    expect(locked.body.writeUnlocked).toBe(false);
    expect(locked.body.mode).toBe('read-only');

    const unlocked = await inject('/api/session/unlock', { method: 'POST', body: {} });
    expect(unlocked.statusCode).toBe(200);
    expect(unlocked.body.writeUnlocked).toBe(true);
    expect(unlocked.body.commandPreview).toEqual([]);

    const health = await inject('/api/health');
    expect(health.body.writeUnlocked).toBe(true);
    expect(health.body.mode).toBe('write-unlocked');

    const relocked = await inject('/api/session/lock', { method: 'POST', body: {} });
    expect(relocked.body.writeUnlocked).toBe(false);
  });
});

describe('preview -> execute', () => {
  it('runs the full flow and carries commandPreview on every response', async () => {
    const png = await fixture.put('routes-flow.png');
    const edits = [{ tag: 'XMP-dc:Title', op: 'set', value: 'from the routes test' }];

    // Preview is allowed while read-only (it writes nothing).
    const preview = await inject('/api/write/preview', { method: 'POST', body: { files: [png], edits } });
    expect(preview.statusCode).toBe(200);
    expect(preview.body.preview.previewId).toMatch(/^pv_/);
    expect(preview.body.commandPreview[0]).toBe('-use');
    expect(preview.body.writeUnlocked).toBe(false);

    // Execute is refused while read-only.
    const refused = await inject('/api/write/execute', {
      method: 'POST',
      body: { previewId: preview.body.preview.previewId },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.body.code).toBe('read_only_mode');

    await inject('/api/session/unlock', { method: 'POST', body: {} });
    const executed = await inject('/api/write/execute', {
      method: 'POST',
      body: { previewId: preview.body.preview.previewId },
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.body.outcome.updated).toBe(1);
    expect(executed.body.outcome.files[0]?.verified).toBe(true);
    expect(executed.body.commandPreview).toEqual(preview.body.commandPreview);
  });

  it('rejects execute with an unknown preview id (409 preview_required)', async () => {
    await inject('/api/session/unlock', { method: 'POST', body: {} });
    const res = await inject('/api/write/execute', { method: 'POST', body: { previewId: 'pv_nope' } });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('preview_required');
  });

  it('rejects malformed edit bodies and non-whitelisted tags', async () => {
    const png = await fixture.put('routes-bad.png');
    const badOp = await inject('/api/write/preview', {
      method: 'POST',
      body: { files: [png], edits: [{ tag: 'XMP-dc:Title', op: 'nuke' }] },
    });
    expect(badOp.statusCode).toBe(400);
    const badTag = await inject('/api/write/preview', {
      method: 'POST',
      body: { files: [png], edits: [{ tag: 'PNG:all', op: 'delete' }] },
    });
    expect(badTag.statusCode).toBe(400);
    expect(badTag.body.code).toBe('unsafe_tag');
    const deleteWithValue = await inject('/api/write/preview', {
      method: 'POST',
      body: { files: [png], edits: [{ tag: 'XMP-dc:Title', op: 'delete', value: 'x' }] },
    });
    expect(deleteWithValue.statusCode).toBe(400);
  });

  it('streams SSE progress frames when stream:true', async () => {
    await inject('/api/session/unlock', { method: 'POST', body: {} });
    const png = await fixture.put('routes-stream.png');
    const preview = await inject('/api/write/preview', {
      method: 'POST',
      body: { files: [png], edits: [{ tag: 'XMP-dc:Title', op: 'set', value: 'streamed' }] },
    });
    const response = await app.inject({
      url: '/api/write/execute',
      method: 'POST',
      headers: { 'x-metadesk-token': TOKEN, host: '127.0.0.1' },
      payload: { previewId: preview.body.preview.previewId, stream: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('event: write-progress');
    expect(response.body).toContain('event: batch-complete');
    const completeLine = response.body
      .split('\n')
      .find((l) => l.startsWith('data: ') && l.includes('batch-complete'));
    expect(completeLine).toBeDefined();
    const frame = JSON.parse((completeLine as string).slice('data: '.length)) as {
      outcome: { updated: number };
      commandPreview: string[];
    };
    expect(frame.outcome.updated).toBe(1);
    expect(frame.commandPreview[0]).toBe('-use');
  });
});

describe('undo + history', () => {
  it('previews undo before confirming, executes it once, then refuses a second', async () => {
    await inject('/api/session/unlock', { method: 'POST', body: {} });
    const png = await fixture.put('routes-undo.png');
    const preview = await inject('/api/write/preview', {
      method: 'POST',
      body: { files: [png], edits: [{ tag: 'XMP-dc:Title', op: 'set', value: 'undo me' }] },
    });
    const executed = await inject('/api/write/execute', {
      method: 'POST',
      body: { previewId: preview.body.preview.previewId },
    });
    const batchId = executed.body.outcome.batchId;

    const undoPreview = await inject('/api/write/undo', { method: 'POST', body: { batchId } });
    expect(undoPreview.statusCode).toBe(200);
    expect(undoPreview.body.requiresConfirmation).toBe(true);
    expect(undoPreview.body.undoPreview.previewId).toMatch(/^pv_/);

    const undone = await inject('/api/write/undo', { method: 'POST', body: { batchId, confirm: true } });
    expect(undone.statusCode).toBe(200);
    expect(undone.body.undone).toBe(true);
    expect(undone.body.batches[0]?.outcome.files[0]?.verified).toBe(true);

    const second = await inject('/api/write/undo', { method: 'POST', body: { batchId, confirm: true } });
    expect(second.statusCode).toBe(400);
  });

  it('refuses undo while read-only', async () => {
    await inject('/api/session/lock', { method: 'POST', body: {} });
    const res = await inject('/api/write/undo', { method: 'POST', body: { batchId: 'wb_anything' } });
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('read_only_mode');
  });

  it('lists history with backup Verified chips computed from hashes', async () => {
    await inject('/api/session/unlock', { method: 'POST', body: {} });
    const history = await inject('/api/write/history');
    expect(history.statusCode).toBe(200);
    expect(history.body.batches.length).toBeGreaterThan(0);
    const withBackups = history.body.batches.find(
      (b: { backups: Array<unknown> }) => b.backups.length > 0,
    );
    expect(withBackups).toBeDefined();
    expect(withBackups.backups[0].verified).toBe(true);
    expect(withBackups.outcomes.some((o: { status: string }) => o.status === 'updated')).toBe(true);
  });
});

describe('scrub routes', () => {
  it('detects via POST /api/scrub/preview and wipes via POST /api/scrub/execute behind the phrase', async () => {
    const png = await fixture.put('routes-scrub.png');
    await writeSdMetadata(png);
    await inject('/api/session/unlock', { method: 'POST', body: {} });

    const report = await inject('/api/scrub/preview', { method: 'POST', body: { files: [png] } });
    expect(report.statusCode).toBe(200);
    expect(report.body.report.affectedTags.length).toBeGreaterThan(0);
    expect(report.body.report.confirmationPhrase).toBe(SCRUB_CONFIRMATION_PHRASE);

    const wrongPhrase = await inject('/api/scrub/execute', {
      method: 'POST',
      body: { files: [png], confirm: 'yes' },
    });
    expect(wrongPhrase.statusCode).toBe(403);
    expect(wrongPhrase.body.message).toMatch(/REMOVE AI METADATA/);

    const wipe = await inject('/api/scrub/execute', {
      method: 'POST',
      body: { files: [png], confirm: SCRUB_CONFIRMATION_PHRASE },
    });
    expect(wipe.statusCode).toBe(200);
    expect(wipe.body.outcome.files[0]?.verified).toBe(true);
    expect(wipe.body.exportedValuesPath).toMatch(/journal[\\/]exports/);
  });

  it('refuses scrub execute while read-only', async () => {
    await inject('/api/session/lock', { method: 'POST', body: {} });
    const png = await fixture.put('routes-scrub-locked.png');
    const res = await inject('/api/scrub/execute', {
      method: 'POST',
      body: { files: [png], confirm: SCRUB_CONFIRMATION_PHRASE },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('read_only_mode');
  });
});

describe('recovery routes', () => {
  it('scans folders and journal, and gates fixes behind confirm:true', async () => {
    await mkdir(fixture.pathOf('recov'), { recursive: true });
    const png = fixture.pathOf(path.join('recov', 'photo.png'));
    await writeFile(png, PNG_1X1);
    await writeFile(`${png}_exiftool_tmp`, 'debris');

    const scanUrl = `/api/recovery/scan?folders=${encodeURIComponent(fixture.pathOf('recov'))}`;
    const scan = await inject(scanUrl);
    expect(scan.statusCode).toBe(200);
    expect(scan.body.clean).toBe(false);
    expect(scan.body.folders[0]?.orphanTempFiles[0]?.path).toBe(`${png}_exiftool_tmp`);
    expect(scan.body.commandPreview).toEqual([]);

    const noConfirm = await inject('/api/recovery/fix', {
      method: 'POST',
      body: { action: 'delete-orphan-temp', path: `${png}_exiftool_tmp`, confirm: false },
    });
    expect(noConfirm.statusCode).toBe(403);

    const fixed = await inject('/api/recovery/fix', {
      method: 'POST',
      body: { action: 'delete-orphan-temp', path: `${png}_exiftool_tmp`, confirm: true },
    });
    expect(fixed.statusCode).toBe(200);
    expect(fixed.body.message).toMatch(/Deleted/);

    const clean = await inject(scanUrl);
    expect(clean.body.clean).toBe(true);
  });

  it('rejects unknown actions and bad paths', async () => {
    const unknown = await inject('/api/recovery/fix', {
      method: 'POST',
      body: { action: 'format-c-drive', confirm: true },
    });
    expect(unknown.statusCode).toBe(400);
    const badPath = await inject('/api/recovery/scan?folders=relative%5Cpath');
    expect(badPath.statusCode).toBe(400);
    expect(badPath.body.code).toBe('path_rejected');
  });
});
