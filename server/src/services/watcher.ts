/**
 * Folder watcher (chokidar) tied to the scan session lifecycle.
 *
 * One watched folder at a time: each scan replaces the previous watch, so
 * the SSE stream always reflects the folder the user is looking at. Bursts
 * of filesystem events (a save, an extraction, a sync client) are debounced
 * into a single notification so the UI refetches once, not N times.
 */
import { watch, type FSWatcher } from 'chokidar';

export type WatchChangeType = 'add' | 'change' | 'unlink';

export interface WatchChange {
  type: WatchChangeType;
  path: string;
}

export interface FolderWatchOptions {
  /** Debounce window for event bursts. Default 250ms. */
  debounceMs?: number;
  /** Watch subfolders too. Default false (matches a non-recursive scan). */
  recursive?: boolean;
}

export class FolderWatcher {
  private watcher: FSWatcher | null = null;
  private watchedFolder: string | null = null;
  private pending: { changes: Map<string, WatchChangeType>; timer: NodeJS.Timeout } | null = null;
  private readonly debounceMs: number;
  private listeners: Array<(changes: WatchChange[]) => void> = [];
  private recursive = false;

  constructor(debounceMs = 250) {
    this.debounceMs = debounceMs;
  }

  get folder(): string | null {
    return this.watchedFolder;
  }

  get isWatching(): boolean {
    return this.watcher !== null;
  }

  /** Subscribe to debounced change batches; returns an unsubscribe function. */
  subscribe(listener: (changes: WatchChange[]) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Start (or replace) the watch for a scan session. */
  async start(folder: string, options: FolderWatchOptions = {}): Promise<void> {
    if (this.watcher !== null && this.watchedFolder === folder && this.recursive === (options.recursive ?? false)) {
      return;
    }
    await this.stop();

    this.recursive = options.recursive ?? false;
    this.watcher = watch(folder, {
      ignoreInitial: true,
      depth: this.recursive ? undefined : 0,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });

    const record = (type: WatchChangeType) => (changedPath: string) => {
      this.record(type, changedPath);
    };
    this.watcher
      .on('add', record('add'))
      .on('change', record('change'))
      .on('unlink', record('unlink'));

    this.watchedFolder = folder;
  }

  /** Stop watching and flush nothing — the UI resyncs via a fresh scan. */
  async stop(): Promise<void> {
    const watcher = this.watcher;
    this.watcher = null;
    this.watchedFolder = null;
    this.recursive = false;
    if (this.pending !== null) {
      clearTimeout(this.pending.timer);
      this.pending = null;
    }
    if (watcher !== null) {
      try {
        await watcher.close();
      } catch {
        /* closing a dead watcher is fine */
      }
    }
  }

  private record(type: WatchChangeType, changedPath: string): void {
    if (this.pending === null) {
      const timer = setTimeout(() => this.flush(), this.debounceMs);
      this.pending = { changes: new Map(), timer };
    }
    // Later events for the same path win, except that an unlink always wins:
    // it is the state the UI must reconcile last.
    const existing = this.pending.changes.get(changedPath);
    if (existing !== 'unlink') this.pending.changes.set(changedPath, type);
  }

  private flush(): void {
    const pending = this.pending;
    this.pending = null;
    if (pending === undefined || pending === null) return;
    const changes: WatchChange[] = [...pending.changes.entries()].map(([changePath, type]) => ({
      type,
      path: changePath,
    }));
    if (changes.length === 0) return;
    for (const listener of this.listeners) {
      try {
        listener(changes);
      } catch {
        /* a broken subscriber must not kill the watcher */
      }
    }
  }
}
