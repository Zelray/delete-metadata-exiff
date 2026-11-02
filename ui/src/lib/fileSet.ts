/**
 * The file-set module (issue #16, arch-review Candidate 2): the ONE owner of
 * "which files am I operating on". Every write-firing view used to re-derive
 * this — BatchPanel with an explicit toggle plus scan-time badge warnings,
 * ScrubWizard with an implicit selection-else-filtered rule plus a cap,
 * FileGrid with its own filter — and "has GPS?" had two disagreeing truth
 * sources (scan-time warning vs session-learned badge). Now the answers live
 * here; views consume them. Pure functions only: no store, no hooks.
 */
import type { FileEntry } from '@metadesk/shared';
import type { FileBadges } from '../state/store';

/** The one case-insensitive name predicate. A blank needle keeps everything. */
export function filterByName(entries: readonly FileEntry[], searchText: string): FileEntry[] {
  const needle = searchText.trim().toLowerCase();
  if (needle === '') return [...entries];
  return entries.filter((entry) => entry.name.toLowerCase().includes(needle));
}

/**
 * The one badge truth: a session-learned badge is FRESHER than the scan, so
 * it wins when the file is known; the scan-time warning is the fallback for
 * files nothing has learned about yet (so a scan-flagged GPS file matches
 * filters immediately, without being clicked first).
 */
export function hasGps(entry: FileEntry, badges: Record<string, FileBadges>): boolean {
  return badges[entry.path]?.hasGps ?? entry.warnings.includes('badge:gps-present');
}

/** The one copyright badge truth (same precedence rule as `hasGps`). */
export function hasCopyright(entry: FileEntry, badges: Record<string, FileBadges>): boolean {
  return badges[entry.path]?.hasCopyright ?? entry.warnings.includes('badge:copyright-present');
}

export interface FileSetInput {
  entries: readonly FileEntry[];
  selectedPaths: readonly string[];
  searchText: string;
}

export interface FileSetOptions {
  /**
   * 'selection': the selection as-is, even when empty (BatchPanel's explicit
   * toggle). 'filtered': the name-filtered folder. 'auto': the selection when
   * non-empty, else the filtered folder (ScrubWizard's implicit rule).
   */
  mode: 'selection' | 'filtered' | 'auto';
  /**
   * Badge conditions applied to the base set (BatchPanel's condition chips).
   * A path the scan does not know is KEPT — the conditions cannot be
   * evaluated for it, so it is not silently dropped.
   */
  badges?: Record<string, FileBadges>;
  onlyWithGps?: boolean;
  onlyMissingCopyright?: boolean;
  /** Hard cap on the returned files (ScrubWizard's server-cap mirror). */
  cap?: number;
}

export interface FileSetResult {
  files: string[];
  /**
   * True when the base set exceeded `cap` — measured BEFORE capping (the
   * wizard's truncation notice compares the pre-cap length, like the server
   * cap does).
   */
  truncated: boolean;
  /** Which base the mode resolved to ('auto' reports its resolution). */
  base: 'selection' | 'filtered';
}

/** Derive the operating file set. The one answer views consume. */
export function fileSet(input: FileSetInput, options: FileSetOptions): FileSetResult {
  const filtered = filterByName(input.entries, input.searchText);
  const filteredPaths = filtered.map((entry) => entry.path);
  const base: 'selection' | 'filtered' =
    options.mode === 'filtered' || (options.mode === 'auto' && input.selectedPaths.length === 0)
      ? 'filtered'
      : 'selection';
  let files = base === 'selection' ? [...input.selectedPaths] : filteredPaths;

  if (options.onlyWithGps === true || options.onlyMissingCopyright === true) {
    files = files.filter((filePath) => {
      const entry = input.entries.find((e) => e.path === filePath);
      if (entry === undefined) return true; // unknown to the scan: keep
      if (options.onlyWithGps === true && !hasGps(entry, options.badges ?? {})) return false;
      if (options.onlyMissingCopyright === true && hasCopyright(entry, options.badges ?? {})) return false;
      return true;
    });
  }

  const truncated = options.cap !== undefined && files.length > options.cap;
  if (truncated) files = files.slice(0, options.cap);
  return { files, truncated, base };
}
