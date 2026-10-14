/**
 * Shared write-surface copy. ONE definition per string that must read
 * identically everywhere it renders: the graceful-cancel confirm shows in TWO
 * surfaces (the view's ConfirmDialog and the review modal's in-dialog flight
 * section), and two surfaces promising different things would be exactly the
 * dishonesty this app never ships. The in-flight-file FIRST sentence is
 * test-pinned, so it cannot be silently dropped from either surface.
 */
export const CANCEL_BATCH_CONFIRM_PARAGRAPH =
  'The file being written right now finishes safely with its full backup and verification. ' +
  'Already-written files keep their verified backups; the rest will not be attempted, and ' +
  'the Results report lists every one of them honestly.';

/**
 * Undo honesty (issue #4): a batch whose ORIGINAL value contained line breaks
 * can never be undone automatically (the engine refuses multiline write-back
 * values). The History card says so BEFORE the click — disabled button, this
 * badge and title — instead of letting the click die on a raw engine guard.
 */
export const UNDO_BLOCKED_BADGE = 'can\'t auto-undo';
/** The blocked badge's warning tone (kept here so HistoryView adds no literals). */
export const UNDO_BLOCKED_BADGE_TONE = 'warning' as const;
export const UNDO_BLOCKED_TITLE =
  'This batch can\'t be auto-undone: its original value contained line breaks. ' +
  'Nothing is lost: the _original backup still holds the data.';

/** The per-card undo button's tooltip for a batch that CAN be auto-undone. */
export const UNDO_TWO_STEP_TITLE =
  'Two-step: first the reverse diff, then your confirm. Undoing twice is refused by design.';
