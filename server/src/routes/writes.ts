/**
 * Write-surface routes (leaf 1.1.4): the session unlock gate, the mandatory
 * preview -> execute write pipeline, undo, history, and the AI scrub.
 *
 * Pinned route paths (BUILD-NOTES):
 *   POST /api/session/unlock     unlock writing for this server session
 *   POST /api/session/lock       re-lock (back to the read-only default)
 *   POST /api/write/preview      {files, edits}          -> WritePreview
 *                                 {files, destructive:{scope:"gps"}} -> GPS-strip preview
 *   POST /api/write/execute      {previewId}             -> BatchOutcome
 *                                 (optionally {"stream": true} -> SSE frames;
 *                                  optionally {"destructive":{"confirmationPhrase"}}
 *                                  for the GPS strip — server-gated)
 *   POST /api/write/cancel       {batchId}               -> cooperative cancel flag
 *                                 (honored between chunks; in-flight files finish)
 *   POST /api/write/undo         {batchId[, confirm]}    -> undo preview/result
 *   GET  /api/write/history                              -> journal history
 *                                 (+ additive scrubId/exportedValuesPath)
 *   POST /api/scrub/preview      {files}                 -> AI-metadata report
 *   POST /api/scrub/execute      {files, confirm}        -> gated wipe
 *
 * Safety shape:
 *  - The GLOBAL DEFAULT IS READ-ONLY. Execute routes refuse until
 *    /api/session/unlock has been called for this server session, and the
 *    mode is always visible: every /api/health response carries the additive
 *    `writeUnlocked`/`mode` fields (stamped by the onSend hook in index.ts), and
 *    unlock/lock emit an additive `mode-changed` SSE event (the announce the
 *    WriteSubsystem fuses into its unlock()/lock()).
 *  - Preview is read-only (scratch-copy simulation) and is MANDATORY: execute
 *    accepts only a previewId this server produced, and only once.
 *  - Every mutating response carries `commandPreview`: the exact argv array
 *    that was (or will be) executed.
 *  - Execute streams progress as SSE-shaped frames (shared SseWriteProgress /
 *    SseBatchComplete payloads) on the execute response itself when
 *    {"stream": true} is set.
 *
 * The mode, the ONE journal, and the pipeline/scrub/strip services are owned
 * by the WriteSubsystem (src/writeSubsystem.ts) the composition root builds
 * once — these routes construct no write state of their own.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TagEdit } from '@metadesk/shared';
import { ArgBuildError } from '../engine/argBuilder.js';
import { PathRejectedError } from '../services/pathGuard.js';
import { WritePipelineError, type ExecuteOptions } from '../services/writePipeline.js';
import { SCRUB_CONFIRMATION_PHRASE } from '../services/scrub.js';
import { GPS_CONFIRMATION_PHRASE } from '../services/gpsStrip.js';
import type { BatchStartRecord } from '../services/journal.js';
import type { WriteSubsystem } from '../writeSubsystem.js';
import { sendError } from './api.js';

export interface WriteRouteDeps {
  /** The ONE write subsystem (mode + journal + pipeline/scrub/strip). */
  write: WriteSubsystem;
}

const MAX_SCRUB_FILES = 1000;
const EDIT_OPS: ReadonlySet<string> = new Set(['set', 'delete', 'append', 'remove']);

