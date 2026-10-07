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

// --- Transport (the only code in this file that touches fetch) ---------------
//
// Endpoints own policy — routes, payloads, capturePreview sites, bespoke error
// copy. These private helpers own the plumbing every endpoint used to
// re-implement: the token door, the fetch wrap, the envelope test, the failure
// mapper, and the SSE read loop.

/** The one place that reads the handshake token for sending. */
function tokenValue(): string {
  return readBootstrap().token;
}

/**
 * The one credentials door: `{...extra}` plus `X-MetaDesk-Token` IFF the
 * per-launch token exists (the header is omitted wholesale when the bootstrap
 * token is ''). Extra rides FIRST, so a caller can never clobber the token.
 */
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const token = tokenValue();
  if (token !== '') headers['X-MetaDesk-Token'] = token;
  return headers;
}

/** THE only fetch call in this file: any network failure is a TransportError(0). */
async function send(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(path, init);
  } catch (cause) {
    throw new TransportError(0, `Could not reach the MetaDesk server: ${String(cause)}`);
  }
}

/** The envelope predicate (null guard included — literal JSON null is not one). */
function isEnvelope(body: unknown): body is ApiError {
  return (
    body !== undefined &&
    body !== null &&
    typeof body === 'object' &&
    'code' in body &&
    'message' in body
  );
}

/**
 * Map a non-ok response to its thrown failure: an ApiError envelope becomes a
 * MetaApiError; anything else becomes a TransportError with the assembled
 * `${label} (HTTP N).` Labels are caller-owned human sentences — five distinct
 * ones today, never unified here.
 */
async function failureOf(response: Response, label: string): Promise<never> {
  const text = await response.text();
  let body: unknown = undefined;
  try {
    body = text === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    body = undefined;
  }
  if (isEnvelope(body)) throw new MetaApiError(response.status, body);
  throw new TransportError(response.status, `${label} (HTTP ${response.status}).`);
}

/**
 * The shared SSE read loop: buffer bytes, split on the literal '\n\n' frame
 * boundary, and hand every frame to the callback CRLF-safely (exiftool emits
 * CRLF — BUILD-NOTES fact 2). Deliberately NO try/finally, NO reader.cancel(),
 * NO releaseLock, and NO final decoder flush: a throw from a frame handler
 * abandons the stream in place, and a trailing unterminated frame stays
 * dropped.
 */
async function readSse(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: Record<string, unknown>) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
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
      if (parsed !== null) onFrame(parsed);
    }
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Accept', 'application/json');
  const token = tokenValue();
  if (token !== '') headers.set('X-MetaDesk-Token', token);
  if (init?.body !== undefined) headers.set('Content-Type', 'application/json');

  const response = await send(path, { ...init, headers });

  // The read + parse deliberately precede the ok-check: an unreadable body is
  // its own honest failure at either status (order pinned by identity).
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
    if (isEnvelope(body)) throw new MetaApiError(response.status, body);
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

