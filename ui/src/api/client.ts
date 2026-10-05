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
  HealthInfo,
  MetadataDepth,
  MetadataPayload,
  SseEvent,
  ThumbnailInfo,
} from '@metadesk/shared';

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

type CommandPreviewSink = (argv: string[], context: string) => void;

/**
 * Reads often include a `commandPreview` (BUILD-NOTES: read endpoints include
 * it where it aids trust). The client forwards any it sees to the persistent
 * Command Preview drawer via this sink, so the trust-and-teaching habit is
 * built by every read operation without each view having to remember.
 */
let commandPreviewSink: CommandPreviewSink | null = null;
export function setCommandPreviewSink(sink: CommandPreviewSink | null): void {
  commandPreviewSink = sink;
}

function capturePreview(data: unknown, context: string): void {
  if (commandPreviewSink === null || data === null || typeof data !== 'object') return;
  const preview = (data as Record<string, unknown>)['commandPreview'];
  if (Array.isArray(preview) && preview.length > 0 && preview.every((t) => typeof t === 'string')) {
    commandPreviewSink(preview as string[], context);
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

export function getHealth(): Promise<HealthInfo> {
  return request<HealthInfo>('/api/health');
}

export function scanFolder(req: FolderScanRequest): Promise<FolderScanResult> {
  return request<FolderScanResult>('/api/folder/scan', {
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
  return request<ThumbnailInfo>(`/api/file/thumbnail?${params.toString()}`);
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
