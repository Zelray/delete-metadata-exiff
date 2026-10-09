import { useMemo, useState } from 'react';
import type { MetadataPayload } from '@metadesk/shared';
import { previewGpsStrip, previewWrite } from '../api/client';
import { useMetadata } from '../state/queries';
import { useUiStore } from '../state/store';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';
import { EditFields, type CurrentValues } from '../write/EditFields';
import { buildTagEdits, emptyStagedEdits, type StagedEdits } from '../write/fields';
import { useWriteRunner, type WriteRunner } from '../write/useWriteRun';
import { basename } from '../lib/format';
import { navigate } from '../lib/router';

/**
 * Edit Panel (ux-spec, route /edit): the curated editable field set operating
 * on the grid selection. Empty means unchanged everywhere; clearing a field is
 * a separate red action with its own confirm; Save always routes through the
 * Save Review modal. The GPS strip lives here as its own destructive,
 * phrase-gated action — gated through the same Save Review modal (the phrase
 * is the SERVER-MINTED one; only the typed phrase is ever sent).
 */
export function EditPanel() {
  const selectedPaths = useUiStore((s) => s.selectedPaths);
  const [staged, setStaged] = useState<StagedEdits>(emptyStagedEdits);

  if (selectedPaths.length === 0) {
    return (
      <div className="p-6">
        <EmptyState title="Nothing is selected">
          Pick one or more files in the grid first — the Edit panel changes the files you have
          selected, never the whole folder by accident.
        </EmptyState>
        <div className="mt-4 text-center">
          <Button variant="primary" size="sm" onClick={() => navigate('/browse')}>
            Go to the grid
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Edit</h1>
        <Badge tone="accent">
          {selectedPaths.length.toLocaleString()} file{selectedPaths.length === 1 ? '' : 's'} selected
        </Badge>
      </header>

      {selectedPaths.length <= 3 && (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {selectedPaths.map((path) => (
            <li key={path} className="truncate font-mono" title={path}>
              {path}
            </li>
          ))}
        </ul>
      )}

      <EditSelection staged={staged} setStaged={setStaged} selectedPaths={selectedPaths} />
    </div>
  );
}

function EditSelection({
  staged,
  setStaged,
  selectedPaths,
}: {
  staged: StagedEdits;
  setStaged: (next: StagedEdits) => void;
  selectedPaths: string[];
}) {
  const single = selectedPaths.length === 1 ? (selectedPaths[0] ?? null) : null;
  const metadata = useMetadata(single, 'simple');
  const current = useMemo(
    () => (metadata.data !== undefined ? currentFromPayload(metadata.data) : undefined),
    [metadata.data],
  );

  const runner = useWriteRunner();
  const edits = useMemo(() => buildTagEdits(staged), [staged]);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<unknown>(null);

  const review = async (): Promise<void> => {
    if (edits.length === 0 || previewing) return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      const envelope = await previewWrite(
        selectedPaths,
        edits,
        staged.timezone === 'none' ? undefined : staged.timezone,
      );
      runner.review(
        [
          {
            label:
              selectedPaths.length === 1
                ? basename(selectedPaths[0] ?? '')
                : `${selectedPaths.length.toLocaleString()} files`,
            evidence: 'previewed',
            preview: envelope.preview,
            commandPreview: envelope.commandPreview,
          },
        ],
        {
          kind: 'edits',
          title: 'Save review — check every change before you allow it',
          edits,
          ...(staged.timezone !== 'none' ? { timezone: staged.timezone } : {}),
        },
      );
    } catch (cause) {
      setPreviewError(cause);
    } finally {
      setPreviewing(false);
    }
  };

  const changedCount = countChangedFields(staged);

  return (
    <div className="space-y-4">
      {previewError !== null && (
        <ErrorBanner error={previewError} context="Building the preview" onRetry={() => void review()} />
      )}
      {runner.error !== null && (
        <ErrorBanner error={runner.error} context="Running the write" onRetry={() => runner.clearError()} />
      )}

      <EditFields
        staged={staged}
        onChange={setStaged}
        current={current}
        scopeNote={
          single === null
            ? 'Current values may differ per file — the review shows the same edit for every selected file.'
            : undefined
        }
      />

      {/* Change tray: 'N fields changed' with per-field revert and Undo all */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
        <span className="text-sm font-medium">
          {changedCount === 0
            ? 'Nothing changed yet — an empty field means leave unchanged.'
            : `${changedCount} field${changedCount === 1 ? '' : 's'} changed`}
        </span>
        {(changedCount > 0 || staged.deletes.length > 0) && (
          <Button size="sm" variant="ghost" onClick={() => setStaged(emptyStagedEdits())}>
            Undo all staged changes
          </Button>
        )}
        <Button
          variant="primary"
          className="ml-auto"
          disabled={edits.length === 0 || previewing || runner.busy}
          onClick={() => void review()}
          title="Every save shows the full diff and the exact command first."
        >
          {previewing ? 'Building the diff…' : 'Review & Save'}
        </Button>
      </div>

      {runner.progress !== null && (
        <div className="rounded-lg border border-accent/40 bg-accent-soft px-3 py-2 text-xs" role="status">
          Writing… phase {runner.progress.phase} — {runner.progress.index} of {runner.progress.total}. Nothing
          else runs while a write is in progress.
        </div>
      )}

      <GpsStrip selectedPaths={selectedPaths} runner={runner} />
      {runner.modal}
    </div>
  );
}

// ---- GPS strip (destructive, phrase-gated through the Save Review modal) -----

/**
 * The GPS strip: the server's destructive channel on the generic write routes.
 * The preview is the authoritative read: it lists EVERY GPS tag to be deleted
 * per file with its current value, the sidecar export is written before
 * anything can run, and the execute is gated on the typed phrase server-side.
 * This component only fetches that preview and hands it to the runner — the
 * gate, the typed phrase, the refusal surface and the execute all live in the
 * Save Review modal / useWriteRun. The phrase displayed is the SERVER-MINTED
 * one (preview.destructive.confirmationPhrase); no client constant exists.
 */
function GpsStrip({ selectedPaths, runner }: { selectedPaths: string[]; runner: WriteRunner }) {
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const openDialog = async (): Promise<void> => {
    setPreviewError(null);
    setPreviewBusy(true);
    try {
      const preview = await previewGpsStrip(selectedPaths);
      // Land on the standard Results report after success: three-valued
      // per-file truth, the sidecar export path (from THIS preview, HEAD
      // parity), and the honest not-removed list. `edits` stay empty so Retry
      // is disabled (a strip retry must re-preview through the GPS channel,
      // not the plain edit channel) — the inert-Retry quirk, kept as-is.
      runner.review(
        [
          {
            label: 'GPS tags to delete',
            evidence: 'previewed',
            preview: preview.preview,
            commandPreview: preview.commandPreview,
          },
        ],
        {
          kind: 'preview',
          title: `Remove GPS — ${selectedPaths.length} file${selectedPaths.length === 1 ? '' : 's'}`,
          destructive: { confirmationPhrase: preview.destructive.confirmationPhrase },
          destructiveNote:
            'This is a privacy strip, not an edit: every GPS tag is deleted from each file. The current values are exported to a journal sidecar first, so the coordinates survive even if the backups are later deleted.',
          confirmLabel: 'Strip GPS data now',
          cannotRemove: preview.notRemoved,
          scrubExtras: {
            exportedValuesPath: preview.exportedValuesPath,
            notRemoved: preview.notRemoved,
          },
        },
      );
    } catch (cause) {
      setPreviewError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPreviewBusy(false);
    }
  };

  return (
    <section className="rounded-lg border border-destructive/40 px-3 py-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-destructive">Remove GPS (destructive)</span>
        <Badge tone="danger">typed confirmation required</Badge>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Deletes every GPS tag from the selected files — location, altitude, direction, timestamps.
        Before anything is removed, the current values are exported to a sidecar file beside the
        journal, so the coordinates survive even if backups are later deleted. Setting new GPS
        values is not offered in this version.
      </p>
      <div className="mt-2">
        <Button
          variant="outline"
          size="sm"
          className="border-destructive/60 text-destructive"
          disabled={runner.busy || previewBusy}
          onClick={() => void openDialog()}
        >
          {previewBusy ? 'Reading GPS tags…' : 'Remove GPS from selection…'}
        </Button>
      </div>
      {previewError !== null && <div className="mt-2 text-xs text-destructive">{previewError}</div>}
    </section>
  );
}

function currentFromPayload(payload: MetadataPayload): CurrentValues {
  const s = payload.simple;
  return {
    ...(s.title !== undefined ? { title: s.title } : {}),
    ...(s.description !== undefined ? { description: s.description } : {}),
    keywords: s.keywords,
    ...(s.rating !== undefined ? { rating: s.rating } : {}),
    ...(s.dateTaken !== undefined ? { dateTaken: s.dateTakenRaw ?? s.dateTaken } : {}),
    ...(s.copyright !== undefined ? { copyright: s.copyright } : {}),
    ...(s.creator !== undefined ? { creator: s.creator } : {}),
  };
}

function countChangedFields(staged: StagedEdits): number {
  let count = 0;
  const setFields = [
    staged.title.trim() !== '' && !staged.deletes.includes('title'),
    staged.description.trim() !== '' && !staged.deletes.includes('description'),
    (staged.addKeywords.length > 0 || staged.removeKeywords.length > 0) &&
      !staged.deletes.includes('keywords'),
    staged.rating !== '' && !staged.deletes.includes('rating'),
    staged.dateTaken !== '' && !staged.deletes.includes('dateTaken'),
    staged.copyright.trim() !== '' && !staged.deletes.includes('copyright'),
    staged.creator.trim() !== '' && !staged.deletes.includes('creator'),
  ];
  count = setFields.filter(Boolean).length;
  for (const key of staged.deletes) {
    // Armed deletes count as changes of their own unless the field is being set.
    const alsoSet =
      (key === 'title' && staged.title.trim() !== '') ||
      (key === 'description' && staged.description.trim() !== '') ||
      (key === 'keywords' && (staged.addKeywords.length > 0 || staged.removeKeywords.length > 0)) ||
      (key === 'rating' && staged.rating !== '') ||
      (key === 'dateTaken' && staged.dateTaken !== '') ||
      (key === 'copyright' && staged.copyright.trim() !== '') ||
      (key === 'creator' && staged.creator.trim() !== '');
    if (!alsoSet) count += 1;
  }
  return count;
}
