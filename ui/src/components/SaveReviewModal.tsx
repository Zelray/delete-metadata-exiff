import { useMemo, useState } from 'react';
import type { DetectedPreview, TagDiff, WritePreview, WritePreviewFile } from '../write/types';
import { chunkEstimate } from '../write/fields';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Input } from './ui/controls';
import { CommandPreviewChips } from './CommandPreviewChips';
import { basename } from '../lib/format';
import { copyText } from '../lib/clipboard';

/**
 * One preview the modal gates, and the fidelity it can honestly claim:
 * 'previewed' groups carry the server's exact per-file diff and argv (the
 * ordinary write channel); 'detected' groups carry a scan projection — the
 * destructive wipe re-detects from a fresh scan before it runs, so no exact
 * command exists and the exact-change claims are suppressed BY MECHANISM.
 */
export type PreviewGroup =
  | {
      label: string;
      /** The server previewed the exact change — argv + command preview are true. */
      evidence: 'previewed';
      preview: WritePreview;
      commandPreview: string[];
    }
  | {
      label: string;
      /** Detection-grade fidelity: rows are what the scan found, values as-scanned. */
      evidence: 'detected';
      detected: DetectedPreview;
    };

/** The file shape both group kinds share (argv exists only on 'previewed'). */
type GateFile = Pick<WritePreviewFile, 'filePath' | 'diffs' | 'warnings' | 'noop'>;

function groupFiles(group: PreviewGroup): GateFile[] {
  return group.evidence === 'previewed' ? group.preview.files : group.detected.files;
}

function groupBlockers(group: PreviewGroup): string[] {
  return group.evidence === 'previewed' ? group.preview.blockers : group.detected.blockers;
}

function groupKey(group: PreviewGroup): string {
  return group.evidence === 'previewed' ? group.preview.previewId : group.detected.detectionId;
}

export interface SaveReviewModalProps {
  open: boolean;
  title: string;
  groups: PreviewGroup[];
  /** When set, the confirm button stays disabled until this phrase is typed. */
  destructivePhrase?: string | null;
  destructiveNote?: string;
  /** true while the execute is running (progress lives outside the modal). */
  busy?: boolean;
  /**
   * The server's refusal of the last confirm attempt, verbatim — rendered
   * INSIDE this dialog, because the scrim occludes every view-level banner.
   * The modal stays open with its groups intact so a retype-and-retry can
   * re-POST the same preview.
   */
  refusal?: string | null;
  /** Overrides the computed confirm-button label (destructive flows keep their copy). */
  confirmLabel?: string;
  /** Detected items that will NOT be removed — stated at the consent moment. */
  cannotRemove?: Array<{ filePath: string; tag: string; reason: string }>;
  /**
   * true only when the execute actually streams chunk progress — the
   * "progress streams per chunk" sentence is a lie otherwise, so the chunk
   * note renders ONLY when this is set.
   */
  streamed?: boolean;
  /** Carries the TYPED phrase — the payload, never a client-held constant. */
  onConfirm: (phrase: string) => void;
  onCancel: () => void;
}

const BACKUP_STATEMENT =
  'Each file’s current version is saved as filename_original before anything changes, and that backup is hash-verified before a file may be counted as updated. Undo is available immediately in History.';

/**
 * THE mandatory gate before any write (ux-spec Save Review Modal): the old →
 * new table per tag per file, blockers rendered distinctly (they disable the
 * execute button), the exact exiftool arguments (exact-change groups only),
 * the backup statement, the honest "no change needed" list, and — only for
 * destructive flows — the typed confirmation phrase. Cancel is the default
 * button; nothing here can write.
 */
