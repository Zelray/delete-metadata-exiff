/**
 * The narrow seam between MetaDesk's UI and the desktop shell (leaf 2.1.2).
 *
 * MetaDesk's page is served by the local engine at http://127.0.0.1:<port>, so
 * the very same bundle runs in a plain browser (the dev seam) and inside the
 * Tauri v2 desktop window. Only ONE thing differs today: in the desktop window,
 * Explorer drops reach the Rust shell first (Tauri's drag-drop handler replaces
 * the HTML5 one) and arrive here as REAL absolute paths, emitted on
 * `metadesk://dropped-paths` as a JSON array of path strings.
 *
 * This module is deliberately tiny and inert in a browser: without
 * `window.__TAURI__` there is nothing to subscribe to, and every function
 * degrades to a no-op so the browser behavior is byte-for-byte what it was
 * before the desktop wrap existed. (SPIKE-1 proved the page at the dynamic
 * port receives shell events through the `core:event:default` capability.)
 */

/** The shell → page drag-drop channel (Rust: `main.rs` `forward_dropped_paths`). */
export const DROPPED_PATHS_EVENT = 'metadesk://dropped-paths';

/** The slice of Tauri's `withGlobalTauri` API the bridge needs. Nothing else
 * is touched, so nothing else is granted: the capability file stays at
 * `core:event:default` only. */
interface TauriEventApi {
  listen(
    event: string,
    handler: (event: { payload?: unknown; event?: string; id?: number }) => void,
  ): Promise<() => void>;
}

/** Reads `window.__TAURI__` when the desktop shell injected it, else null. */
function tauriEventApi(): TauriEventApi | null {
  const injected = (window as unknown as { __TAURI__?: { event?: Partial<TauriEventApi> } })
    .__TAURI__;
  const event = injected?.event;
  if (event === undefined || typeof event.listen !== 'function') return null;
  const listen = event.listen;
  return { listen: (eventName, handler) => listen(eventName, handler) };
}

/** True when the UI is running inside the desktop shell (not a browser). */
export function isDesktopShell(): boolean {
  return tauriEventApi() !== null;
}

/** The shell sends a JSON array of absolute path strings; anything else
 * (older shell, malformed payload) is dropped rather than guessed at. */
export function parseDroppedPaths(payload: unknown): string[] {
  if (!Array.isArray(payload)) return [];
  return payload.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
  );
}

/**
 * Subscribes to the shell's absolute-path drop channel.
 *
 * Returns an unsubscribe function. In a browser (no `window.__TAURI__`) it
 * returns a no-op unsubscribe and never calls the handler — the HTML5 dev seam
 * in Home keeps doing what it always did.
 */
export function onDroppedPaths(handler: (paths: string[]) => void): () => void {
  const api = tauriEventApi();
  if (api === null) return () => {};

  let disposed = false;
  let unlisten: (() => void) | null = null;
  api
    .listen(DROPPED_PATHS_EVENT, (event) => {
      const paths = parseDroppedPaths(event?.payload);
      if (paths.length > 0) handler(paths);
    })
    .then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    })
    .catch((error: unknown) => {
      // The desktop shell is chrome, not a requirement: a listen failure must
      // never take the page down. Paste-path and the HTML5 seam still work.
      console.warn('MetaDesk: could not listen for desktop drops', error);
    });

  return () => {
    disposed = true;
    const stop = unlisten;
    unlisten = null;
    if (stop) stop();
  };
}
