import { useState } from 'react';
import { recoveryFix, recoveryScan } from '../api/client';
import { useHealth } from '../state/queries';
import { useUiStore } from '../state/store';
import { navigate } from '../lib/router';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { ErrorBanner } from '../components/ErrorBanner';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Segmented } from '../components/ui/controls';
import type { ThemeChoice } from '../state/store';
import type { RecoveryFixResult, RecoveryScanReport } from '../write/types';

/**
 * Settings (route /settings): engine path + version + Verify, the theme
 * toggle (same control as the status strip), the hard-floored safety toggles —
 * shown LOCKED with honest copy, they are what makes undo possible — and the
 * recovery section: run the scan, then guided fixes where every fix needs an
 * explicit confirmation.
 */
export function SettingsView() {
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold">Settings</h1>
        <p className="text-xs text-muted-foreground">
          The engine, the look, and the safety floors. The floors cannot be turned off — they are
          what makes every write previewable and every change undoable.
        </p>
      </header>
      <EngineCard />
      <AppearanceCard />
      <SafetyFloorsCard />
      <RecoveryCard />
    </div>
  );
}

function EngineCard() {
  const { data: health, isLoading, refetch, isFetching } = useHealth();
  const [verifyNote, setVerifyNote] = useState<string | null>(null);

  return (
    <section className="rounded-lg border border-border px-4 py-4" aria-label="Engine">
      <h2 className="text-sm font-semibold">Engine (exiftool)</h2>
      <dl className="mt-2 space-y-1.5 text-sm">
        <div className="flex gap-3">
          <dt className="w-28 shrink-0 text-muted-foreground">Version</dt>
          <dd className="font-mono">{health !== undefined && health.version !== '' ? health.version : '—'}</dd>
        </div>
        <div className="flex gap-3">
          <dt className="w-28 shrink-0 text-muted-foreground">Path</dt>
          <dd className="min-w-0 break-all font-mono text-xs" title={health?.executablePath}>
            {health?.executablePath ?? 'unknown'}
          </dd>
        </div>
        <div className="flex gap-3">
          <dt className="w-28 shrink-0 text-muted-foreground">Handshake</dt>
          <dd>
            {health === undefined ? (
              <Badge tone="neutral">checking…</Badge>
            ) : health.ok ? (
              <Badge tone="success">verified — read commands run</Badge>
            ) : (
              <Badge tone="danger">not verified — read-only fallback</Badge>
            )}
          </dd>
        </div>
      </dl>
      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={isLoading || isFetching}
          onClick={() => {
            setVerifyNote(null);
            void refetch().then((result) => {
              setVerifyNote(
                result.data?.ok === true
                  ? `Verified: exiftool ${result.data.version} answered the -ver handshake.`
                  : 'The engine did not verify. MetaDesk stays read-only; check the path above and restart the launcher.',
              );
            });
          }}
        >
          {isFetching ? 'Verifying…' : 'Verify engine'}
        </Button>
        <span className="text-xs text-muted-foreground">
          Runs the same health check the app performs at startup (exiftool -ver).
        </span>
      </div>
      {verifyNote !== null && <p className="mt-2 text-xs text-muted-foreground">{verifyNote}</p>}
    </section>
  );
}

function AppearanceCard() {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const density = useUiStore((s) => s.density);
  const setDensity = useUiStore((s) => s.setDensity);

  return (
    <section className="rounded-lg border border-border px-4 py-4" aria-label="Appearance">
      <h2 className="text-sm font-semibold">Appearance</h2>
      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
        <label className="flex items-center gap-2 text-sm">
          Theme
          <Segmented<ThemeChoice>
            ariaLabel="Theme"
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
              { value: 'system', label: 'Auto' },
            ]}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          Density
          <Segmented
            ariaLabel="Density"
            value={density}
            onChange={setDensity}
            options={[
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'compact', label: 'Compact' },
            ]}
          />
        </label>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        The same controls also live in the bottom status strip, where they always stay reachable.
      </p>
    </section>
  );
}

