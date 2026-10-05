/**
 * Shutdown tests: the documented `-stay_open False` handshake must make the
 * real process EXIT on Windows, with no orphan exiftool.exe left behind and
 * no forced kill required.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ExifToolSession } from '../src/engine/exiftoolSession.js';
import { EXE_PATH, countExiftoolProcesses } from './helpers.js';

const sessionsToClean: ExifToolSession[] = [];

async function freshSession(): Promise<ExifToolSession> {
  const session = new ExifToolSession({
    executablePath: EXE_PATH,
    requestTimeoutMs: 30_000,
    shutdownGraceMs: 5_000,
  });
  await session.start();
  sessionsToClean.push(session);
  return session;
}

afterEach(async () => {
  while (sessionsToClean.length > 0) {
    const session = sessionsToClean.pop();
    if (session !== undefined) await session.shutdown();
  }
});

describe('graceful shutdown', () => {
  it('exits the process cleanly after -stay_open False', async () => {
    const session = await freshSession();
    const pid = session.pid;
    expect(pid).toBeGreaterThan(0);

    const report = await session.shutdown();
    expect(report.started).toBe(true);
    expect(report.graceful).toBe(true);
    expect(report.forcedKill).toBe(false);
    expect(report.exitCode).toBe(0);
    expect(session.isRunning).toBe(false);
    expect(session.pid).toBeUndefined();
  });

  it('leaves no orphan exiftool.exe process behind', async () => {
    const before = await countExiftoolProcesses();
    const session = await freshSession();
    await session.run(['-ver']);
    const during = await countExiftoolProcesses();
    await session.shutdown();
    const after = await countExiftoolProcesses();

    expect(during).toBeGreaterThanOrEqual(before + 1);
    expect(after).toBeLessThanOrEqual(before);
  }, 60_000);

  it('shutting down twice is safe and reports no process', async () => {
    const session = await freshSession();
    await session.shutdown();
    const second = await session.shutdown();
    expect(second.started).toBe(false);
    expect(second.graceful).toBe(false);
  });

  it('refuses new work after shutdown', async () => {
    const session = await freshSession();
    await session.shutdown();
    await expect(session.run(['-ver'])).rejects.toThrow(/not running|shutting down/);
  });

  it('rejects a second start of a running session', async () => {
    const session = await freshSession();
    await expect(session.start()).rejects.toThrow(/already started/);
  });

  it('propagates a startup failure when the executable is missing', async () => {
    const broken = new ExifToolSession({
      executablePath: 'C:\\definitely\\not\\here\\exiftool.exe',
      startupTimeoutMs: 10_000,
    });
    await expect(broken.start()).rejects.toThrow(/ExifTool startup failed/);
    await broken.shutdown();
  });
});
