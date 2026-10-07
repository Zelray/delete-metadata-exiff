import { useMemo, useState } from 'react';
import { scrubPreview } from '../api/client';
import { useUiStore } from '../state/store';
import { navigate } from '../lib/router';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';
import { useWriteRunner } from '../write/useWriteRun';
import type { DetectedPreview, ScrubDetection, TagEdit } from '../write/types';
import { basename } from '../lib/format';

/** Server cap for one scrub scan (writes.ts MAX_SCRUB_FILES). */
const MAX_SCRUB_FILES = 1000;

type Step = 'detect' | 'findings';

/**
 * Strip / Clean wizard v1 — the AI-scrub (route /scrub): detect → findings,
 * then the typed-phrase gate opens in the SHARED Save Review modal (the
 * runner is the only place a write fires). Removable tags are listed per file
 * with values; the cannot-be-removed section is rendered prominently (ComfyUI
 * prompt/workflow chunks, C2PA — no metadata tool can delete these in safe
 * mode); the hidden-alpha warning tells the truth about pixel-level data; the
 * full original values are exported to a sidecar before anything is removed.
 */
export function ScrubWizard() {
  const selectedPaths = useUiStore((s) => s.selectedPaths);
  const scanResult = useUiStore((s) => s.scanResult);
  const searchText = useUiStore((s) => s.searchText);
  const badges = useUiStore((s) => s.badges);
  const noteBadges = useUiStore((s) => s.noteBadges);
  const runner = useWriteRunner();

  const [step, setStep] = useState<Step>('detect');
  const [report, setReport] = useState<ScrubDetection | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<unknown>(null);

  /** The files the wizard would scan: the selection, else the filtered folder. */
  const scope = useMemo(() => {
    const base =
      selectedPaths.length > 0
        ? selectedPaths
        : (scanResult?.entries ?? [])
            .filter((entry) => searchText.trim() === '' || entry.name.toLowerCase().includes(searchText.trim().toLowerCase()))
            .map((entry) => entry.path);
    return base.slice(0, MAX_SCRUB_FILES);
  }, [selectedPaths, scanResult, searchText]);
  const scopeTruncated = selectedPaths.length > 0
    ? selectedPaths.length > MAX_SCRUB_FILES
    : (scanResult?.entries.length ?? 0) > MAX_SCRUB_FILES;

  const detect = async (): Promise<void> => {
    if (scope.length === 0 || scanning) return;
    setScanning(true);
    setError(null);
    try {
      const result = await scrubPreview(scope);
      setReport(result.report);
      // Wire the grid/detail AI badges from the detection results.
      for (const file of result.report.files) {
        const flagged =
          file.tags.length > 0 || file.c2paPresent || file.jumbfPresent || file.softwareMatches.length > 0;
        const existing = badges[file.filePath];
        noteBadges(file.filePath, {
          hasGps: existing?.hasGps ?? false,
          hasCopyright: existing?.hasCopyright ?? false,
          aiGenerated: flagged ? true : file.tags.length === 0 ? false : null,
        });
      }
      setStep('findings');
    } catch (cause) {
      setError(cause);
    } finally {
      setScanning(false);
    }
  };

  const affectedFiles = useMemo(
    () => (report !== null ? [...new Set(report.affectedTags.map((row) => row.filePath))] : []),
    [report],
  );

  /**
   * Open the Save Review gate: one DETECTED group (delete rows from
   * affectedTags, values as-scanned — the wipe re-detects from a fresh scan,
   * so no exact preview exists) plus the phrase, the honest cannot-remove
   * rows, and the onRecorded badge refresh. The typed phrase travels with the
   * confirm; the wipe itself fires inside the runner.
   */
  const openConfirm = (): void => {
    if (report === null || affectedFiles.length === 0) return;
    const findingByPath = new Map(report.files.map((file) => [file.filePath, file]));
    const detected: DetectedPreview = {
      detectionId: report.scrubId,
      files: affectedFiles.map((filePath) => {
        const finding = findingByPath.get(filePath);
        return {
          filePath,
          diffs: report.affectedTags
            .filter((row) => row.filePath === filePath)
            .map((row) => ({ tag: row.tag, before: row.value, kind: 'delete' as const })),
          warnings:
            finding?.possibleHiddenAlphaData === true
              ? [
                  finding.hiddenAlphaNote ??
                    'This file may hide data inside the image pixels themselves — MetaDesk cannot scrub pixels.',
                ]
              : [],
          noop: false,
        };
      }),
      blockers: [],
    };
    runner.review(
      [
        {
          label: 'AI metadata to remove',
          evidence: 'detected',
          detected,
        },
      ],
      {
        kind: 'scrub',
        // The title doubles as the lastWrite label — HEAD's exact wording.
        title: `AI-metadata scrub — ${affectedFiles.length} file(s)`,
        files: affectedFiles,
        destructive: { confirmationPhrase: report.confirmationPhrase },
        destructiveNote:
          'The full original values are exported to a file beside the journal before anything is removed — the last copy of those prompts. Every file gets a verified _original backup first; items listed as cannot-be-removed will still be in the files afterward.',
        confirmLabel: `Remove AI metadata from ${affectedFiles.length} file${affectedFiles.length === 1 ? '' : 's'}`,
        cannotRemove: [
          ...report.files.flatMap((file) =>
            file.tags
              .filter((tag) => !tag.removable)
              .map((tag) => ({
                filePath: file.filePath,
                tag: tag.tag,
                reason: tag.note ?? 'Not removable by name.',
              })),
          ),
          ...report.files.flatMap((file) => {
            const rows: Array<{ filePath: string; tag: string; reason: string }> = [];
            if (file.possibleHiddenAlphaData) {
              rows.push({
                filePath: file.filePath,
                tag: '(pixel data / alpha channel)',
                reason:
                  file.hiddenAlphaNote ??
                  'Some tools hide prompts in pixel data (alpha channel) or burn watermarks. No metadata tool can remove these; MetaDesk flags the risk instead of claiming a clean file.',
              });
            }
            if (file.c2paPresent || file.jumbfPresent) {
              rows.push({
                filePath: file.filePath,
                tag: file.c2paPresent ? 'C2PA manifest' : 'JUMBF structure',
                reason:
                  'Content Credentials live in a JUMBF structure that can only be removed with a group delete, which this version refuses. Flagged, not removed.',
              });
            }
            return rows;
          }),
        ],
        recordEdits: [...new Set(report.affectedTags.map((row) => row.tag))].map(
          (tag): TagEdit => ({ tag, op: 'delete' }),
        ),
        onRecorded: (result) => {
          // Honest badge refresh: only files that were actually cleaned drop the flag.
          const stillFlagged = new Set(result.notRemoved.map((row) => row.filePath));
          for (const outcome of result.outcome.files) {
            const existing = useUiStore.getState().badges[outcome.filePath];
            useUiStore.getState().noteBadges(outcome.filePath, {
              hasGps: existing?.hasGps ?? false,
              hasCopyright: existing?.hasCopyright ?? false,
              aiGenerated:
                outcome.status === 'updated' && outcome.verified === true && !stillFlagged.has(outcome.filePath)
                  ? false
                  : existing?.aiGenerated ?? null,
            });
          }
        },
      },
    );
  };

  if (scanResult === null && selectedPaths.length === 0) {
    return (
      <div className="p-6">
        <EmptyState title="No folder is open">
          The AI scrub scans the folder in the grid (or the files you selected). Open a folder in
          Browse first — the scan is read-only and changes nothing.
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
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold">AI-metadata scrub</h1>
        <p className="text-xs text-muted-foreground">
          Detect → review findings → confirm with a typed phrase → remove. Read-only until the last
          step.
        </p>
      </header>

      {/* Step indicator */}
      <ol className="flex gap-2 text-xs" aria-label="Wizard steps">
        {(
          [
            ['detect', '1 · Detect'],
            ['findings', '2 · Findings'],
          ] as const
        ).map(([value, label]) => (
          <li
            key={value}
            className={`rounded-full border px-3 py-1 ${
              step === value ? 'border-accent bg-accent-soft text-accent' : 'border-border text-muted-foreground'
            }`}
            aria-current={step === value ? 'step' : undefined}
          >
            {label}
          </li>
        ))}
      </ol>

      {error !== null && <ErrorBanner error={error} context="Scanning for AI metadata" onRetry={() => void detect()} />}

      {step === 'detect' && (
        <section className="space-y-3 rounded-lg border border-border px-4 py-4">
          <div className="text-sm">
            Scans <strong>{scope.length.toLocaleString()}</strong> file{scope.length === 1 ? '' : 's'}{' '}
            {selectedPaths.length > 0 ? '(your selection)' : '(all filtered files)'} for
            Stable-Diffusion-family metadata: A1111 parameters, ComfyUI prompt/workflow chunks,
            NovelAI fingerprints, software strings, AI text in description fields, and C2PA
            Content Credentials.
          </div>
          {scopeTruncated && (
            <div className="rounded border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
              The server scans at most {MAX_SCRUB_FILES} files per pass — narrow the selection or the
              filter and run the rest after.
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            The scan is read-only — nothing is modified. Detection also lights the AI badge in the
            grid and the inspector.
          </p>
          <Button variant="primary" disabled={scope.length === 0 || scanning} onClick={() => void detect()}>
            {scanning ? 'Scanning…' : 'Scan for AI metadata'}
          </Button>
        </section>
      )}

      {step === 'findings' && report !== null && (
        <FindingsStep
          report={report}
          onNext={openConfirm}
          onBack={() => setStep('detect')}
          affectedCount={affectedFiles.length}
        />
      )}

      {runner.modal}
    </div>
  );
}

function FindingsStep({
  report,
  onNext,
  onBack,
  affectedCount,
}: {
  report: ScrubDetection;
  onNext: () => void;
  onBack: () => void;
  affectedCount: number;
}) {
  const hiddenAlphaFiles = report.files.filter((file) => file.possibleHiddenAlphaData);
  const flaggedFiles = report.files.filter(
    (file) => file.tags.length > 0 || file.c2paPresent || file.jumbfPresent || file.softwareMatches.length > 0,
  );

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-4 py-3 text-sm">
        <Badge tone="accent">{affectedCount} file(s) with removable AI metadata</Badge>
        <Badge tone="warning">{notRemovableCount(report)} detected item(s) cannot be removed</Badge>
        <Badge tone="neutral">{report.cleanFilePaths.length} clean</Badge>
        {report.blockedFilePaths.length > 0 && (
          <Badge tone="neutral">{report.blockedFilePaths.length} skipped (RAW / unreadable)</Badge>
        )}
      </section>

      {/* Hidden-alpha honesty banner */}
      {hiddenAlphaFiles.length > 0 && (
        <div className="rounded-lg border border-warning/50 bg-warning/10 px-4 py-3 text-sm">
          <div className="font-semibold text-warning">
            {hiddenAlphaFiles.length} file(s) may hide data inside the image pixels themselves
          </div>
          <p className="mt-1 text-xs">
            Some tools hide prompts inside the image pixels (alpha-channel “stealth pnginfo”) or
            burn invisible watermarks into the picture. MetaDesk removes the standard metadata but{' '}
            <strong>cannot scrub pixels</strong> — no metadata tool can. These files stay flagged
            even after a clean scrub.
          </p>
          <ul className="mt-1.5 list-disc pl-5 text-xs">
            {hiddenAlphaFiles.slice(0, 8).map((file) => (
              <li key={file.filePath} className="break-words">
                {basename(file.filePath)}
                {file.hiddenAlphaNote !== undefined ? ` — ${file.hiddenAlphaNote}` : ''}
              </li>
            ))}
            {hiddenAlphaFiles.length > 8 && <li>… and {hiddenAlphaFiles.length - 8} more</li>}
          </ul>
        </div>
      )}

      {/* Cannot-be-removed: rendered prominently, never silently skipped */}
      {notRemovableCount(report) > 0 && (
        <section className="rounded-lg border border-destructive/50 px-4 py-3">
          <h2 className="text-sm font-semibold text-destructive">
            Detected but CANNOT be removed by any metadata tool in safe mode
          </h2>
          <ul className="mt-2 space-y-1.5 text-xs">
            {report.files
              .flatMap((file) =>
                file.tags
                  .filter((tag) => !tag.removable)
                  .map((tag) => ({ filePath: file.filePath, tag })),
              )
              .slice(0, 12)
              .map(({ filePath, tag }) => (
                <li key={`${filePath}:${tag.tag}`} className="break-words">
                  <span className="font-mono">{basename(filePath)}</span> —{' '}
                  <span className="font-mono font-semibold">{tag.tag}</span>:{' '}
                  <span className="text-muted-foreground">{tag.note ?? 'Not removable by name.'}</span>
                </li>
              ))}
            {report.files
              .filter((file) => file.c2paPresent || file.jumbfPresent)
              .slice(0, 6)
              .map((file) => (
                <li key={`${file.filePath}:c2pa`} className="break-words">
                  <span className="font-mono">{basename(file.filePath)}</span> —{' '}
                  <span className="font-semibold">C2PA/JUMBF Content Credentials</span>: these chunk
                  types cannot be deleted by any metadata tool in safe mode (only a whole-group
                  delete could, which MetaDesk refuses).
                </li>
              ))}
          </ul>
        </section>
      )}

      {/* Removable tags per file with summarized values */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">What WILL be removed</h2>
        {flaggedFiles.length === 0 && (
          <p className="rounded border border-border px-3 py-2 text-xs text-muted-foreground">
            No removable AI metadata was found. Blocked or clean files are listed below.
          </p>
        )}
        {flaggedFiles
          .filter((file) => file.tags.some((tag) => tag.removable))
          .map((file) => (
            <details key={file.filePath} className="rounded-lg border border-border px-3 py-2">
              <summary className="cursor-pointer text-xs">
                <span className="font-mono font-medium">{basename(file.filePath)}</span>{' '}
                <span className="text-muted-foreground">
                  {file.tags.filter((tag) => tag.removable).length} removable tag(s)
                  {file.softwareMatches.length > 0 && ` · ${file.softwareMatches.join(', ')}`}
                </span>
              </summary>
              <ul className="mt-1.5 space-y-1">
                {file.tags
                  .filter((tag) => tag.removable)
                  .map((tag) => (
                    <li key={tag.tag} className="text-xs">
                      <span className="font-mono font-medium">{tag.tag}</span>
                      <span className="ml-2 break-all font-mono text-muted-foreground">
                        “{tag.value}”
                      </span>
                    </li>
                  ))}
              </ul>
            </details>
          ))}
      </section>

      {report.blockedFilePaths.length > 0 && (
        <details className="rounded-lg border border-border px-3 py-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            {report.blockedFilePaths.length} file(s) skipped entirely — why
          </summary>
          <ul className="mt-1 space-y-1">
            {report.blockedFilePaths.map((row) => (
              <li key={row.filePath} className="break-words">
                <span className="font-mono">{basename(row.filePath)}</span>: {row.reason}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="flex gap-2">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button
          variant="primary"
          disabled={affectedCount === 0}
          onClick={onNext}
          title={affectedCount === 0 ? 'Nothing removable was found.' : 'The typed-phrase gate is next.'}
        >
          Continue to confirm ({affectedCount})
        </Button>
      </div>
    </div>
  );
}

function notRemovableCount(report: ScrubDetection): number {
  return (
    report.files.reduce((sum, file) => sum + file.tags.filter((tag) => !tag.removable).length, 0) +
    report.files.filter((file) => file.c2paPresent || file.jumbfPresent).length
  );
}
