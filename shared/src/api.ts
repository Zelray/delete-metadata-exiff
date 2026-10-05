/**
 * Cross-cutting API types: error envelope, health handshake, SSE event union.
 */
import type { BatchOutcome } from './write.js';
import type { MetadataDepth } from './metadata.js';

/** Stable machine-readable error codes used by the API envelope. */
export type ApiErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'path_rejected'
  | 'read_only_mode'
  | 'write_locked'
  | 'engine_unavailable'
  | 'engine_version_unsupported'
  | 'preview_required'
  | 'unsafe_tag'
  | 'internal_error';

/** Uniform error envelope returned by every failing API route. */
export interface ApiError {
  code: ApiErrorCode;
  /** Human-readable message safe to show the user. */
  message: string;
  /** Structured context (e.g. the rejected path, the failing file). */
  details?: Record<string, unknown>;
}

/** Health of the exiftool engine as reported by the startup handshake. */
export interface HealthInfo {
  /** true when the engine answered `-ver` and passed the version gate. */
  ok: boolean;
  /** Engine version string, e.g. "13.59". Empty when unknown. */
  version: string;
  /**
   * true when the engine could not be fully validated and the app degraded to
   * a read-only session (no writes of any kind are permitted).
   */
  readOnlyFallback: boolean;
  /** Why health failed / degraded; human-readable, safe to display. */
  reason?: string;
  /** Absolute path of the exiftool.exe the engine is driving. */
  executablePath: string;
  /** Minimum version the engine gate accepts. */
  minimumVersion: string;
}

/**
 * Server-sent event union streamed on `/api/events`.
 *
 * Every event carries a monotonic `seq` so the client can detect gaps, and a
 * UTC ISO-8601 `timestamp`.
 */
export type SseEvent =
  | SseHelloEvent
  | SseHeartbeatEvent
  | SseScanProgressEvent
  | SseScanCompleteEvent
  | SseMetadataReadyEvent
  | SseThumbnailReadyEvent
  | SseWriteProgressEvent
  | SseBatchCompleteEvent
  | SseHealthEvent;

interface SseBase {
  seq: number;
  /** UTC ISO-8601 timestamp. */
  timestamp: string;
}

export interface SseHelloEvent extends SseBase {
  type: 'hello';
  health: HealthInfo;
}

export interface SseHeartbeatEvent extends SseBase {
  type: 'heartbeat';
}

export interface SseScanProgressEvent extends SseBase {
  type: 'scan-progress';
  scanId: string;
  filesScanned: number;
  currentDirectory?: string;
}

export interface SseScanCompleteEvent extends SseBase {
  type: 'scan-complete';
  scanId: string;
  totalFiles: number;
  warningCount: number;
}

export interface SseMetadataReadyEvent extends SseBase {
  type: 'metadata-ready';
  filePath: string;
  depth: MetadataDepth;
}

export interface SseThumbnailReadyEvent extends SseBase {
  type: 'thumbnail-ready';
  filePath: string;
  /** URL from which the cached thumbnail JPEG can be fetched. */
  url: string;
}

export interface SseWriteProgressEvent extends SseBase {
  type: 'write-progress';
  batchId: string;
  filePath: string;
  index: number;
  total: number;
}

export interface SseBatchCompleteEvent extends SseBase {
  type: 'batch-complete';
  batchId: string;
  outcome: BatchOutcome;
}

export interface SseHealthEvent extends SseBase {
  type: 'health';
  health: HealthInfo;
}
