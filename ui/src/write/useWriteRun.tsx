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
 *
 * Since arch-v11 leaf 1.5 the run state itself (busy, progress, error, the
 * active batch id, cancel state, refusal, the staged review, and the honest
 * completion latch) lives in the store's TRANSIENT writeRun slice, not in
 * per-view useState: a write in flight survives any navigation, the same
 * WriteRunModal renders from the mounting view or the shell's host, and
 * single-flight is enforced (one global write at a time) instead of accidental.
 */
import { type ReactNode } from 'react';
import { cancelWriteBatch, confirmUndo, executeWrite, scrubExecute } from '../api/client';
import { SaveReviewModal } from '../components/SaveReviewModal';
import { useUiStore, type LastWrite } from '../state/store';
import { navigate } from '../lib/router';
import type {
  BatchOutcome,
  BatchOutcomeWithCancel,
  WriteOutcome,
} from './types';
import type {
  CancelRequestState,
  PreviewGroup,
  WriteProgress,
  WriteRunConfig,
} from './types';

// The plan/flight types relocated to write/types.ts (the store's slice carries
// them); re-exported so every existing import path keeps working.
export type { CancelRequestState, WriteProgress, WriteRunConfig, WriteRunPlan } from './types';

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

/**
 * The route-parse twin of the router's (unexported, pure) parseHash — same
 * math, so startedRoute and the route-at-completion compare equal only when
 * the user really is where the run started.
 */
function currentRoute(): string {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  return raw.split('?')[0] ?? '/';
}

/**
 * Open the Save Review modal for these previews. Session single-flight: a
 * no-op while ANY write is in flight (the server's lock is process-global, so
 * a second review could only end in a write_locked refusal). Opening a new
 * review replaces the staged one — the session holds at most ONE.
 */
function review(next: PreviewGroup[], runConfig: WriteRunConfig): void {
  if (useUiStore.getState().writeRun.busy) return;
  useUiStore.getState().setWriteRun({
    error: null,
    refusal: null,
    completion: null,
    groups: next,
    config: runConfig,
  });
}

function cancelReview(): void {
  if (useUiStore.getState().writeRun.busy) return;
  useUiStore.getState().setWriteRun({ groups: null, config: null });
}

function clearWriteError(): void {
  useUiStore.getState().setWriteRun({ error: null });
}

/** Clear the shell's completion latch (the View report click). */
export function clearWriteCompletion(): void {
  useUiStore.getState().setWriteRun({ completion: null });
}

/**
 * THE write. Single-flight at entry (a no-op while the session is busy), and
 * the completion rule is honest by construction: on success, recordLastWrite
 * as always, then — only if the user is still on the route the run started
 * from — navigate('/results'); away, NO yank, the shell's 'Write finished'
 * latch offers the report instead. In the CATCH branch (never finally) the
 * latch records 'failed', so a failed run can never claim success.
 */
