/**
 * MetaDesk server bootstrap (leaf 1.1.2).
 *
 * Binds 127.0.0.1 ONLY. Every request passes three gates before any /api
 * route runs:
 *
 *  1. Host check — the Host header must name this machine and this port
 *     (DNS-rebinding guard).
 *  2. Origin check — browser requests that carry an Origin must originate
 *     from this server's own origin; cross-origin browser calls are 403.
 *  3. Token check — every /api route except /api/health requires the
 *     per-launch X-MetaDesk-Token (401 otherwise). /api/health stays open so
 *     the launcher can poll it without a token (pinned handshake, BUILD-NOTES).
 *
 * The per-launch token is generated at boot (or taken from METADESK_TOKEN)
 * and written to app/data/portfile.json next to {port, pid} so the launcher
 * and the UI can find it. The token is also injected into the served UI as
 * window.__METADESK__ = {token, version, readOnlyDefault}.
 *
 * Engine lifecycle: one persistent exiftool session serves all reads; server
 * shutdown shuts the session down through its graceful ladder, so no orphan
 * exiftool process survives a clean stop. On Windows, killing the console
 * sends no signal — the server therefore also shuts down when its stdin pipe
 * closes (the launcher's and the verify script's stop channel).
 */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { ApiError as ApiErrorLike } from '@metadesk/shared';
import fastifyStatic from '@fastify/static';
import type { HealthInfo, TagCatalog } from '@metadesk/shared';
import {
  loadConfig,
  writeEngineVersionCache,
  type MetaDeskConfig,
} from './config.js';
import { checkEngineHealth } from './engine/healthCheck.js';
import { ExifToolSession } from './engine/exiftoolSession.js';
import { loadTagCatalog } from './engine/tagDatabase.js';
import { MetadataService } from './services/metadata.js';
import { ThumbnailService } from './services/thumbnails.js';
import { FolderWatcher } from './services/watcher.js';
import { registerConsoleRoute, registerHealthRoute, sendError } from './routes/api.js';
import { registerFileRoutes } from './routes/files.js';
import { registerMetadataRoutes } from './routes/metadata.js';
import { registerThumbnailRoutes } from './routes/thumbnails.js';
import { registerEventsRoute, SseHub } from './routes/events.js';
import { registerWriteRoutes } from './routes/writes.js';
import { registerRecoveryRoutes } from './routes/recovery.js';
import { registerDiagnosticsRoutes } from './routes/diagnostics.js';

export interface BuildServerOptions {
  config: MetaDeskConfig;
  /** Per-launch token; generated when absent. */
  token?: string;
  /** Pre-computed health (tests); a live handshake is used when absent. */
  health?: HealthInfo;
  /** Existing engine session to attach (tests); a new one is created when absent. */
  engine?: ExifToolSession | null;
  /** SSE heartbeat interval in ms (tests may shorten it). Default 15000. */
  sseHeartbeatMs?: number;
  /** Fastify logger. Default false. */
  logger?: boolean;
}

export interface BuildServerResult {
  app: FastifyInstance;
  config: MetaDeskConfig;
  token: string;
  engine: ExifToolSession | null;
  hub: SseHub;
  watcher: FolderWatcher;
  metadata: MetadataService | null;
  thumbnails: ThumbnailService;
  getHealth: () => Promise<HealthInfo>;
}

