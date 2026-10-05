import { useCallback, useEffect, useMemo, useState } from 'react';
import { getWriteHistory, previewUndo, recoveryFix } from '../api/client';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useWriteRunner } from '../write/useWriteRun';
import type { HistoryBatch } from '../write/types';
import { basename, formatDateTime } from '../lib/format';

/**
 * Backup & Undo History (ux-spec, route /history): reverse-chronological batch
 * list from the journal with Verified backup chips (hash-checked on every
 * view), one-click undo of the last batch through the mandatory two-step
 * (diff first, then confirm), the clearly-labeled nuclear _original restore
 * for a batch behind a double confirm, and the scrub-sidecar note.
 */
export function HistoryView() {
  const [limit, setLimit] = useState(20);
  const [batches, setBatches] = useState<HistoryBatch[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const runner = useWriteRunner();

  const [undoTarget, setUndoTarget] = useState<HistoryBatch | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoError, setUndoError] = useState<unknown>(null);
  const [nuclearTarget, setNuclearTarget] = useState<HistoryBatch | null>(null);
  const [nuclearConfirm, setNuclearConfirm] = useState(false);
  const [nuclearBusy, setNuclearBusy] = useState(false);
  const [nuclearResult, setNuclearResult] = useState<string | null>(null);

  const load = useCallback(async (nextLimit: number): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await getWriteHistory(nextLimit);
      setBatches(result.batches);
    } catch (cause) {
      setLoadError(cause);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(limit);
  }, [load, limit]);

  const beginUndo = async (batch: HistoryBatch): Promise<void> => {
    setUndoBusy(true);
    setUndoError(null);
    try {
      // Step 1 of the two-step undo: show exactly what the reverse write does.
      const preview = await previewUndo(batch.batchId);
      setUndoTarget(null);
      runner.review(
        [
          {
            label: `Undo: restore ${preview.undoPreview.files.length} file(s) to their pre-edit values`,
            preview: preview.undoPreview,
            commandPreview: preview.commandPreview,
          },
        ],
        {
          title: `Undo review — what “${batch.description || 'this batch'}” changed goes back`,
          undoBatchId: batch.batchId,
        },
      );
    } catch (cause) {
      setUndoError(cause);
    } finally {
      setUndoBusy(false);
    }
  };

  const runNuclearRestore = async (): Promise<void> => {
    if (nuclearTarget === null || !nuclearConfirm) return;
    setNuclearBusy(true);
    try {
      const result = await recoveryFix({
        action: 'restore-originals-for-batch',
        batchId: nuclearTarget.batchId,
        confirm: true,
      });
      setNuclearResult(result.message);
      setNuclearTarget(null);
      setNuclearConfirm(false);
      await load(limit);
    } catch (cause) {
      setNuclearResult(
        cause instanceof Error ? cause.message : String(cause),
      );
    } finally {
      setNuclearBusy(false);
    }
  };

  const lastUndoable = useMemo(() => batches?.find((batch) => batch.undoable && !batch.interrupted), [batches]);

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">History &amp; undo</h1>
        {batches !== null && <Badge tone="neutral">{batches.length} batch(es)</Badge>}
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => void load(limit)} disabled={loading}>
          {loading ? 'Reading the journal…' : 'Refresh'}
        </Button>
      </header>

      {loadError !== undefined && loadError !== null && (
        <ErrorBanner error={loadError} context="Reading the journal" onRetry={() => void load(limit)} />
      )}
      {undoError !== null && (
        <ErrorBanner
          error={undoError}
          context="Preparing the undo"
          onRetry={undoTarget !== null ? () => void beginUndo(undoTarget) : undefined}
        />
      )}
      {runner.error !== null && (
        <ErrorBanner error={runner.error} context="Running the undo" onRetry={() => runner.clearError()} />
      )}
      {nuclearResult !== null && (
        <div className="rounded-lg border border-border bg-muted px-3 py-2 text-sm" role="status">
          {nuclearResult}
          <Button size="sm" variant="ghost" className="ml-2" onClick={() => setNuclearResult(null)}>
            Dismiss
          </Button>
        </div>
      )}

      {/* One-click restore of the last batch — the common case */}
      {lastUndoable !== undefined && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2.5">
          <div className="min-w-0 flex-1 text-sm">
            <span className="font-medium">Last reversible batch:</span>{' '}
            <span className="text-muted-foreground">
              {lastUndoable.description || lastUndoable.batchId} — {formatDateTime(lastUndoable.startedAt ?? undefined)}
            </span>
          </div>
          <Button
            variant="primary"
            size="sm"
            disabled={undoBusy || runner.busy}
            onClick={() => void beginUndo(lastUndoable)}
            title="Shows the reverse diff first — the write happens only after you confirm it."
          >
            {undoBusy ? 'Building the reverse diff…' : 'Restore last batch'}
          </Button>
        </div>
      )}

      {batches !== null && batches.length === 0 && !loading && (
        <EmptyState title="No changes yet">
          Every write MetaDesk makes is journalled here with its backup proof. Once you make the
          first edit, it appears with a Verified chip you can undo.
        </EmptyState>
      )}

      <ul className="space-y-3">
        {(batches ?? []).map((batch) => (
          <BatchCard
            key={batch.batchId}
            batch={batch}
            onUndo={() => void beginUndo(batch)}
            undoBusy={undoBusy}
            onNuclear={() => {
              setNuclearTarget(batch);
              setNuclearConfirm(false);
            }}
          />
        ))}
      </ul>

      {batches !== null && batches.length >= limit && limit < 100 && (
        <div className="text-center">
          <Button size="sm" variant="outline" onClick={() => setLimit(Math.min(100, limit + 30))}>
            Show more (up to 100)
          </Button>
        </div>
      )}

      {/* Nuclear restore: double confirm, clearly labeled */}
      <ConfirmDialog
        open={nuclearTarget !== null}
        danger
        title={nuclearTarget !== null ? 'Restore every file in this batch from its _original?' : ''}
        confirmLabel="Yes — show the second warning"
        cancelLabel="Cancel"
        onConfirm={() => setNuclearConfirm(true)}
        onCancel={() => {
          setNuclearTarget(null);
          setNuclearConfirm(false);
        }}
      >
        <p>
          This does <strong>not</strong> undo just this batch. Restoring from <code className="font-mono text-xs">_original</code>{' '}
          reverts each file to its FIRST-contact snapshot — <strong>every edit since then is wiped</strong>,
          including later batches and edits made outside MetaDesk.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={nuclearTarget !== null && nuclearConfirm}
        danger
        title="Final confirmation — revert EVERYTHING since first contact?"
        confirmLabel={nuclearBusy ? 'Restoring…' : 'Revert everything'}
        cancelLabel="No — stop"
        onConfirm={() => void runNuclearRestore()}
        onCancel={() => setNuclearConfirm(false)}
      >
        <p>
          {nuclearTarget?.outcomes.filter((outcome) => outcome.backup !== undefined).length ?? 0}{' '}
          file(s) in this batch have verified backups. Copying them back cannot be undone by
          MetaDesk. Only continue if you understand this reverts everything, not just this batch.
        </p>
      </ConfirmDialog>

      {runner.modal}
    </div>
  );
}

