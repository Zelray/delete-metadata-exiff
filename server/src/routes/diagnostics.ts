/**
 * Diagnostics support bundle (leaf 2.2.1):
 *
 *   GET /api/diagnostics/bundle  ->  application/zip (attachment)
 *
 * Builds a small ZIP of MetaDesk's OWN records — never photo data — so a
 * helper can see what the app was doing:
 *
 *   README.txt        plain English: what this bundle is and what is inside
 *   context.txt       data dir, write mode at bundle time, timestamps
 *   engine.txt        remembered engine version + a LIVE `exiftool -ver` check
 *   versions.txt      app version, server version, Node, platform
 *   journal-tail.txt  the last ~200 lines (or ~256 KB) of the write journal
 *
 * The same bytes are ALSO written to <dataDir>/diagnostics/<name>.zip and the
 * on-disk path is returned in `X-MetaDesk-Diagnostics-Path`: the file survives
 * even when a browser download leaves the user unsure where it landed. Nothing
 * is ever uploaded — the route only reads local state and writes one local file.
 *
 * Auth rides the server's global onRequest gates (Host / Origin / token) like
 * every other /api route; there is deliberately no token exemption here.
 *
 * ZIP shape: STORED (uncompressed) entries written by hand with node:buffer —
 * the files are small text, so compression buys nothing, and a hand-rolled
 * stored-entry zip stays honest and dependency-free. CRC-32 is implemented
 * locally (the standard reflected table) rather than zlib.crc32, so the bundle
 * works on any Node 22.x, including the pinned portable runtime.
 */
import { readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { arch, release, type } from 'node:os';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { APP_ROOT, readEngineVersionCache } from '../config.js';
import { Journal } from '../services/journal.js';
import { sendError } from './api.js';

export interface DiagnosticsRouteDeps {
  dataDir: string;
  /** The exiftool.exe this server was configured to drive. */
  executablePath: string;
  /** App version from app/package.json (config.serverVersion). */
  appVersion: string;
}

/** Journal tail caps (leaf-2.2.1 spec: ~200 lines or ~256 KB). */
const JOURNAL_TAIL_LINES = 200;
const JOURNAL_TAIL_BYTES = 256 * 1024;

// ---- zip (stored entries) ---------------------------------------------------

interface ZipEntry {
  name: string;
  data: Buffer;
  timestamp: Date;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    const byte = data[i] ?? 0;
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS packed time/date, local time (what every zip tool shows). */
function dosDateTime(at: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, at.getFullYear());
  return {
    dosTime: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
    dosDate: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}

/** Build a valid STORED-entry zip (local headers + central directory + EOCD). */
function buildZip(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let centralSize = 0;
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const { dosTime, dosDate } = dosDateTime(entry.timestamp);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 entry names
    local.writeUInt16LE(0, 8); // method 0 = stored
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18); // stored: sizes are equal
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    chunks.push(local, name, entry.data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); // central directory signature
    dir.writeUInt16LE(0x0014, 4); // version made by: MS-DOS, spec 2.0
    dir.writeUInt16LE(20, 6); // version needed to extract
    dir.writeUInt16LE(0x0800, 8); // flags: UTF-8 entry names
    dir.writeUInt16LE(0, 10); // method 0 = stored
    dir.writeUInt16LE(dosTime, 12);
    dir.writeUInt16LE(dosDate, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(entry.data.length, 20);
    dir.writeUInt32LE(entry.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30); // extra length
    dir.writeUInt16LE(0, 32); // comment length
    dir.writeUInt16LE(0, 34); // disk number start
    dir.writeUInt16LE(0, 36); // internal attributes
    dir.writeUInt32LE(0, 38); // external attributes
    dir.writeUInt32LE(offset, 42); // relative offset of local header
    central.push(dir, name);

    offset += local.length + name.length + entry.data.length;
    centralSize += 46 + name.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16); // central directory offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...chunks, ...central, eocd]);
}

// ---- bundle contents ----------------------------------------------------------

function bundleStamp(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  );
}

let serverVersionCache: string | null = null;

/**
 * The server workspace's own package.json version. In the bundled portable
 * layout the frozen server ships as a single file with no server/package.json,
 * where "not labeled in this install" is the honest answer.
 */
function readServerVersion(): string {
  if (serverVersionCache !== null) return serverVersionCache;
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(APP_ROOT, 'server', 'package.json'), 'utf8'),
    ) as { version?: string };
    serverVersionCache = typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    serverVersionCache = 'not labeled in this install';
  }
  return serverVersionCache;
}

/**
 * Journal tail: walk batch files newest-first, keep WHOLE JSON records until
 * the line cap or the byte cap is hit, and label exactly what was kept — a
 * support helper must be able to trust that nothing was silently summarized.
 */