/** Construct (but do not start listening) the fully wired server. */
export async function buildServer(options: BuildServerOptions): Promise<BuildServerResult> {
  const config = options.config;
  const token =
    options.token ?? process.env['METADESK_TOKEN'] ?? randomBytes(24).toString('base64url');

  // ---- engine -----------------------------------------------------------------
  let engine = options.engine ?? null;
  let health =
    options.health ??
    (await checkEngineHealth({ executablePath: config.executablePath }));
  if (engine === null && health.ok) {
    const session = new ExifToolSession({ executablePath: config.executablePath });
    try {
      await session.start();
      engine = session;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      health = { ...health, ok: false, readOnlyFallback: true, reason: message };
    }
  }

  // The `-listx` catalog is loaded lazily on first raw-tier read and cached
  // on disk; a failed load only costs writable flags, never a request.
  let catalogPromise: Promise<TagCatalog | null> | null = null;
  const getCatalog = (): Promise<TagCatalog | null> => {
    if (catalogPromise === null) {
      catalogPromise = loadTagCatalog({
        executablePath: config.executablePath,
        cacheDir: config.dataDir,
      })
        .then((result) => result.catalog)
        .catch(() => null);
    }
    return catalogPromise;
  };

  const getHealth = async (): Promise<HealthInfo> => {
    if (options.health !== undefined) return options.health;
    const live = await checkEngineHealth({ executablePath: config.executablePath });
    if (live.ok && engine === null) {
      return { ...live, ok: false, readOnlyFallback: true, reason: 'engine session is not running' };
    }
    return live;
  };

  const hub = new SseHub(options.sseHeartbeatMs ?? 15_000);
  // `hello` frames carry the boot health snapshot; refresh it whenever the
  // health route is polled.
  hub.setHealth(health);
  const watcher = new FolderWatcher();
  const metadata = engine !== null ? new MetadataService(engine, getCatalog) : null;
  const thumbnails = new ThumbnailService(config);

  watcher.subscribe((changes) => {
    if (watcher.folder !== null) hub.publishFolderChanged(watcher.folder, changes);
  });

  // ---- fastify ------------------------------------------------------------------
  const app = Fastify({ logger: options.logger ?? false });

  /** A gate rejection: thrown in onRequest, shaped by the error handler. */
  class RequestGateError extends Error {
    constructor(
      readonly statusCode: number,
      readonly payload: { code: ApiErrorLike['code']; message: string },
    ) {
      super(payload.message);
      this.name = 'RequestGateError';
    }
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RequestGateError) {
      return reply.code(error.statusCode).send(error.payload);
    }
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(500).send({ code: 'internal_error', message });
  });

  app.addHook('onRequest', async (request: FastifyRequest, _reply: FastifyReply) => {
    const boundPort = boundServerPort(app);
    // 1. Host: this machine, this port (when bound).
    if (!hostAllowed(request.headers.host, boundPort)) {
      throw new RequestGateError(403, {
        code: 'bad_request',
        message: 'This server only answers to 127.0.0.1 (Host check).',
      });
    }
    // 2. Origin: browser-sent origins must be this server's own origin.
    const origin = request.headers.origin;
    if (typeof origin === 'string' && origin.length > 0 && !originAllowed(origin, boundPort)) {
      throw new RequestGateError(403, {
        code: 'bad_request',
        message: 'Cross-origin requests are rejected.',
      });
    }
    // 3. Token: every /api route except /api/health.
    const url = request.raw.url ?? '';
    if (url.startsWith('/api') && !url.startsWith('/api/health')) {
      const provided =
        request.headers['x-metadesk-token'] ??
        (url.startsWith('/api/events') ? (request.query as Record<string, unknown>)?.['token'] : undefined);
      if (typeof provided !== 'string' || !tokenMatches(provided, token)) {
        throw new RequestGateError(401, {
          code: 'bad_request',
          message: 'Missing or invalid X-MetaDesk-Token.',
        });
      }
    }
  });

  registerHealthRoute(app, { getHealth, hub });
  registerConsoleRoute(app, { engine });
  registerFileRoutes(app, { engine, thumbnails, hub, watcher });
  registerMetadataRoutes(app, { metadata });
  registerThumbnailRoutes(app, { thumbnails });
  registerEventsRoute(app, hub);
  // Safety core (leaf 1.1.4): write pipeline + recovery routes. Registered
  // after the read routes; write routes self-gate on the session unlock
  // state and the single-writer lock.
  registerWriteRoutes(app, { engine, dataDir: config.dataDir, hub });
  registerRecoveryRoutes(app, { dataDir: config.dataDir });
  // Diagnostics support bundle (leaf 2.2.1) — rides the same request gates.
  registerDiagnosticsRoutes(app, {
    dataDir: config.dataDir,
    executablePath: config.executablePath,
    appVersion: config.serverVersion,
  });

  await registerStaticUi(app, config, { token, version: config.serverVersion });

  app.addHook('onClose', async () => {
    await watcher.stop();
    hub.closeAll();
    if (engine !== null) {
      await engine.shutdown();
    }
  });

  return {
    app,
    config,
    token,
    engine,
    hub,
    watcher,
    metadata,
    thumbnails,
    getHealth,
  };
}

// ---- static UI ---------------------------------------------------------------

const METADESK_PLACEHOLDER = '<!--__METADESK__-->';

async function registerStaticUi(
  app: FastifyInstance,
  config: MetaDeskConfig,
  boot: { token: string; version: string },
): Promise<void> {
  const hasDist = existsSync(config.uiDistDir);
  if (hasDist) {
    await app.register(fastifyStatic, {
      root: config.uiDistDir,
      prefix: '/',
      index: false,
      decorateReply: false,
    });
  }

  const sendIndex = async (reply: FastifyReply): Promise<FastifyReply> => {
    const html = hasDist
      ? await readFile(path.join(config.uiDistDir, 'index.html'), 'utf8').catch(() => null)
      : null;
    const page = html ?? statusPage(config);
    return reply
      .code(200)
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(injectBootScript(page, boot.token, boot.version));
  };

  app.get('/', async (_request, reply) => sendIndex(reply));

  app.setNotFoundHandler(async (request, reply) => {
    if (request.raw.url?.startsWith('/api') === true) {
      return sendError(reply, 404, 'not_found', `No such API route: ${request.raw.url}`);
    }
    // SPA history fallback: any non-API route serves the app shell.
    return sendIndex(reply);
  });
}

/**
 * Put the boot script where the UI expects it: replacing the pinned
 * placeholder comment when present, otherwise just before </head> (or at the
 * very top of the document as a last resort).
 */
