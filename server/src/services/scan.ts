/**
 * Folder scan: fast filesystem listing + one light engine pass for the
 * per-file badges (GPS present / copyright present / editor present).
 *
 * Design points, all pinned by the build contract:
 *  - listing comes from `fs` (name/size/mtime/extension) so a scan never
 *    errors because one entry is hostile — odd names become per-file
 *    warnings and structurally unusable paths land in `rejectedPaths`;
 *  - the engine pass is BATCHED (one -stay_open round trip per ~200 files,
 *    `-fast2` + explicit tags) so a folder view costs a handful of engine
 *    round trips, not one per file;
 *  - preflight reports count, total size, free space, a capped locked-file
 *    probe, and odd-name flags without failing the scan;
 *  - exiftool artifacts (*_original, *_exiftool_tmp) are excluded by default
 *    (backup hygiene requirement).
 */
import { open, readdir, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import type { FileEntry, FileKind, FolderScanRequest, FolderScanResult } from '@metadesk/shared';
import type { ExifToolSession } from '../engine/exiftoolSession.js';
import { normalizeExifPath } from './exifPath.js';
import { inspectPath, isUncPath, probeReadable } from './pathGuard.js';

/** Extension chips (per -listf families). Lowercase, no dot. */
export const EXTENSION_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  images: ['jpg', 'jpeg', 'jpe', 'jfif', 'png', 'gif', 'webp', 'avif', 'tif', 'tiff', 'bmp'],
  raw: [
    'crw', 'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng', 'raf', 'orf',
    'rw2', 'raw', 'rwl', 'dcr', 'kdc', 'mrw', 'pef', 'srw', 'x3f', '3fr', 'fff', 'iiq', 'erf',
  ],
  video: ['3gp', 'avi', 'm2ts', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'mts', 'wmv'],
  docs: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'],
  sidecar: ['xmp'],
};

/** The default media set when the request carries no extension filter. */
export const DEFAULT_EXTENSIONS: readonly string[] = Object.values(EXTENSION_FAMILIES).flat();

const KIND_BY_EXTENSION: Readonly<Record<string, FileKind>> = buildKindMap();

function buildKindMap(): Record<string, FileKind> {
  const map: Record<string, FileKind> = {};
  const assign = (kind: FileKind, exts: readonly string[]) => {
    for (const ext of exts) map[ext] = kind;
  };
  assign('jpeg', ['jpg', 'jpeg', 'jpe', 'jfif']);
  assign('png', ['png']);
  assign('gif', ['gif']);
  assign('webp', ['webp']);
  assign('heic', ['heic', 'heif']);
  assign('tiff', ['tif', 'tiff']);
  assign('raw', EXTENSION_FAMILIES['raw'] ?? []);
  assign('video', EXTENSION_FAMILIES['video'] ?? []);
  assign('sidecar', EXTENSION_FAMILIES['sidecar'] ?? []);
  return map;
}

const ENGINE_ARTIFACT_RE = /_original$|_exiftool_tmp/;
const BADGE_BATCH_SIZE = 200;
const LOCKED_PROBE_CAP = 500;

/** Tags requested in the light badge pass (group-qualified reads only). */
const BADGE_TAGS: readonly string[] = [
  '-GPSLatitude',
  '-GPSLongitude',
  '-EXIF:Copyright',
  '-XMP-dc:Rights',
  '-IPTC:CopyrightNotice',
  '-EXIF:Software',
  '-XMP-xmp:CreatorTool',
  '-IPTC:Writer-Editor',
  '-XMP-photoshop:Credit',
];

export interface ScanDeps {
  /** The persistent engine session; null degrades the scan to fs-only. */
  engine: ExifToolSession | null;
  onScanProgress?(event: { scanId: string; filesScanned: number; currentDirectory?: string }): void;
  onScanComplete?(event: { scanId: string; totalFiles: number; warningCount: number }): void;
}

export interface ScanFailure extends Error {
  code: 'path_rejected' | 'not_found';
}

export class ScanError extends Error {
  readonly code: 'path_rejected' | 'not_found';
  constructor(code: 'path_rejected' | 'not_found', message: string) {
    super(message);
    this.name = 'ScanError';
    this.code = code;
  }
}

