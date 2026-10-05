/**
 * File routes: folder scan and the single-binary-tag endpoint.
 *
 * `GET /api/file/binary?path=&tag=` is the pinned binary extraction route:
 * it streams one whitelisted binary tag (thumbnail/preview/ICC) as raw bytes.
 * The tag comes from a fixed whitelist — never from a user-spelled tag name.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { FolderScanRequest } from '@metadesk/shared';
import type { FolderWatcher } from '../services/watcher.js';
import { PathRejectedError } from '../services/pathGuard.js';
import { ScanError, scanFolder } from '../services/scan.js';
import { BINARY_TAG_WHITELIST, type ThumbnailService } from '../services/thumbnails.js';
import type { SseHub } from './events.js';
import { sendError } from './api.js';

export interface FileRouteDeps {
  engine: import('../engine/exiftoolSession.js').ExifToolSession | null;
  thumbnails: ThumbnailService;
  hub: SseHub;
  watcher: FolderWatcher;
}

export function registerFileRoutes(app: FastifyInstance, deps: FileRouteDeps): void {
  app.post(
    '/api/files/scan',
    async (
      request: FastifyRequest<{ Body: Partial<FolderScanRequest> }>,
      reply: FastifyReply,
    ) => {
      const body = request.body ?? {};
      if (typeof body.folder !== 'string') {
        return sendError(reply, 400, 'bad_request', 'The body must include {"folder": string}.');
      }
      try {
        const result = await scanFolder(
          {
            folder: body.folder,
            recursive: body.recursive === true,
            extensions: Array.isArray(body.extensions) ? body.extensions : undefined,
            excludeEngineArtifacts: body.excludeEngineArtifacts !== false,
          },
          {
            engine: deps.engine,
            onScanProgress: (event) => deps.hub.publishScanProgress(event),
            onScanComplete: (event) => deps.hub.publishScanComplete(event),
          },
        );
        // Watcher lifecycle is tied to the scan session: every successful
        // scan replaces the previous watch.
        await deps.watcher.start(result.folder, { recursive: result.recursive });
        return reply.code(200).send(result);
      } catch (error) {
        if (error instanceof PathRejectedError) {
          return sendError(reply, 400, 'path_rejected', error.message, { path: error.inputPath });
        }
        if (error instanceof ScanError) {
          const code = error.code === 'not_found' ? 'not_found' : 'path_rejected';
          return sendError(reply, code === 'not_found' ? 404 : 400, code, error.message);
        }
        throw error;
      }
    },
  );

  app.get(
    '/api/file/binary',
    async (
      request: FastifyRequest<{ Querystring: { path?: string; tag?: string } }>,
      reply: FastifyReply,
    ) => {
      const query = request.query ?? {};
      const filePath = query['path'];
      const tag = query['tag'];
      if (typeof filePath !== 'string' || filePath.length === 0) {
        return sendError(reply, 400, 'bad_request', 'A "path" query parameter is required.');
      }
      if (typeof tag !== 'string' || tag.length === 0) {
        return sendError(reply, 400, 'bad_request', 'A "tag" query parameter is required.');
      }
      if (!BINARY_TAG_WHITELIST.has(tag)) {
        return sendError(
          reply,
          400,
          'unsafe_tag',
          `"${tag}" is not a binary tag MetaDesk extracts. Allowed: ${[...BINARY_TAG_WHITELIST].join(', ')}.`,
        );
      }
      try {
        const bytes = await deps.thumbnails.extractBinaryTag(filePath, tag);
        if (bytes === null) {
          return sendError(
            reply,
            404,
            'not_found',
            `The file has no ${tag} embedded (or it is empty).`,
          );
        }
        reply.header('content-type', sniffImageType(bytes));
        reply.header('content-length', bytes.length);
        reply.header('cache-control', 'private, max-age=300');
        return reply.code(200).send(bytes);
      } catch (error) {
        if (error instanceof PathRejectedError) {
          return sendError(reply, 400, 'path_rejected', error.message, { path: error.inputPath });
        }
        const message = error instanceof Error ? error.message : String(error);
        if (/ENOENT|no such file/i.test(message)) {
          return sendError(reply, 404, 'not_found', `The file "${filePath}" does not exist.`);
        }
        throw error;
      }
    },
  );
}

/** JPEG/embedded previews are JPEG; everything else streams as octet-stream. */
function sniffImageType(bytes: Buffer): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  return 'application/octet-stream';
}
