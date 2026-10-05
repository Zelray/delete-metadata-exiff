/**
 * Startup health handshake: `exiftool -ver`, parsed and gated.
 *
 * On any failure the app degrades to a read-only session (`readOnlyFallback`)
 * and reports a human-readable reason — it never crashes and never pretends
 * the engine is healthy.
 */
import type { EngineVersionInfo, HealthInfo } from '@metadesk/shared';
import { runOnce } from './exiftoolSession.js';

/** Oldest exiftool the MetaDesk engine accepts. */
export const MINIMUM_EXIFTOOL_VERSION = '13.0';

/** Extract a `major.minor[.patch]` version from `-ver` output. */
export function parseVersion(output: string): string | null {
  const firstLine = output.split(/\r?\n/).find((l) => l.trim().length > 0);
  const match = /^\s*(\d+\.\d+(?:\.\d+)?)\s*$/.exec(firstLine ?? '');
  return match === null ? null : (match[1] ?? null);
}

/** Numeric comparison of dotted version strings. */
export function versionAtLeast(version: string, minimum: string): boolean {
  const a = version.split('.').map((p) => Number.parseInt(p, 10));
  const b = minimum.split('.').map((p) => Number.parseInt(p, 10));
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (Number.isNaN(left) || Number.isNaN(right)) return false;
    if (left !== right) return left > right;
  }
  return true;
}

export interface EngineHealthOptions {
  executablePath: string;
  minimumVersion?: string;
  timeoutMs?: number;
}

/**
 * Raw handshake result: version + gate. The session-level health surface
 * (with the executable path and fallback semantics) is {@link checkEngineHealth}.
 */
export async function readEngineVersion(opts: EngineHealthOptions): Promise<EngineVersionInfo> {
  const minimum = opts.minimumVersion ?? MINIMUM_EXIFTOOL_VERSION;
  try {
    const result = await runOnce(opts.executablePath, ['-ver'], {
      timeoutMs: opts.timeoutMs ?? 20_000,
    });
    const version = parseVersion(result.stdout);
    if (version === null) {
      return {
        ok: false,
        version: '',
        readOnlyFallback: true,
        reason: `exiftool -ver produced unparseable output: ${JSON.stringify(
          result.stdout.slice(0, 200),
        )}`,
      };
    }
    if (!versionAtLeast(version, minimum)) {
      return {
        ok: false,
        version,
        readOnlyFallback: true,
        reason: `exiftool ${version} is older than the supported minimum ${minimum}; the app will run read-only until the bundled engine is restored`,
      };
    }
    return { ok: true, version, readOnlyFallback: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      version: '',
      readOnlyFallback: true,
      reason: `could not start exiftool (${opts.executablePath}): ${message}`,
    };
  }
}

/** Full startup health record as served to the UI. */
export async function checkEngineHealth(opts: EngineHealthOptions): Promise<HealthInfo> {
  const minimum = opts.minimumVersion ?? MINIMUM_EXIFTOOL_VERSION;
  const versionInfo = await readEngineVersion(opts);
  return {
    ok: versionInfo.ok,
    version: versionInfo.version,
    readOnlyFallback: versionInfo.readOnlyFallback,
    reason: versionInfo.reason,
    executablePath: opts.executablePath,
    minimumVersion: minimum,
  };
}
