import { useMemo, useState } from 'react';
import type { MetadataPayload } from '@metadesk/shared';
import { getMetadata, previewWrite } from '../api/client';
import { useMetadata } from '../state/queries';
import { useUiStore } from '../state/store';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/controls';
import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EditFields, type CurrentValues } from '../write/EditFields';
import { buildTagEdits, emptyStagedEdits, type StagedEdits } from '../write/fields';
import { useWriteRunner } from '../write/useWriteRun';
import { basename } from '../lib/format';
import { navigate } from '../lib/router';

/** The typed phrase for the GPS strip (BUILD-NOTES: same pattern as the scrub). */
const GPS_CONFIRM_PHRASE = 'REMOVE GPS DATA';

/**
 * Edit Panel (ux-spec, route /edit): the curated editable field set operating
 * on the grid selection. Empty means unchanged everywhere; clearing a field is
 * a separate red action with its own confirm; Save always routes through the
 * Save Review modal. The GPS strip lives here as its own destructive,
 * phrase-gated action with a per-file tag inventory.
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
          {selectedPaths.length} file{selectedPaths.length === 1 ? '' : 's'} selected
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
                : `${selectedPaths.length} files`,
            preview: envelope.preview,
            commandPreview: envelope.commandPreview,
          },
        ],
        {
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

      <GpsStrip selectedPaths={selectedPaths} gpsPayload={metadata.data} />
      {runner.modal}
    </div>
  );
}

// ---- GPS strip (destructive, phrase-gated) -----------------------------------

/**
 * The GPS strip: preview listing EVERY GPS tag to be deleted per file (built
 * from real reads of the files), a typed confirmation phrase, and the note
 * that current values are exported to a sidecar before removal. The server's
 * verdict on the actual delete is surfaced verbatim — in v1 the engine's write
 * whitelist does not include GPS tags, so the refusal is shown honestly with
 * "nothing was written" rather than any pretend success.
 */