export function SaveReviewModal({
  open,
  title,
  groups,
  destructivePhrase = null,
  destructiveNote,
  busy = false,
  refusal = null,
  confirmLabel,
  cannotRemove,
  streamed = false,
  onConfirm,
  onCancel,
}: SaveReviewModalProps) {
  const [filter, setFilter] = useState<'all' | 'changing' | 'noop'>('all');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [phrase, setPhrase] = useState('');
  const [copied, setCopied] = useState(false);

  const visibleGroups = useMemo(
    () => groups.filter((g) => groupFiles(g).length > 0),
    [groups],
  );

  const counts = useMemo(() => {
    let changing = 0;
    let noop = 0;
    let warnings = 0;
    let blockers: string[] = [];
    let files = 0;
    for (const group of visibleGroups) {
      for (const file of groupFiles(group)) {
        files += 1;
        if (file.noop || file.diffs.every((d) => d.kind === 'unchanged')) noop += 1;
        else changing += 1;
        warnings += file.warnings.length;
      }
      blockers = blockers.concat(groupBlockers(group));
    }
    return { changing, noop, warnings, blockers: [...new Set(blockers)], files };
  }, [visibleGroups]);

  const chunks = useMemo(
    () => visibleGroups.reduce((sum, g) => sum + chunkEstimate(groupFiles(g).length), 0),
    [visibleGroups],
  );

  const phraseOk = destructivePhrase === null || phrase === destructivePhrase;
  const canExecute = !busy && phraseOk && counts.blockers.length === 0 && counts.files > 0;

  if (!open) return null;

  const computedLabel =
    destructivePhrase !== null
      ? `Remove metadata from ${counts.changing} file${counts.changing === 1 ? '' : 's'}`
      : `Write ${counts.changing} file${counts.changing === 1 ? '' : 's'}`;
  const confirmLabel_ = confirmLabel ?? computedLabel;
  const detected = visibleGroups.some((group) => group.evidence === 'detected');

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div className="flex max-h-[92vh] w-full max-w-3xl flex-col rounded-lg border border-border bg-card shadow-xl">
        <header className="border-b border-border px-5 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {detected
              ? 'Nothing has been written yet. These are the items the scan detected — the removal re-scans every file just before it runs, so it may remove more than listed here. Read it, then decide.'
              : 'Nothing has been written yet. This is the exact change MetaDesk will make — read it, then decide.'}
          </p>
        </header>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-3 text-sm">
          {/* The server's refusal of the last confirm, verbatim — inside the
              dialog, where the scrim cannot hide it (occlusion fix). */}
          {refusal !== null && (
            <div className="mb-3 rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2" role="alert">
              <div className="text-xs font-semibold text-destructive">
                This was refused — nothing was changed.
              </div>
              <p className="mt-1 break-words font-mono text-xs">{refusal}</p>
            </div>
          )}

          {/* Blockers: they disable the execute button, rendered distinctly */}
          {counts.blockers.length > 0 && (
            <div className="mb-3 rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-destructive">
                Blocked — these must be fixed before anything can be written
              </div>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
                {counts.blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Per-file summary tabs */}
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="font-semibold">{counts.files} file{counts.files === 1 ? '' : 's'} in this write</span>
            <Badge tone="accent">{counts.changing} will change</Badge>
            <Badge tone="neutral">{counts.noop} no change needed</Badge>
            {counts.warnings > 0 && <Badge tone="warning">{counts.warnings} warning(s)</Badge>}
            <span className="ml-auto flex rounded-md border border-border" role="group" aria-label="Show files">
              {(
                [
                  ['all', 'All'],
                  ['changing', 'Changing'],
                  ['noop', 'No change'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                  className={`px-2 py-0.5 text-xs ${
                    filter === value
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-muted'
                  }`}
                >
                  {label}
                </button>
              ))}
            </span>
          </div>

          {visibleGroups.map((group) => (
            <GroupSection
              key={`${group.label}:${groupKey(group)}`}
              group={group}
              filter={filter}
              expanded={expanded}
              setExpanded={setExpanded}
              copied={copied}
              setCopied={setCopied}
            />
          ))}

          {/* Backup statement — always, in every write path */}
          <div className="mt-4 rounded-md border border-success/40 bg-success/5 px-3 py-2 text-xs">
            <span className="font-semibold text-success">Backup first: </span>
            {BACKUP_STATEMENT}
          </div>
          {streamed && chunks > 1 && (
            <p className="mt-2 text-xs text-muted-foreground">
              This batch runs in {chunks} chunks of up to 200 files; progress streams per chunk and
              a failed file never stops the others.
            </p>
          )}

          {/* Detected items that will NOT be removed — honest at the consent
              moment (bounded; the full list lands on Results / the findings). */}
          {cannotRemove !== undefined && cannotRemove.length > 0 && (
            <div className="mt-4 rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-xs">
              <span className="font-semibold text-warning">
                {cannotRemove.length} detected item{cannotRemove.length === 1 ? '' : 's'} can NOT be
                removed by this version — they will still be in the files:
              </span>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {cannotRemove.slice(0, 8).map((row) => (
                  <li key={`${row.filePath}:${row.tag}`} className="break-words">
                    <span className="font-mono">{basename(row.filePath)}</span> —{' '}
                    <span className="font-mono font-semibold">{row.tag}</span>: {row.reason}
                  </li>
                ))}
              </ul>
              {cannotRemove.length > 8 && (
                <p className="mt-1 text-muted-foreground">
                  … and {cannotRemove.length - 8} more — full list in Results.
                </p>
              )}
            </div>
          )}

          {destructivePhrase !== null && (
            <div className="mt-4 rounded-md border border-destructive/50 bg-destructive/5 px-3 py-3">
              <div className="text-sm font-semibold text-destructive">Destructive and one-way once backups are gone</div>
              {destructiveNote !== undefined && (
                <p className="mt-1 text-xs text-muted-foreground">{destructiveNote}</p>
              )}
              <label htmlFor="destructive-phrase" className="mt-2 block text-xs font-medium">
                Type “{destructivePhrase}” to confirm
              </label>
              <Input
                id="destructive-phrase"
                value={phrase}
                onChange={(event) => setPhrase(event.target.value)}
                placeholder={destructivePhrase}
                autoComplete="off"
                spellCheck={false}
                className="mt-1 max-w-xs font-mono"
              />
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="secondary" onClick={onCancel} disabled={busy} autoFocus>
            Cancel
          </Button>
          <Button
            variant={destructivePhrase !== null ? 'danger' : 'primary'}
            onClick={() => onConfirm(phrase)}
            disabled={!canExecute}
            title={
              counts.blockers.length > 0
                ? 'Fix the blockers first — nothing can be written while they stand.'
                : destructivePhrase !== null && !phraseOk
                  ? `Type "${destructivePhrase}" to enable.`
                  : undefined
            }
          >
            {busy ? 'Working…' : confirmLabel_}
          </Button>
        </footer>
      </div>
    </div>
  );
}

function GroupSection({
  group,
  filter,
  expanded,
  setExpanded,
  copied,
  setCopied,
}: {
  group: PreviewGroup;
  filter: 'all' | 'changing' | 'noop';
  expanded: Record<string, boolean>;
  setExpanded: (next: Record<string, boolean>) => void;
  copied: boolean;
  setCopied: (v: boolean) => void;
}) {
  const allFiles = groupFiles(group);
  const commandPreview = group.evidence === 'previewed' ? group.commandPreview : [];
  // Per-file argv exists ONLY on previewed groups — the suppression mechanism
  // for the "Exact command" blocks (a detected scan has nothing to show).
  const perFileArgv = new Map(
    group.evidence === 'previewed'
      ? group.preview.files.map((file) => [file.filePath, file.argv] as const)
      : [],
  );
  const files = allFiles.filter((file) => {
    const noop = file.noop || file.diffs.every((d) => d.kind === 'unchanged');
    return filter === 'all' || (filter === 'noop' ? noop : !noop);
  });

  return (
    <section className="mb-4">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{group.label}</h3>
        <span className="text-xs text-muted-foreground">{allFiles.length} file(s)</span>
      </div>

      {files.length === 0 ? (
        <p className="rounded border border-border px-3 py-2 text-xs text-muted-foreground">
          No files in this view.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {files.map((file) => {
            const key = `${groupKey(group)}:${file.filePath}`;
            const isOpen = expanded[key] === true;
            const noop = file.noop || file.diffs.every((d) => d.kind === 'unchanged');
            return (
              <li key={key}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setExpanded({ ...expanded, [key]: !isOpen })}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted"
                >
                  <span className="text-xs" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                  <span className="min-w-0 flex-1 truncate text-xs font-medium" title={file.filePath}>
                    {basename(file.filePath)}
                  </span>
                  {noop ? (
                    <Badge tone="neutral">no change needed</Badge>
                  ) : (
                    <Badge tone="accent">{countKinds(file.diffs)} change(s)</Badge>
                  )}
                  {file.warnings.length > 0 && <Badge tone="warning">{file.warnings.length} warning(s)</Badge>}
                </button>

                {isOpen && (
                  <div className="border-t border-border bg-muted/30 px-3 py-2">
                    {noop ? (
                      <p className="text-xs text-muted-foreground">
                        Every affected tag already holds the requested value — writing would change
                        nothing, so this file is listed honestly rather than counted as updated.
                      </p>
                    ) : (
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-left text-muted-foreground">
                            <th className="py-1 pr-2 font-medium">Tag</th>
                            <th className="py-1 pr-2 font-medium">Now</th>
                            <th className="py-1 pr-2 font-medium">After write</th>
                            <th className="py-1 font-medium">Change</th>
                          </tr>
                        </thead>
                        <tbody>
                          {file.diffs.map((diff) => (
                            <DiffRow key={`${diff.tag}:${diff.kind}`} diff={diff} />
                          ))}
                        </tbody>
                      </table>
                    )}

                    {file.warnings.length > 0 && (
                      <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-warning">
                        {file.warnings.map((warning) => (
                          <li key={warning}>{warning}</li>
                        ))}
                      </ul>
                    )}

                    {/* Exact argv only when the server truly previewed the
                        change — a detected scan has no command to show. */}
                    {perFileArgv.has(file.filePath) && (
                      <div className="mt-2">
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Exact command for this file
                        </div>
                        <CommandPreviewChips argv={perFileArgv.get(file.filePath) ?? []} />
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {group.evidence === 'previewed' && commandPreview.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Command preview (first chunk, exact arguments)
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void copyText(`exiftool ${commandPreview.map(quoteToken).join(' ')}`).then((ok) => {
                  setCopied(ok);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <CommandPreviewChips argv={commandPreview} />
        </div>
      )}
    </section>
  );
}

function DiffRow({ diff }: { diff: TagDiff }) {
  const kindLabel: Record<TagDiff['kind'], string> = {
    create: 'added',
    change: 'changed',
    delete: 'deleted',
    unchanged: 'same',
  };
  return (
    <tr className="border-t border-border/60 align-top">
      <td className="py-1 pr-2 font-mono">{diff.tag}</td>
      <td className="max-w-52 break-all py-1 pr-2 font-mono text-muted-foreground">
        {diff.before !== undefined ? diff.before : <span className="italic">(not set)</span>}
      </td>
      <td className="max-w-52 break-all py-1 pr-2 font-mono">
        {diff.after !== undefined ? diff.after : <span className="italic">(removed)</span>}
      </td>
      <td className="py-1">
        <Badge tone={diff.kind === 'unchanged' ? 'neutral' : diff.kind === 'delete' ? 'danger' : 'info'}>
          {kindLabel[diff.kind]}
        </Badge>
      </td>
    </tr>
  );
}

function countKinds(diffs: WritePreviewFile['diffs']): number {
  return diffs.filter((d) => d.kind !== 'unchanged').length;
}

/** Quote a token for shell display only — execution is always argv-array. */
function quoteToken(token: string): string {
  return token.includes(' ') ? `"${token}"` : token;
}
