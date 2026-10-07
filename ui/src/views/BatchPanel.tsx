import { useMemo, useState } from 'react';
import type { MetadataPayload } from '@metadesk/shared';
import { getMetadata, previewWrite } from '../api/client';
import { useUiStore } from '../state/store';
import { navigate } from '../lib/router';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input, Checkbox } from '../components/ui/controls';
import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';
import { ConfirmDialog } from '../components/ConfirmDialog';
import type { PreviewGroup } from '../components/SaveReviewModal';
import { EditFields } from '../write/EditFields';
import {
  TIMEZONES,
  buildTagEdits,
  emptyStagedEdits,
  shiftExifDate,
  type ShiftUnit,
  type StagedEdits,
} from '../write/fields';
import { useWriteRunner } from '../write/useWriteRun';
import type { TagEdit } from '../write/types';

/** Server read cap the date-shift pre-read must honor honestly. */
const DATE_SHIFT_CAP = 200;

const DATE_TAGS = ['EXIF:DateTimeOriginal', 'EXIF:CreateDate', 'EXIF:ModifyDate'] as const;

/**
 * Batch Apply Panel (ux-spec, route /batch): one set of edits applied to many
 * files with an honest preview. Scope is the selection or the filtered folder;
 * plain-English condition filters narrow it; the date-shift tool previews
 * old → new across DateTimeOriginal + CreateDate + ModifyDate together (one
 * preview group per distinct current-date set); every execution streams
 * chunk progress.
 */