export function registerWriteRoutes(app: FastifyInstance, deps: WriteRouteDeps): void {
  const write = deps.write;
  // Readonly views of the subsystem's state and services (null iff the
  // engine is null; the routes gate on that exactly as before).
  const journal = write.journal;
  const pipeline = write.pipeline;
  const scrub = write.scrub;
  const gpsStrip = write.gpsStrip;

  // ---- session unlock / lock -------------------------------------------------

  app.post('/api/session/unlock', async (_request: FastifyRequest, reply: FastifyReply) => {
    const result = write.unlock();
    return reply.code(200).send({
      ...result,
      commandPreview: [],
      note: 'Writing is unlocked for this session. Every write still requires a preview, runs in backup mode, and is journalled.',
    });
  });

  app.post('/api/session/lock', async (_request: FastifyRequest, reply: FastifyReply) => {
    const result = write.lock();
    return reply.code(200).send({ ...result, commandPreview: [] });
  });

  // ---- write preview / execute ------------------------------------------------

  app.post(
    '/api/write/preview',
    async (request: FastifyRequest<{ Body: PreviewBody }>, reply: FastifyReply) => {
      if (pipeline === null || gpsStrip === null) {
        return sendError(reply, 503, 'engine_unavailable', 'The exiftool engine is not running.');
      }
      const body = request.body ?? {};

      // Destructive channel: ONLY the GPS strip is accepted here, with the
      // server's own curated whitelist — the client declares intent, never a
      // tag list. Edits are rejected on this path (the strip's delete list is
      // fixed), and the mandatory pre-write export is produced NOW so the
      // preview cannot be executed without it.
      if (body.destructive !== undefined) {
        const scopeError = validateGpsDestructiveBody(body);
        if (scopeError !== null) {
          return sendError(reply, 400, 'bad_request', scopeError);
        }
        const files = parseFilesBody(body);
        if (typeof files === 'string') return sendError(reply, 400, 'bad_request', files);
        try {
          const strip = await gpsStrip.preview(files);
          return reply.code(200).send({
            preview: strip.envelope.preview,
            commandPreview: strip.envelope.commandPreview,
            diffNotes: strip.envelope.diffNotes,
            writeUnlocked: write.writeUnlocked,
            destructive: {
              scope: 'gps',
              requiresTypedConfirmation: true,
              confirmationPhrase: GPS_CONFIRMATION_PHRASE,
            },
            gpsStripId: strip.gpsStripId,
            exportedValuesPath: strip.exportedValuesPath,
            notRemoved: strip.notRemoved,
          });
        } catch (error) {
          return writeError(reply, error);
        }
      }

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
          writeUnlocked: write.writeUnlocked,
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
      const confirmationPhrase = parseConfirmationPhrase(body);
      if (confirmationPhrase === null) {
        return sendError(
          reply,
          400,
          'bad_request',
          'The destructive field, when present, must be {"destructive": {"confirmationPhrase": string}}.',
        );
      }
      const executeOptions: ExecuteOptions = {
        ...(confirmationPhrase !== undefined ? { destructive: { confirmationPhrase } } : {}),
      };

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
          ...executeOptions,
          onProgress: (event) => send('write-progress', { ...event }),
        };
        try {
          const result = await pipeline.execute(body.previewId, progressOptions);
          // A cancelled batch reports its cancellation as its own additive
          // frame before the completion payload (clients ignore unknown types).
          if ((result.outcome as { cancelled?: boolean }).cancelled === true) {
            send('batch-cancelled', {
              batchId: result.outcome.batchId,
              cancelledAt: (result.outcome as { cancelledAt?: string }).cancelledAt,
              notAttemptedFilePaths: (result.outcome as { notAttemptedFilePaths?: string[] })
                .notAttemptedFilePaths,
            });
          }
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
        const result = await pipeline.execute(body.previewId, executeOptions);
        return reply.code(200).send({
          outcome: result.outcome,
          commandPreview: result.commandPreview,
          consistencyNotes: result.consistencyNotes,
          writeUnlocked: write.writeUnlocked,
        });
      } catch (error) {
        return writeError(reply, error);
      }
    },
  );

  // ---- graceful batch cancel ---------------------------------------------------

  app.post(
    '/api/write/cancel',
    async (request: FastifyRequest<{ Body: CancelBody }>, reply: FastifyReply) => {
      if (pipeline === null) {
        return sendError(reply, 503, 'engine_unavailable', 'The exiftool engine is not running.');
      }
      const body = request.body ?? {};
      if (typeof body.batchId !== 'string' || body.batchId.length === 0) {
        return sendError(reply, 400, 'bad_request', 'The body must include {"batchId": string}.');
      }
      const result = pipeline.requestCancel(body.batchId);
      if (!result.requested) {
        return sendError(reply, 404, 'not_found', result.note);
      }
      return reply.code(200).send({
        batchId: body.batchId,
        cancelRequested: true,
        note: result.note,
        commandPreview: [],
      });
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
      if (!write.writeUnlocked) {
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
        // Additive history fields (leaf 1.1.4b): destructive flows carry the
        // scrub/strip id and the pre-write sidecar export path on their
        // batch-start record, restated here for the History view.
        const { records } = await journal.readBatch(batchId);
        const start = records.find((r): r is BatchStartRecord => r.kind === 'batch-start');
        const extras: Record<string, unknown> = {};
        if (start?.scrubId !== undefined) extras['scrubId'] = start.scrubId;
        if (start?.destructive?.exportPath !== undefined) {
          extras['exportedValuesPath'] = start.destructive.exportPath;
        }
        // Verified chips: each backup is hashed against the journal record now.
        const backups = [];
        for (const outcome of history.outcomes) {
          if (outcome.backup === undefined) continue;
          const verification = await journal.verifyBackup(outcome.backup);
          backups.push({ filePath: outcome.filePath, backup: outcome.backup, verified: verification.verified });
        }
        batches.push({ ...history, ...extras, backups });
      }
      return reply.code(200).send({
        batches,
        writeUnlocked: write.writeUnlocked,
        mode: write.mode,
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
      if (!write.writeUnlocked) {
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
  destructive?: unknown;
}
interface ExecuteBody {
  previewId?: unknown;
  stream?: unknown;
  destructive?: unknown;
}
interface CancelBody {
  batchId?: unknown;
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

// ---- GPS destructive-channel body helpers -------------------------------------

/**
 * Validate the destructive field on the generic preview channel. ONLY the GPS
 * strip is accepted, the client declares scope but never a tag list (the
 * whitelist is server-curated), and explicit edits are refused — the strip's
 * delete list is fixed. Returns an error message or null.
 */
function validateGpsDestructiveBody(body: PreviewBody): string | null {
  const destructive = body.destructive as Record<string, unknown> | null;
  if (typeof destructive !== 'object' || destructive === null || Array.isArray(destructive)) {
    return 'The destructive field must be an object: {"destructive": {"scope": "gps"}}.';
  }
  if (destructive['scope'] !== 'gps') {
    return 'Only {"destructive": {"scope": "gps"}} is accepted on this channel; other destructive flows have their own routes.';
  }
  const extraKeys = Object.keys(destructive).filter((key) => key !== 'scope');
  if (extraKeys.length > 0) {
    return `The GPS destructive preview takes only {"scope": "gps"} (unexpected: ${extraKeys.join(', ')}).`;
  }
  if (Array.isArray(body.edits) && body.edits.length > 0) {
    return 'Omit "edits" on a GPS-strip preview: the delete list is the engine-approved GPS tag set, applied to every selected file.';
  }
  return null;
}

/** Validate and return the {files} body; returns a message on any problem. */
function parseFilesBody(body: PreviewBody): string[] | string {
  if (!Array.isArray(body.files) || body.files.some((f) => typeof f !== 'string')) {
    return 'The body must be {"files": string[]}.';
  }
  if (body.files.length === 0) return 'At least one file is required.';
  return body.files as string[];
}

/**
 * The execute request's typed phrase, or null on a malformed destructive
 * field, or undefined when no destructive confirmation was sent.
 */
function parseConfirmationPhrase(body: ExecuteBody): string | undefined | null {
  if (body.destructive === undefined) return undefined;
  const destructive = body.destructive as Record<string, unknown> | null;
  if (
    typeof destructive !== 'object' ||
    destructive === null ||
    typeof destructive['confirmationPhrase'] !== 'string'
  ) {
    return null;
  }
  return destructive['confirmationPhrase'];
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
