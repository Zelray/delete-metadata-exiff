/**
 * The shared write state machine: preview → Save Review modal → execute →
 * Results Report. Every write path in the app rides this hook so the safety
 * sequence is structurally identical everywhere (ux-spec: "the same
 * diff-before-write modal every single time, in every path").
 *
 * Execution uses {stream:true} and reports chunk progress; the outcome is
 * merged across preview groups (a date shift can need one preview per
 * distinct current-date value) into one honest Results Report.
 */
import { useState, type ReactNode } from 'react';
import { confirmUndo, executeWrite } from '../api/client';
import { SaveReviewModal, type PreviewGroup } from '../components/SaveReviewModal';
import { useUiStore, type LastWrite } from '../state/store';
import { navigate } from '../lib/router';
import type { BatchOutcome, TagEdit, WriteOutcome } from './types';

export interface WriteRunConfig {
  title: string;
  /** Typed-phrase gate for destructive flows (null = ordinary write). */
  destructivePhrase?: string | null;
  destructiveNote?: string;
  /** The edits that ran — recorded so Results' retry can re-preview them. */
  edits?: TagEdit[];
  timezone?: string;
  /** For undo runs: the confirm goes to /api/write/undo, not execute. */
  undoBatchId?: string;
  /** Where to land after success (default /results). */
  goToResults?: boolean;
}

export interface WriteProgress {
  phase: string;
  index: number;
  total: number;
}

export interface WriteRunner {
  busy: boolean;
  progress: WriteProgress | null;
  /** null when no error — views check `!== null`. */
  error: unknown;
  clearError: () => void;
  /** Open the Save Review modal for these previews. */
  review: (groups: PreviewGroup[], config: WriteRunConfig) => void;
  cancelReview: () => void;
  /** The modal element — render it from the view. */
  modal: ReactNode;
}

export function useWriteRunner(): WriteRunner {
  const [groups, setGroups] = useState<PreviewGroup[] | null>(null);
  const [config, setConfig] = useState<WriteRunConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<WriteProgress | null>(null);
  const [error, setError] = useState<unknown>(null);

  const review = (next: PreviewGroup[], runConfig: WriteRunConfig): void => {
    setError(null);
    setGroups(next);
    setConfig(runConfig);
  };

  const cancelReview = (): void => {
    if (busy) return;
    setGroups(null);
    setConfig(null);
  };

  const run = async (): Promise<void> => {
    if (groups === null || config === null || busy) return;
    setBusy(true);
    setError(null);
    const setLastWrite = useUiStore.getState().setLastWrite;
    try {
      if (config.undoBatchId !== undefined) {
        // Undo's second step: the server replays the reverse write itself.
        const result = await confirmUndo(config.undoBatchId);
        const merged = mergeOutcomes(result.batches.map((b) => b.outcome));
        recordLastWrite(setLastWrite, config, merged, result.batches[0]?.commandPreview ?? []);
      } else if (config.edits !== undefined && config.edits.length > 0) {
        const outcomes: BatchOutcome[] = [];
        let commandPreview: string[] = [];
        let consistencyNotes: string[] = [];
        for (const group of groups) {
          setProgress({ phase: 'starting', index: 0, total: group.preview.files.length });
          const result = await executeWrite(group.preview.previewId, {
            stream: true,
            onFrame: (frame) => {
              if (frame.type === 'write-progress' && typeof frame.phase === 'string') {
                setProgress({
                  phase: frame.phase,
                  index: typeof frame.index === 'number' ? frame.index : 0,
                  total: typeof frame.total === 'number' ? frame.total : group.preview.files.length,
                });
              }
            },
          });
          outcomes.push(result.outcome);
          commandPreview = commandPreview.length > 0 ? commandPreview : result.commandPreview;
          consistencyNotes = consistencyNotes.concat(result.consistencyNotes);
        }
        const merged = mergeOutcomes(outcomes);
        recordLastWrite(setLastWrite, config, merged, commandPreview, consistencyNotes);
      } else {
        setError(new Error('No edits were attached to this write; nothing was executed.'));
      }
      setGroups(null);
      setConfig(null);
      if (config.goToResults !== false) navigate('/results');
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const modal =
    groups !== null && config !== null ? (
      <SaveReviewModal
        open
        title={config.title}
        groups={groups}
        destructivePhrase={config.destructivePhrase ?? null}
        destructiveNote={config.destructiveNote}
        busy={busy}
        onConfirm={() => void run()}
        onCancel={cancelReview}
      />
    ) : null;

  return { busy, progress, error, clearError: () => setError(null), review, cancelReview, modal };
}

/** Merge per-group outcomes into one honest batch-level report. */
export function mergeOutcomes(outcomes: BatchOutcome[]): BatchOutcome {
  if (outcomes.length === 0) {
    // Unreachable via the server contract; kept total for typing honesty.
    return {
      batchId: 'none',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      files: [],
      updated: 0,
      unchanged: 0,
      failed: 0,
      allVerified: false,
      retryFilePaths: [],
    };
  }
  const files: WriteOutcome[] = outcomes.flatMap((o) => o.files);
  return {
    batchId: outcomes[0]?.batchId ?? 'none',
    startedAt: outcomes[0]?.startedAt ?? new Date().toISOString(),
    finishedAt: outcomes[outcomes.length - 1]?.finishedAt ?? new Date().toISOString(),
    files,
    updated: files.filter((f) => f.status === 'updated').length,
    unchanged: files.filter((f) => f.status === 'unchanged').length,
    failed: files.filter((f) => f.status === 'failed').length,
    allVerified: files.length > 0 && files.every((f) => f.status === 'updated' && f.verified === true),
    retryFilePaths: files
      .filter(
        (f) =>
          f.status === 'failed' &&
          (f.stage === undefined || f.stage === 'write' || f.stage === 'preflight' || f.stage === 'verify' || f.stage === 'unknown'),
      )
      .map((f) => f.filePath),
  };
}

function recordLastWrite(
  setLastWrite: (write: LastWrite) => void,
  config: WriteRunConfig,
  outcome: BatchOutcome,
  commandPreview: string[],
  consistencyNotes: string[] = [],
): void {
  setLastWrite({
    label: config.title,
    edits: config.edits ?? [],
    ...(config.timezone !== undefined ? { timezone: config.timezone } : {}),
    outcome,
    commandPreview,
    consistencyNotes,
    at: new Date().toISOString(),
  });
}
