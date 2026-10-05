/**
 * Server configuration: filesystem layout, the engine executable location,
 * and the engine-version cache.
 *
 * Every path defaults to a location inside the app tree and can be overridden
 * (environment for the executable and data dir, constructor overrides for
 * tests). Nothing here is user-facing; the routes own all user input.
 */
import { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The app tree root (two levels above app/server/src). */
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface MetaDeskConfig {
  /** app/ root: the tree that holds vendor/, data/, ui/, server/. */
  appRoot: string;
  /** Absolute path to the vendored, non-pause exiftool.exe. */
  executablePath: string;
  /** Mutable app state (portfile, thumbnail cache, catalog cache). */
  dataDir: string;
  /** Cached extracted embedded previews. */
  thumbsDir: string;
  /** Launcher handshake file {port, token, pid}. */
  portfilePath: string;
  /** Built UI bundle; may not exist (the server then serves a status page). */
  uiDistDir: string;
  /** Port to bind. 0 = let the OS pick a free port. */
  requestedPort: number;
  /** App version string, for the UI handshake. */
  serverVersion: string;
}

export interface LoadConfigOverrides {
  appRoot?: string;
  executablePath?: string;
  dataDir?: string;
  requestedPort?: number;
}

/**
 * Build the effective configuration. Precedence for the executable:
 * constructor override > METADESK_EXIFTOOL env > app/vendor/exiftool/exiftool.exe.
 * Precedence for the port: constructor override > METADESK_PORT env > 0 (free).
 */
export function loadConfig(overrides: LoadConfigOverrides = {}): MetaDeskConfig {
  const appRoot = overrides.appRoot ?? APP_ROOT;
  const dataDir = overrides.dataDir ?? process.env['METADESK_DATA_DIR'] ?? path.join(appRoot, 'data');
  const requestedPort =
    overrides.requestedPort ??
    readPortFromArgv() ??
    readPortFromEnv() ??
    0;

  return {
    appRoot,
    executablePath:
      overrides.executablePath ??
      process.env['METADESK_EXIFTOOL'] ??
      path.join(appRoot, 'vendor', 'exiftool', 'exiftool.exe'),
    dataDir,
    thumbsDir: path.join(dataDir, 'thumbs'),
    portfilePath: path.join(dataDir, 'portfile.json'),
    uiDistDir: path.join(appRoot, 'ui', 'dist'),
    requestedPort,
    serverVersion: readAppVersion(appRoot),
  };
}

function readPortFromArgv(): number | undefined {
  const argv = process.argv;
  const flagIndex = argv.indexOf('--port');
  const byFlag = flagIndex >= 0 ? Number.parseInt(argv[flagIndex + 1] ?? '', 10) : Number.NaN;
  if (Number.isInteger(byFlag) && byFlag >= 0) return byFlag;
  const equalsForm = argv.find((a) => a.startsWith('--port='));
  if (equalsForm !== undefined) {
    const parsed = Number.parseInt(equalsForm.slice('--port='.length), 10);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function readPortFromEnv(): number | undefined {
  const raw = process.env['METADESK_PORT'];
  if (raw === undefined || raw.length === 0) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** App version from app/package.json, cached at first call. */
function readAppVersion(appRoot: string): string {
  if (readAppVersion.cached !== null) return readAppVersion.cached;
  try {
    // Synchronous here is fine: called once during server construction.
    const pkg = JSON.parse(readFileSync(path.join(appRoot, 'package.json'), 'utf8')) as {
      version?: string;
    };
    readAppVersion.cached = typeof pkg.version === 'string' ? pkg.version : '0.0.0-dev';
  } catch {
    readAppVersion.cached = '0.0.0-dev';
  }
  return readAppVersion.cached;
}
readAppVersion.cached = null as string | null;

// ---------------------------------------------------------------------------
// Engine version cache
// ---------------------------------------------------------------------------

export interface EngineVersionCacheEntry {
  version: string;
  checkedAt: string;
  executablePath: string;
}

const VERSION_CACHE_FILE = 'engine-version.json';

/** Read the remembered engine version, when the cache file is present and sane. */
export async function readEngineVersionCache(
  config: Pick<MetaDeskConfig, 'dataDir'>,
): Promise<EngineVersionCacheEntry | null> {
  try {
    const raw = await readFile(path.join(config.dataDir, VERSION_CACHE_FILE), 'utf8');
    const parsed = JSON.parse(raw) as Partial<EngineVersionCacheEntry>;
    if (
      typeof parsed.version === 'string' &&
      typeof parsed.checkedAt === 'string' &&
      typeof parsed.executablePath === 'string'
    ) {
      return parsed as EngineVersionCacheEntry;
    }
    return null;
  } catch {
    return null;
  }
}

/** Remember an engine version handshake result for diagnostics/UI display. */
export async function writeEngineVersionCache(
  config: Pick<MetaDeskConfig, 'dataDir'>,
  entry: EngineVersionCacheEntry,
): Promise<void> {
  try {
    await mkdir(config.dataDir, { recursive: true });
    await writeFile(
      path.join(config.dataDir, VERSION_CACHE_FILE),
      JSON.stringify(entry, null, 2),
      'utf8',
    );
  } catch {
    // The version cache is informational only; never fail the boot for it.
  }
}
