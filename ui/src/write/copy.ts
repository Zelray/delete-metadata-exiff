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