async function buildJournalTail(dataDir: string, generatedAt: Date): Promise<string> {
  const journal = new Journal({ dataDir });
  const header = [
    'MetaDesk write journal — tail',
    `Generated at: ${generatedAt.toISOString()}`,
    `Journal folder: ${journal.batchesDir}`,
  ];

  let names: string[];
  try {
    names = (await readdir(journal.batchesDir)).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return [
      ...header,
      'The journal folder does not exist yet — no writes have been journalled on this install.',
      '',
    ].join('\n');
  }

  const stamped = await Promise.all(
    names.map(async (name) => ({
      name,
      modifiedAt: (await stat(path.join(journal.batchesDir, name))).mtimeMs,
    })),
  );
  stamped.sort((a, b) => b.modifiedAt - a.modifiedAt);

  const lines: string[] = [];
  const sizes: number[] = [];
  let bytes = 0;
  let filesRead = 0;
  let complete = true;

  for (const file of stamped) {
    let raw: string;
    try {
      raw = await readFile(path.join(journal.batchesDir, file.name), 'utf8');
    } catch {
      complete = false; // a file vanished mid-read: say so rather than pretend
      continue;
    }
    filesRead += 1;
    const fileLines = raw.split('\n').filter((line) => line.trim().length > 0);
    for (let i = fileLines.length - 1; i >= 0; i -= 1) {
      const line = fileLines[i] as string;
      const size = Buffer.byteLength(line, 'utf8');
      // The caps are soft for the first record: an empty tail would be honest
      // but useless, so at least one whole record always survives.
      const capReached =
        lines.length >= JOURNAL_TAIL_LINES || (lines.length > 0 && bytes + size > JOURNAL_TAIL_BYTES);
      if (capReached) {
        complete = false;
        break;
      }
      lines.unshift(line);
      sizes.unshift(size);
      bytes += size;
    }
    if (!complete) break;
  }

  // Whole-record safety: never cut a JSON record in half to meet the byte cap.
  while (lines.length > 1 && bytes > JOURNAL_TAIL_BYTES) {
    const dropped = sizes.shift() as number;
    lines.shift();
    bytes -= dropped;
  }

  return [
    ...header,
    `Batch files on disk: ${names.length} (read newest-first; ${filesRead} read)`,
    complete
      ? `Kept: all ${lines.length} lines — the whole journal fits in this tail.`
      : `Kept: the newest ${lines.length} lines; older lines were dropped (the journal is longer than this tail).`,
    'Each line below is one JSON journal record (batch-start, intent, result, batch-end).',
    '---',
    ...lines,
    '',
  ].join('\n');
}

interface LiveHealth {
  ok: boolean;
  version: string;
  executablePath: string;
  reason: string;
  mode: string | null;
  writeUnlocked: boolean | null;
}

/**
 * One internal round trip to /api/health gives the bundle BOTH the live
 * `exiftool -ver` handshake result AND the session's write mode (the additive
 * fields the write routes stamp on every health reply). It rides the same
 * gates as any request and costs the single handshake a health poll costs.
 * Every field is parsed defensively: an unknown shape degrades to "unknown"
 * in the bundle, never to a wrong answer.
 */
async function readLiveHealth(app: FastifyInstance): Promise<LiveHealth | null> {
  try {
    const address = app.server.address();
    const port = address !== null && typeof address === 'object' ? address.port : null;
    const host = port === null ? '127.0.0.1' : `127.0.0.1:${port}`;
    const response = await app.inject({ url: '/api/health', headers: { host } });
    if (response.statusCode !== 200) return null;
    const body = response.json() as Record<string, unknown>;
    return {
      ok: body['ok'] === true,
      version: typeof body['version'] === 'string' ? body['version'] : '',
      executablePath: typeof body['executablePath'] === 'string' ? body['executablePath'] : '',
      reason: typeof body['reason'] === 'string' ? body['reason'] : '',
      mode: typeof body['mode'] === 'string' ? (body['mode'] as string) : null,
      writeUnlocked: typeof body['writeUnlocked'] === 'boolean' ? body['writeUnlocked'] : null,
    };
  } catch {
    return null;
  }
}

async function buildEngineSection(
  deps: DiagnosticsRouteDeps,
  live: LiveHealth | null,
): Promise<string> {
  const cached = await readEngineVersionCache({ dataDir: deps.dataDir });
  const lines = [
    'MetaDesk engine (exiftool)',
    `Configured executable path: ${deps.executablePath}`,
    '',
    'Remembered from the last startup handshake (data\\engine-version.json):',
    cached === null
      ? '  none recorded — the startup handshake has not written its cache yet'
      : [
          `  version: ${cached.version}`,
          `  checked at: ${cached.checkedAt}`,
          `  path: ${cached.executablePath}`,
        ].join('\n'),
    '',
    'Live handshake run just now (exiftool -ver):',
  ];
  if (live === null) {
    lines.push('  the live check could not be run — no answer was recorded');
  } else {
    lines.push(
      `  answered: ${live.ok ? 'yes — read commands run' : 'no — read-only fallback'}`,
      `  version: ${live.version === '' ? '(none reported)' : live.version}`,
      `  path: ${live.executablePath}`,
    );
    if (!live.ok && live.reason.length > 0) lines.push(`  why: ${live.reason}`);
  }
  lines.push('');
  return lines.join('\n');
}

