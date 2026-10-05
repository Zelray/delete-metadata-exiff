/**
 * `/api/health` and `/api/console/run`.
 *
 * The console is the one place user text comes near the engine, so it is
 * gated by a strict read-only WHITELIST validator:
 *
 *  - any argument containing `=`, `<` or `>` is rejected outright (every
 *    assignment form, CSV/JSON import, and copy/redirect grammar dies here),
 *  - an explicit deny list re-states the dangerous flags by name
 *    (`-overwrite*`, `-o`, `-tagsFromFile`, `-geotag`, `-config`, session
 *    control like `-stay_open`/`-@`/`-execute`/`-common_args`, ...),
 *  - exact-match read flags from the capability map pass,
 *  - a small set of value-taking read flags (`-ext`, `-d`, `-c`, `-sep`,
 *    `-lang`) consume and validate their next argument,
 *  - anything else starting with `-` must be pure tag grammar (no operators),
 *    and if it collides with a known engine option that is not whitelisted,
 *    it is rejected rather than silently reinterpreted as a tag,
 *  - every non-flag argument is a file path and passes the path guard
 *    (absolute, sanitized) before execution.
 *
 * Execution goes through the persistent engine session's queue — one
 * serialized round trip, argv array, in-band diagnostics, never an exit code.
 * The response carries `commandPreview`: the exact argv that ran.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ApiError, HealthInfo } from '@metadesk/shared';
import { KNOWN_OPTIONS } from '../engine/engineArgs.js';
import type { ExifToolSession } from '../engine/exiftoolSession.js';
import { assertSafePath } from '../services/pathGuard.js';
import type { SseHub } from './events.js';

// ---- health -----------------------------------------------------------------

export interface HealthRouteDeps {
  getHealth: () => Promise<HealthInfo>;
  hub: SseHub;
}

export function registerHealthRoute(app: FastifyInstance, deps: HealthRouteDeps): void {
  app.get('/api/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    const health = await deps.getHealth();
    deps.hub.setHealth(health);
    return reply.code(200).send(health);
  });
}

// ---- console ----------------------------------------------------------------

/**
 * Read flags that take no value of their own (exact tokens, case-sensitive,
 * matching exiftool's single-letter case sensitivity and the GUI's spellings).
 */
const READ_FLAGS: ReadonlySet<string> = new Set([
  // output shape
  '-j', '-G', '-G0', '-G1', '-G2', '-G3', '-G4', '-g', '-g0', '-g1', '-g2',
  '-a', '-struct', '-n', '-l', '-s', '-s2', '-s3', '-S', '-D', '-H', '-t', '-T',
  '-b', '-e', '-u', '-U', '-ee', '-ee2', '-ee3', '-fast', '-fast2', '-fast3',
  '-fast4', '-fast5', '-r', '-r.', '-sort', '-q', '-scanForXMP', '-X', '-php',
  '-args', '-validate', '-warning', '-progress', '-progress0',
  // discovery (no input file needed)
  '-list', '-listw', '-listf', '-listx', '-listg', '-listd', '-listr', '-listwf',
  '-ver',
]);

/** Read flags whose NEXT argument is a value of a specific shape. */
const READ_VALUE_FLAGS: Readonly<Record<string, (value: string) => string | null>> = {
  '-ext': (value) =>
    /^[A-Za-z0-9]{1,8}$/.test(value) ? null : 'the -ext value must be a plain file extension',
  '-ext+': (value) =>
    /^[A-Za-z0-9]{1,8}$/.test(value) ? null : 'the -ext+ value must be a plain file extension',
  '-d': (value) =>
    value.length > 0 && value.length <= 64 && !/[\r\n\0]/.test(value)
      ? null
      : 'the -d date format must be 1-64 plain characters',
  '-c': (value) =>
    value.length > 0 && value.length <= 64 && !/[\r\n\0]/.test(value)
      ? null
      : 'the -c coordinate format must be 1-64 plain characters',
  '-sep': (value) =>
    value.length > 0 && value.length <= 8 && !/[\r\n\0]/.test(value)
      ? null
      : 'the -sep separator must be 1-8 plain characters',
  '-lang': (value) =>
    /^[A-Za-z]{2,12}(-[A-Za-z0-9]+)?$/.test(value)
      ? null
      : 'the -lang value must be a language code like de or ja',
};

