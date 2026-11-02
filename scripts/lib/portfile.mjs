/**
 * The ONE Node-side reader for the server's portfile handshake file
 * (issue #17, arch-review Candidate 4). Before this module, seven tooling
 * consumers each re-declared "the portfile is real" with drifting rules —
 * three dereferenced fields with no validation at all, so one script's "boot
 * worked" could be another's false verdict (the lifecycle contract's O1
 * masking path). The field rules live HERE now, as behaviour.
 *
 * READ-ONLY by contract: the server (server/src/index.ts writePortfile) is
 * the sole portfile writer; a reader that ever wrote or deleted would be "a
 * second lifecycle owner". The launcher (bin/metadesk.mjs) and the Rust
 * shell keep their own pinned reader subsets — they are the two adapters
 * that justify the seam; this module serves the TOOLING side only.
 *
 * Field rules (PortfilePayload, server/src/index.ts): port and pid are
 * positive integers, token and url are non-empty strings. The tsx-hop pid
 * caveat: under the dev pair the server runs INSIDE the spawned tsx tree, so
 * whether the portfile pid equals a pid you spawned is a per-consumer
 * POLICY (verify-server deliberately waives it) and is deliberately NOT
 * enforced here — this module validates the file, not your process tree.
 *
 * Node builtins only (project rule MD6). Never a new launch runtime
 * dependency; imported by scripts/, tests-e2e/, and the vite dev plugin.
 */
import { readFileSync } from 'node:fs';

/**
 * Read and validate a portfile. Returns the parsed payload (extra fields
 * like startedAt/engine ride along) or null when the file is absent,
 * malformed, or fails any field rule — never a thrown error, so a poll can
 * treat "not yet real" and "gone" identically.
 */
export function readPortfile(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return null;
    if (!Number.isInteger(parsed.port) || parsed.port <= 0) return null;
    if (typeof parsed.token !== 'string' || parsed.token.length === 0) return null;
    if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
    if (typeof parsed.url !== 'string' || parsed.url.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Poll until the portfile is real. Resolves the validated payload, resolves
 * null on a quiet timeout (the caller owns its failure message), and throws
 * an Error carrying the abort reason when `abort` returns a string (e.g.
 * "the child exited during startup") — aborting beats timing out because a
 * dead child will never write the file.
 *
 * Options:
 * - timeoutMs (required): overall deadline.
 * - intervalMs: poll period (default 250 ms, the established cadence).
 * - abort: () => string | null — return a reason string to abort NOW.
 * - accept: (candidate) => boolean — extra admission filter for candidates
 *   that are structurally valid but not THIS boot's (verify-desktop seeds a
 *   stale portfile in one case and must skip it).
 */
export async function pollPortfile(filePath, { timeoutMs, intervalMs = 250, abort = null, accept = null } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const abortReason = abort === null ? null : abort();
    if (abortReason !== null) throw new Error(abortReason);
    const candidate = readPortfile(filePath);
    if (candidate !== null && (accept === null || accept(candidate))) return candidate;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}
