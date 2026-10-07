/**
 * UI state (zustand). Server state lives in TanStack Query — this store only
 * holds view state that outlives a query cache: selection, the Command
 * Preview drawer, badge knowledge learned from detail reads, the small
 * preferences that persist to localStorage, and the TRANSIENT session-scoped
 * write run (busy/progress/cancel — never persisted; see WriteRunState).
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { FolderScanRequest, FolderScanResult } from '@metadesk/shared';
import type {
  BatchOutcome,
  CancelRequestState,
  PreviewGroup,
  TagEdit,
  WriteProgress,
  WriteRunConfig,
} from '../write/types';

/** The most recent executed write — the Results Report's subject (/results). */
export interface LastWrite {
  label: string;
  /** The edits that ran (retry re-previews ONLY failed files with these). */
  edits: TagEdit[];
  timezone?: string;
  outcome: BatchOutcome;
  commandPreview: string[];
  consistencyNotes: string[];
  at: string;
  /** Present for scrub runs: the sidecar export + honest not-removed list. */
  scrub?: {
    exportedValuesPath: string;
    notRemoved: Array<{ filePath: string; tag: string; reason: string }>;
  };
}

export type ThemeChoice = 'dark' | 'light' | 'system';
export type Density = 'comfortable' | 'compact';

/** Per-file badge knowledge, learned when a file's metadata is read or the
 * AI-scrub wizard detects findings (aiGenerated is tri-state: unknown/null). */
export interface FileBadges {
  hasGps: boolean;
  hasCopyright: boolean;
  /** true when the scrub detector found AI-generation signals in this file. */
  aiGenerated: boolean | null;
}

/** One entry in the Command Preview drawer's history. */
export interface CommandHistoryEntry {
  id: number;
  argv: string[];
  label: string;
  readOnly: boolean;
  ok: boolean;
  at: string;
}

/**
 * The ONE session-scoped write run in flight (arch-v11 leaf 1.5). Every
 * write-running state — the busy gate, streamed progress, the cancel state,
 * the staged review, and the honest terminal latch — lives here instead of in
 * per-view useState, so a run survives any navigation and every surface (the
 * five view mounts and the shell host) reads the same truth. Transient BY
 * RULE: a persisted flight would LIE after a reload (a vanished client never
 * fails the batch and nothing re-attaches), so partialize never carries it.
 */
export interface WriteRunState {
  /** true while a write is executing — the session-wide single-flight gate. */
  busy: boolean;
  /** Last streamed progress frame (null on the non-streamed arms). */
  progress: WriteProgress | null;
  /** The edits-arm execute error (null when none — views check `!== null`). */
  error: unknown;
  /**
   * The batch id of the write currently executing with {stream:true} — the
   * cancel target. null whenever nothing streamable is in flight.
   */
  activeBatchId: string | null;
  /** After a cancel request: what the server said (for the honest note). */
  cancelState: CancelRequestState | null;
  /** The server's refusal of the last destructive confirm, verbatim. */
  refusal: string | null;
  /** The staged review (at most ONE per session; a new review replaces it). */
  groups: PreviewGroup[] | null;
  config: WriteRunConfig | null;
  /** The route the run started from — completion compares against it. */
  startedRoute: string | null;
  /**
   * Terminal latch: 'done' written in the SUCCESS branch, 'failed' in the
   * CATCH branch — never derived from finally, so a failed run can never
   * claim success. Cleared by any new review/run and by the View report click.
   */
  completion: 'done' | 'failed' | null;
}

/** The idle flight — also the flight-aware suites' beforeEach reset value. */
export const WRITE_RUN_IDLE: WriteRunState = {
  busy: false,
  progress: null,
  error: null,
  activeBatchId: null,
  cancelState: null,
  refusal: null,
  groups: null,
  config: null,
  startedRoute: null,
  completion: null,
};

interface UiState {
  // --- mode (safety UX) ---
  /** Mirror of the server's session state; health is the source of truth. */
  writeUnlocked: boolean;
  setWriteUnlocked: (unlocked: boolean) => void;

  // --- last executed write (feeds /results) ---
  lastWrite: LastWrite | null;
  setLastWrite: (write: LastWrite) => void;

  // --- folder / scan context ---
  scanRequest: FolderScanRequest | null;
  scanResult: FolderScanResult | null;
  setScan: (request: FolderScanRequest, result: FolderScanResult) => void;
  clearScan: () => void;

