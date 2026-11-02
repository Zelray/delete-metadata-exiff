import { defineConfig } from 'vitest/config';
import type { Plugin, ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Issue #17: the portfile's field rules live in ONE reader for the whole
// Node side (scripts/lib/portfile.mjs) — the dev plugin no longer keeps a
// private fifth definition of the shape.
import { readPortfile } from '../scripts/lib/portfile.mjs';

/**
 * MetaDesk dev-mode handshake (BUILD-NOTES pinned decision).
 *
 * When the UI is served by the Fastify server, the server injects
 * `window.__METADESK__ = { token, version, readOnlyDefault }` into the HTML.
 * Under `vite dev` there is no server-side injection, so this tiny plugin:
 *
 *   1. reads the launcher's `app/data/portfile.json` (fresh per request),
 *   2. proxies `/api` (and `/thumbnails`) to that port so the browser talks
 *      to the real MetaDesk server from the Vite origin, and
 *   3. injects a dev `window.__METADESK__` bootstrap with the portfile's
 *      token, when the launcher records one.
 */
const PORTFILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../data/portfile.json',
);

function metadeskDev(): Plugin {
  return {
    name: 'metadesk-dev-handshake',
    apply: 'serve',
    transformIndexHtml() {
      return [
        {
          tag: 'script',
          attrs: { type: 'module' },
          children: `
            (async () => {
              try {
                const pf = await fetch('/@metadesk/portfile').then((r) => (r.ok ? r.json() : null));
                window.__METADESK__ = {
                  token: pf && typeof pf.token === 'string' ? pf.token : '',
                  version: 'dev',
                  readOnlyDefault: true,
                };
              } catch {
                window.__METADESK__ = { token: '', version: 'dev', readOnlyDefault: true };
              }
              window.dispatchEvent(new Event('metadesk:bootstrap'));
            })();
          `,
          injectTo: 'head-prepend',
        },
      ];
    },
    configureServer(server: ViteDevServer) {
      // Tiny JSON endpoint so the injected bootstrap can read the portfile
      // without any build-time coupling to the launcher's disk layout.
      server.middlewares.use('/@metadesk/portfile', (_req: IncomingMessage, res: ServerResponse) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(readPortfile(PORTFILE) ?? {}));
      });

      // Dynamic /api (and /thumbnails) proxy: re-reads the portfile on every
      // request, so the launcher can restart the server on a new port without
      // restarting Vite.
      const forward = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const pf = readPortfile(PORTFILE);
        if (pf === null) {
          res.statusCode = 503;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              code: 'engine_unavailable',
              message:
                'MetaDesk server is not running. Start it with "npm run dev" in app/, then reload.',
            }),
          );
          return;
        }
        const url = `http://127.0.0.1:${pf.port}${req.url ?? '/'}`;
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
        try {
          const upstream = await fetch(url, {
            method: req.method,
            headers: { host: `127.0.0.1:${pf.port}` },
            body: body,
          });
          res.statusCode = upstream.status;
          upstream.headers.forEach((value, key) => {
            const lower = key.toLowerCase();
            if (lower !== 'content-encoding' && lower !== 'transfer-encoding') {
              res.setHeader(key, value);
            }
          });
          const payload = Buffer.from(await upstream.arrayBuffer());
          res.end(payload);
        } catch (err) {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              code: 'engine_unavailable',
              message: `Could not reach the MetaDesk server on port ${pf.port}: ${String(err)}`,
            }),
          );
        }
      };
      server.middlewares.use('/api', (req: IncomingMessage, res: ServerResponse) =>
        void forward(req, res),
      );
      server.middlewares.use('/thumbnails', (req: IncomingMessage, res: ServerResponse) =>
        void forward(req, res),
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), metadeskDev()],
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