/**
 * Flags that must NEVER reach the engine from the console, spelled out so the
 * deny list doubles as documentation. The whitelist above is the actual gate;
 * this list produces better error messages for the common dangerous cases.
 */
const DENIED_FLAGS: ReadonlyMap<string, string> = new Map([
  ['-o', 'writes output files (-o is write-side)'],
  ['-overwrite_original', 'deletes the backup copy; writes are not available in the console'],
  ['-overwrite_original_in_place', 'destroys the original; writes are not available in the console'],
  ['-tagsFromFile', 'copies tags between files (write)'],
  ['-addTagsFromFile', 'copies tags between files (write)'],
  ['-geotag', 'writes GPS from a track log (write)'],
  ['-geosync', 'adjusts geotag timing (write)'],
  ['-csv', 'bare -csv exports, but -csv=FILE imports (write) — use -j instead'],
  ['-config', 'changes engine configuration; -config is not allowed after startup'],
  ['-use', 'loads modules (sticky across the session); not allowed in the console'],
  ['-stay_open', 'session control; not allowed in the console'],
  ['-@', 'argfile control; not allowed in the console'],
  ['-execute', 'session control; not allowed in the console'],
  ['-common_args', 'session control; not allowed in the console'],
  ['-charset', 'set at session start; not allowed in the console'],
  ['-w', 'writes one text file per source file'],
  ['-W', 'writes one file per tag (binary extraction belongs to the API routes)'],
  ['-Wext', 'filters -W output files'],
  ['-delete_original', 'deletes backup files'],
  ['-restore_original', 'rewrites files from backups'],
  ['-password', 'not allowed in the console'],
  ['-srcfile', 'not allowed in the console'],
  ['-api', 'API options need KEY=VALUE values, which are write-capable; not allowed in the console'],
  ['-m', 'downgrades error handling; the console never runs write-risky commands'],
  ['-fileOrder', 'not allowed in the console'],
  ['-if', 'conditional expressions are not allowed in the console'],
  ['-p', 'template expressions are not allowed in the console'],
]);

export interface ConsoleRunResponse {
  commandPreview: string[];
  json: Array<Record<string, unknown>>;
  stdout: string;
  diagnostics: Array<{ severity: string; message: string; sourceFile?: string }>;
  durationMs: number;
}

export interface ConsoleRouteDeps {
  engine: ExifToolSession | null;
}

interface ConsoleBody {
  args?: unknown;
}

const MAX_CONSOLE_ARGS = 64;
const MAX_ARG_LENGTH = 1024;

export function registerConsoleRoute(app: FastifyInstance, deps: ConsoleRouteDeps): void {
  app.post(
    '/api/console/run',
    async (
      request: FastifyRequest<{ Body: ConsoleBody }>,
      reply: FastifyReply,
    ) => {
      const body = request.body ?? {};
      const args = body.args;
      if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
        return sendError(reply, 400, 'bad_request', 'The body must be {"args": string[]}.');
      }
      if (args.length === 0) {
        return sendError(reply, 400, 'bad_request', 'At least one argument is required.');
      }
      if (args.length > MAX_CONSOLE_ARGS) {
        return sendError(
          reply,
          400,
          'bad_request',
          `At most ${MAX_CONSOLE_ARGS} arguments are allowed per console command.`,
        );
      }
      if (deps.engine === null) {
        return sendError(
          reply,
          503,
          'engine_unavailable',
          'The exiftool engine is not running; the console is unavailable.',
        );
      }

      const validation = validateConsoleArgs(args as string[]);
      if (!validation.ok) {
        return sendError(reply, 400, validation.code, validation.message, {
          arg: validation.arg,
        });
      }

      const argv = validation.argv;
      const startedAt = Date.now();
      try {
        const result = await deps.engine.run(argv, { json: true });
        const response: ConsoleRunResponse = {
          commandPreview: argv,
          json: result.json as Array<Record<string, unknown>>,
          stdout: result.stdout.length > 512 * 1024 ? `${result.stdout.slice(0, 512 * 1024)}...` : result.stdout,
          diagnostics: result.diagnostics,
          durationMs: Date.now() - startedAt,
        };
        return reply.code(200).send(response);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return sendError(reply, 502, 'engine_unavailable', `The engine rejected the command: ${message}`, {
          commandPreview: argv,
        });
      }
    },
  );
}

