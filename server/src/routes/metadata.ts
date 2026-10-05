/**
 * Metadata read routes.
 *
 *  - GET /api/file/metadata?path=&depth=  -> one MetadataPayload
 *  - POST /api/metadata {paths, depth}    -> payloads for a folder view
 *    (batched: one engine round trip per ~100 files, never one per file)
 *
 * NOTE: the gate ledger's OWNS glob lists routes/{api,files,thumbnails,events}
 * but the build brief names "src/routes/metadata routes" explicitly; this file
 * is that route module. Flagged to the orchestrator for the ledger.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { MetadataDepth, MetadataPayload } from '@metadesk/shared';
import { PathRejectedError } from '../services/pathGuard.js';
import { assertSafePath } from '../services/pathGuard.js';
import type { MetadataService } from '../services/metadata.js';
import { sendError } from './api.js';

const DEPTHS: ReadonlySet<string> = new Set(['simple', 'all', 'raw']);
const MAX_BATCH_PATHS = 500;

export interface MetadataRouteDeps {
  metadata: MetadataService | null;
}

interface BatchBody {
  paths?: unknown;
  depth?: unknown;
}

export function registerMetadataRoutes(app: FastifyInstance, deps: MetadataRouteDeps): void {
  app.get(
    '/api/file/metadata',
    async (
      request: FastifyRequest<{ Querystring: { path?: string; depth?: string } }>,
      reply: FastifyReply,
    ) => {
      if (deps.metadata === null) {
        return sendError(reply, 503, 'engine_unavailable', 'The metadata engine is not running.');
      }
      const query = request.query ?? {};
      const depth = normalizeDepth(query['depth']);
      if (depth === null) {
        return sendError(reply, 400, 'bad_request', 'depth must be one of simple, all, raw.');
      }
      let filePath: string;
      try {
        filePath = assertSafePath(query['path']);
      } catch (error) {
        return pathError(reply, error);
      }
      const payloads = await deps.metadata.read([filePath], depth);
      const payload = payloads.get(filePath);
      if (payload === undefined) {
        return sendError(reply, 404, 'not_found', `No metadata could be read from "${filePath}".`);
      }
      if (payload.errors.length > 0 && payloadIsEmpty(payload)) {
        return sendError(reply, 422, 'engine_unavailable', payload.errors.join('; '), {
          filePath,
        });
      }
      return reply.code(200).send(payload);
    },
  );

  app.post(
    '/api/metadata',
    async (request: FastifyRequest<{ Body: BatchBody }>, reply: FastifyReply) => {
      if (deps.metadata === null) {
        return sendError(reply, 503, 'engine_unavailable', 'The metadata engine is not running.');
      }
      const body = request.body ?? {};
      const depth = normalizeDepth(body.depth);
      if (depth === null) {
        return sendError(reply, 400, 'bad_request', 'depth must be one of simple, all, raw.');
      }
      if (!Array.isArray(body.paths) || body.paths.some((p) => typeof p !== 'string')) {
        return sendError(reply, 400, 'bad_request', 'The body must be {"paths": string[], depth}.');
      }
      if (body.paths.length === 0) {
        return reply.code(200).send({ payloads: [] });
      }
      if (body.paths.length > MAX_BATCH_PATHS) {
        return sendError(
          reply,
          400,
          'bad_request',
          `At most ${MAX_BATCH_PATHS} paths per metadata batch.`,
        );
      }
      let paths: string[];
      try {
        paths = (body.paths as string[]).map((p) => assertSafePath(p));
      } catch (error) {
        return pathError(reply, error);
      }
      const payloadMap = await deps.metadata.read(paths, depth);
      const payloads = paths
        .map((p) => payloadMap.get(p))
        .filter((p): p is MetadataPayload => p !== undefined);
      return reply.code(200).send({ payloads });
    },
  );
}

function normalizeDepth(raw: unknown): MetadataDepth | null {
  if (typeof raw !== 'string' || !DEPTHS.has(raw)) return null;
  return raw as MetadataDepth;
}

function pathError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof PathRejectedError) {
    return sendError(reply, 400, 'path_rejected', error.message, { path: error.inputPath });
  }
  const message = error instanceof Error ? error.message : String(error);
  return sendError(reply, 400, 'bad_request', message);
}

function payloadIsEmpty(payload: MetadataPayload): boolean {
  return (
    Object.keys(payload.simple).length === 0 &&
    Object.keys(payload.all).length === 0 &&
    payload.raw.length === 0
  );
}