function buildVersionsSection(deps: DiagnosticsRouteDeps): string {
  return [
    'MetaDesk versions',
    `App version (app\\package.json): ${deps.appVersion}`,
    `Server workspace version (app\\server\\package.json): ${readServerVersion()}`,
    `Node.js: ${process.version}`,
    `Platform: ${process.platform} ${arch()} — ${type()} ${release()}`,
    '',
  ].join('\n');
}

function buildContextSection(
  deps: DiagnosticsRouteDeps,
  outPath: string,
  generatedAt: Date,
  live: LiveHealth | null,
): string {
  const mode =
    live === null || live.mode === null
      ? 'unknown — the mode lives in the running session and could not be read just now'
      : live.mode === 'write-unlocked'
        ? 'write-unlocked for this session (unlocking is deliberate and resets at restart)'
        : 'read-only';
  return [
    'MetaDesk diagnostics — context',
    `Generated at: ${generatedAt.toISOString()} (local: ${generatedAt.toString()})`,
    `Data folder: ${deps.dataDir}`,
    `Journal folder: ${path.join(deps.dataDir, 'journal')}`,
    `This bundle was also saved to: ${outPath}`,
    '',
    `Write mode at bundle time: ${mode}`,
    'MetaDesk always STARTS read-only; writing requires an explicit per-session unlock.',
    '',
  ].join('\n');
}

function buildReadme(generatedAt: Date): string {
  return [
    'What this bundle is',
    '',
    `MetaDesk wrote this file bundle on ${generatedAt.toString()} so a helper can see what the`,
    'app was doing. It is a few small text files — MetaDesk\'s own records, not your photos:',
    '',
    '  journal-tail.txt  the last part of MetaDesk\'s journal of changes. It can contain file',
    '                    paths and the tag values MetaDesk wrote (a title you set, for example),',
    '                    but never the photos themselves.',
    '  engine.txt        which ExifTool engine MetaDesk found, its version, and whether the',
    '                    live handshake answered just now.',
    '  versions.txt      which MetaDesk, Node and Windows versions are in use.',
    '  context.txt       where MetaDesk keeps its data and which mode it was in.',
    '',
    'Nothing here was sent anywhere by MetaDesk. The bundle stays on this computer until you',
    'choose to share it — attach the zip to an email or a support message yourself.',
    '',
  ].join('\n');
}

// ---- route --------------------------------------------------------------------

export function registerDiagnosticsRoutes(app: FastifyInstance, deps: DiagnosticsRouteDeps): void {
  app.get('/api/diagnostics/bundle', async (_request: FastifyRequest, reply: FastifyReply) => {
    const generatedAt = new Date();
    const filename = `metadesk-diagnostics-${bundleStamp(generatedAt)}.zip`;

    try {
      const live = await readLiveHealth(app);
      const outPath = path.join(deps.dataDir, 'diagnostics', filename);
      const entries: ZipEntry[] = [
        { name: 'README.txt', data: Buffer.from(buildReadme(generatedAt), 'utf8'), timestamp: generatedAt },
        {
          name: 'context.txt',
          data: Buffer.from(buildContextSection(deps, outPath, generatedAt, live), 'utf8'),
          timestamp: generatedAt,
        },
        {
          name: 'engine.txt',
          data: Buffer.from(await buildEngineSection(deps, live), 'utf8'),
          timestamp: generatedAt,
        },
        {
          name: 'versions.txt',
          data: Buffer.from(buildVersionsSection(deps), 'utf8'),
          timestamp: generatedAt,
        },
        {
          name: 'journal-tail.txt',
          data: Buffer.from(await buildJournalTail(deps.dataDir, generatedAt), 'utf8'),
          timestamp: generatedAt,
        },
      ];

      const bytes = buildZip(entries);
      const outDir = path.join(deps.dataDir, 'diagnostics');
      await mkdir(outDir, { recursive: true });
      await writeFile(outPath, bytes);

      return reply
        .code(200)
        .header('content-type', 'application/zip')
        .header('content-length', bytes.length)
        .header('content-disposition', `attachment; filename="${filename}"`)
        // Same-origin by pinned design (the server serves the UI), so the
        // browser hands this header to fetch() without an expose-list.
        .header('x-metadesk-diagnostics-path', outPath)
        .send(bytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return sendError(
        reply,
        500,
        'internal_error',
        `The diagnostics bundle could not be built: ${message}`,
      );
    }
  });
}
