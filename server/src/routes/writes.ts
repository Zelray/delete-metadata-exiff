/**
 * Write-surface routes (leaf 1.1.4): the session unlock gate, the mandatory
 * preview -> execute write pipeline, undo, history, and the AI scrub.
 *
 * Pinned route paths (BUILD-NOTES):
 *   POST /api/session/unlock     unlock writing for this server session
 *   POST /api/session/lock       re-lock (back to the read-only default)
 *   POST /api/write/preview      {files, edits}          -> WritePreview
 *   POST /api/write/execute      {previewId}             -> BatchOutcome
 *                                 (optionally {"stream": true} -> SSE frames)
 *   POST /api/write/undo         {batchId[, confirm]}    -> undo preview/result
 *   GET  /api/write/history                              -> journal history
 *   POST /api/scrub/preview      {files}                 -> AI-metadata report
 *   POST /api/scrub/execute      {files, confirm}        -> gated wipe
 *
 * Safety shape:
 *  - The GLOBAL DEFAULT IS READ-ONLY. Execute routes refuse until
 *    /api/session/unlock has been called for this server session, and the
 *    mode is always visible: every /api/health response carries the additive
 *    `writeUnlocked` field (added here by an onSend hook), and unlock/lock
 *    emit an additive `mode-changed` SSE event.
 *  - Preview is read-only (scratch-copy simulation) and is MANDATORY: execute
 *    accepts only a previewId this server produced, and only once.
 *  - Every mutating response carries `commandPreview`: the exact argv array
 *    that was (or will be) executed.
 *  - Execute streams progress as SSE-shaped frames (shared SseWriteProgress /
 *    SseBatchComplete payloads) on the execute response itself when
 *    {"stream": true} is set.
 *
 * FLAGGED TO THE ORCHESTRATOR: SseHub (routes/events.ts, leaf 1.1.2) has no
 * public publish API for additive event types, so `mode-changed` is emitted
 * through a guarded adapter over the hub's internal broadcast. The one-line
 * upstream fix is a public `publishModeChanged()`; this adapter degrades to a
 * no-op (and the mode stays visible via /api/health) if the hub changes.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TagEdit } from '@metadesk/shared';
import type { ExifToolSession } from '../engine/exiftoolSession.js';
import { ArgBuildError } from '../engine/argBuilder.js';
import { PathRejectedError } from '../services/pathGuard.js';
import {
  WritePipeline,
  WritePipelineError,
  type ExecuteOptions,
} from '../services/writePipeline.js';
import { ScrubService, SCRUB_CONFIRMATION_PHRASE } from '../services/scrub.js';
import { Journal } from '../services/journal.js';
import type { SseHub } from './events.js';
import { sendError } from './api.js';

// ---- session write-unlock state ---------------------------------------------

export type WriteMode = 'read-only' | 'write-unlocked';

/** In-memory, session-scoped write unlock. The server process IS the session:
 *  a restart drops back to the read-only default by construction. */
export class WriteSessionState {
  private unlockedAt: string | null = null;

  get writeUnlocked(): boolean {
    return this.unlockedAt !== null;
  }

  get mode(): WriteMode {
    return this.writeUnlocked ? 'write-unlocked' : 'read-only';
  }

  unlock(): { mode: WriteMode; writeUnlocked: true; unlockedAt: string } {
    this.unlockedAt = new Date().toISOString();
    return { mode: this.mode, writeUnlocked: true, unlockedAt: this.unlockedAt };
  }

  lock(): { mode: WriteMode; writeUnlocked: false } {
    this.unlockedAt = null;
    return { mode: this.mode, writeUnlocked: false };
  }
}

export interface WriteRouteDeps {
  engine: ExifToolSession | null;
  /** Mutable app state dir (journal, scratch, write temp files). */
  dataDir: string;
  hub?: SseHub;
  /** Provider used by the execute gate; defaults to the local session state. */
  sessionState?: WriteSessionState;
}

const MAX_SCRUB_FILES = 1000;
const EDIT_OPS: ReadonlySet<string> = new Set(['set', 'delete', 'append', 'remove']);

