/**
 * Typed API client — hand-written against the frozen shared contract
 * (`@metadesk/shared`), consumed by TanStack Query hooks.
 *
 * Every call carries the per-launch token in the `X-MetaDesk-Token` header
 * (BUILD-NOTES pinned handshake). Failures arrive as the uniform ApiError
 * envelope; `message` is written for humans (pathGuard copy) and is surfaced
 * verbatim in the UI.
 */
import type {
  ApiError,
  FolderScanRequest,
  FolderScanResult,
  MetadataDepth,
  MetadataPayload,
  SseEvent,
  ThumbnailInfo,
} from '@metadesk/shared';
import type {
  CancelWriteResponse,
  ExecuteStreamFrame,
  GpsStripExecuteResponse,
  GpsStripPreviewResponse,
  HealthWithWrite,
  RecoveryFixAction,
  RecoveryFixResult,
  RecoveryScanReport,
  ScrubExecuteResponse,
  ScrubPreviewResponse,
  SessionModeResult,
  TagEdit,
  UndoPreviewResponse,
  UndoResultResponse,
  WriteExecuteResponse,
  WriteHistoryResponse,
  WritePreviewResponse,
} from '../write/types';

/** Bootstrap injected by the server (prod) or the dev handshake plugin. */
export interface Bootstrap {
  token: string;
  version: string;
  readOnlyDefault: boolean;
}

export function readBootstrap(): Bootstrap {
  const injected = window.__METADESK__;
  return {
    token: injected?.token ?? '',
    version: injected?.version ?? 'unknown',
    readOnlyDefault: injected?.readOnlyDefault ?? true,
  };
}

/** Error carrying the API envelope's code + human message. */
export class MetaApiError extends Error {
  readonly code: ApiError['code'];
  readonly details?: Record<string, unknown>;
  readonly status: number;

  constructor(status: number, envelope: ApiError) {
    super(envelope.message);
    this.name = 'MetaApiError';
    this.code = envelope.code;
    this.details = envelope.details;
    this.status = status;
  }
}

/** Error that is not an API envelope (network down, non-JSON body...). */
export class TransportError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'TransportError';
    this.status = status;
  }
}

type CommandPreviewSink = (argv: string[], context: string, readOnly: boolean) => void;

/**
 * Reads often include a `commandPreview` (BUILD-NOTES: read endpoints include
 * it where it aids trust). The client forwards any it sees to the persistent
 * Command Preview drawer via this sink, so the trust-and-teaching habit is
 * built by every read operation without each view having to remember.
 * Write-surface endpoints pass `readOnly = false` so the drawer labels them.
 */
let commandPreviewSink: CommandPreviewSink | null = null;
export function setCommandPreviewSink(sink: CommandPreviewSink | null): void {
  commandPreviewSink = sink;
}