function BatchCard({
  batch,
  onUndo,
  undoBusy,
  onNuclear,
}: {
  batch: HistoryBatch;
  onUndo: () => void;
  undoBusy: boolean;
  onNuclear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const withBackups = batch.backups;
  const allVerified = withBackups.length > 0 && withBackups.every((row) => row.verified);
  const someUnverified = withBackups.some((row) => !row.verified);
  const isScrub = batch.mode === 'scrub';
  const isUndo = batch.mode === 'undo';

  return (
    <li className="rounded-lg border border-border bg-card">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full flex-wrap items-center gap-2 px-3 py-2.5 text-left hover:bg-muted"
      >
        <span className="text-xs" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            {batch.description || batch.batchId}
          </span>
          <span className="block text-xs text-muted-foreground">
            {formatDateTime(batch.startedAt ?? undefined)} · {batch.updated} updated ·{' '}
            {batch.unchanged} unchanged · {batch.failed} failed
          </span>
        </span>
        {isScrub && <Badge tone="warning">AI scrub</Badge>}
        {isUndo && <Badge tone="info">undo</Badge>}
        {batch.interrupted ? (
          <Badge tone="warning">interrupted</Badge>
        ) : allVerified ? (
          <Badge tone="success">backups verified</Badge>
        ) : someUnverified ? (
          <Badge tone="warning">backup unverifiable</Badge>
        ) : (
          <Badge tone="neutral">no backups</Badge>
        )}
        {!batch.undoable && !batch.interrupted && <Badge tone="neutral">nothing to undo</Badge>}
      </button>

      {open && (
        <div className="border-t border-border px-3 py-2.5 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-muted-foreground">{batch.batchId}</span>
            <span className="text-muted-foreground">mode: {batch.mode}</span>
          </div>

          {isScrub && (
            <p className="mt-2 rounded border border-warning/40 bg-warning/10 px-2 py-1.5">
              Before this scrub ran, the full original values of every removed tag were exported to
              a sidecar file beside the journal (app/data/journal/exports/), keyed by this batch's
              scrub id — the coordinates-and-prompts safety copy.
            </p>
          )}

          {someUnverified && (
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-warning">
              {withBackups
                .filter((row) => !row.verified)
                .map((row) => (
                  <li key={row.filePath}>
                    {basename(row.filePath)}: the backup could not be hash-verified — treat this
                    entry with care.
                  </li>
                ))}
            </ul>
          )}

          <details className="mt-2">
            <summary className="cursor-pointer text-muted-foreground">
              {batch.outcomes.length} file(s) — outcomes
            </summary>
            <ul className="mt-1 space-y-1">
              {batch.outcomes.map((outcome) => (
                <li key={outcome.filePath} className="flex items-center gap-2">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      outcome.status === 'updated'
                        ? 'bg-success'
                        : outcome.status === 'unchanged'
                          ? 'bg-muted-foreground'
                          : 'bg-destructive'
                    }`}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate font-mono" title={outcome.filePath}>
                    {basename(outcome.filePath)}
                  </span>
                  <span className="text-muted-foreground">{outcome.status}</span>
                </li>
              ))}
            </ul>
          </details>

          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={!batch.undoable || batch.interrupted || undoBusy}
              onClick={onUndo}
              title="Two-step: first the reverse diff, then your confirm. Undoing twice is refused by design."
            >
              Restore this change (undo)
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="border-destructive/50 text-destructive"
              onClick={onNuclear}
              title="The nuclear option: reverts EVERYTHING since first contact, not just this batch."
            >
              Restore _original files…
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
