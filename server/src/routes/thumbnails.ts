/**
 * Thumbnail route: `GET /api/thumbnail?path=`.
 *
 * Serves the best embedded preview as image/jpeg with immutable caching
 * headers (the cache key is path+mtime+size, so an immutable max-age is
 * always safe). A file with no embedded preview is a 404 ApiError — the UI
 * shows a placeholder for that.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PathRejectedError } from '../services/pathGuard.js';
import type { ThumbnailService } from '../services/thumbnails.js';
import { sendError } from './api.js';

export interface ThumbnailRouteDeps {
  thumbnails: ThumbnailService;
}

export function registerThumbnailRoutes(app: FastifyInstance, deps: ThumbnailRouteDeps): void {
  app.get(
    '/api/thumbnail',
    async (
      request: FastifyRequest<{ Querystring: { path?: string } }>,
      reply: FastifyReply,
    ) => {
      const filePath = request.query?.['path'];
      if (typeof filePath !== 'string' || filePath.length === 0) {
        return sendError(reply, 400, 'bad_request', 'A "path" query parameter is required.');
      }
      try {
        const thumbnail = await deps.thumbnails.get(filePath);
        if (thumbnail === null) {
          return sendError(
            reply,
            404,
            'not_found',
            'This file has no embedded preview to show.',
            { path: filePath },
          );
        }
        if (request.headers['if-none-match'] === `"${thumbnail.hash}"`) {
          return reply.code(304).header('etag', `"${thumbnail.hash}"`).send();
        }
        reply.header('content-type', 'image/jpeg');
        reply.header('content-length', thumbnail.bytes.length);
        reply.header('etag', `"${thumbnail.hash}"`);
        reply.header('cache-control', 'private, max-age=31536000, immutable');
        reply.header('x-metadesk-thumbnail-source', thumbnail.source);
        reply.header('x-metadesk-thumbnail-cached', thumbnail.cached ? '1' : '0');
        return reply.code(200).send(thumbnail.bytes);
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