/** Run a folder scan. Throws ScanError (never a raw fs error) on bad input. */
export async function scanFolder(
  request: FolderScanRequest,
  deps: ScanDeps,
): Promise<FolderScanResult> {
  const guarded = inspectPath(request.folder);
  if (!guarded.ok) throw new ScanError('path_rejected', guarded.message);
  const folder = guarded.path;

  const isUnc = isUncPath(folder);
  if (isUnc) await probeReadable(folder, { isUnc: true });
  let folderStat;
  try {
    folderStat = await stat(folder);
  } catch {
    throw new ScanError('not_found', `The folder "${folder}" does not exist or is not readable.`);
  }
  if (!folderStat.isDirectory()) {
    throw new ScanError('not_found', `"${folder}" is a file, not a folder.`);
  }

  const scanId = newScanId();
  const recursive = request.recursive === true;
  const excludeArtifacts = request.excludeEngineArtifacts !== false;
  const filter = new Set(
    (request.extensions ?? []).map((e) => e.toLowerCase().replace(/^\./, '')).filter((e) => e.length > 0),
  );
  const extensions = filter.size > 0 ? filter : new Set(DEFAULT_EXTENSIONS);
  // Extensionless files ride along in the default listing on purpose: the
  // canonical hostile fixture (`--All=`) has no extension, exiftool reads
  // such files by CONTENT when addressed explicitly, and hiding them from
  // the grid would hide exactly the files the safety model cares about.
  if (filter.size === 0) extensions.add('');

  const entries: FileEntry[] = [];
  const rejectedPaths: Array<{ path: string; reason: string }> = [];
  const unreadableDirectories: Array<{ path: string; reason: string }> = [];
  const resultWarnings: string[] = [];

  // ---- 1. Filesystem walk ---------------------------------------------------
  let filesScanned = 0;
  await walk(folder, recursive, async (dirPath, name, fullPath) => {
    if (excludeArtifacts && ENGINE_ARTIFACT_RE.test(name)) return;
    const extension = path.extname(name).slice(1).toLowerCase();
    if (!extensions.has(extension)) return;

    const guard = inspectPath(fullPath);
    if (!guard.ok) {
      rejectedPaths.push({ path: fullPath, reason: guard.message });
      return;
    }

    let sizeBytes = 0;
    let modifiedAt = new Date(0).toISOString();
    try {
      const fileStat = await stat(fullPath);
      sizeBytes = fileStat.size;
      modifiedAt = fileStat.mtime.toISOString();
    } catch (error) {
      rejectedPaths.push({
        path: fullPath,
        reason: `could not be read: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }

    const entry: FileEntry = {
      path: fullPath,
      name,
      extension,
      sizeBytes,
      modifiedAt,
      kind: KIND_BY_EXTENSION[extension] ?? 'other',
      warnings: oddNameWarnings(name),
    };
    filesScanned += 1;
    entries.push(entry);
    deps.onScanProgress?.({ scanId, filesScanned, currentDirectory: dirPath });
  }, (dirPath, error) => {
    unreadableDirectories.push({
      path: dirPath,
      reason: error instanceof Error ? error.message : String(error),
    });
  });

  // ---- 2. Preflight ----------------------------------------------------------
  let freeBytes: number | undefined;
  try {
    const fsStats = await statfs(folder);
    freeBytes = Number(fsStats.bavail) * Number(fsStats.bsize);
  } catch {
    resultWarnings.push('free space could not be determined for this volume');
  }

  const probeCount = Math.min(entries.length, LOCKED_PROBE_CAP);
  if (entries.length > LOCKED_PROBE_CAP) {
    resultWarnings.push(
      `locked-file probe ran on the first ${LOCKED_PROBE_CAP} of ${entries.length} files`,
    );
  }
  for (const entry of entries.slice(0, probeCount)) {
    await probeLocked(entry);
  }

  // ---- 3. Light engine pass for badges (batched) ------------------------------
  if (deps.engine !== null && entries.length > 0) {
    for (let offset = 0; offset < entries.length; offset += BADGE_BATCH_SIZE) {
      const batch = entries.slice(offset, offset + BADGE_BATCH_SIZE);
      await applyBadges(batch, deps.engine);
    }
  } else if (entries.length > 0) {
    resultWarnings.push('engine unavailable: GPS/copyright/editor badges were skipped');
  }

  const totalBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const warningCount = entries.reduce((sum, entry) => sum + entry.warnings.length, 0);

  const result: FolderScanResult = {
    scanId,
    folder,
    recursive,
    entries,
    totalFiles: entries.length,
    totalBytes,
    unreadableDirectories,
    rejectedPaths,
    freeBytes,
    warnings: resultWarnings,
  };
  deps.onScanComplete?.({ scanId, totalFiles: entries.length, warningCount });
  return result;
}

// ---- internals ---------------------------------------------------------------

async function walk(
  root: string,
  recursive: boolean,
  onFile: (dir: string, name: string, full: string) => Promise<void> | void,
  onUnreadableDir: (dir: string, error: unknown) => void,
): Promise<void> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() ?? '';
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      onUnreadableDir(dir, error);
      continue;
    }
    for (const dirent of dirents) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        if (recursive) stack.push(full);
        continue;
      }
      if (!dirent.isFile()) continue; // symlinks/junctions are out of scope for v1
      await onFile(dir, dirent.name, full);
    }
  }
}

/** Names that are legal but trip exiftool/shell grammar become warnings. */
function oddNameWarnings(name: string): string[] {
  const warnings: string[] = [];
  if (/^[-%*?#]/.test(name)) warnings.push('odd-name: starts with -, %, *, ? or #');
  if (/[. ]$/.test(name)) warnings.push('odd-name: ends with a space or dot');
  if (/[%#=]/.test(name)) warnings.push('odd-name: contains %, # or =');
  if (name.length > 240) warnings.push('odd-name: longer than 240 characters');
  return warnings;
}

async function probeLocked(entry: FileEntry): Promise<void> {
  let handle;
  try {
    handle = await open(entry.path, 'r+');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    // A file may be read-only (r succeeds, r+ does not) or genuinely locked
    // by another process (EBUSY/EPERM). Either blocks a future write; the
    // distinction is advisory, so one warning shape covers both.
    try {
      const readHandle = await open(entry.path, 'r');
      await readHandle.close();
      entry.warnings.push(`not writable: ${code || 'access denied'} (read-only or in use)`);
    } catch {
      entry.warnings.push('not readable: locked or permission denied');
    }
    return;
  }
  await handle.close();
}

/** One batched engine round trip: per-file GPS/copyright/editor flags. */
async function applyBadges(batch: FileEntry[], engine: ExifToolSession): Promise<void> {
  const args = ['-j', '-G1', '-a', '-fast2', ...BADGE_TAGS, ...batch.map((e) => e.path)];
  let json: Array<Record<string, unknown>>;
  try {
    const result = await engine.run(args, { json: true });
    json = result.json as Array<Record<string, unknown>>;
    for (const diagnostic of result.diagnostics) {
      if (diagnostic.severity !== 'error') continue;
      const sourceFile = diagnostic.sourceFile;
      const entry =
        sourceFile === undefined
          ? undefined
          : batch.find((e) => e.path.replace(/\\/g, '/') === sourceFile.replace(/\\/g, '/'));
      entry?.warnings.push(`engine: ${diagnostic.message}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const entry of batch) entry.warnings.push(`engine: ${message}`);
    return;
  }

  const byPath = new Map(json.map((obj) => [normalizeExifPath(String(obj['SourceFile'] ?? '')), obj]));
  for (const entry of batch) {
    const payload = byPath.get(normalizeExifPath(entry.path));
    if (payload === undefined) continue;
    if (hasTag(payload, 'GPSLatitude') || hasTag(payload, 'GPSLongitude')) {
      entry.warnings.push('badge:gps-present');
    }
    if (
      hasTag(payload, 'Copyright') ||
      hasTag(payload, 'Rights') ||
      hasTag(payload, 'CopyrightNotice')
    ) {
      entry.warnings.push('badge:copyright-present');
    }
    if (
      hasTag(payload, 'Software') ||
      hasTag(payload, 'CreatorTool') ||
      hasTag(payload, 'Writer-Editor') ||
      hasTag(payload, 'Credit')
    ) {
      entry.warnings.push('badge:editor-present');
    }
  }
}

function hasTag(payload: Record<string, unknown>, bareName: string): boolean {
  for (const key of Object.keys(payload)) {
    if (key.includes(':') && key.slice(key.indexOf(':') + 1) === bareName) {
      const value = payload[key];
      if (typeof value === 'string' && value.length > 0 && !value.startsWith('(Binary data')) {
        return true;
      }
    }
  }
  return false;
}

function newScanId(): string {
  return `scan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
