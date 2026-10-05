#!/usr/bin/env node
/**
 * Portable Node runtime fetch (leaf 2.1.1, decision D3).
 *
 * Downloads the PINNED Node.js win-x64 `node.exe` into `app/vendor/node/node.exe`
 * so the Tauri shell can ship it UNRENAMED at `node\node.exe` inside the portable
 * package (the stock OpenJS Authenticode signature is the AV reputation).
 *
 * PINNING (decision D3 — exact version, verified against the release SHASUMS):
 *   version : v22.22.3 (the dev machine's runtime; published 2026-05-13, `lts` line)
 *   artifact: https://nodejs.org/dist/v22.22.3/win-x64/node.exe
 *   sha256  : 780f44f2c53c108bae261ada21a525b4bfe733c020ac85e41bfe94479090ac9b
 *             (from https://nodejs.org/dist/v22.22.3/SHASUMS256.txt, entry
 *              `win-x64/node.exe`; re-checked against the live SHASUMS file on
 *              every download, and the downloaded bytes must match BOTH the pin
 *              and the published list — a mismatch is a supply-chain tripwire
 *              and fails the build).
 * To move the pin: bump both constants from the new release's SHASUMS256.txt and
 * record the change in the build log.
 *
 * Modes:
 *   (default)    ensure `app/vendor/node/node.exe` exists with the pinned hash —
 *                a matching file is a cache hit and is NOT re-downloaded;
 *                otherwise download to a temp file, hash, verify, install.
 *   --verify     re-check an existing download (hash must equal the pin) and
 *                print `node runtime fetch verified` as the FIRST stdout line.
 *
 * Output convention: markers on stdout, progress on stderr. Node built-ins only.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(APP_ROOT, 'vendor', 'node', 'node.exe');

const PINNED_NODE_VERSION = 'v22.22.3';
const PINNED_NODE_EXE_SHA256 = '780f44f2c53c108bae261ada21a525b4bfe733c020ac85e41bfe94479090ac9b';
const DIST_BASE = 'https://nodejs.org/dist';
const ARTIFACT_PATH = `win-x64/node.exe`;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

const verifyOnly = process.argv.slice(2).includes('--verify');

function note(message) {
  process.stderr.write(`[fetch-node] ${message}\n`);
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function fetchShasums() {
  const url = `${DIST_BASE}/${PINNED_NODE_VERSION}/SHASUMS256.txt`;
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`SHASUMS256.txt -> HTTP ${response.status} (${url})`);
  const text = await response.text();
  for (const line of text.split(/\r?\n/)) {
    const [hash, ...rest] = line.trim().split(/\s+/);
    if (rest.join(' ') === ARTIFACT_PATH && /^[0-9a-f]{64}$/.test(hash)) return hash;
  }
  throw new Error(`${ARTIFACT_PATH} is missing from ${PINNED_NODE_VERSION}/SHASUMS256.txt`);
}

async function download(url, destFile) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    throw new Error(`download -> HTTP ${response.status} (${url})`);
  }
  const total = Number(response.headers.get('content-length') ?? 0);
  note(`downloading ${url}`);
  note(total > 0 ? `${(total / 1048576).toFixed(1)} MiB total` : 'size unknown (streaming)');
  let seen = 0;
  let lastNote = 0;
  const source = Readable.fromWeb(response.body);
  source.on('data', (chunk) => {
    seen += chunk.length;
    const now = Date.now();
    if (now - lastNote > 4000) {
      lastNote = now;
      note(
        total > 0
          ? `  ${(seen / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MiB`
          : `  ${(seen / 1048576).toFixed(1)} MiB`,
      );
    }
  });
  await pipeline(source, createWriteStream(destFile));
  note(`downloaded ${(seen / 1048576).toFixed(1)} MiB`);
  return seen;
}

async function main() {
  const localHash = existsSync(TARGET) ? await sha256File(TARGET) : null;

  if (localHash === PINNED_NODE_EXE_SHA256) {
    // Cache hit: the pinned runtime is already installed; never re-download.
    const provenance = `${PINNED_NODE_VERSION} sha256=${localHash} bytes=${statSync(TARGET).size}`;
    note(`cache hit: ${TARGET} already carries the pinned hash`);
    if (verifyOnly) {
      await crossCheckPublished();
      // Marker first (gate convention), provenance second.
      process.stdout.write('node runtime fetch verified\n');
      process.stdout.write(`node runtime pinned ${provenance}\n`);
    } else {
      process.stdout.write(`node runtime fetch cache-hit ${provenance}\n`);
    }
    return;
  }

  if (verifyOnly) {
    if (localHash === null) {
      throw new Error(
        `--verify: no runtime fetched yet (expected ${TARGET}). Run "npm run fetch:node" first.`,
      );
    }
    throw new Error(
      `--verify: ${TARGET} hash ${localHash} does not match the pin ${PINNED_NODE_EXE_SHA256} (${PINNED_NODE_VERSION}); delete it and re-run "npm run fetch:node".`,
    );
  }

  // Download path: the published list is the primary authority, the pin the
  // tripwire. Both must agree before the file is installed.
  const published = await fetchShasums();
  if (published !== PINNED_NODE_EXE_SHA256) {
    throw new Error(
      `PIN DRIFT: nodejs.org lists sha256 ${published} for ${PINNED_NODE_VERSION} ${ARTIFACT_PATH} ` +
        `but this script pins ${PINNED_NODE_EXE_SHA256}. Update the pin deliberately (PINNING header) — never ship an unverified runtime.`,
    );
  }

  mkdirSync(path.dirname(TARGET), { recursive: true });
  const staging = `${TARGET}.download-${process.pid}`;
  try {
    await download(`${DIST_BASE}/${PINNED_NODE_VERSION}/${ARTIFACT_PATH}`, staging);
    const got = await sha256File(staging);
    if (got !== published || got !== PINNED_NODE_EXE_SHA256) {
      throw new Error(
        `downloaded node.exe hash ${got} does not match the release list (${published}); refusing to install`,
      );
    }
    renameSync(staging, TARGET);
  } finally {
    if (existsSync(staging)) {
      try {
        statSync(staging);
      } catch {
        /* renamed away */
      }
    }
  }

  const size = statSync(TARGET).size;
  process.stdout.write(
    `node runtime fetch installed ${PINNED_NODE_VERSION} sha256=${PINNED_NODE_EXE_SHA256} bytes=${size}\n`,
  );
  note(`installed ${TARGET}`);
}

/** Re-confirm the pin against the live release list when the network allows it. */
async function crossCheckPublished() {
  try {
    const published = await fetchShasums();
    if (published !== PINNED_NODE_EXE_SHA256) {
      throw new Error(
        `PIN DRIFT: nodejs.org now lists sha256 ${published} for ${PINNED_NODE_VERSION} ${ARTIFACT_PATH}; the pin is ${PINNED_NODE_EXE_SHA256}`,
      );
    }
    note(`pin re-checked against ${PINNED_NODE_VERSION}/SHASUMS256.txt`);
  } catch (error) {
    note(`published-list re-check skipped (${error.message})`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`node runtime fetch FAILED\n`);
  process.stderr.write(`[fetch-node] ${message}\n`);
  process.exit(1);
});
