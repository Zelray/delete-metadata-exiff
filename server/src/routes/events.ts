/**
 * Server-Sent Events hub: `/api/events`.
 *
 * Wire shape: one `event: <type>` + `data: <json>` frame per event. Every
 * payload carries a per-connection monotonic `seq` (gap detection) and a UTC
 * `timestamp`, matching the shared SseEvent union. `hello` is sent on
 * connect, `heartbeat` every 15s (injectable for tests), `scan-progress` /
 * `scan-complete` during scans, and `folder-changed` when the watched folder
 * changes (an additive event type — same frame shape, extra union member the
 * client may safely ignore).
 *
 * Token via query parameter is accepted for this route only (EventSource
 * cannot set headers); Origin/Host checks stay strict for SSE.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { HealthInfo } from '@metadesk/shared';
import type { WatchChange } from '../services/watcher.js';

export type SsePayload = Record<string, unknown> & { type: string };

interface SseConnection {
  reply: FastifyReply;
  nextSeq: number;
  heartbeat: NodeJS.Timeout;
}

export class SseHub {
  private readonly connections = new Set<SseConnection>();
  private readonly heartbeatMs: number;
  private health: HealthInfo | null = null;

  constructor(heartbeatMs = 15_000) {
    this.heartbeatMs = heartbeatMs;
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  /** The health snapshot attached to `hello` events (updated by /api/health). */
  setHealth(health: HealthInfo): void {
    this.health = health;
  }

  /** Attach one SSE client to the hub. Returns a closer. */
  connect(request: FastifyRequest, reply: FastifyReply): () => void {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.flushHeaders?.();

    const connection: SseConnection = {
      reply,
      nextSeq: 1,
      heartbeat: setInterval(() => {
        this.sendTo(connection, { type: 'heartbeat' });
      }, this.heartbeatMs),
    };
    // The heartbeat keeps proxies away; an unref'd timer must not hold the
    // process open by itself during shutdown.
    connection.heartbeat.unref();

    this.connections.add(connection);
    if (this.health !== null) {
      this.sendTo(connection, { type: 'hello', health: this.health });
    }

    const close = () => this.disconnect(connection);
    request.raw.on('close', close);
    return close;
  }

  /** Publish a `folder-changed` event (debounced batch from the watcher). */
  publishFolderChanged(folder: string, changes: WatchChange[]): void {
    this.broadcast({
      type: 'folder-changed',
      folder,
      changes: changes.slice(0, 50),
      truncated: changes.length > 50,
    });
  }

  publishScanProgress(event: { scanId: string; filesScanned: number; currentDirectory?: string }): void {
    this.broadcast({ type: 'scan-progress', ...event });
  }

  publishScanComplete(event: { scanId: string; totalFiles: number; warningCount: number }): void {
    this.broadcast({ type: 'scan-complete', ...event });
  }

  /** Close every connection and stop the heartbeats (server shutdown). */
  closeAll(): void {
    for (const connection of [...this.connections]) {
      clearInterval(connection.heartbeat);
      try {
        connection.reply.raw.end();
      } catch {
        /* already closed */
      }
    }
    this.connections.clear();
  }

  private broadcast(payload: SsePayload): void {
    for (const connection of [...this.connections]) {
      this.sendTo(connection, payload);
    }
  }

  private sendTo(connection: SseConnection, payload: SsePayload): void {
    const frame = { seq: connection.nextSeq, timestamp: new Date().toISOString(), ...payload };
    connection.nextSeq += 1;
    try {
      connection.reply.raw.write(`event: ${payload.type}\ndata: ${JSON.stringify(frame)}\n\n`);
    } catch {
      this.disconnect(connection);
    }
  }

  private disconnect(connection: SseConnection): void {
    if (!this.connections.has(connection)) return;
    this.connections.delete(connection);
    clearInterval(connection.heartbeat);
    try {
      connection.reply.raw.end();
    } catch {
      /* already closed */
    }
  }
}

/** Route registration: GET /api/events (token accepted via ?token= as well). */
export function registerEventsRoute(
  app: import('fastify').FastifyInstance,
  hub: SseHub,
): void {
  app.get('/api/events', async (request: FastifyRequest, reply: FastifyReply) => {
    // Hijack: the response is a never-ending SSE stream managed by the hub,
    // not a payload Fastify should serialize.
    reply.hijack();
    hub.connect(request, reply);
    return await Promise.resolve();
  });
}
