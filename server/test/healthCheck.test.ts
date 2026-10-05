/**
 * Health handshake tests against the real exe, plus version-gate unit cases.
 */
import { describe, expect, it } from 'vitest';
import {
  MINIMUM_EXIFTOOL_VERSION,
  checkEngineHealth,
  parseVersion,
  readEngineVersion,
  versionAtLeast,
} from '../src/engine/healthCheck.js';
import { APP_ROOT, EXE_PATH } from './helpers.js';

describe('version parsing and gating (unit)', () => {
  it('parses a bare version line', () => {
    expect(parseVersion('13.59\r\n')).toBe('13.59');
    expect(parseVersion('12.24\n')).toBe('12.24');
    expect(parseVersion('13.0')).toBe('13.0');
  });

  it('rejects junk, warnings or empty output', () => {
    expect(parseVersion('')).toBeNull();
    expect(parseVersion('Error: nope')).toBeNull();
    expect(parseVersion('13.59 extra')).toBeNull();
  });

  it('compares dotted versions numerically', () => {
    expect(versionAtLeast('13.59', '13.0')).toBe(true);
    expect(versionAtLeast('13.0', '13.0')).toBe(true);
    expect(versionAtLeast('12.99', '13.0')).toBe(false);
    expect(versionAtLeast('14.1', '13.0')).toBe(true);
    expect(versionAtLeast('9.10', '9.9')).toBe(true);
  });
});

describe('health handshake (real exe)', () => {
  it('reports a healthy bundled engine above the minimum version', async () => {
    const health = await checkEngineHealth({ executablePath: EXE_PATH });
    expect(health.ok).toBe(true);
    expect(health.readOnlyFallback).toBe(false);
    expect(health.version).toMatch(/^\d+\.\d+$/);
    expect(versionAtLeast(health.version, MINIMUM_EXIFTOOL_VERSION)).toBe(true);
    expect(health.executablePath).toBe(EXE_PATH);
    expect(health.minimumVersion).toBe(MINIMUM_EXIFTOOL_VERSION);
  });

  it('falls back to read-only when the engine cannot be started', async () => {
    const health = await checkEngineHealth({
      executablePath: 'C:\\definitely\\not\\here\\exiftool.exe',
    });
    expect(health.ok).toBe(false);
    expect(health.readOnlyFallback).toBe(true);
    expect(health.version).toBe('');
    expect(health.reason).toMatch(/could not start exiftool/);
  });

  it('falls back to read-only when the version gate fails', async () => {
    const info = await readEngineVersion({
      executablePath: EXE_PATH,
      minimumVersion: '99.0',
    });
    expect(info.ok).toBe(false);
    expect(info.readOnlyFallback).toBe(true);
    expect(info.version).toMatch(/^\d+\.\d+$/);
    expect(info.reason).toMatch(/older than the supported minimum/);
  });

  it('resolves the bundled engine path the app ships with', () => {
    expect(EXE_PATH.startsWith(APP_ROOT)).toBe(true);
    expect(EXE_PATH).toMatch(/vendor[\\/]exiftool[\\/]exiftool\.exe$/);
  });
});
