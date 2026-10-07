/**
 * The shared write state machine: preview → Save Review modal → execute →
 * Results Report. Every write path in the app rides this hook — it is the
 * ONLY place a write is fired (the source-contract test pins this) so the
 * safety sequence is structurally identical everywhere (ux-spec: "the same
 * diff-before-write modal every single time, in every path").
 *
 * Four arms, discriminated by WriteRunPlan.kind:
 *   edits   — the ordinary write, streamed chunk progress (byte-identical);
 *   undo    — the reverse write replay (byte-identical);
 *   preview — a previewed destructive execute (GPS), NON-streamed so the
 *             consistencyNotes channel survives the batch-complete response;
 *   scrub   — the AI-metadata wipe: scrubExecute fires HERE, inside run(),
 *             with the caller's onRecorded compile-required.
 *
 * The confirm button hands the TYPED phrase to run(phrase); for destructive
 * arms that typed phrase is transmitted as the destructive confirmationPhrase
 * exactly as typed — the server re-checks it and is the phrase authority.
 */
import { useState, type ReactNode } from 'react';
import { cancelWriteBatch, confirmUndo, executeWrite, scrubExecute } from '../api/client';
import { SaveReviewModal, type PreviewGroup } from '../components/SaveReviewModal';
import { useUiStore, type LastWrite } from '../state/store';
import { navigate } from '../lib/router';
import type {
  BatchOutcome,
  BatchOutcomeWithCancel,
  ScrubExecuteResponse,
  TagEdit,
  WriteOutcome,
} from './types';

/**
 * Which write this run fires. The old config fields (edits / undoBatchId)
 * folded into the plan; every existing caller stays on its current arm.
 */
export type WriteRunPlan =
  | { kind: 'edits'; edits: TagEdit[]; timezone?: string }
  | { kind: 'undo'; undoBatchId: string }
  /** A previewed destructive execute — destructive when the envelope is set. */
  | { kind: 'preview'; destructive?: { confirmationPhrase: string } }
  | {
      kind: 'scrub';
      /** Exactly the files the wipe targets — sent as {files, confirm}. */
      files: string[];
      /** The server's phrase DISPLAYS in the gate; only the typed phrase is sent. */
      destructive: { confirmationPhrase: string };
      /** Recorded as lastWrite.edits (synthesized from affectedTags). */
      recordEdits: TagEdit[];
      /** REQUIRED: the caller's post-write work (the honest badge refresh). */
      onRecorded: (result: ScrubExecuteResponse) => void;
    };

export type WriteRunConfig = WriteRunPlan & {
  title: string;
  /** Honesty copy under the gate's destructive heading. */
  destructiveNote?: string;
  /** Keeps a destructive flow's confirm-button copy ('Strip GPS data now'…). */
  confirmLabel?: string;
  /** Detected items that will NOT be removed — shown at the consent moment. */
  cannotRemove?: Array<{ filePath: string; tag: string; reason: string }>;
  /** scrub-sidecar extras recorded with lastWrite (the preview's export). */
  scrubExtras?: { exportedValuesPath: string; notRemoved: Array<{ filePath: string; tag: string; reason: string }> };
  /** Where to land after success (default /results). */
  goToResults?: boolean;
};

export interface WriteProgress {
  phase: string;
  index: number;
  total: number;
}

/**
 * Result of a graceful cancel request (POST /api/write/cancel). `requested`
 * means the server accepted the flag (honored between chunks); `refused`
 * means the batch had already finished — honestly reported, nothing changed.
 */
export interface CancelRequestState {
  status: 'requested' | 'refused';
  note: string;
}

export interface WriteRunner {
  busy: boolean;
  progress: WriteProgress | null;
  /** null when no error — views check `!== null`. */
  error: unknown;
  clearError: () => void;
  /**
   * The batch id of the write currently executing with {stream:true} — null
   * whenever nothing is in flight. It is the cancel target: views may offer
   * Cancel ONLY while this is set.
   */
  activeBatchId: string | null;
  /** After a cancel request: what the server said (for the honest note). */
  cancelState: CancelRequestState | null;
  /** Request a graceful cancel of the in-flight batch. */
  requestCancel: () => Promise<void>;
  /** Open the Save Review modal for these previews. */
  review: (groups: PreviewGroup[], config: WriteRunConfig) => void;
  cancelReview: () => void;
  /**
   * The server's refusal of the last destructive confirm, verbatim — rendered
   * INSIDE the still-open modal (a view banner would be occluded by the
   * scrim). null when nothing was refused.
   */
  refusal: string | null;
  /** The modal element — render it from the view. */
  modal: ReactNode;
}

