/**
 * The MetaDesk exiftool engine driver.
 *
 * One long-lived `exiftool -charset filename=UTF8 -stay_open True -@ -`
 * process serves every request. Requests are serialized through an internal
 * queue; each one streams its argument lines to the child's stdin and is
 * terminated by a numbered `-executeN`, and the response is complete when the
 * matching `{readyN}` line arrives on stdout. That numbered handshake is the
 * documented protocol and is immune to `-q`.
 *
 * Safety properties implemented here:
 *  - spawn with an argument ARRAY and `shell: false`, `windowsHide: true`;
 *    never a shell string, never cmd.exe.
 *  - `-charset filename=UTF8` precedes `-@` (required on Windows).
 *  - every argument passes {@link assertArgsSafe}; the destructive
 *    `-overwrite_original*` flags are structurally unreachable.
 *  - per-file `Error`/`Warning` fields are surfaced in-band. Exit codes are
 *    never treated as proof of anything.
 *  - shutdown stacks `-stay_open` / `False`, waits for a real exit, and only
 *    then falls back to terminate/kill, so no orphan survives on Windows.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { EngineRequestResult, ExifDiagnostic } from '@metadesk/shared';
import { assertArgsSafe } from './engineArgs.js';
import { extractDiagnostics, parseJsonDocuments } from './jsonStream.js';

export interface ExifToolSessionOptions {
  /** Absolute path to exiftool.exe (the non-pause binary, never exiftool(-k)). */
  executablePath: string;
  /** Extra arguments appended to the initial command line, after the built-ins. */
  extraInitialArgs?: string[];
  /** Per-request timeout in ms. Default 60_000. */
  requestTimeoutMs?: number;
  /** Warmup handshake timeout in ms. Default 20_000. */
  startupTimeoutMs?: number;
  /** Grace period for a graceful shutdown before terminating. Default 5_000. */
  shutdownGraceMs?: number;
  cwd?: string;
}

export interface ShutdownReport {
  /** true when a session process existed to shut down. */
  started: boolean;
  /** true when the process exited after the documented `-stay_open False`. */
  graceful: boolean;
  /** true when terminate/kill had to be used. */
  forcedKill: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface RunRequestOptions {
  /** Parse stdout as one or more JSON documents. */
  json?: boolean;
  /** Override the per-request timeout for this call. */
  timeoutMs?: number;
}

interface PendingRequest {
  executeNumber: number;
  expectJson: boolean;
  stdoutLines: string[];
  stderrLines: string[];
  startedAt: number;
  timer: NodeJS.Timeout;
  resolve: (result: EngineRequestResult) => void;
  reject: (error: Error) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

export class ExifToolSession {
  private readonly options: Required<
    Pick<ExifToolSessionOptions, 'requestTimeoutMs' | 'startupTimeoutMs' | 'shutdownGraceMs'>
  > & ExifToolSessionOptions;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending: PendingRequest | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private nextExecuteNumber = 1;
  private lineBuffer = '';
  private unsolicitedStdout: string[] = [];
  private orphanedStderr: string[] = [];
  private brokenReasonValue: string | null = null;
  private shuttingDown = false;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private exitWaiters: Array<(exited: boolean) => void> = [];

  /** Version reported by the warmup `-ver` handshake, once started. */
  warmupVersion: string | null = null;
  /** Arguments the process was actually started with (for diagnostics/tests). */
  initialArgs: readonly string[] = [];