export async function getThumbnail(filePath: string): Promise<ThumbnailInfo> {
  const params = new URLSearchParams({ path: filePath });
  const endpoint = `/api/thumbnail?${params.toString()}`;
  // The endpoint streams raw image/jpeg bytes (BUILD-NOTES route pin) and an
  // <img> tag cannot send the X-MetaDesk-Token header — so the client fetches
  // the bytes itself and hands the view an object URL. Token-ONLY headers: no
  // Accept, and this path deliberately does NOT classify envelopes.
  const response = await send(endpoint, { headers: authHeaders() });
  if (response.status === 404) {
    throw new MetaApiError(404, {
      code: 'not_found',
      message: 'This file has no embedded preview image.',
    });
  }
  if (!response.ok) {
    throw new TransportError(response.status, `Thumbnail failed (HTTP ${response.status}).`);
  }
  const blob = await response.blob();
  return {
    filePath,
    url: URL.createObjectURL(blob),
    source: 'thumbnail',
    cached: false,
  };
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
  const response = await send(`/api/file/binary?${params.toString()}`, {
    headers: authHeaders(),
  });
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
  /**
   * The destructive envelope (the GPS strip): the server re-checks this phrase
   * against the one the preview minted and refuses 403 without writing
   * anything on mismatch. Accepted on BOTH the plain and streamed body paths;
   * the runner only ever sends it NON-streamed — the streamed batch-complete
   * frame omits consistencyNotes, which would kill the engine-cross-check
   * channel on the Results report.
   */
  destructive?: { confirmationPhrase: string };
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
      body: JSON.stringify({
        previewId,
        ...(options.destructive !== undefined ? { destructive: options.destructive } : {}),
      }),
    });
    capturePreview(result, 'write execute', false);
    return result;
  }

  const headers = authHeaders({
    Accept: 'text/event-stream',
    // Fastify only parses the JSON body when Content-Type says JSON — without
    // this the server 400s with "body must include previewId" (e2e matrix bug).
    'Content-Type': 'application/json',
  });

  // No AbortController here, by pin: post-Back progress is REAL frame data, and
  // this init carries no 'signal' key. A stream refusal rides the same envelope
  // door as every other endpoint.
  const response = await send('/api/write/execute', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      previewId,
      stream: true,
      ...(options.destructive !== undefined ? { destructive: options.destructive } : {}),
    }),
  });
  if (!response.ok) {
    await failureOf(response, 'The write failed');
  }
  if (response.body === null) {
    throw new TransportError(response.status, 'The server closed the progress stream early.');
  }

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

  await readSse(response.body, handleFrame);

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

// --- Diagnostics (leaf 2.2.1) -----------------------------------------------

export interface DiagnosticsBundleResult {
  /** Object URL of the zip bytes (revoke it when the card goes away). */
  blobUrl: string;
  /** Filename from the server's Content-Disposition. */
  filename: string;
  /** Where the server ALSO wrote the file, from X-MetaDesk-Diagnostics-Path. */
  savedPath: string | null;
}

/**
 * GET /api/diagnostics/bundle — a plain <a download> link cannot send the
 * X-MetaDesk-Token header (the same lesson as the thumbnail fetch), so the
 * client fetches the bytes itself and hands back an object URL. The server
 * has already saved the same bytes on disk; `savedPath` is where.
 */
export async function createDiagnosticsBundle(): Promise<DiagnosticsBundleResult> {
  const response = await send('/api/diagnostics/bundle', {
    headers: authHeaders({ Accept: 'application/zip' }),
  });
  if (!response.ok) {
    await failureOf(response, 'The diagnostics bundle could not be created');
  }

  const blob = await response.blob();
  return {
    blobUrl: URL.createObjectURL(blob),
    filename: filenameFromDisposition(response.headers.get('content-disposition')),
    savedPath: headerValue(response.headers.get('x-metadesk-diagnostics-path')),
  };
}

/** `attachment; filename="x.zip"` -> x.zip (with a plain fallback name). */
function filenameFromDisposition(value: string | null): string {
  if (value !== null) {
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(value);
    const name = match?.[1]?.trim();
    if (name !== undefined && name.length > 0) return name;
  }
  return 'metadesk-diagnostics.zip';
}

function headerValue(value: string | null): string | null {
  return value !== null && value.length > 0 ? value : null;
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

  void (async () => {
    let lastSeq = -1;
    try {
      const response = await send('/api/events', {
        headers: authHeaders({ Accept: 'text/event-stream' }),
        signal: controller.signal,
      });
      // The one deliberate exception to the envelope door: a refused or empty
      // /api/events response is a SILENT return — disconnects must never become
      // errors above SseBridge's backoff.
      if (!response.ok || response.body === null) return;
      await readSse(response.body, (parsed) => {
        const seq = typeof parsed['seq'] === 'number' ? parsed['seq'] : lastSeq + 1;
        if (seq <= lastSeq) return; // duplicate/replay — drop
        lastSeq = seq;
        onEvent(parsed as unknown as SseEvent);
      });
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
