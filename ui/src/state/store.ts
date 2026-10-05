/**
 * UI state (zustand). Server state lives in TanStack Query — this store only
 * holds view state that outlives a query cache: selection, the Command
 * Preview drawer, badge knowledge learned from detail reads, and the small
 * preferences that persist to localStorage.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { FolderScanRequest, FolderScanResult } from '@metadesk/shared';
import type { BatchOutcome, TagEdit } from '../write/types';

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