type ConsoleValidation =
  | { ok: true; argv: string[] }
  | { ok: false; code: 'bad_request' | 'path_rejected' | 'unsafe_tag'; message: string; arg: string };

/**
 * Strict read-only validation. Returns the argv to execute (paths normalized)
 * or a structured rejection with a human message naming the offending arg.
 */
export function validateConsoleArgs(args: readonly string[]): ConsoleValidation {
  const argv: string[] = [];
  let valueFlag: ((value: string) => string | null) | null = null;

  for (const arg of args) {
    if (arg.length > MAX_ARG_LENGTH) {
      return reject('bad_request', `Argument is longer than ${MAX_ARG_LENGTH} characters.`, arg);
    }

    // A pending value flag consumes exactly one argument and validates it.
    if (valueFlag !== null) {
      const problem = valueFlag(arg);
      if (problem !== null) return reject('bad_request', problem, arg);
      argv.push(arg);
      valueFlag = null;
      continue;
    }

    // Any assignment, copy or redirect grammar is write-side: reject on sight.
    if (/[=<>]/.test(arg)) {
      return reject(
        'unsafe_tag',
        'Assignments and redirects (any "=", "<" or ">") can change files and are not allowed in the read-only console.',
        arg,
      );
    }

    if (arg.startsWith('-')) {
      const denied = DENIED_FLAGS.get(arg);
      if (denied !== undefined) {
        return reject('unsafe_tag', `Not allowed in the read-only console: ${denied}`, arg);
      }
      if (/^-\w*execute/.test(arg)) {
        return reject('unsafe_tag', 'Session control flags are not allowed in the console.', arg);
      }
      if (/^-{1,2}overwrite/i.test(arg)) {
        return reject('unsafe_tag', 'Overwrite flags are not allowed in the console.', arg);
      }
      const valueValidator = READ_VALUE_FLAGS[arg];
      if (valueValidator !== undefined) {
        argv.push(arg);
        valueFlag = valueValidator;
        continue;
      }
      if (READ_FLAGS.has(arg)) {
        argv.push(arg);
        continue;
      }
      // Not whitelisted. If it collides with a known engine option, say so
      // instead of letting exiftool reinterpret it as something else.
      if (KNOWN_OPTIONS.has(arg) || KNOWN_OPTIONS.has(arg.toLowerCase())) {
        return reject(
          'unsafe_tag',
          `"${arg}" is an engine option that is not on the console read whitelist.`,
          arg,
        );
      }
      // Otherwise it must be pure read-tag grammar (-TAG or -GROUP:TAG, with
      // wildcards allowed; no operators survived the [=<>] check above).
      const body = arg.replace(/^-+/, '');
      if (body.length === 0 || !/^[A-Za-z0-9_?*#+.:-]+$/.test(body)) {
        return reject(
          'unsafe_tag',
          `"${arg}" is not a recognized read flag or tag name. The console only runs read-flag commands.`,
          arg,
        );
      }
      argv.push(arg);
      continue;
    }

    // No leading dash: a file/folder argument. Absolute, sanitized, nothing else.
    try {
      argv.push(assertSafePath(arg));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reject('path_rejected', message, arg);
    }
  }

  if (valueFlag !== null) {
    return reject('bad_request', 'The last flag expects a value, but none was given.', '');
  }
  return { ok: true, argv };
}

function reject(
  code: 'bad_request' | 'path_rejected' | 'unsafe_tag',
  message: string,
  arg: string,
): ConsoleValidation {
  return { ok: false, code, message, arg };
}

export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: ApiError['code'],
  message: string,
  details?: Record<string, unknown>,
): FastifyReply {
  return reply.code(statusCode).send(details === undefined ? { code, message } : { code, message, details });
}