export function useWriteRunner(): WriteRunner {
  const [groups, setGroups] = useState<PreviewGroup[] | null>(null);
  const [config, setConfig] = useState<WriteRunConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<WriteProgress | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [cancelState, setCancelState] = useState<CancelRequestState | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const review = (next: PreviewGroup[], runConfig: WriteRunConfig): void => {
    setError(null);
    setRefusal(null);
    setGroups(next);
    setConfig(runConfig);
  };

  const cancelReview = (): void => {
    if (busy) return;
    setGroups(null);
    setConfig(null);
  };

  const run = async (phrase: string): Promise<void> => {
    if (groups === null || config === null || busy) return;
    setBusy(true);
    setError(null);
    setRefusal(null);
    setCancelState(null);
    const setLastWrite = useUiStore.getState().setLastWrite;
    try {
      if (config.kind === 'scrub') {
        // The scrub wipe fires HERE, inside the runner — the wizard only builds
        // the detection projection and receives onRecorded. The TYPED phrase is
        // the payload; the server fails fast on any mismatch, before any read.
        const result = await scrubExecute(config.files, phrase);
        recordLastWrite(
          setLastWrite,
          config,
          result.outcome,
          result.commandPreview,
          result.consistencyNotes,
          { exportedValuesPath: result.exportedValuesPath, notRemoved: result.notRemoved },
        );
        config.onRecorded(result);
      } else if (config.kind === 'undo') {
        // Undo's second step: the server replays the reverse write itself.
        const result = await confirmUndo(config.undoBatchId);
        const merged = mergeOutcomes(result.batches.map((b) => b.outcome));
        recordLastWrite(setLastWrite, config, merged, result.batches[0]?.commandPreview ?? []);
      } else if (config.kind === 'edits') {
        if (config.edits.length === 0) {
          setError(new Error('No edits were attached to this write; nothing was executed.'));
        } else {
          const outcomes: BatchOutcome[] = [];
          let commandPreview: string[] = [];
          let consistencyNotes: string[] = [];
          for (const group of groups) {
            if (group.evidence !== 'previewed') {
              // Unreachable: every caller of the edits arm reviews a real
              // server preview (the source-contract test pins the callers).
              throw new Error('This review has no exact preview to execute; nothing was executed.');
            }
            const preview = group.preview;
            setProgress({ phase: 'starting', index: 0, total: preview.files.length });
            setActiveBatchId(null);
            const result = await executeWrite(preview.previewId, {
              stream: true,
              onFrame: (frame) => {
                // The first frame carries the batch id: from here until the
                // stream ends, a graceful cancel is possible and offerable.
                if (typeof frame.batchId === 'string' && frame.batchId.length > 0) {
                  setActiveBatchId(frame.batchId);
                }
                if (frame.type === 'write-progress' && typeof frame.phase === 'string') {
                  setProgress({
                    phase: frame.phase,
                    index: typeof frame.index === 'number' ? frame.index : 0,
                    total: typeof frame.total === 'number' ? frame.total : preview.files.length,
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
        }
      } else {
        // The preview arm: per-group NON-streamed execute, carrying the
        // destructive envelope (typed phrase) when this run is destructive.
        // Non-streamed ON PURPOSE — the plain response always carries
        // consistencyNotes; the streamed batch-complete frame omits them.
        const outcomes: BatchOutcome[] = [];
        let commandPreview: string[] = [];
        let consistencyNotes: string[] = [];
        for (const group of groups) {
          if (group.evidence !== 'previewed') {
            throw new Error('This review has no exact preview to execute; nothing was executed.');
          }
          const result = await executeWrite(group.preview.previewId, {
            ...(config.destructive !== undefined
              ? { destructive: { confirmationPhrase: phrase } }
              : {}),
          });
          outcomes.push(result.outcome);
          commandPreview = commandPreview.length > 0 ? commandPreview : result.commandPreview;
          consistencyNotes = consistencyNotes.concat(result.consistencyNotes);
        }
        const merged = mergeOutcomes(outcomes);
        recordLastWrite(setLastWrite, config, merged, commandPreview, consistencyNotes, config.scrubExtras);
      }
      setGroups(null);
      setConfig(null);
      if (config.goToResults !== false) navigate('/results');
    } catch (cause) {
      if (config.kind === 'scrub' || (config.kind === 'preview' && config.destructive !== undefined)) {
        // Destructive-arm refusal: the server's message, verbatim, INSIDE the
        // still-open modal (groups/config stay intact — a retype-and-retry
        // re-POSTs the same previewId / files).
        setRefusal(cause instanceof Error ? cause.message : String(cause));
      } else {
        setError(cause);
      }
    } finally {
      setBusy(false);
      setProgress(null);
      setActiveBatchId(null);
    }
  };

  /**
   * Graceful cancel of the in-flight batch (BatchPanel's Cancel button). The
   * server honors the flag between chunks: the file being written finishes
   * with its full verification, already-written files keep their verified
   * backups, and the rest are reported as not attempted. A batch that already
   * finished refuses with 404 — surfaced here as an honest note, not a crash.
   */
  const requestCancel = async (): Promise<void> => {
    if (activeBatchId === null) return;
    try {
      const result = await cancelWriteBatch(activeBatchId);
      setCancelState({ status: 'requested', note: result.note });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setCancelState({ status: 'refused', note: message });
    }
  };

  const gatePhrase =
    config !== null && (config.kind === 'scrub' || config.kind === 'preview')
      ? (config.destructive?.confirmationPhrase ?? null)
      : null;
  const modal =
    groups !== null && config !== null ? (
      <SaveReviewModal
        open
        title={config.title}
        groups={groups}
        destructivePhrase={gatePhrase}
        destructiveNote={config.destructiveNote}
        refusal={refusal}
        confirmLabel={config.confirmLabel}
        cannotRemove={config.cannotRemove}
        // The chunk note rode on the edits arm at HEAD, and on undo too (its
        // chunking half is true there) — only the destructive gates, which
        // never streamed, lose the streaming sentence.
        streamed={config.kind === 'edits' || config.kind === 'undo'}
        busy={busy}
        onConfirm={(phrase) => void run(phrase)}
        onCancel={cancelReview}
      />
    ) : null;

  return {
    busy,
    progress,
    error,
    clearError: () => setError(null),
    activeBatchId,
    cancelState,
    requestCancel,
    review,
    cancelReview,
    refusal,
    modal,
  };
}

/**
 * Merge per-group outcomes into one honest batch-level report. The additive
 * cancel fields (`cancelled` / `cancelledAt` / `notAttempted` /
 * `notAttemptedFilePaths`) are carried across when any group's batch was
 * cancelled, so the Results report can say plainly which files the batch
 * never attempted.
 */
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
  const cancelledGroups = outcomes.filter((o) => (o as BatchOutcomeWithCancel).cancelled === true);
  const notAttemptedPaths = cancelledGroups.flatMap(
    (o) => (o as BatchOutcomeWithCancel).notAttemptedFilePaths ?? [],
  );
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
    // Additive, present ONLY when a cancel actually happened (frozen
    // BatchOutcome shape stays intact otherwise).
    ...(cancelledGroups.length > 0
      ? {
          cancelled: true,
          cancelledAt: (cancelledGroups[0] as BatchOutcomeWithCancel).cancelledAt,
          notAttempted: notAttemptedPaths.length,
          notAttemptedFilePaths: notAttemptedPaths,
        }
      : {}),
  };
}

function recordLastWrite(
  setLastWrite: (write: LastWrite) => void,
  config: WriteRunConfig,
  outcome: BatchOutcome,
  commandPreview: string[],
  consistencyNotes: string[] = [],
  scrubExtras?: { exportedValuesPath: string; notRemoved: Array<{ filePath: string; tag: string; reason: string }> },
): void {
  setLastWrite({
    label: config.title,
    edits: config.kind === 'edits' ? config.edits : config.kind === 'scrub' ? config.recordEdits : [],
    ...(config.kind === 'edits' && config.timezone !== undefined ? { timezone: config.timezone } : {}),
    outcome,
    commandPreview,
    consistencyNotes,
    at: new Date().toISOString(),
    ...(scrubExtras !== undefined ? { scrub: scrubExtras } : {}),
  });
}