function capturePreview(data: unknown, context: string, readOnly = true): void {
  if (commandPreviewSink === null || data === null || typeof data !== 'object') return;
  const preview = (data as Record<string, unknown>)['commandPreview'];
  if (Array.isArray(preview) && preview.length > 0 && preview.every((t) => typeof t === 'string')) {
    commandPreviewSink(preview as string[], context, readOnly);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Accept', 'application/json');
  const token = readBootstrap().token;
  if (token !== '') headers.set('X-MetaDesk-Token', token);
  if (init?.body !== undefined) headers.set('Content-Type', 'application/json');

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch (cause) {
    throw new TransportError(0, `Could not reach the MetaDesk server: ${String(cause)}`);
  }

  const text = await response.text();
  let body: unknown = undefined;
  try {
    body = text === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    throw new TransportError(
      response.status,
      `The server sent a response the UI could not read (HTTP ${response.status}).`,
    );
  }

  if (!response.ok) {
    const envelope = body as ApiError | undefined;
    if (envelope !== undefined && envelope !== null && typeof envelope === 'object' && 'code' in envelope && 'message' in envelope) {
      throw new MetaApiError(response.status, envelope as ApiError);
    }
    throw new TransportError(response.status, `Request failed (HTTP ${response.status}).`);
  }
  return body as T;
}

// --- Read endpoints -------------------------------------------------------

/**
 * /api/health is token-EXEMPT and, since wave 3, carries the additive
 * `writeUnlocked` + `mode` fields alongside the frozen HealthInfo shape.
 */
export function getHealth(): Promise<HealthWithWrite> {
  return request<HealthWithWrite>('/api/health');
}

export function scanFolder(req: FolderScanRequest): Promise<FolderScanResult> {
  return request<FolderScanResult>('/api/files/scan', {
    method: 'POST',
    body: JSON.stringify(req),
  }).then((result) => {
    capturePreview(result, `scan ${req.folder}`);
    return result;
  });
}

export function getMetadata(filePath: string, depth: MetadataDepth): Promise<MetadataPayload> {
  const params = new URLSearchParams({ path: filePath, depth });
  return request<MetadataPayload>(`/api/file/metadata?${params.toString()}`).then((payload) => {
    capturePreview(payload, `metadata ${depth} ${filePath}`);
    return payload;
  });
}

export function getThumbnail(filePath: string): Promise<ThumbnailInfo> {
  const params = new URLSearchParams({ path: filePath });
  return request<ThumbnailInfo>(`/api/thumbnail?${params.toString()}`);
}

/**
 * Console execution (BUILD-NOTES pin): POST /api/console/run { args }.
 * The server's strict validator only allows read-flag commands; write-class
 * tokens are rejected with a human message the UI surfaces verbatim.
 *
 * The result shape is leaf 1.1.2's; until its routes land the client parses
 * leniently and the console view renders what exists.
 */
export interface ConsoleRunResult {
  stdout?: string;
  stderr?: string;
  diagnostics?: Array<{ severity: string; message: string }>;
  commandPreview?: string[];
  [key: string]: unknown;
}

export function runConsole(args: string[]): Promise<ConsoleRunResult> {
  return request<ConsoleRunResult>('/api/console/run', {
    method: 'POST',
    body: JSON.stringify({ args }),
  }).then((result) => {
    capturePreview(result, 'console');
    return result;
  });
}

/** Fetch one binary tag (thumbnail/preview/ICC) as a downloadable blob. */
export async function downloadBinary(filePath: string, tag: string): Promise<void> {
  const params = new URLSearchParams({ path: filePath, tag });
  const headers: Record<string, string> = {};
  const token = readBootstrap().token;
  if (token !== '') headers['X-MetaDesk-Token'] = token;
  const response = await fetch(`/api/file/binary?${params.toString()}`, { headers });
  if (!response.ok) {
    throw new TransportError(response.status, `Extract failed (HTTP ${response.status}).`);
  }
  const blob = await response.blob();
  const safeTag = tag.replace(/[^A-Za-z0-9_-]+/g, '_');
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = safeTag;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

// --- Write surfaces (leaf 1.1.4 server; consumed here) ----------------------

/**
 * POST /api/session/unlock — deliberate, session-scoped. The server's global
 * default is read-only; every write still requires a preview, runs in backup
 * mode, and is journalled (the response note says so verbatim).
 */
export function unlockSession(): Promise<SessionModeResult> {
  return request<SessionModeResult>('/api/session/unlock', {
    method: 'POST',
    body: JSON.stringify({}),
  }).then((result) => {
    capturePreview(result, 'session unlock', false);
    return result;
  });
}

/** POST /api/session/lock — back to the read-only default. Always safe. */
export function lockSession(): Promise<SessionModeResult> {
  return request<SessionModeResult>('/api/session/lock', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/**
 * POST /api/write/preview — the mandatory, read-only diff (scratch-copy
 * simulation). Execute accepts only a previewId this produced, once.
 */
export function previewWrite(
  files: string[],
  edits: TagEdit[],
  timezone?: string,
): Promise<WritePreviewResponse> {
  return request<WritePreviewResponse>('/api/write/preview', {
    method: 'POST',
    body: JSON.stringify({ files, edits, ...(timezone !== undefined && timezone !== '' ? { timezone } : {}) }),
  }).then((result) => {
    capturePreview(result, `write preview · ${files.length} file(s)`, false);
    return result;
  });
}

export interface ExecuteWriteOptions {
  /** Stream SSE-framed chunk progress on the response itself. */
  stream?: boolean;
  onFrame?: (frame: ExecuteStreamFrame) => void;
}

/**
 * POST /api/write/execute — runs a live preview exactly once. With
 * {stream:true} the server streams progress frames on this response:
 * `write-progress` chunks (intent/write/verify phases), then one
 * `batch-complete` carrying the BatchOutcome — or a single `write-error`,
 * which becomes a MetaApiError-shaped failure here.
 */
export async function executeWrite(
  previewId: string,
  options: ExecuteWriteOptions = {},
): Promise<WriteExecuteResponse> {
  if (options.stream !== true) {
    const result = await request<WriteExecuteResponse>('/api/write/execute', {
      method: 'POST',
      body: JSON.stringify({ previewId }),
    });
    capturePreview(result, 'write execute', false);
    return result;
  }

  const headers: Record<string, string> = { Accept: 'text/event-stream' };
  const token = readBootstrap().token;
  if (token !== '') headers['X-MetaDesk-Token'] = token;

  let response: Response;
  try {
    response = await fetch('/api/write/execute', {
      method: 'POST',
      headers,
      body: JSON.stringify({ previewId, stream: true }),
    });
  } catch (cause) {
    throw new TransportError(0, `Could not reach the MetaDesk server: ${String(cause)}`);
  }
  if (!response.ok) {
    const text = await response.text();
    let envelope: ApiError | undefined;
    try {
      envelope = text === '' ? undefined : (JSON.parse(text) as ApiError);
    } catch {
      envelope = undefined;
    }
    if (envelope !== undefined && typeof envelope === 'object' && 'code' in envelope && 'message' in envelope) {
      throw new MetaApiError(response.status, envelope);
    }
    throw new TransportError(response.status, `The write failed (HTTP ${response.status}).`);
  }
  if (response.body === null) {
    throw new TransportError(response.status, 'The server closed the progress stream early.');
  }

  // exiftool emits CRLF (BUILD-NOTES fact 2); the frame parser is CRLF-safe.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // Held in a box because the assignment happens inside the frame handler.
  const result: { complete: WriteExecuteResponse | null } = { complete: null };

  const handleFrame = (frame: Record<string, unknown>): void => {
    const type = frame['type'];
    if (typeof type !== 'string') return;
    options.onFrame?.(frame as unknown as ExecuteStreamFrame);
    if (type === 'batch-complete') {
      const outcome = frame['outcome'];
      if (outcome !== undefined && outcome !== null && typeof outcome === 'object') {
        result.complete = {
          outcome: outcome as WriteExecuteResponse['outcome'],
          commandPreview: Array.isArray(frame['commandPreview'])
            ? (frame['commandPreview'] as string[])
            : [],
          consistencyNotes: [],
        };
        capturePreview(result.complete, 'write execute', false);
      }
    } else if (type === 'write-error') {
      const code = typeof frame['code'] === 'string' ? frame['code'] : 'internal_error';
      const message =
        typeof frame['message'] === 'string'
          ? frame['message']
          : 'The write failed before any per-file result was produced.';
      throw new MetaApiError(500, { code: code as ApiError['code'], message });
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const rawFrame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
      const parsed = parseSseFrame(rawFrame);
      if (parsed !== null) handleFrame(parsed);
    }
  }

  if (result.complete === null) {
    throw new TransportError(
      response.status,
      'The write stream ended without a completion report. Check History for what actually happened.',
    );
  }
  return result.complete;
}

/** POST /api/write/undo step 1 (no confirm): the reverse-write diff. */
export function previewUndo(batchId: string): Promise<UndoPreviewResponse> {
  return request<UndoPreviewResponse>('/api/write/undo', {
    method: 'POST',
    body: JSON.stringify({ batchId }),
  }).then((result) => {
    capturePreview(result, `undo preview ${batchId}`, false);
    return result;
  });
}

/** POST /api/write/undo step 2 ({confirm:true}): run the reverse write. */
export function confirmUndo(batchId: string): Promise<UndoResultResponse> {
  return request<UndoResultResponse>('/api/write/undo', {
    method: 'POST',
    body: JSON.stringify({ batchId, confirm: true }),
  }).then((result) => {
    capturePreview(result, `undo ${batchId}`, false);
    return result;
  });
}

/** GET /api/write/history — journal batches with freshly verified backups. */
export function getWriteHistory(limit = 20): Promise<WriteHistoryResponse> {
  return request<WriteHistoryResponse>(`/api/write/history?limit=${limit}`);
}

/** POST /api/scrub/preview — read-only AI-metadata detection (cap 1000). */
export function scrubPreview(files: string[], includeFullValues = false): Promise<ScrubPreviewResponse> {
  return request<ScrubPreviewResponse>('/api/scrub/preview', {
    method: 'POST',
    body: JSON.stringify({ files, includeFullValues }),
  }).then((result) => {
    capturePreview(result, `AI metadata scan · ${files.length} file(s)`, true);
    return result;
  });
}

/** POST /api/scrub/execute — the gated destructive wipe (phrase required). */
export function scrubExecute(files: string[], confirm: string): Promise<ScrubExecuteResponse> {
  return request<ScrubExecuteResponse>('/api/scrub/execute', {
    method: 'POST',
    body: JSON.stringify({ files, confirm }),
  }).then((result) => {
    capturePreview(result, 'AI metadata scrub', false);
    return result;
  });
}

// --- GPS strip + batch cancel (leaf 1.1.4b) ---------------------------------

/**
 * POST /api/write/preview {files, destructive:{scope:"gps"}} — the destructive
 * GPS-strip preview. The server applies its own curated GPS whitelist (the
 * client declares intent, never a tag list), writes the mandatory pre-write
 * sidecar export, and lists the GPS tags it cannot delete by name.
 */
export function previewGpsStrip(files: string[]): Promise<GpsStripPreviewResponse> {
  return request<GpsStripPreviewResponse>('/api/write/preview', {
    method: 'POST',
    body: JSON.stringify({ files, destructive: { scope: 'gps' } }),
  }).then((result) => {
    capturePreview(result, `GPS strip preview · ${files.length} file(s)`, false);
    return result;
  });
}

/**
 * POST /api/write/execute {previewId, destructive:{confirmationPhrase}} — the
 * phrase-gated execution of a GPS-strip preview. The server re-checks the
 * phrase and refuses (403) without writing anything unless it matches exactly.
 */
export function executeGpsStrip(
  previewId: string,
  confirmationPhrase: string,
): Promise<GpsStripExecuteResponse> {
  return request<GpsStripExecuteResponse>('/api/write/execute', {
    method: 'POST',
    body: JSON.stringify({ previewId, destructive: { confirmationPhrase } }),
  }).then((result) => {
    capturePreview(result, 'GPS strip execute', false);
    return result;
  });
}

/**
 * POST /api/write/cancel {batchId} — request a graceful cancel of a running
 * batch. Cooperative by contract: the in-flight chunk always finishes (exiftool
 * is never interrupted mid-file), written files keep their verified results,
 * and unprocessed files are reported as not attempted. A batch that already
 * finished refuses the cancel with 404 — honestly.
 */
export function cancelWriteBatch(batchId: string): Promise<CancelWriteResponse> {
  return request<CancelWriteResponse>('/api/write/cancel', {
    method: 'POST',
    body: JSON.stringify({ batchId }),
  });
}

/** GET /api/recovery/scan — read-only; safe at startup. */
export function recoveryScan(folders: string[] = []): Promise<RecoveryScanReport> {
  const query = folders.length > 0 ? `?folders=${encodeURIComponent(folders.join('|'))}` : '';
  return request<RecoveryScanReport>(`/api/recovery/scan${query}`).then((result) => {
    capturePreview(result, 'recovery scan', true);
    return result;
  });
}

/** POST /api/recovery/fix — mutates disk; runs only with confirm:true. */
export function recoveryFix(action: RecoveryFixAction): Promise<RecoveryFixResult> {
  return request<RecoveryFixResult>('/api/recovery/fix', {
    method: 'POST',
    body: JSON.stringify(action),
  });
}

// --- SSE ------------------------------------------------------------------

export type Unsubscribe = () => void;

/**
 * Subscribe to `/api/events`.
 *
 * EventSource cannot send the `X-MetaDesk-Token` header, so the stream is
 * consumed through fetch + ReadableStream and parsed as SSE by hand. Events
 * arrive CRLF-safe (exiftool emits CRLF; the server normalizes lines) and
 * carry a monotonic `seq` — gaps are tolerated silently, duplicates dropped.
 */
export function subscribeEvents(
  onEvent: (event: SseEvent) => void,
  onDisconnected?: () => void,
): Unsubscribe {
  const controller = new AbortController();
  const headers: Record<string, string> = { Accept: 'text/event-stream' };
  const token = readBootstrap().token;
  if (token !== '') headers['X-MetaDesk-Token'] = token;

  void (async () => {
    let lastSeq = -1;
    try {
      const response = await fetch('/api/events', { headers, signal: controller.signal });
      if (!response.ok || response.body === null) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
          const parsed = parseSseFrame(rawEvent);
          if (parsed === null) continue;
          const seq = typeof parsed['seq'] === 'number' ? parsed['seq'] : lastSeq + 1;
          if (seq <= lastSeq) continue; // duplicate/replay — drop
          lastSeq = seq;
          onEvent(parsed as unknown as SseEvent);
        }
      }
    } catch {
      // Aborted or disconnected — the caller reconnects with backoff.
    } finally {
      if (!controller.signal.aborted) onDisconnected?.();
    }
  })();

  return () => controller.abort();
}

/** Parse one SSE frame (`event:`/`data:` lines, CRLF-tolerant). */
function parseSseFrame(frame: string): Record<string, unknown> | null {
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  try {
    return JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
