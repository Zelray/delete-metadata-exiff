/**
 * Folder scanning and file listing types.
 */

/** A single image/media file discovered by a folder scan. */
export interface FileEntry {
  /** Absolute, normalized path (the primary key for every later call). */
  path: string;
  name: string;
  /** Lowercase extension without the dot; empty when the file has none. */
  extension: string;
  sizeBytes: number;
  /** UTC ISO-8601 last-modified time. */
  modifiedAt: string;
  /** Container family used for badges and safety gating. */
  kind: FileKind;
  /** Set when the file was skipped or flagged by the scanner. */
  warnings: string[];
}

export type FileKind =
  | 'jpeg'
  | 'png'
  | 'tiff'
  | 'webp'
  | 'heic'
  | 'gif'
  | 'raw'
  | 'video'
  | 'sidecar'
  | 'other';

/** Request to scan a folder. */
export interface FolderScanRequest {
  /** Absolute folder path. Relative paths are rejected. */
  folder: string;
  /** Recurse into subfolders (drives exiftool `-r`). */
  recursive: boolean;
  /** Extension whitelist, lowercase without dots. Empty = default media set. */
  extensions?: string[];
  /** Exclude exiftool artifacts (`*_original`, `*_exiftool_tmp`); default true. */
  excludeEngineArtifacts?: boolean;
}

/** Result of a folder scan. */
export interface FolderScanResult {
  scanId: string;
  /** Absolute folder actually scanned (resolved). */
  folder: string;
  recursive: boolean;
  entries: FileEntry[];
  totalFiles: number;
  totalBytes: number;
  /** Directories that could not be read, with reasons. */
  unreadableDirectories: Array<{ path: string; reason: string }>;
  /** Paths rejected by the path sanitizer, with reasons. */
  rejectedPaths: Array<{ path: string; reason: string }>;
  /** Free bytes on the volume holding the folder, when determinable. */
  freeBytes?: number;
  warnings: string[];
}
