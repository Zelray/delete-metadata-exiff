/**
 * Recovery routes (leaf 1.1.4; the amendment from the planned console.ts):
 *
 *   GET  /api/recovery/scan   ?folders=C:\a|C:\b  (optional; |-separated,
 *                              the only safe separator — "," and ";" can
 *                              appear in real folder names) -> RecoveryScanReport
 *   POST /api/recovery/fix    {action, ...args, confirm:true} -> FixResult
 *
 * The scan is read-only and safe to call at startup: journal interrupted
 * batches always, folder debris when folders are given. Fixes mutate the disk
 * (delete an orphan temp, rename a backup back into place, adopt an untracked
 * backup, mark an interrupted batch abandoned, or the explicitly-labeled
 * nuclear restore) and run ONLY with {"confirm": true}. Every mutating
 * response carries `commandPreview` — which is `[]` here on purpose: recovery
 * fixes are MetaDesk's own verified file operations, never exiftool
 * invocations (the interactive -delete_original prompt is never triggered).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { RecoveryService, RecoveryError, type FixAction } from '../services/recovery.js';
import { Journal } from '../services/journal.js';
import { PathRejectedError, assertSafePath } from '../services/pathGuard.js';
import { sendError } from './api.js';

export interface RecoveryRouteDeps {
  dataDir: string;
  /** The ONE shared journal (the same instance the write pipeline records to). */
  journal: Journal;
}

interface FixBody {
  action?: unknown;
  confirm?: unknown;
  path?: unknown;
  backupPath?: unknown;
  photoPath?: unknown;
  batchId?: unknown;
}

export function registerRecoveryRoutes(app: FastifyInstance, deps: RecoveryRouteDeps): void {
  const journal = deps.journal;
  const recovery = new RecoveryService({ dataDir: deps.dataDir, journal });

  app.get(
    '/api/recovery/scan',
    async (request: FastifyRequest<{ Querystring: { folders?: string } }>, reply: FastifyReply) => {
      const foldersParam = request.query.folders;
      const folders: string[] = [];
      if (typeof foldersParam === 'string' && foldersParam.trim().length > 0) {
        for (const raw of foldersParam.split('|')) {
          const trimmed = raw.trim();
          if (trimmed.length === 0) continue;
          try {
            folders.push(assertSafePath(trimmed));
          } catch (error) {
            if (error instanceof PathRejectedError) {
              return sendError(reply, 400, 'path_rejected', error.message, { path: error.inputPath });
            }
            throw error;
          }
        }
      }

      const journalReport = await recovery.scanJournal();
      const folderReports = folders.length > 0 ? await recovery.scanFolders(folders) : [];
      const clean =
        journalReport.interruptedBatches.length === 0 &&
        folderReports.every(
          (f) =>
            f.orphanTempFiles.length === 0 &&
            f.originalsWithoutPhoto.length === 0 &&
            f.untrackedOriginals.length === 0,
        );

      return reply.code(200).send({
        scannedAt: new Date().toISOString(),
        clean,
        journal: journalReport,
        folders: folderReports,
        commandPreview: [],
      });
    },
  );

  app.post('/api/recovery/fix', async (request: FastifyRequest<{ Body: FixBody }>, reply: FastifyReply) => {
    const body = request.body ?? {};
    if (typeof body.action !== 'string') {
      return sendError(
        reply,
        400,
        'bad_request',
        'The body must be {"action": string, ..., "confirm": true}.',
      );
    }
    let action: FixAction;
    switch (body.action) {
      case 'delete-orphan-temp': {
        if (typeof body.path !== 'string') {
          return sendError(reply, 400, 'bad_request', 'delete-orphan-temp needs {"path": string}.');
        }
        action = { action: 'delete-orphan-temp', path: body.path, confirm: body.confirm === true };
        break;
      }
      case 'restore-original': {
        if (typeof body.backupPath !== 'string') {
          return sendError(reply, 400, 'bad_request', 'restore-original needs {"backupPath": string}.');
        }
        action = { action: 'restore-original', backupPath: body.backupPath, confirm: body.confirm === true };
        break;
      }
      case 'adopt-original': {
        if (typeof body.backupPath !== 'string' || typeof body.photoPath !== 'string') {
          return sendError(
            reply,
            400,
            'bad_request',
            'adopt-original needs {"backupPath": string, "photoPath": string}.',
          );
        }
        action = {
          action: 'adopt-original',
          backupPath: body.backupPath,
          photoPath: body.photoPath,
          confirm: body.confirm === true,
        };
        break;
      }
      case 'mark-batch-abandoned': {
        if (typeof body.batchId !== 'string') {
          return sendError(reply, 400, 'bad_request', 'mark-batch-abandoned needs {"batchId": string}.');
        }
        action = { action: 'mark-batch-abandoned', batchId: body.batchId, confirm: body.confirm === true };
        break;
      }
      case 'restore-originals-for-batch': {
        if (typeof body.batchId !== 'string') {
          return sendError(
            reply,
            400,
            'bad_request',
            'restore-originals-for-batch needs {"batchId": string}.',
          );
        }
        action = {
          action: 'restore-originals-for-batch',
          batchId: body.batchId,
          confirm: body.confirm === true,
        };
        break;
      }
      default:
        return sendError(reply, 400, 'bad_request', `Unknown recovery action: "${body.action}".`);
    }

    try {
      const result = await recovery.fix(action);
      return reply.code(200).send({ ...result, commandPreview: [] });
    } catch (error) {
      if (error instanceof RecoveryError) {
        const statusCode =
          error.code === 'confirmation_required' || error.code === 'writer_active' || error.code === 'unsafe'
            ? 403
            : error.code === 'not_found'
              ? 404
              : 400;
        return sendError(reply, statusCode, error.code === 'not_found' ? 'not_found' : 'bad_request', error.message, {
          ...error.details,
          fixAction: body.action,
        });
      }
      throw error;
    }
  });
}