function SafetyFloorsCard() {
  return (
    <section className="rounded-lg border border-border px-4 py-4" aria-label="Safety floors">
      <h2 className="text-sm font-semibold">Safety floors</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        These cannot be disabled — they are what makes undo possible. They are not preferences;
        they are the product.
      </p>
      <div className="mt-3 space-y-3">
        <LockedFloor
          id="floor-diff"
          label="Show me the diff before every write"
          explanation="Always ON. The Save Review modal is the only door to any write — preview, then execute."
        />
        <LockedFloor
          id="floor-backup"
          label="Keep a backup (_original) of every file before it changes"
          explanation="Always ON. Writes run in exiftool's default backup mode; -overwrite_original is structurally impossible here."
        />
        <LockedFloor
          id="floor-hash"
          label="Verify each backup by hash before a file is counted as updated"
          explanation="Always ON. A file is only 'updated' when its backup's sha256 matches what was captured before the write."
        />
        <LockedFloor
          id="floor-phrase"
          label="Typed confirmation for destructive operations"
          explanation="Always ON. GPS strips and AI scrubs require typing a phrase per batch."
        />
        <LockedFloor
          id="floor-session"
          label="Writes-unlock lasts this session only"
          explanation="Always ON. Closing MetaDesk returns everything to the read-only default by construction."
        />
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        In-place overwrite does not exist in the product, at any setting.
      </p>
    </section>
  );
}

function LockedFloor({ id, label, explanation }: { id: string; label: string; explanation: string }) {
  return (
    <div className="flex items-start gap-2.5 opacity-90">
      <input
        id={id}
        type="checkbox"
        checked
        disabled
        aria-label={`${label} (always on — cannot be disabled)`}
        className="mt-0.5 h-4 w-4 cursor-not-allowed accent-[var(--success)]"
      />
      <div className="text-sm leading-5">
        <label htmlFor={id} className="font-medium">
          {label} <Badge tone="success" className="ml-1">locked ON</Badge>
        </label>
        <div className="text-xs text-muted-foreground mt-0.5">{explanation}</div>
      </div>
    </div>
  );
}

interface RecoveryIssue {
  kind: 'orphan-temp' | 'missing-photo' | 'untracked-backup' | 'interrupted-batch';
  title: string;
  explanation: string;
  actionLabel: string;
  confirmText: string;
  run: () => Promise<RecoveryFixResult>;
}

