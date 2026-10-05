import { useMemo, useState } from 'react';
import { previewWrite } from '../api/client';
import { useUiStore } from '../state/store';
import { navigate } from '../lib/router';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';
import { explainFailure } from '../write/failures';
import { useWriteRunner } from '../write/useWriteRun';
import type { WriteOutcome } from '../write/types';
import { basename, formatDateTime } from '../lib/format';

/**
 * Batch Results Report (ux-spec, route /results): three-valued per-file truth —
 * updated / unchanged / needs attention — where "unchanged" is a visible third
 * state never folded into success, per-file stderr is preserved and shown,
 * failures get plain-English explanations with the server's suggested fixes
 * verbatim, and Retry re-previews ONLY the failed files.
 */
export function ResultsReport() {
  const lastWrite = useUiStore((s) => s.lastWrite);
  const runner = useWriteRunner();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<unknown>(null);

  const outcome = lastWrite?.outcome;
  const counts = useMemo(
    () =>
      outcome === undefined
        ? { updated: 0, unchanged: 0, failed: 0 }
        : {
            updated: outcome.files.filter((f) => f.status === 'updated').length,
            unchanged: outcome.files.filter((f) => f.status === 'unchanged').length,
            failed: outcome.files.filter((f) => f.status === 'failed').length,
          },
    [outcome],
  );

  const retry = async (): Promise<void> => {
    if (lastWrite === null || retrying) return;
    const failedPaths = outcome?.retryFilePaths ?? [];
    if (failedPaths.length === 0 || lastWrite.edits.length === 0) return;
    setRetrying(true);
    setRetryError(null);
    try {
      const envelope = await previewWrite(failedPaths, lastWrite.edits, lastWrite.timezone);
      runner.review(
        [
          {
            label: `Retry — ${failedPaths.length} failed file${failedPaths.length === 1 ? '' : 's'}`,
            preview: envelope.preview,
            commandPreview: envelope.commandPreview,
          },
        ],
        {
          title: 'Retry review — only the files that failed last time',
          edits: lastWrite.edits,
          ...(lastWrite.timezone !== undefined ? { timezone: lastWrite.timezone } : {}),
        },
      );
    } catch (cause) {
      setRetryError(cause);
    } finally {
      setRetrying(false);
    }
  };

  if (lastWrite === null || outcome === undefined) {
    return (
      <div className="p-6">
        <EmptyState title="Nothing to report yet">
          After any write — an edit, a batch, or an undo — the per-file truth lands here: what
          changed, what nothing-happened to, and what needs attention.
        </EmptyState>
        <div className="mt-4 text-center">
          <Button variant="primary" size="sm" onClick={() => navigate('/history')}>
            Open History
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold">Results</h1>
        <p className="text-xs text-muted-foreground">
          {lastWrite.label} · finished {formatDateTime(outcome.finishedAt)} · batch{' '}
          <span className="font-mono">{outcome.batchId}</span>
        </p>
      </header>

      {/* Three-valued summary — 'unchanged' is its own state, never a green check */}
      <section className="grid grid-cols-3 gap-3" aria-label="Outcome counts">
        <CountCard count={counts.updated} label="Updated" tone="success" hint="Changed, backup verified, and re-read to match the preview." />
        <CountCard
          count={counts.unchanged}
          label="Unchanged — nothing happened"
          tone="neutral"
          hint="Nothing matched or nothing needed changing. This is not a success — it is the honest 'no change' state."
        />
        <CountCard count={counts.failed} label="Needs attention" tone={counts.failed > 0 ? 'danger' : 'neutral'} hint="These files were left as found. Read the plain-English reason below each." />
      </section>

      {outcome.allVerified ? (
        <div className="rounded-lg border border-success/40 bg-success/5 px-3 py-2 text-sm text-success">
          All {counts.updated} updated file{counts.updated === 1 ? '' : 's'} were re-read after
          writing and match the preview exactly. Backups hash-verified.
        </div>
      ) : (
        counts.updated > 0 && (
          <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
            Some updated files could not be fully verified — treat them with care and check History
            before trusting those backups.
          </div>
        )
      )}

      {lastWrite.consistencyNotes.length > 0 && (
        <details className="rounded-lg border border-border px-3 py-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            {lastWrite.consistencyNotes.length} engine cross-check note(s) — honest noise, shown not swallowed
          </summary>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {lastWrite.consistencyNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </details>
      )}

      {lastWrite.scrub !== undefined && (
        <section className="space-y-2 rounded-lg border border-border px-3 py-3 text-sm">
          <h2 className="text-sm font-semibold">AI scrub extras</h2>
          <p className="text-xs text-muted-foreground">
            The full original values were exported before the scrub ran:{' '}
            <span className="break-all font-mono text-[11px]">{lastWrite.scrub.exportedValuesPath}</span>
          </p>
          {lastWrite.scrub.notRemoved.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs text-warning">
                {lastWrite.scrub.notRemoved.length} detected item(s) could NOT be removed — read this
              </summary>
              <ul className="mt-1 space-y-1 text-xs">
                {lastWrite.scrub.notRemoved.map((row) => (
                  <li key={`${row.filePath}:${row.tag}`}>
                    <span className="font-mono">{basename(row.filePath)}</span> — {row.tag}: {row.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      {retryError !== null && (
        <ErrorBanner error={retryError} context="Building the retry preview" onRetry={() => void retry()} />
      )}
      {runner.error !== null && (
        <ErrorBanner error={runner.error} context="Running the retry" onRetry={() => runner.clearError()} />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          disabled={counts.failed === 0 || (lastWrite.edits.length === 0 && lastWrite.scrub === undefined) || retrying || runner.busy}
          onClick={() => void retry()}
          title="Previews again — showing the diff first — for ONLY the files that failed."
        >
          {retrying ? 'Building the retry diff…' : `Retry failed (${counts.failed})`}
        </Button>
        {lastWrite.edits.length === 0 && counts.failed > 0 && (
          <span className="text-xs text-muted-foreground">
            This was an undo run — retry re-runs the reverse write from History instead.
          </span>
        )}
        <Button variant="outline" size="md" className="ml-auto" onClick={() => navigate('/history')}>
          Open History
        </Button>
      </div>

      {/* Per-file truth, expandable to stderr */}
      <section className="rounded-lg border border-border" aria-label="Per-file results">
        <ul className="divide-y divide-border">
          {outcome.files.map((file) => (
            <FileRow key={file.filePath} file={file} />
          ))}
        </ul>
      </section>

      {runner.progress !== null && (
        <div className="rounded-lg border border-accent/40 bg-accent-soft px-3 py-2 text-xs" role="status">
          Retry running… phase {runner.progress.phase} — {runner.progress.index} of{' '}
          {runner.progress.total}.
        </div>
      )}

      {runner.modal}
    </div>
  );
}

function CountCard({
  count,
  label,
  tone,
  hint,
}: {
  count: number;
  label: string;
  tone: 'success' | 'neutral' | 'danger';
  hint: string;
}) {
  const color =
    tone === 'success'
      ? 'text-success'
      : tone === 'danger'
        ? count > 0
          ? 'text-destructive'
          : 'text-muted-foreground'
        : 'text-foreground';
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-3 text-center">
      <div className={`text-2xl font-semibold ${color}`}>{count}</div>
      <div className="mt-0.5 text-xs font-medium">{label}</div>
      <div className="tip mt-1 text-[10px] leading-4 text-muted-foreground underline decoration-dotted cursor-help" tabIndex={0}>
        what this means
        <span className="tip-body">{hint}</span>
      </div>
    </div>
  );
}

function FileRow({ file }: { file: WriteOutcome }) {
  const [open, setOpen] = useState(false);
  const firstError = file.errors[0];
  const explanation = firstError !== undefined ? explainFailure(firstError) : null;

  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted"
      >
        <span className="text-xs" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={file.filePath}>
          {basename(file.filePath)}
        </span>
        {file.status === 'updated' && <Badge tone="success">updated{file.verified === true ? ' · verified' : ''}</Badge>}
        {file.status === 'unchanged' && <Badge tone="neutral">unchanged — nothing happened</Badge>}
        {file.status === 'failed' && <Badge tone="danger">needs attention</Badge>}
        {file.backup !== undefined && (
          <span className="hidden font-mono text-[10px] text-muted-foreground sm:inline" title={file.backup.path}>
            backup kept
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-border bg-muted/30 px-3 py-2 text-xs">
          {explanation !== null && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
              <div className="text-sm font-semibold text-destructive">{explanation.title}</div>
              <p className="mt-1">{explanation.explanation}</p>
              <p className="mt-1 text-muted-foreground">
                <span className="font-medium">Suggested fix: </span>
                {explanation.suggestedFix}
              </p>
            </div>
          )}

          {file.errors.length > 0 && (
            <div className="mt-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Engine message(s) — preserved verbatim
              </div>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-background/60 p-2 font-mono text-[11px]">
                {file.errors.join('\n')}
              </pre>
            </div>
          )}
          {file.warnings.length > 0 && (
            <div className="mt-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Warnings
              </div>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-warning">
                {file.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
          {file.backup !== undefined && (
            <p className="mt-2 text-muted-foreground">
              Backup: <span className="break-all font-mono">{file.backup.path}</span> ·{' '}
              {file.backup.sizeBytes.toLocaleString()} bytes · sha256{' '}
              <span className="font-mono">{file.backup.sha256.slice(0, 12)}…</span>
            </p>
          )}
          {file.errors.length === 0 && file.warnings.length === 0 && file.status === 'updated' && (
            <p className="text-muted-foreground">
              The write matched the preview and the backup verified — nothing to fix here.
            </p>
          )}
        </div>
      )}
    </li>
  );
}
