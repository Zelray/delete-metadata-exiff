/**
 * Write subsystem (arch-v11 leaf 1.1): the ONE owner of the write mode, the
 * single Journal, and the write services (pipeline, scrub, GPS strip).
 *
 * Created ONCE by buildServer and handed to the write routes, recovery, and
 * diagnostics, so every consumer sees the same mode and the same journal.
 * `announce` is a constructor dependency that unlock()/lock() always call —
 * a mode flip can never skip its `mode-changed` frame (the silent-flip hole
 * in the old route-level state is closed by construction).
 *
 * The module does NOT own engine boot, getHealth, shutdown, or route
 * registration (the engine is a shared read+write resource owned by the
 * composition root) and imports no Fastify types.
 */
import type { ExifToolSession } from './engine/exiftoolSession.js';
import { WritePipeline } from './services/writePipeline.js';
import { ScrubService } from './services/scrub.js';
import { GpsStripService } from './services/gpsStrip.js';
import { Journal } from './services/journal.js';

export type WriteMode = 'read-only' | 'write-unlocked';

/** In-memory, session-scoped write unlock. The server process IS the session:
 *  a restart drops back to the read-only default by construction. */
class WriteSessionState {
  private unlockedAt: string | null = null;

  get writeUnlocked(): boolean {
    return this.unlockedAt !== null;
  }

  get mode(): WriteMode {
    return this.writeUnlocked ? 'write-unlocked' : 'read-only';
  }

  unlock(): { mode: WriteMode; writeUnlocked: true; unlockedAt: string } {
    this.unlockedAt = new Date().toISOString();
    return { mode: this.mode, writeUnlocked: true, unlockedAt: this.unlockedAt };
  }

  lock(): { mode: WriteMode; writeUnlocked: false } {
    this.unlockedAt = null;
    return { mode: this.mode, writeUnlocked: false };
  }
}

export interface WriteSubsystemOptions {
  /** The persistent engine session; null degrades every write surface to 503. */
  engine: ExifToolSession | null;
  /** Mutable app state dir (journal, scratch, write temp files). */
  dataDir: string;
  /** Called on EVERY unlock/lock — the mode-changed cast is fused in here. */
  announce: (writeUnlocked: boolean) => void;
  /** Files per execution chunk (default 200; test seam for cancel drills). */
  chunkSize?: number;
}

export class WriteSubsystem {
  private readonly session = new WriteSessionState();
  private readonly announce: (writeUnlocked: boolean) => void;
  /** THE journal: the pipeline records here; recovery and diagnostics read here. */
  readonly journal: Journal;
  /** Null iff the engine is null (pinned nullability invariant). */
  readonly pipeline: WritePipeline | null;
  readonly scrub: ScrubService | null;
  readonly gpsStrip: GpsStripService | null;

  constructor(options: WriteSubsystemOptions) {
    this.announce = options.announce;
    this.journal = new Journal({ dataDir: options.dataDir });
    this.pipeline =
      options.engine !== null
        ? new WritePipeline({
            engine: options.engine,
            dataDir: options.dataDir,
            journal: this.journal,
            isWriteUnlocked: () => this.session.writeUnlocked,
            ...(options.chunkSize !== undefined ? { chunkSize: options.chunkSize } : {}),
          })
        : null;
    this.scrub =
      options.engine !== null && this.pipeline !== null
        ? new ScrubService({ engine: options.engine, pipeline: this.pipeline, dataDir: options.dataDir })
        : null;
    this.gpsStrip =
      options.engine !== null && this.pipeline !== null
        ? new GpsStripService({ engine: options.engine, pipeline: this.pipeline, dataDir: options.dataDir })
        : null;
  }

  get writeUnlocked(): boolean {
    return this.session.writeUnlocked;
  }

  get mode(): WriteMode {
    return this.session.mode;
  }

  /** THE single definition of the additive /api/health pair. */
  healthFields(): { writeUnlocked: boolean; mode: WriteMode } {
    return { writeUnlocked: this.writeUnlocked, mode: this.mode };
  }

  /** Unlock writing for this session and announce the new mode. */
  unlock(): { mode: WriteMode; writeUnlocked: true; unlockedAt: string } {
    const result = this.session.unlock();
    this.announce(true);
    return result;
  }

  /** Re-lock (back to the read-only default) and announce the new mode. */
  lock(): { mode: WriteMode; writeUnlocked: false } {
    const result = this.session.lock();
    this.announce(false);
    return result;
  }
}