  // --- selection ---
  selectedPaths: string[];
  toggleSelected: (path: string) => void;
  setSelection: (paths: string[]) => void;
  clearSelection: () => void;

  // --- command preview drawer ---
  drawerOpen: boolean;
  toggleDrawer: () => void;
  nextCommand: { argv: string[]; label: string; readOnly: boolean } | null;
  setNextCommand: (argv: string[], label: string, readOnly: boolean) => void;
  commandHistory: CommandHistoryEntry[];
  recordCommand: (entry: Omit<CommandHistoryEntry, 'id' | 'at'>) => void;
  consoleDraft: string[];
  setConsoleDraft: (argv: string[]) => void;

  // --- badge knowledge ---
  badges: Record<string, FileBadges>;
  noteBadges: (path: string, badges: FileBadges) => void;

  // --- grid filter (fed by the top-bar search) ---
  searchText: string;
  setSearchText: (text: string) => void;

  // --- preferences (persisted) ---
  recents: string[];
  pushRecent: (folder: string) => void;
  theme: ThemeChoice;
  setTheme: (theme: ThemeChoice) => void;
  density: Density;
  setDensity: (density: Density) => void;

  // --- console history (persisted) ---
  consoleHistory: string[];
  pushConsoleHistory: (line: string) => void;

  // --- help overlay ---
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;

  // --- background progress (SSE) ---
  scanProgress: { scanId: string; filesScanned: number; currentDirectory?: string } | null;
  setScanProgress: (p: UiState['scanProgress']) => void;

  // --- the write run in flight (session-scoped, transient — never persisted) ---
  writeRun: WriteRunState;
  /** ONE shallow-merge setter for the flight slice. */
  setWriteRun: (patch: Partial<WriteRunState>) => void;
}

let commandCounter = 0;

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      writeUnlocked: false,
      setWriteUnlocked: (unlocked) => set({ writeUnlocked: unlocked }),

      lastWrite: null,
      setLastWrite: (write) => set({ lastWrite: write }),

      scanRequest: null,
      scanResult: null,
      setScan: (request, result) => set({ scanRequest: request, scanResult: result }),
      clearScan: () => set({ scanRequest: null, scanResult: null, selectedPaths: [] }),

      selectedPaths: [],
      toggleSelected: (path) => {
        const current = get().selectedPaths;
        set({
          selectedPaths: current.includes(path)
            ? current.filter((p) => p !== path)
            : [...current, path],
        });
      },
      setSelection: (paths) => set({ selectedPaths: [...paths] }),
      clearSelection: () => set({ selectedPaths: [] }),

      drawerOpen: false,
      toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),
      nextCommand: null,
      setNextCommand: (argv, label, readOnly) => set({ nextCommand: { argv, label, readOnly } }),
      commandHistory: [],
      recordCommand: (entry) =>
        set((s) => ({
          commandHistory: [
            { ...entry, id: ++commandCounter, at: new Date().toISOString() },
            ...s.commandHistory,
          ].slice(0, 50),
        })),
      consoleDraft: [],
      setConsoleDraft: (argv) => set({ consoleDraft: argv }),

      badges: {},
      noteBadges: (path, badges) => set((s) => ({ badges: { ...s.badges, [path]: badges } })),

      searchText: '',
      setSearchText: (text) => set({ searchText: text }),

      recents: [],
      pushRecent: (folder) =>
        set((s) => ({ recents: [folder, ...s.recents.filter((f) => f !== folder)].slice(0, 8) })),
      theme: 'dark',
      setTheme: (theme) => set({ theme }),
      density: 'comfortable',
      setDensity: (density) => set({ density }),

      consoleHistory: [],
      pushConsoleHistory: (line) =>
        set((s) => ({ consoleHistory: [line, ...s.consoleHistory.filter((l) => l !== line)].slice(0, 50) })),

      helpOpen: false,
      setHelpOpen: (open) => set({ helpOpen: open }),

      scanProgress: null,
      setScanProgress: (p) => set({ scanProgress: p }),

      writeRun: { ...WRITE_RUN_IDLE },
      setWriteRun: (patch) => set((s) => ({ writeRun: { ...s.writeRun, ...patch } })),
    }),
    {
      name: 'metadesk-ui',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        recents: s.recents,
        theme: s.theme,
        density: s.density,
        consoleHistory: s.consoleHistory,
      }),
    },
  ),
);