export function injectBootScript(html: string, token: string, version: string): string {
  const payload = JSON.stringify({ token, version, readOnlyDefault: true }).replace(/</g, '\\u003c');
  const script = `<script>window.__METADESK__=${payload};</script>`;
  if (html.includes(METADESK_PLACEHOLDER)) {
    return html.replace(METADESK_PLACEHOLDER, script);
  }
  if (html.includes('</head>')) {
    return html.replace('</head>', `${script}</head>`);
  }
  return `${script}${html}`;
}

function statusPage(config: MetaDeskConfig): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><title>MetaDesk</title>',
    '<style>body{font-family:system-ui,sans-serif;margin:4rem auto;max-width:42rem;color:#1c1c1c}',
    'code{background:#f2f2f2;padding:0 .35em;border-radius:4px}</style></head><body>',
    '<h1>MetaDesk server is running</h1>',
    `<p>Version <code>${config.serverVersion}</code> on <code>127.0.0.1</code>.</p>`,
    '<p>The UI bundle is not built yet (<code>app/ui/dist</code> is missing).',
    'The API is live: see <code>/api/health</code>.</p>',
    '</body></html>',
  ].join('');
}

// ---- request gates --------------------------------------------------------------

const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function boundServerPort(app: FastifyInstance): number | null {
  const address = app.server.address();
  if (address === null || typeof address === 'string') return null;
  return address.port;
}

function splitHost(host: string | undefined): { hostname: string; port: string } | null {
  if (host === undefined || host.length === 0) return null;
  const separator = host.lastIndexOf(':');
  if (host.startsWith('[')) {
    // [::1]:8080
    const close = host.indexOf(']');
    if (close < 0) return { hostname: host, port: '' };
    return { hostname: host.slice(0, close + 1), port: host.slice(close + 2) };
  }
  if (separator <= 0) return { hostname: host, port: '' };
  return { hostname: host.slice(0, separator), port: host.slice(separator + 1) };
}

function hostAllowed(host: string | undefined, boundPort: number | null): boolean {
  const parts = splitHost(host);
  if (parts === null) return false;
  if (!LOCAL_HOSTNAMES.has(parts.hostname)) return false;
  if (boundPort !== null && parts.port.length > 0 && Number.parseInt(parts.port, 10) !== boundPort) {
    return false;
  }
  return true;
}

function originAllowed(origin: string, boundPort: number | null): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!LOCAL_HOSTNAMES.has(hostname) && !LOCAL_HOSTNAMES.has(`[${hostname}]`)) return false;
  if (boundPort !== null) {
    const port = parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : 80;
    if (port !== boundPort) return false;
  }
  return true;
}

/** Constant-time token comparison (hashed to equal length first). */
function tokenMatches(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

// ---- process entry ----------------------------------------------------------------

export interface PortfilePayload {
  port: number;
  token: string;
  pid: number;
  startedAt: string;
  engine: string;
  url: string;
}

/** Write the launcher handshake file: {port, token, pid, ...}. */
export async function writePortfile(
  config: MetaDeskConfig,
  payload: PortfilePayload,
): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(config.portfilePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

const ENTRY_DIRECT = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (ENTRY_DIRECT) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`metadesk server failed to start: ${message}\n`);
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const health = await checkEngineHealth({ executablePath: config.executablePath });
  await writeEngineVersionCache(config, {
    version: health.version,
    checkedAt: new Date().toISOString(),
    executablePath: config.executablePath,
  });

  // Test/dev seam: shorten the SSE heartbeat without touching the 15s default.
  const heartbeatRaw = Number.parseInt(process.env['METADESK_SSE_HEARTBEAT_MS'] ?? '', 10);
  const sseHeartbeatMs = Number.isFinite(heartbeatRaw) && heartbeatRaw > 0 ? heartbeatRaw : undefined;

  const server = await buildServer({ config, health, sseHeartbeatMs });

  let stopping = false;
  const stop = (reason: string): void => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`metadesk server stopping (${reason})\n`);
    void server.app
      .close()
      .catch(() => undefined)
      .then(() => process.exit(0));
  };

  // Windows sends no signal on console close / taskkill; the launcher and the
  // verify script stop the server by closing its stdin pipe instead.
  if (!process.stdin.isTTY) {
    process.stdin.on('end', () => stop('stdin closed'));
    process.stdin.on('close', () => stop('stdin closed'));
    process.stdin.resume();
  }
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  await server.app.listen({ port: config.requestedPort, host: '127.0.0.1' });
  const boundPort = boundServerPort(server.app) ?? config.requestedPort;

  await writePortfile(config, {
    port: boundPort,
    token: server.token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    engine: config.executablePath,
    url: `http://127.0.0.1:${boundPort}/`,
  });

  process.stdout.write(
    `MetaDesk server listening on http://127.0.0.1:${boundPort} (pid ${process.pid}, engine ${health.version || 'unavailable'}, portfile ${config.portfilePath})\n`,
  );
}