  constructor(options: ExifToolSessionOptions) {
    this.options = {
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      shutdownGraceMs: options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS,
      ...options,
    };
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  get isRunning(): boolean {
    return this.proc !== null && this.exitInfo === null;
  }

  get brokenReason(): string | null {
    return this.brokenReasonValue;
  }

  /** Spawn the persistent process and prove the protocol with a `-ver` round trip. */
  async start(): Promise<void> {
    if (this.proc) throw new Error('ExifTool session is already started');

    // Order is load-bearing: -charset filename=UTF8 must precede -@.
    const args = [
      '-charset',
      'filename=UTF8',
      '-stay_open',
      'True',
      '-@',
      '-',
      ...(this.options.extraInitialArgs ?? []),
    ];
    this.initialArgs = args;

    const proc = spawn(this.options.executablePath, args, {
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.options.cwd,
    }) as ChildProcessWithoutNullStreams;

    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    proc.stderr.on('data', (chunk: string) => this.onStderr(chunk));
    proc.on('error', (error: Error) => this.onProcessError(error));
    proc.on('exit', (code, signal) => this.onExit(code, signal));

    // Warmup: proves the child is alive AND that the -execute/{ready} framing
    // round-trips before the app trusts it with real work.
    try {
      const warmup = await this.run(['-ver'], { timeoutMs: this.options.startupTimeoutMs });
      const version = warmup.stdout.trim();
      if (!/^\d+\.\d+$/.test(version)) {
        throw new Error(`exiftool -ver returned unparseable output: ${JSON.stringify(version)}`);
      }
      this.warmupVersion = version;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.brokenReasonValue = `startup handshake failed: ${message}`;
      await this.shutdown();
      throw new Error(`ExifTool startup failed (${this.options.executablePath}): ${message}`);
    }
  }

  /**
   * Queue a command against the persistent process. Resolves once the
   * matching `{readyN}` line has been read. Never throws for in-band exiftool
   * errors — those come back as `diagnostics` — only for protocol failure.
   */
  run<T = Record<string, unknown>>(
    args: readonly string[],
    opts: RunRequestOptions = {},
  ): Promise<EngineRequestResult<T>> {
    const request = this.tail.then(
      () => this.runExclusive<T>(args, opts),
      () => this.runExclusive<T>(args, opts),
    );
    this.tail = request.catch(() => undefined);
    return request;
  }

  private async runExclusive<T>(
    args: readonly string[],
    opts: RunRequestOptions,
  ): Promise<EngineRequestResult<T>> {
    const proc = this.proc;
    if (!proc || this.exitInfo !== null) {
      throw new Error('ExifTool session is not running');
    }
    if (this.shuttingDown) {
      throw new Error('ExifTool session is shutting down');
    }
    if (this.brokenReasonValue !== null) {
      throw new Error(`ExifTool session is unusable: ${this.brokenReasonValue}`);
    }

    assertArgsSafe(args);

    const executeNumber = this.nextExecuteNumber;
    this.nextExecuteNumber += 1;
    const timeoutMs = opts.timeoutMs ?? this.options.requestTimeoutMs;

    const result = await new Promise<EngineRequestResult>((resolve, reject) => {
      const pending: PendingRequest = {
        executeNumber,
        expectJson: opts.json ?? false,
        stdoutLines: [],
        stderrLines: [],
        startedAt: Date.now(),
        timer: setTimeout(() => {
          this.brokenReasonValue = `request ${executeNumber} timed out after ${timeoutMs}ms`;
          if (this.pending === pending) this.pending = null;
          reject(
            new Error(
              `exiftool request ${executeNumber} timed out after ${timeoutMs}ms; the session must be restarted`,
            ),
          );
        }, timeoutMs),
        resolve: (value) => resolve(value as EngineRequestResult<T>),
        reject,
      };
      this.pending = pending;

      // One argument per line, then the numbered execute token. write() is
      // guarded because the child may have died since the last response.
      try {
        const payload = `${args.map((arg) => `${arg}\n`).join('')}-execute${executeNumber}\n`;
        proc.stdin.write(payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.brokenReasonValue = `stdin write failed: ${message}`;
        if (this.pending === pending) this.pending = null;
        clearTimeout(pending.timer);
        reject(new Error(`exiftool stdin write failed: ${message}`));
      }
    });

    return result as EngineRequestResult<T>;
  }

  /** Graceful shutdown: stack `-stay_open` / `False`, wait, then escalate. */
  async shutdown(): Promise<ShutdownReport> {
    const proc = this.proc;
    if (!proc) {
      return {
        started: false,
        graceful: false,
        forcedKill: false,
        exitCode: this.exitInfo?.code ?? null,
        signal: this.exitInfo?.signal ?? null,
      };
    }
    this.proc = null;
    this.shuttingDown = true;

    // Let in-flight (already transmitted) work settle before closing stdin.
    try {
      await this.tail;
    } catch {
      /* an in-flight failure must not block shutdown */
    }

    try {
      proc.stdin.write('-stay_open\nFalse\n');
      proc.stdin.end();
    } catch {
      /* the child may already be gone; the wait/kill ladder below handles it */
    }

    let graceful = await this.waitForExit(this.options.shutdownGraceMs);
    let forcedKill = false;
    if (!graceful) {
      try {
        proc.kill('SIGTERM');
      } catch {
        /* already dead */
      }
      graceful = await this.waitForExit(2_000);
      if (!graceful) {
        forcedKill = true;
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already dead */
        }
        await this.waitForExit(2_000);
      }
    }

    this.rejectPending(new Error('ExifTool session shut down before the request completed'));

    return {
      started: true,
      graceful,
      forcedKill,
      exitCode: proc.exitCode,
      signal: proc.signalCode,
    };
  }

  // ---- internals ----------------------------------------------------------

  private waitForExit(ms: number): Promise<boolean> {
    if (this.exitInfo !== null) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.exitWaiters = this.exitWaiters.filter((w) => w !== waiter);
        resolve(false);
      }, ms);
      const waiter = (exited: boolean) => {
        clearTimeout(timer);
        resolve(exited);
      };
      this.exitWaiters.push(waiter);
    });
  }

  private onStdout(chunk: string): void {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.lineBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.onStdoutLine(line);
      newlineIndex = this.lineBuffer.indexOf('\n');
    }
  }

  private onStdoutLine(line: string): void {
    const pending = this.pending;
    if (pending === null) {
      this.unsolicitedStdout.push(line);
      return;
    }
    if (line === `{ready${pending.executeNumber}}`) {
      this.pending = null;
      clearTimeout(pending.timer);
      pending.resolve(this.buildResult(pending));
      return;
    }
    pending.stdoutLines.push(line);
  }

  private onStderr(chunk: string): void {
    const pending = this.pending;
    const target = pending !== null ? pending.stderrLines : this.orphanedStderr;
    for (const line of chunk.split(/\r?\n/)) {
      if (line.length > 0) target.push(line);
    }
  }

  private buildResult(pending: PendingRequest): EngineRequestResult {
    const stdout = pending.stdoutLines.join('\n');
    const stderr = pending.stderrLines.join('\n');
    const json = pending.expectJson ? parseJsonDocuments(stdout) : [];
    const diagnostics: ExifDiagnostic[] = extractDiagnostics(json).map((d) => ({
      severity: d.severity,
      message: d.message,
      sourceFile: d.sourceFile,
    }));
    for (const line of pending.stderrLines) {
      const severity = /^error/i.test(line)
        ? 'error'
        : /^warning/i.test(line)
          ? /\(minor\)/i.test(line)
            ? 'minor'
            : 'warning'
          : null;
      if (severity !== null) {
        diagnostics.push({ severity, message: line });
      }
    }
    return {
      executeNumber: pending.executeNumber,
      json,
      stdout,
      stderr,
      diagnostics,
    };
  }

  private onProcessError(error: Error): void {
    this.brokenReasonValue = `exiftool process error: ${error.message}`;
    this.rejectPending(
      new Error(`exiftool process error (${this.options.executablePath}): ${error.message}`),
    );
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitInfo = { code, signal };
    this.rejectPending(
      new Error(
        `exiftool exited unexpectedly (code=${String(code)}, signal=${String(signal)}) while a request was in flight`,
      ),
    );
    const waiters = this.exitWaiters;
    this.exitWaiters = [];
    for (const waiter of waiters) waiter(true);
  }

  private rejectPending(error: Error): void {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(error);
  }
}

export interface RunOnceResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Wall-clock duration in ms. */
  durationMs: number;
}

export interface RunOnceOptions {
  timeoutMs?: number;
  cwd?: string;
}

/**
 * One-shot command (`-ver`, `-listx`, binary extraction): spawns a fresh
 * exiftool with an argv array, collects stdout/stderr, waits for a real exit.
 * Output size is unbounded (streams, not `execFile`'s maxBuffer).
 */
export function runOnce(
  executablePath: string,
  args: readonly string[],
  opts: RunOnceOptions = {},
): Promise<RunOnceResult> {
  assertArgsSafe(args);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const startedAt = Date.now();

  return new Promise<RunOnceResult>((resolve, reject) => {
    const child = spawn(executablePath, [...args], {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: opts.cwd,
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => stdout.push(chunk));
    child.stderr.on('data', (chunk: string) => stderr.push(chunk));

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      reject(new Error(`exiftool one-shot command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`failed to run ${executablePath}: ${error.message}`));
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal,
        stdout: stdout.join(''),
        stderr: stderr.join(''),
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
