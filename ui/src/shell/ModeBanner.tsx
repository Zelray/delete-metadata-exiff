import { useHealth } from '../state/queries';
import { useUiStore } from '../state/store';

/**
 * The safety centerpiece (ux-spec): mode is never ambiguous. Every launch is
 * READ-ONLY (calm chip); unlocking writes is a deliberate, session-scoped act
 * that shifts the whole frame amber. The unlock control is rendered but
 * disabled in this leaf — write mode arrives later, and the nav stays honest.
 */
export function ModeBanner() {
  const { data: health } = useHealth();
  const writeUnlocked = useUiStore((s) => s.writeUnlocked);

  const degraded = health !== undefined && health.readOnlyFallback;
  const engineDown = health !== undefined && !health.ok;

  const mode = writeUnlocked && !degraded && !engineDown ? 'unlocked' : 'read-only';

  return (
    <div className="flex items-center gap-2">
      {degraded && (
        <span
          className="tip inline-flex"
          title="The engine could not be fully verified, so the app started in read-only mode."
        >
          <span className="inline-flex items-center rounded border border-destructive/40 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-destructive">
            Read-only fallback
          </span>
        </span>
      )}
      {mode === 'read-only' ? (
        <span
          className="tip inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
          aria-label="Mode: read-only"
        >
          <span className="h-2 w-2 rounded-full bg-success" aria-hidden="true" />
          Read-only
          <span className="tip-body">
            MetaDesk is viewing. Nothing on disk can change. Unlocking writes (a deliberate,
            session-only act) arrives with the edit features.
          </span>
        </span>
      ) : (
        <span
          className="inline-flex items-center gap-1.5 rounded-md bg-warning px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-warning-foreground"
          aria-label="Mode: write unlocked"
        >
          <span className="h-2 w-2 rounded-full bg-warning-foreground" aria-hidden="true" />
          Write unlocked
        </span>
      )}
      <button
        type="button"
        disabled
        title="Write unlock arrives with the edit features. Until then every session is read-only."
        className="rounded px-1.5 py-1 text-[11px] text-muted-foreground/60 cursor-not-allowed"
      >
        {mode === 'read-only' ? 'Unlock' : 'Lock'}
      </button>
    </div>
  );
}