export function registerWriteRoutes(app: FastifyInstance, deps: WriteRouteDeps): void {
  const session = deps.sessionState ?? new WriteSessionState();
  const journal = new Journal({ dataDir: deps.dataDir });
  const pipeline =
    deps.engine !== null
      ? new WritePipeline({
          engine: deps.engine,
          dataDir: deps.dataDir,
          journal,
          isWriteUnlocked: () => session.writeUnlocked,
        })
      : null;
  const scrub =
    deps.engine !== null && pipeline !== null
      ? new ScrubService({ engine: deps.engine, pipeline, dataDir: deps.dataDir })
      : null;

  // The always-visible mode: every /api/health response gains the additive
  // writeUnlocked/mode fields (the launcher ignores unknown fields).
  app.addHook('onSend', async (request, _reply, payload) => {
    const url = request.raw.url ?? '';
    if (!url.startsWith('/api/health') || typeof payload !== 'string') return payload;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      parsed['writeUnlocked'] = session.writeUnlocked;
      parsed['mode'] = session.mode;
      return JSON.stringify(parsed);
    } catch {
      return payload;
    }
  });

  // ---- session unlock / lock -------------------------------------------------

  app.post('/api/session/unlock', async (_request: FastifyRequest, reply: FastifyReply) => {
    const result = session.unlock();
    publishModeChanged(deps.hub, true);
    return reply.code(200).send({
      ...result,
      commandPreview: [],
      note: 'Writing is unlocked for this session. Every write still requires a preview, runs in backup mode, and is journalled.',
    });
  });

  app.post('/api/session/lock', async (_request: FastifyRequest, reply: FastifyReply) => {
    const result = session.lock();
    publishModeChanged(deps.hub, false);
    return reply.code(200).send({ ...result, commandPreview: [] });
  });

  // ---- write preview / execute ------------------------------------------------

  app.post(
    '/api/write/preview',
    async (request: FastifyRequest<{ Body: PreviewBody }>, reply: FastifyReply) => {
      if (pipeline === null) {
        return sendError(reply, 503, 'engine_unavailable', 'The exiftool engine is not running.');
      }
      const body = request.body ?? {};
      const parsed = parseEditsBody(body);
      if (typeof parsed === 'string') {
        return sendError(reply, 400, 'bad_request', parsed);
      }
      try {
        const envelope = await pipeline.preview({
          files: parsed.files,
          edits: parsed.edits,
          ...(typeof body.timezone === 'string' && body.timezone.length > 0 ? { timezone: body.timezone } : {}),
        });
        return reply.code(200).send({
          preview: envelope.preview,
          commandPreview: envelope.commandPreview,
          diffNotes: envelope.diffNotes,
          writeUnlocked: session.writeUnlocked,
        });
      } catch (error) {
        return writeError(reply, error);
      }
    },
  );

  app.post(
    '/api/write/execute',
    async (request: FastifyRequest<{ Body: ExecuteBody }>, reply: FastifyReply) => {
      if (pipeline === null) {
        return sendError(reply, 503, 'engine_unavailable', 'The exiftool engine is not running.');
      }
      const body = request.body ?? {};
      if (typeof body.previewId !== 'string' || body.previewId.length === 0) {
        return sendError(reply, 400, 'bad_request', 'The body must include {"previewId": string}.');
      }

      if (body.stream === true) {
        // Stream progress as SSE-shaped frames on this response (shared
        // SseWriteProgress / SseBatchComplete payloads).
        reply.hijack();
        reply.raw.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        });
        reply.raw.flushHeaders?.();
        let seq = 1;
        const send = (type: string, payload: Record<string, unknown>): void => {
          const frame = { seq: seq++, timestamp: new Date().toISOString(), type, ...payload };
          try {
            reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(frame)}\n\n`);
          } catch {
            /* client vanished; the batch itself is unaffected */
          }
        };
        const progressOptions: ExecuteOptions = {
          onProgress: (event) => send('write-progress', { ...event }),
        };
        try {
          const result = await pipeline.execute(body.previewId, progressOptions);
          send('batch-complete', {
            batchId: result.outcome.batchId,
            outcome: result.outcome,
            commandPreview: result.commandPreview,
          });
        } catch (error) {
          const mapped = mapWriteError(error);
          send('write-error', { code: mapped.code, message: mapped.message });
        } finally {
          try {
            reply.raw.end();
          } catch {
            /* already closed */
          }
        }
        return await Promise.resolve();
      }

      try {
        const result = await pipeline.execute(body.previewId);
        return reply.code(200).send({
          outcome: result.outcome,
          commandPreview: result.commandPreview,
          consistencyNotes: result.consistencyNotes,
          writeUnlocked: session.writeUnlocked,
        });
      } catch (error) {
        return writeError(reply, error);
      }
    },
  );

  // ---- undo / history -----------------------------------------------------------

  app.post(
    '/api/write/undo',
    async (request: FastifyRequest<{ Body: UndoBody }>, reply: FastifyReply) => {
      if (pipeline === null) {
        return sendError(reply, 503, 'engine_unavailable', 'The exiftool engine is not running.');
      }
      const body = request.body ?? {};
      if (typeof body.batchId !== 'string' || body.batchId.length === 0) {
        return sendError(reply, 400, 'bad_request', 'The body must include {"batchId": string}.');
      }
      if (!session.writeUnlocked) {
        return sendError(
          reply,
          403,
          'read_only_mode',
          'Undo writes to your files. Unlock writing for this session first.',
        );
      }
      try {
        if (body.confirm !== true) {
          // Step 1 of the one-click flow: show exactly what the undo restores.
          const envelope = await pipeline.prepareUndo(body.batchId);
          return reply.code(200).send({
            requiresConfirmation: true,
            undoPreview: envelope.preview,
            commandPreview: envelope.commandPreview,
          });
        }
        const { results } = await pipeline.undoBatch(body.batchId);
        return reply.code(200).send({
          undone: true,
          batches: results.map((r) => ({
            batchId: r.outcome.batchId,
            outcome: r.outcome,
            commandPreview: r.commandPreview,
          })),
          commandPreview: results[0]?.commandPreview ?? [],
        });
      } catch (error) {
        return writeError(reply, error);
      }
    },
  );

  app.get(
    '/api/write/history',
    async (request: FastifyRequest<{ Querystring: { limit?: string } }>, reply: FastifyReply) => {
      const limitRaw = Number.parseInt(request.query.limit ?? '', 10);
      const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 20;
      const batchIds = await journal.listBatchIds(limit);
      const batches: Array<Record<string, unknown>> = [];
      for (const batchId of batchIds) {
        const history = await journal.batchHistory(batchId);
        if (history === null) continue;
        // Verified chips: each backup is hashed against the journal record now.
        const backups = [];
        for (const outcome of history.outcomes) {
          if (outcome.backup === undefined) continue;
          const verification = await journal.verifyBackup(outcome.backup);
          backups.push({ filePath: outcome.filePath, backup: outcome.backup, verified: verification.verified });
        }
        batches.push({ ...history, backups });
      }
      return reply.code(200).send({
        batches,
        writeUnlocked: session.writeUnlocked,
        mode: session.mode,
        commandPreview: [],
      });
    },
  );

  // ---- AI scrub -------------------------------------------------------------------

  app.post(
    '/api/scrub/preview',
    async (request: FastifyRequest<{ Body: ScrubPreviewBody }>, reply: FastifyReply) => {
      if (scrub === null) {
        return sendError(reply, 503, 'engine_unavailable', 'The exiftool engine is not running.');
      }
      const body = request.body ?? {};
      if (!Array.isArray(body.files) || body.files.some((f) => typeof f !== 'string')) {
        return sendError(reply, 400, 'bad_request', 'The body must be {"files": string[]}.');
      }
      if (body.files.length === 0) {
        return sendError(reply, 400, 'bad_request', 'At least one file is required.');
      }
      if (body.files.length > MAX_SCRUB_FILES) {
        return sendError(reply, 400, 'bad_request', `At most ${MAX_SCRUB_FILES} files per scrub scan.`);
      }
      try {
        const report = await scrub.detect(body.files as string[], {
          includeFullValues: body.includeFullValues === true,
        });
        return reply.code(200).send({
          report,
          commandPreview: [],
          note: 'Read-only scan. Removing what it found is destructive and requires typing the confirmation phrase.',
        });
      } catch (error) {
        return writeError(reply, error);
      }
    },
  );

  app.post(
    '/api/scrub/execute',
    async (request: FastifyRequest<{ Body: ScrubExecuteBody }>, reply: FastifyReply) => {
      if (scrub === null) {
        return sendError(reply, 503, 'engine_unavailable', 'The exiftool engine is not running.');
      }
      const body = request.body ?? {};
      if (!Array.isArray(body.files) || body.files.some((f) => typeof f !== 'string')) {
        return sendError(reply, 400, 'bad_request', 'The body must be {"files": string[], "confirm": string}.');
      }
      if (!session.writeUnlocked) {
        return sendError(
          reply,
          403,
          'read_only_mode',
          'The scrub writes to your files. Unlock writing for this session first.',
        );
      }
      if (typeof body.confirm !== 'string') {
        return sendError(
          reply,
          403,
          'unsafe_tag',
          `This is a destructive operation. Type "${SCRUB_CONFIRMATION_PHRASE}" to confirm. Nothing was written.`,
        );
      }
      try {
        const wipe = await scrub.wipe(body.files as string[], body.confirm);
        return reply.code(200).send({
          outcome: wipe.result.outcome,
          commandPreview: wipe.result.commandPreview,
          consistencyNotes: wipe.result.consistencyNotes,
          report: wipe.detection,
          exportedValuesPath: wipe.exportedValuesPath,
          notRemoved: wipe.notRemoved,
        });
      } catch (error) {
        return writeError(reply, error);
      }
    },
  );
}

// ---- helpers -----------------------------------------------------------------

interface PreviewBody {
  files?: unknown;
  edits?: unknown;
  timezone?: unknown;
}
interface ExecuteBody {
  previewId?: unknown;
  stream?: unknown;
}
interface UndoBody {
  batchId?: unknown;
  confirm?: unknown;
}
interface ScrubPreviewBody {
  files?: unknown;
  includeFullValues?: unknown;
}
interface ScrubExecuteBody {
  files?: unknown;
  confirm?: unknown;
}

/** Validate the {files, edits} body; returns a message on any problem. */
function parseEditsBody(body: PreviewBody): { files: string[]; edits: TagEdit[] } | string {
  if (!Array.isArray(body.files) || body.files.some((f) => typeof f !== 'string')) {
    return 'The body must be {"files": string[], "edits": TagEdit[]}.';
  }
  if (!Array.isArray(body.edits) || body.edits.length === 0) {
    return 'At least one edit is required.';
  }
  for (const raw of body.edits) {
    const edit = raw as Partial<TagEdit>;
    if (typeof edit !== 'object' || edit === null) return 'Each edit must be an object.';
    if (typeof edit.tag !== 'string' || edit.tag.length === 0) return 'Each edit needs a "tag".';
    if (typeof edit.op !== 'string' || !EDIT_OPS.has(edit.op)) {
      return `Edit op must be one of set, delete, append, remove (got "${String(edit.op)}").`;
    }
    if ((edit.op === 'set' || edit.op === 'append' || edit.op === 'remove') && typeof edit.value !== 'string') {
      return `Edit op "${edit.op}" needs a string "value".`;
    }
    if (edit.op === 'delete' && edit.value !== undefined && edit.value.length > 0) {
      return 'A delete edit takes no value. Use "set" to change a tag.';
    }
  }
  return {
    files: body.files as string[],
    edits: body.edits as TagEdit[],
  };
}

interface MappedError {
  statusCode: number;
  code: string;
  message: string;
}

function mapWriteError(error: unknown): MappedError {
  if (error instanceof WritePipelineError) {
    switch (error.code) {
      case 'read_only_mode':
        return { statusCode: 403, code: 'read_only_mode', message: error.message };
      case 'write_locked':
        return { statusCode: 409, code: 'write_locked', message: error.message };
      case 'preview_required':
      case 'preview_expired':
        return { statusCode: 409, code: 'preview_required', message: error.message };
      case 'destructive_confirmation_required':
        return { statusCode: 403, code: 'unsafe_tag', message: error.message };
      case 'batch_too_large':
      case 'validation':
      case 'undo_unavailable':
      case 'already_undone':
        return { statusCode: 400, code: 'bad_request', message: error.message };
      default:
        return { statusCode: 400, code: 'bad_request', message: error.message };
    }
  }
  if (error instanceof ArgBuildError) {
    return { statusCode: 400, code: 'unsafe_tag', message: error.message };
  }
  if (error instanceof PathRejectedError) {
    return { statusCode: 400, code: 'path_rejected', message: error.message };
  }
  return {
    statusCode: 500,
    code: 'internal_error',
    message: error instanceof Error ? error.message : String(error),
  };
}

function writeError(reply: FastifyReply, error: unknown): FastifyReply {
  const mapped = mapWriteError(error);
  return sendError(reply, mapped.statusCode, mapped.code as never, mapped.message);
}

/** Emit the additive `mode-changed` SSE event through the hub's broadcast. */
function publishModeChanged(hub: SseHub | undefined, writeUnlocked: boolean): void {
  if (hub === undefined) return;
  const broadcaster = hub as unknown as { broadcast?: (payload: Record<string, unknown>) => void };
  if (typeof broadcaster.broadcast !== 'function') return;
  broadcaster.broadcast({
    type: 'mode-changed',
    writeUnlocked,
    mode: writeUnlocked ? 'write-unlocked' : 'read-only',
  });
}
