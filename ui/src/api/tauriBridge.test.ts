// @vitest-environment jsdom
/**
 * tauriBridge (leaf 2.1.2): the desktop-shell seam for absolute-path drops.
 *
 * The contract under test is the SPLIT: with `window.__TAURI__` present the
 * bridge listens on the shell's drop channel and hands the UI clean absolute
 * paths; without it (the browser / dev seam) the bridge is completely inert —
 * no listener, no callback, no throw. `window.__TAURI__` is stubbed by hand:
 * no Tauri, no IPC, no shell in these tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DROPPED_PATHS_EVENT,
  isDesktopShell,
  onDroppedPaths,
  parseDroppedPaths,
} from './tauriBridge';

type Listener = (event: { payload?: unknown; event?: string; id?: number }) => void;

interface Captured {
  event: string;
  handler: Listener;
  unlisten: ReturnType<typeof vi.fn>;
  /** The stub models a real shell: after unlisten, no more events arrive. */
  active: boolean;
}

const windowWithTauri = window as unknown as Record<string, unknown>;

function forgetShell(): void {
  delete windowWithTauri.__TAURI__;
}

/** Pretend the page is running inside the desktop shell. */
function stubShell(listen?: (event: string, handler: Listener) => Promise<() => void>): Captured[] {
  const captured: Captured[] = [];
  windowWithTauri.__TAURI__ = {
    event: {
      listen: listen ?? ((event: string, handler: Listener) => {
        const entry: Captured = {
          event,
          handler,
          unlisten: vi.fn(() => {
            entry.active = false;
          }),
          active: true,
        };
        captured.push(entry);
        return Promise.resolve(entry.unlisten);
      }),
    },
  };
  return captured;
}

function emitDrops(captured: Captured[], payload: unknown): void {
  for (const entry of captured) {
    if (entry.active) entry.handler({ payload, event: entry.event });
  }
}

/** Strict-mode helper: assert the value exists instead of silencing the checker. */
function assertDefined<T>(value: T | undefined): asserts value is T {
  if (value === undefined) throw new Error('expected a captured listener, found none');
}

beforeEach(() => {
  forgetShell();
});

afterEach(() => {
  forgetShell();
  vi.restoreAllMocks();
});

describe('tauriBridge — browser seam (no window.__TAURI__)', () => {
  it('is completely inert: no shell detected, no listener registered, handler never called', () => {
    expect(isDesktopShell()).toBe(false);

    const handler = vi.fn();
    const unsubscribe = onDroppedPaths(handler);

    expect(typeof unsubscribe).toBe('function');
    expect(() => unsubscribe()).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it('a half-installed shell (no listen function) still counts as "not desktop"', () => {
    windowWithTauri.__TAURI__ = { event: {} };
    expect(isDesktopShell()).toBe(false);

    const handler = vi.fn();
    const unsubscribe = onDroppedPaths(handler);
    unsubscribe();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('tauriBridge — payload parsing', () => {
  it('keeps only non-empty absolute path strings out of the shell payload', () => {
    expect(
      parseDroppedPaths(['C:\\photos\\2026-06', 42, '', null, 'C:\\other', undefined]),
    ).toEqual(['C:\\photos\\2026-06', 'C:\\other']);
  });

  it('rejects anything that is not a JSON array of strings', () => {
    expect(parseDroppedPaths(undefined)).toEqual([]);
    expect(parseDroppedPaths(null)).toEqual([]);
    expect(parseDroppedPaths('C:\\photos')).toEqual([]);
    expect(parseDroppedPaths({ paths: ['C:\\photos'] })).toEqual([]);
  });
});

describe('tauriBridge — desktop shell present', () => {
  it('reports the desktop shell and subscribes to the drop channel only', () => {
    const captured = stubShell();
    expect(isDesktopShell()).toBe(true);

    onDroppedPaths(() => {});

    const first = captured[0];
    expect(captured).toHaveLength(1);
    assertDefined(first);
    expect(first.event).toBe(DROPPED_PATHS_EVENT);
    expect(DROPPED_PATHS_EVENT).toBe('metadesk://dropped-paths');
  });

  it('dispatches parsed absolute paths to the handler (non-ASCII names survive intact)', () => {
    const captured = stubShell();
    const seen: string[][] = [];
    onDroppedPaths((paths) => seen.push(paths));

    emitDrops(captured, ['C:\\photos\\2026-06', 'D:\\相册\\肖像 --All=.']);
    expect(seen).toEqual([['C:\\photos\\2026-06', 'D:\\相册\\肖像 --All=.']]);

    // A malformed payload is dropped, not guessed at.
    emitDrops(captured, { paths: ['C:\\nope'] });
    emitDrops(captured, undefined);
    expect(seen).toHaveLength(1);
  });

  it('unsubscribe reaches the shell and stops delivery', async () => {
    const captured = stubShell();
    const handler = vi.fn();
    const unsubscribe = onDroppedPaths(handler);

    emitDrops(captured, ['C:\\before']);
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
    // The shell hands its unlisten handle back on a promise; give that turn a
    // moment before asserting the teardown landed.
    await Promise.resolve();
    await Promise.resolve();
    const entry = captured[0];
    assertDefined(entry);
    expect(entry.unlisten).toHaveBeenCalledTimes(1);

    emitDrops(captured, ['C:\\after']);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('unsubscribing before the shell finishes registering still unlistens', async () => {
    // Held in a ref so TypeScript sees the assignment the callback makes.
    const release: { current: ((stop: () => void) => void) | null } = { current: null };
    const unlisten = vi.fn();
    const seen: string[] = [];
    stubShell((event: string, _handler: Listener) => {
      seen.push(event);
      return new Promise<() => void>((resolve) => {
        release.current = resolve;
      });
    });
    const handler = vi.fn();
    const unsubscribe = onDroppedPaths(handler);

    // Gone before the shell ever handed back the unlisten handle.
    unsubscribe();
    release.current?.(unlisten);
    await Promise.resolve();
    await Promise.resolve();

    expect(seen).toEqual([DROPPED_PATHS_EVENT]);
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it('a listen failure degrades to a warning instead of taking the page down', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stubShell(() => Promise.reject(new Error('listen refused')));

    const handler = vi.fn();
    const unsubscribe = onDroppedPaths(handler);
    await Promise.resolve();
    await Promise.resolve();

    expect(warn).toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(() => unsubscribe()).not.toThrow();
  });
});
