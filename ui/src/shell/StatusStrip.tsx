import { useHealth } from '../state/queries';
import { useUiStore } from '../state/store';
import { readBootstrap } from '../api/client';
import { Segmented } from '../components/ui/controls';
import type { ThemeChoice } from '../state/store';

/**
 * Bottom status strip (ux-spec): exiftool version chip from the -ver
 * handshake, current folder, counts, background progress, single-writer /
 * read-only indicator, and the theme toggle.
 */
export function StatusStrip() {
  const { data: health, isLoading } = useHealth();
  const scanResult = useUiStore((s) => s.scanResult);
  const scanProgress = useUiStore((s) => s.scanProgress);
  const selectedCount = useUiStore((s) => s.selectedPaths.length);
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  // The session's write run in flight — the writer line reflects it while one
  // is in flight (health's lock data alone used to say "idle" mid-run).
  const writeBusy = useUiStore((s) => s.writeRun.busy);

  const version = health?.version !== undefined && health.version !== '' ? health.version : readBootstrap().version;
  const versionOk = health?.ok === true;

  return (
    <div className="flex h-8 items-center gap-4 border-t border-border bg-card px-3 text-[11px] text-muted-foreground">
      <span
        className="tip inline-flex items-center gap-1.5"
        title={
          versionOk
            ? `Engine verified: exiftool ${version} (${health?.executablePath ?? 'bundled'})`
            : 'Engine not verified yet — the app stays read-only until the handshake passes.'
        }
      >
        <span
          className={`h-2 w-2 rounded-full ${versionOk ? 'bg-success' : isLoading ? 'bg-muted-foreground/50' : 'bg-destructive'}`}
          aria-hidden="true"
        />
        <span className="font-mono">exiftool {versionOk ? version : '—'}</span>
      </span>

      <span className="truncate" title={scanResult?.folder ?? undefined}>
        {scanResult !== null ? scanResult.folder : 'No folder open'}
      </span>

      {scanResult !== null && (
        <span>
          {scanResult.totalFiles.toLocaleString()} files
          {selectedCount > 0 && <span className="text-accent"> · {selectedCount} selected</span>}
        </span>
      )}

      {scanProgress !== null && (
        <span className="text-accent">
          Scanning… {scanProgress.filesScanned.toLocaleString()} files
        </span>
      )}

      <span className="ml-auto flex items-center gap-3">
        <span
          title={
            health?.readOnlyFallback === true
              ? 'Read-only session (engine not fully verified)'
              : writeBusy
                ? 'A write is in flight — the single-writer lock holds until it finishes.'
                : 'Single-writer lock: no write in progress'
          }
        >
          {health?.readOnlyFallback === true ? 'Read-only session' : writeBusy ? 'Write in progress' : 'Writer idle'}
        </span>
        <Segmented<ThemeChoice>
          ariaLabel="Theme"
          value={theme}
          onChange={setTheme}
          options={[
            { value: 'dark', label: 'Dark', title: 'Dark theme' },
            { value: 'light', label: 'Light', title: 'Light theme' },
            { value: 'system', label: 'Auto', title: 'Follow Windows' },
          ]}
        />
      </span>
    </div>
  );
}