function RecoveryCard() {
  const scanResult = useUiStore((s) => s.scanResult);
  const [report, setReport] = useState<RecoveryScanReport | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<unknown>(null);
  const [pendingIssue, setPendingIssue] = useState<RecoveryIssue | null>(null);
  const [results, setResults] = useState<Array<{ ok: boolean; message: string }>>([]);
  const [fixBusy, setFixBusy] = useState(false);

  const scan = async (): Promise<void> => {
    setScanning(true);
    setScanError(null);
    try {
      const folders = scanResult !== null ? [scanResult.folder] : [];
      setReport(await recoveryScan(folders));
    } catch (cause) {
      setScanError(cause);
    } finally {
      setScanning(false);
    }
  };

  const runFix = async (issue: RecoveryIssue): Promise<void> => {
    setFixBusy(true);
    try {
      const result = await issue.run();
      setResults((current) => [{ ok: true, message: result.message }, ...current].slice(0, 6));
      await scan();
    } catch (cause) {
      setResults((current) => [
        { ok: false, message: cause instanceof Error ? cause.message : String(cause) },
        ...current,
      ]);
    } finally {
      setFixBusy(false);
      setPendingIssue(null);
    }
  };

  const issues: RecoveryIssue[] = [];
  if (report !== null) {
    for (const folder of report.folders) {
      for (const temp of folder.orphanTempFiles) {
        issues.push({
          kind: 'orphan-temp',
          title: `Leftover scratch file: ${temp.path}`,
          explanation:
            'A write was interrupted here; the photo itself is safe. This leftover temp file makes every future write to that photo fail until it is deleted.',
          actionLabel: 'Delete the leftover temp file',
          confirmText: 'Deletes only the *_exiftool_tmp scratch file. The photo is never touched.',
          run: () => recoveryFix({ action: 'delete-orphan-temp', path: temp.path, confirm: true }),
        });
      }
      for (const pair of folder.originalsWithoutPhoto) {
        issues.push({
          kind: 'missing-photo',
          title: `${pair.photoPath} exists only as its _original backup`,
          explanation:
            'A write was interrupted mid-swap: the backup was made but the finished copy never landed. The backup IS the photo.',
          actionLabel: 'Restore the photo from its backup',
          confirmText: 'Renames the backup back into place. When the journal tracks it, the hash is verified first.',
          run: () => recoveryFix({ action: 'restore-original', backupPath: pair.backupPath, confirm: true }),
        });
      }
      for (const pair of folder.untrackedOriginals) {
        issues.push({
          kind: 'untracked-backup',
          title: `Untracked backup next to ${pair.photoPath}`,
          explanation:
            'An _original backup MetaDesk did not journal was found here — another tool wrote to this folder, or the journal was lost. Undo does not know about it yet.',
          actionLabel: 'Record it in the journal (adopt)',
          confirmText: 'Records path, size, and hash in the journal so undo and verification know about this backup.',
          run: () =>
            recoveryFix({ action: 'adopt-original', backupPath: pair.backupPath, photoPath: pair.photoPath, confirm: true }),
        });
      }
    }
    for (const batch of report.journal.interruptedBatches) {
      issues.push({
        kind: 'interrupted-batch',
        title: `Unfinished batch ${batch.batchId} (${batch.pendingFiles.length} file(s) without a result)`,
        explanation:
          'This batch started but never finished. Files already written are safe and journalled; the rest were left unchanged.',
        actionLabel: 'Mark this batch abandoned',
        confirmText:
          'Marks the batch abandoned in the journal so it stops appearing as pending. History stays readable; nothing is written to photos.',
        run: () => recoveryFix({ action: 'mark-batch-abandoned', batchId: batch.batchId, confirm: true }),
      });
    }
  }

  return (
    <section className="rounded-lg border border-border px-4 py-4" aria-label="Recovery">
      <h2 className="text-sm font-semibold">Recovery</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Finds the debris a crash or power cut leaves behind — leftover temp files, half-finished
        swaps, untracked backups, interrupted batches. Nothing runs automatically: every fix below
        is your explicit choice, and every choice is journaled.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={scanning} onClick={() => void scan()}>
          {scanning ? 'Scanning…' : 'Run recovery scan'}
        </Button>
        <span className="text-xs text-muted-foreground">
          {scanResult !== null ? `scans the journal + ${scanResult.folder}` : 'scans the journal (open a folder to include it)'}
        </span>
      </div>

      {scanError !== undefined && scanError !== null && (
        <div className="mt-2">
          <ErrorBanner error={scanError} context="Recovery scan" onRetry={() => void scan()} />
        </div>
      )}

      {report !== null && (
        <div className="mt-3 space-y-2 text-sm">
          {report.clean ? (
            <div className="rounded border border-success/40 bg-success/5 px-3 py-2 text-success">
              All clean — no interrupted batches, no orphan temp files, no untracked backups.
            </div>
          ) : (
            <ul className="space-y-2">
              {issues.map((issue) => (
                <li key={issue.title} className="rounded border border-warning/40 bg-warning/5 px-3 py-2">
                  <div className="text-sm font-medium">{issue.title}</div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{issue.explanation}</p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-1.5"
                    disabled={fixBusy}
                    onClick={() => setPendingIssue(issue)}
                  >
                    {issue.actionLabel}…
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {results.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {results.map((result, index) => (
            <div
              key={`${index}:${result.message.slice(0, 24)}`}
              className={`rounded border px-3 py-1.5 text-xs ${
                result.ok ? 'border-success/40 bg-success/5' : 'border-destructive/40 bg-destructive/5'
              }`}
              role="status"
            >
              {result.message}
            </div>
          ))}
        </div>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        The journal (with every backup record and scrub export) lives in{' '}
        <span className="font-mono">app/data/journal/</span>. Nuclear per-batch restores live in{' '}
        <button type="button" className="text-accent underline" onClick={() => navigate('/history')}>
          History
        </button>
        .
      </p>

      <ConfirmDialog
        open={pendingIssue !== null}
        danger={pendingIssue?.kind !== 'untracked-backup' && pendingIssue?.kind !== 'interrupted-batch'}
        title={pendingIssue !== null ? pendingIssue.actionLabel : ''}
        confirmLabel="Confirm this fix"
        cancelLabel="Cancel"
        onConfirm={() => {
          if (pendingIssue !== null) void runFix(pendingIssue);
        }}
        onCancel={() => setPendingIssue(null)}
      >
        <p>{pendingIssue?.confirmText}</p>
      </ConfirmDialog>
    </section>
  );
}
