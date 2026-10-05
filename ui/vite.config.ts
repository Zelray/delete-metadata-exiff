import { defineConfig } from 'vitest/config';
import type { Plugin, ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

interface Portfile {
  port: number;
  pid?: number;
  token?: string;
  url?: string;
}

async function readPortfile(): Promise<Portfile | null> {
  try {
    const raw = await readFile(PORTFILE, 'utf8');
    return JSON.parse(raw) as Portfile;
  } catch {
    return null;
  }
}

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
        void readPortfile().then((pf) => {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(pf ?? {}));
        });
      });

      // Dynamic /api (and /thumbnails) proxy: re-reads the portfile on every
      // request, so the launcher can restart the server on a new port without
      // restarting Vite.
      const forward = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const pf = await readPortfile();
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