export function BatchPanel() {
  const scanResult = useUiStore((s) => s.scanResult);
  const selectedPaths = useUiStore((s) => s.selectedPaths);
  const searchText = useUiStore((s) => s.searchText);

  const [staged, setStaged] = useState<StagedEdits>(emptyStagedEdits);
  const [scope, setScope] = useState<'selection' | 'filtered'>('selection');
  const [onlyWithGps, setOnlyWithGps] = useState(false);
  const [onlyMissingCopyright, setOnlyMissingCopyright] = useState(false);

  const [shiftEnabled, setShiftEnabled] = useState(false);
  const [shiftDirection, setShiftDirection] = useState<1 | -1>(1);
  const [shiftAmount, setShiftAmount] = useState('2');
  const [shiftUnit, setShiftUnit] = useState<ShiftUnit>('hours');
  const [shiftTimezone, setShiftTimezone] = useState('none');

  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<unknown>(null);
  const [buildNote, setBuildNote] = useState<string | null>(null);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);

  const runner = useWriteRunner();

  const entries = scanResult?.entries ?? [];
  const filtered = useMemo(() => {
    const needle = searchText.trim().toLowerCase();
    return entries.filter((entry) => needle === '' || entry.name.toLowerCase().includes(needle));
  }, [entries, searchText]);

  const inScope = useMemo(() => {
    const base = scope === 'selection' ? selectedPaths : filtered.map((entry) => entry.path);
    return base.filter((path) => {
      const entry = entries.find((e) => e.path === path);
      if (entry === undefined) return true;
      if (onlyWithGps && !entry.warnings.includes('badge:gps-present')) return false;
      if (onlyMissingCopyright && entry.warnings.includes('badge:copyright-present')) return false;
      return true;
    });
  }, [scope, selectedPaths, filtered, entries, onlyWithGps, onlyMissingCopyright]);

  const fieldEdits = useMemo(() => buildTagEdits(staged), [staged]);
  const shiftAmountValue = Number(shiftAmount);
  const shift = {
    amount: (Number.isFinite(shiftAmountValue) ? shiftAmountValue : 0) * shiftDirection,
    unit: shiftUnit,
  };
  const shiftValid =
    shiftEnabled && shiftAmount.trim() !== '' && Number.isFinite(shiftAmountValue) && shiftAmountValue !== 0;
  const hasWork = fieldEdits.length > 0 || shiftValid;

  /** Build the previews: one for the uniform field edits, plus one per
   * distinct current-date group when a shift is staged. */
  const buildPreview = async (): Promise<void> => {
    if (!hasWork || building) return;
    setBuilding(true);
    setBuildError(null);
    setBuildNote(null);
    try {
      const timezone = staged.timezone !== 'none' ? staged.timezone : undefined;
      const groups: Array<{ label: string; files: string[]; edits: TagEdit[] }> = [];

      if (shiftValid) {
        if (inScope.length > DATE_SHIFT_CAP) {
          throw new Error(
            `Date shift reads every file's current dates first, so it is capped at ${DATE_SHIFT_CAP} files ` +
              `(your scope is ${inScope.length}). Narrow the scope — the filter chips help — and run the rest after.`,
          );
        }
        const noDates: string[] = [];
        const byEdits = new Map<string, { files: string[]; edits: TagEdit[] }>();
        for (const filePath of inScope) {
          const payload = await getMetadata(filePath, 'all');
          const shiftEdits = shiftEditsFor(payload, shift, shiftTimezone);
          if (shiftEdits.length === 0) {
            noDates.push(filePath);
            continue;
          }
          const combined = [...fieldEdits, ...shiftEdits];
          if (combined.length === 0) continue;
          const key = JSON.stringify(combined);
          const existing = byEdits.get(key);
          if (existing === undefined) byEdits.set(key, { files: [filePath], edits: combined });
          else existing.files.push(filePath);
        }
        for (const group of byEdits.values()) {
          groups.push({
            label: `Date shift (${group.files.length} file${group.files.length === 1 ? '' : 's'}, from ${firstShiftLabel(group.edits)})`,
            files: group.files,
            edits: group.edits,
          });
        }
        if (noDates.length > 0) {
          setBuildNote(
            `${noDates.length} file${noDates.length === 1 ? '' : 's'} in scope have no readable dates, so the shift skips ` +
              (fieldEdits.length > 0 ? 'them — they still receive the field changes.' : 'them entirely.'),
          );
          if (fieldEdits.length > 0) {
            groups.push({ label: `Field changes (${noDates.length} files without dates)`, files: noDates, edits: fieldEdits });
          }
        }
      } else if (fieldEdits.length > 0) {
        groups.push({
          label: scope === 'selection' ? `${inScope.length} selected file(s)` : `${inScope.length} filtered file(s)`,
          files: inScope,
          edits: fieldEdits,
        });
      }

      if (groups.length === 0) {
        throw new Error('Nothing to write: the scope is empty after the filters.');
      }

      const previewGroups: PreviewGroup[] = [];
      for (const group of groups) {
        const envelope = await previewWrite(group.files, group.edits, timezone);
        previewGroups.push({
          label: group.label,
          evidence: 'previewed',
          preview: envelope.preview,
          commandPreview: envelope.commandPreview,
        });
      }
      runner.review(previewGroups, {
        kind: 'edits',
        title: 'Batch review — check every change before you allow it',
        edits: fieldEdits,
        ...(timezone !== undefined ? { timezone } : {}),
      });
    } catch (cause) {
      setBuildError(cause);
    } finally {
      setBuilding(false);
    }
  };

  if (scanResult === null) {
    return (
      <div className="p-6">
        <EmptyState title="No folder is open">
          Batch apply works on the folder in the grid. Open a folder in Browse first.
        </EmptyState>
        <div className="mt-4 text-center">
          <Button variant="primary" size="sm" onClick={() => navigate('/')}>
            Go to Browse
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Batch apply</h1>
        <Badge tone="accent">
          {inScope.length.toLocaleString()} in scope
        </Badge>
        {scope === 'selection' && selectedPaths.length > 0 && (
          <Badge tone="neutral">{selectedPaths.length} selected</Badge>
        )}
      </header>

      {buildError !== null && (
        <ErrorBanner error={buildError} context="Building the preview" />
      )}
      {buildNote !== null && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs">{buildNote}</div>
      )}
      {runner.error !== null && (
        <ErrorBanner error={runner.error} context="Running the write" onRetry={() => runner.clearError()} />
      )}

      {/* Scope picker + plain-English condition filters */}
      <section className="rounded-lg border border-border px-3 py-3">
        <h2 className="mb-2 text-sm font-semibold">Scope</h2>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="scope"
              checked={scope === 'selection'}
              onChange={() => setScope('selection')}
              disabled={selectedPaths.length === 0}
            />
            Current selection ({selectedPaths.length})
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="scope"
              checked={scope === 'filtered'}
              onChange={() => setScope('filtered')}
            />
            All filtered files ({filtered.length.toLocaleString()})
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-4 text-xs">
          <span className="flex items-center gap-1.5">
            <Checkbox
              checked={onlyWithGps}
              onChange={setOnlyWithGps}
              ariaLabel="Only files with GPS"
            />
            Only files with GPS
          </span>
          <span className="flex items-center gap-1.5">
            <Checkbox
              checked={onlyMissingCopyright}
              onChange={setOnlyMissingCopyright}
              ariaLabel="Only files missing Copyright"
            />
            Only files missing Copyright
          </span>
          <span className="text-muted-foreground">
            filters use the folder scan's badge data (GPS/copyright presence as scanned)
          </span>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          RAW files accept only the safe whitelisted fields — which is everything this panel
          offers. Group deletes stay hard-blocked.
        </p>
      </section>

      <EditFields
        staged={staged}
        onChange={setStaged}
        showDateTaken={false}
        scopeNote="Same field set as the Edit panel — keywords ADD to each file's existing list."
      />

      {/* Batch-only tool: shift dates across all three date tags together */}
      <section className="rounded-lg border border-border px-3 py-3">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          Shift dates
          <span className="text-xs font-normal text-muted-foreground">
            moves DateTimeOriginal, CreateDate, and ModifyDate together so they never drift apart
          </span>
        </h2>
        <Checkbox
          checked={shiftEnabled}
          onChange={setShiftEnabled}
          ariaLabel="Enable date shift"
        />{' '}
        <span className="text-sm">Shift dates by…</span>
        {shiftEnabled && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <select
              value={shiftDirection}
              onChange={(event) => setShiftDirection(event.target.value === '-1' ? -1 : 1)}
              aria-label="Shift direction"
              className="h-8 rounded-md border border-input bg-card px-2 text-xs"
            >
              <option value="1">Forward (later)</option>
              <option value="-1">Backward (earlier)</option>
            </select>
            <Input
              type="number"
              min={0}
              value={shiftAmount}
              onChange={(event) => setShiftAmount(event.target.value)}
              aria-label="Shift amount"
              className="h-8 w-20 text-sm"
            />
            <select
              value={shiftUnit}
              onChange={(event) => setShiftUnit(event.target.value as ShiftUnit)}
              aria-label="Shift unit"
              className="h-8 rounded-md border border-input bg-card px-2 text-xs"
            >
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
            </select>
            <select
              value={shiftTimezone}
              onChange={(event) => setShiftTimezone(event.target.value)}
              aria-label="Timezone marker for shifted dates"
              className="h-8 rounded-md border border-input bg-card px-2 text-xs"
            >
              {TIMEZONES.map((tz) => (
                <option key={tz.id} value={tz.id}>
                  {tz.label}
                </option>
              ))}
            </select>
            <span className="text-xs text-muted-foreground">
              preview shows old → new for all three tags, per file
            </span>
          </div>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Reading current dates is capped at {DATE_SHIFT_CAP} files per shift; files without
          readable dates are listed honestly, never silently skipped.
        </p>
      </section>

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
        <span className="text-sm font-medium">
          {hasWork
            ? `${inScope.length} file${inScope.length === 1 ? '' : 's'} will be previewed.`
            : 'Stage field changes or a date shift to begin.'}
        </span>
        <Button
          variant="primary"
          className="ml-auto"
          disabled={!hasWork || building || runner.busy || inScope.length === 0}
          onClick={() => void buildPreview()}
          title="Builds the read-only diff first — nothing is written until you approve the review."
        >
          {building ? 'Reading files and building the diff…' : 'Preview batch'}
        </Button>
      </div>

      {runner.progress !== null && (
        <div className="rounded-lg border border-accent/40 bg-accent-soft px-3 py-2 text-xs" role="status">
          <div className="flex flex-wrap items-center gap-2">
            <div className="font-medium">Writing — phase {runner.progress.phase}</div>
            {runner.activeBatchId !== null && (
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                disabled={runner.cancelState?.status === 'requested'}
                onClick={() => setCancelConfirmOpen(true)}
                title="Stops the batch between files — already-written files keep their verified backups."
              >
                {runner.cancelState?.status === 'requested' ? 'Cancelling…' : 'Cancel this batch'}
              </Button>
            )}
          </div>
          <div className="mt-1">
            {runner.progress.index} of {runner.progress.total} files processed. MetaDesk never
            hard-kills a write: this runs to completion chunk by chunk, and the Results report opens
            when it finishes.
          </div>
          {runner.cancelState !== null && (
            <div className="mt-1 text-muted-foreground" role="status">
              {runner.cancelState.status === 'requested'
                ? runner.cancelState.note
                : `Cancel was not accepted: ${runner.cancelState.note}`}
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={cancelConfirmOpen}
        danger
        title="Cancel this batch?"
        confirmLabel="Request cancel"
        cancelLabel="Keep writing"
        onConfirm={() => {
          setCancelConfirmOpen(false);
          void runner.requestCancel();
        }}
        onCancel={() => setCancelConfirmOpen(false)}
      >
        <p>
          The file being written right now finishes safely with its full backup and verification.
          Already-written files keep their verified backups; the rest will not be attempted, and
          the Results report lists every one of them honestly.
        </p>
      </ConfirmDialog>

      {runner.modal}
    </div>
  );
}

/** Build this file's date-shift set edits from its read payload. */
function shiftEditsFor(
  payload: MetadataPayload,
  shift: { amount: number; unit: ShiftUnit },
  timezone: string,
): TagEdit[] {
  const edits: TagEdit[] = [];
  for (const tag of DATE_TAGS) {
    const value = findDateValue(payload, tag);
    if (value === undefined) continue;
    const shifted = shiftExifDate(value, shift, timezone);
    if (shifted === null || shifted === value) continue;
    edits.push({ tag, op: 'set', value: shifted });
  }
  return edits;
}

/** Find a date tag's stored value across the group families exiftool reports. */
function findDateValue(payload: MetadataPayload, tag: string): string | undefined {
  const bare = (tag.split(':')[1] ?? '').toLowerCase();
  for (const [key, value] of Object.entries(payload.all)) {
    const colon = key.indexOf(':');
    const group = (colon > 0 ? key.slice(0, colon) : '').toLowerCase();
    const name = (colon > 0 ? key.slice(colon + 1) : key).toLowerCase();
    if (name !== bare) continue;
    if (['exif', 'ifd0', 'exififd', 'subifd', 'interopifd'].includes(group)) return value;
  }
  return undefined;
}

/** Label a shift group by its first old → new pair. */
function firstShiftLabel(edits: TagEdit[]): string {
  const first = edits[0];
  if (first === undefined || first.value === undefined) return 'dates';
  return `from ${first.value.slice(0, 19)}`;
}