async function run(phrase: string): Promise<void> {
  const store = useUiStore.getState();
  const current = store.writeRun;
  if (current.groups === null || current.config === null || current.busy) return;
  const config = current.config;
  const groups = current.groups;
  const startedRoute = currentRoute();
  const setWriteRun = store.setWriteRun;
  setWriteRun({
    busy: true,
    error: null,
    refusal: null,
    cancelState: null,
    completion: null,
    startedRoute,
  });
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
        setWriteRun({ error: new Error('No edits were attached to this write; nothing was executed.') });
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
          setWriteRun({ progress: { phase: 'starting', index: 0, total: preview.files.length } });
          setWriteRun({ activeBatchId: null });
          const result = await executeWrite(preview.previewId, {
            stream: true,
            onFrame: (frame) => {
              // The first frame carries the batch id: from here until the
              // stream ends, a graceful cancel is possible and offerable.
              if (typeof frame.batchId === 'string' && frame.batchId.length > 0) {
                setWriteRun({ activeBatchId: frame.batchId });
              }
              if (frame.type === 'write-progress' && typeof frame.phase === 'string') {
                setWriteRun({
                  progress: {
                    phase: frame.phase,
                    index: typeof frame.index === 'number' ? frame.index : 0,
                    total: typeof frame.total === 'number' ? frame.total : preview.files.length,
                  },
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
    setWriteRun({ groups: null, config: null });
    if (config.goToResults !== false) {
      if (currentRoute() === startedRoute) {
        // Still on the origin route: land on Results exactly as before.
        navigate('/results');
      } else {
        // Away from the origin: NO yank. The shell's completion latch tells
        // the user the write finished and offers the report.
        setWriteRun({ completion: 'done' });
      }
    }
  } catch (cause) {
    if (config.kind === 'scrub' || (config.kind === 'preview' && config.destructive !== undefined)) {
      // Destructive-arm refusal: the server's message, verbatim, INSIDE the
      // still-open modal (groups/config stay intact — a retype-and-retry
      // re-POSTs the same previewId / files).
      setWriteRun({ refusal: cause instanceof Error ? cause.message : String(cause) });
    } else {
      setWriteRun({ error: cause });
    }
    // The terminal latch is written HERE, in the catch — a failed run must
    // never be mistaken for a finished one.
    setWriteRun({ completion: 'failed' });
  } finally {
    setWriteRun({ busy: false, progress: null, activeBatchId: null });
  }
}

/**
 * Graceful cancel of the in-flight batch (the in-dialog button and the view
 * chrome). The server honors the flag between chunks: the file being written
 * finishes with its full verification, already-written files keep their
 * verified backups, and the rest are reported as not attempted. A batch that
 * already finished refuses with 404 — surfaced here as an honest note, not a
 * crash.
 */
export async function requestWriteCancel(): Promise<void> {
  const batchId = useUiStore.getState().writeRun.activeBatchId;
  if (batchId === null) return;
  try {
    const result = await cancelWriteBatch(batchId);
    useUiStore.getState().setWriteRun({ cancelState: { status: 'requested', note: result.note } });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    useUiStore.getState().setWriteRun({ cancelState: { status: 'refused', note: message } });
  }
}

/**
 * THE one Save Review modal (arch-v11 leaf 1.5): the five views and the
 * shell's WriteRunModalHost all render this same component, which reads the
 * session's writeRun slice directly — so the staged review and the busy gate
 * follow the user across navigation instead of living in one view. While the
 * streamed write runs it passes the in-dialog flight section (progress + the
 * reachable cancel) to the gate.
 */
export function WriteRunModal(): ReactNode {
  const writeRun = useUiStore((s) => s.writeRun);
  if (writeRun.groups === null || writeRun.config === null) return null;
  const config = writeRun.config;
  const gatePhrase =
    config.kind === 'scrub' || config.kind === 'preview'
      ? (config.destructive?.confirmationPhrase ?? null)
      : null;
  return (
    <SaveReviewModal
      open
      title={config.title}
      groups={writeRun.groups}
      destructivePhrase={gatePhrase}
      destructiveNote={config.destructiveNote}
      refusal={writeRun.refusal}
      confirmLabel={config.confirmLabel}
      cannotRemove={config.cannotRemove}
      // The chunk note rode on the edits arm at HEAD, and on undo too (its
      // chunking half is true there) — only the destructive gates, which
      // never streamed, lose the streaming sentence.
      streamed={config.kind === 'edits' || config.kind === 'undo'}
      busy={writeRun.busy}
      flight={{
        progress: writeRun.progress,
        cancelOfferable: writeRun.activeBatchId !== null,
        cancelState: writeRun.cancelState,
        onRequestCancel: () => void requestWriteCancel(),
      }}
      onConfirm={(phrase) => void run(phrase)}
      onCancel={cancelReview}
    />
  );
}

export function useWriteRunner(): WriteRunner {
  const writeRun = useUiStore((s) => s.writeRun);
  return {
    busy: writeRun.busy,
    progress: writeRun.progress,
    error: writeRun.error,
    clearError: clearWriteError,
    activeBatchId: writeRun.activeBatchId,
    cancelState: writeRun.cancelState,
    requestCancel: requestWriteCancel,
    review,
    cancelReview,
    refusal: writeRun.refusal,
    modal: <WriteRunModal />,
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