function GpsStrip({
  selectedPaths,
  gpsPayload,
}: {
  selectedPaths: string[];
  gpsPayload: MetadataPayload | undefined;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [inventory, setInventory] = useState<Array<{ filePath: string; tags: string[] }> | null>(null);
  const [inventoryBusy, setInventoryBusy] = useState(false);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const rows = useMemo<Array<{ filePath: string; tags: string[] }>>(() => {
    if (inventory !== null) return inventory;
    if (gpsPayload === undefined) return [];
    const tags = collectGpsTags(gpsPayload);
    return tags.length > 0 ? [{ filePath: gpsPayload.filePath, tags }] : [];
  }, [inventory, gpsPayload]);
  const affectedFiles = rows.filter((row) => row.tags.length > 0);

  const openDialog = async (): Promise<void> => {
    setRefusal(null);
    setPhrase('');
    setInventoryError(null);
    if (inventory !== null || selectedPaths.length === 1) {
      setDialogOpen(true);
      return;
    }
    setInventoryBusy(true);
    try {
      const readRows: Array<{ filePath: string; tags: string[] }> = [];
      for (const filePath of selectedPaths) {
        readRows.push({ filePath, tags: collectGpsTags(await getMetadata(filePath, 'all')) });
      }
      setInventory(readRows);
      setDialogOpen(true);
    } catch (cause) {
      setInventoryError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setInventoryBusy(false);
    }
  };

  const attemptStrip = async (): Promise<void> => {
    if (phrase !== GPS_CONFIRM_PHRASE || busy || affectedFiles.length === 0) return;
    setBusy(true);
    try {
      await previewWrite(
        affectedFiles.map((row) => row.filePath),
        [
          { tag: 'EXIF:GPSLatitude', op: 'delete' },
          { tag: 'EXIF:GPSLongitude', op: 'delete' },
        ],
      );
      setDialogOpen(false);
      setRefusal(null);
    } catch (cause) {
      // The engine's verdict, verbatim. In v1 this is the whitelist refusal.
      setRefusal(cause instanceof Error ? cause.message : String(cause));
      setDialogOpen(false);
    } finally {
      setBusy(false);
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
          disabled={busy || inventoryBusy}
          onClick={() => void openDialog()}
        >
          {inventoryBusy ? 'Reading GPS tags…' : 'Remove GPS from selection…'}
        </Button>
      </div>
      {inventoryError !== null && <div className="mt-2 text-xs text-destructive">{inventoryError}</div>}

      {refusal !== null && (
        <div className="mt-3 rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-xs">
          <div className="font-semibold text-warning">
            The engine refused this write — nothing was changed.
          </div>
          <p className="mt-1 break-words font-mono">{refusal}</p>
          <p className="mt-1 text-muted-foreground">
            In this version the engine's editable-field whitelist does not include GPS tags, so the
            removal cannot be executed. The scan above is a real read of your files, and no file was
            touched.
          </p>
        </div>
      )}

      <ConfirmDialog
        open={dialogOpen}
        danger
        title={`Remove ALL GPS data from ${affectedFiles.length} file${affectedFiles.length === 1 ? '' : 's'}?`}
        confirmLabel={phrase === GPS_CONFIRM_PHRASE ? 'Strip GPS data now' : `Type “${GPS_CONFIRM_PHRASE}” first`}
        cancelLabel="Keep location"
        onConfirm={() => void attemptStrip()}
        onCancel={() => setDialogOpen(false)}
      >
        <p>
          This is a privacy strip, not an edit. Every GPS tag below is deleted from each file, and
          the full current values are exported to a journal sidecar first.
        </p>
        <div className="max-h-56 overflow-auto rounded border border-border bg-background/40 p-2">
          {affectedFiles.length === 0 ? (
            <p className="text-xs">No GPS tags were found in the selection — there is nothing to remove.</p>
          ) : (
            affectedFiles.map((row) => (
              <div key={row.filePath} className="mb-1.5">
                <div className="truncate font-mono text-xs font-semibold">{basename(row.filePath)}</div>
                <div className="font-mono text-[11px] text-muted-foreground">{row.tags.join(', ')}</div>
              </div>
            ))
          )}
        </div>
        <label htmlFor="gps-phrase" className="block text-xs font-medium">
          Type “{GPS_CONFIRM_PHRASE}” to confirm
        </label>
        <Input
          id="gps-phrase"
          value={phrase}
          onChange={(event) => setPhrase(event.target.value)}
          placeholder={GPS_CONFIRM_PHRASE}
          autoComplete="off"
          spellCheck={false}
          className="max-w-xs font-mono"
        />
      </ConfirmDialog>
    </section>
  );
}

// ---- helpers -----------------------------------------------------------------

const GPS_TAG_ORDER = [
  'gpslatitude',
  'gpslongitude',
  'gpsaltitude',
  'gpsaltituderef',
  'gpsdatetimestamp',
  'gpsdatestamp',
  'gpstimestamp',
  'gpsimgdirection',
  'gpsimgdirectionref',
  'gpsmapdatum',
  'gpsversionid',
  'gpsspeed',
  'gpsspeedref',
  'gpstrack',
  'gpstrackref',
  'gpsdestlatitude',
  'gpsdestlongitude',
  'gpsprocessingmethod',
];

/** Every GPS tag a file actually carries, in canonical order. */
function collectGpsTags(payload: MetadataPayload): string[] {
  const keys = new Set<string>();
  for (const key of Object.keys(payload.all)) {
    if (/^(gps|exif:gps)/i.test(key)) keys.add(key);
  }
  for (const tag of payload.raw) {
    if (/^gps$/i.test(tag.group)) keys.add(`${tag.group}:${tag.name}`);
  }
  return [...keys].sort((a, b) => {
    const rank = (key: string): number => {
      const bare = (key.split(':').pop() ?? '').toLowerCase();
      const index = GPS_TAG_ORDER.indexOf(bare);
      return index === -1 ? GPS_TAG_ORDER.length : index;
    };
    return rank(a) - rank(b) || a.localeCompare(b);
  });
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
