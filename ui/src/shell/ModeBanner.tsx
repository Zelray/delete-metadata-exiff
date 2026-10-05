import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { lockSession, unlockSession } from '../api/client';
import { queryKeys, useHealth } from '../state/queries';
import { useUiStore } from '../state/store';
import { Button } from '../components/ui/button';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ErrorBanner } from '../components/ErrorBanner';

/**
 * The safety centerpiece (ux-spec): mode is never ambiguous. Every launch is
 * READ-ONLY (calm chip); unlocking writes is a deliberate, session-scoped act
 * behind a plain-English confirm, and the whole frame shifts amber while
 * unlocked (the amber border itself is AppShell's). Health is the truth — the
 * server's additive `writeUnlocked` field — and this banner mirrors it into
 * the store so every other surface reads the same answer.
 */
export function ModeBanner() {
  const { data: health } = useHealth();
  const writeUnlocked = useUiStore((s) => s.writeUnlocked);
  const setWriteUnlocked = useUiStore((s) => s.setWriteUnlocked);
  const queryClient = useQueryClient();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Health is the server's word. Mirror it (additive writeUnlocked field).
  const serverUnlocked = health?.writeUnlocked;
  useEffect(() => {
    if (typeof serverUnlocked === 'boolean') setWriteUnlocked(serverUnlocked);
  }, [serverUnlocked, setWriteUnlocked]);

  const degraded = health !== undefined && health.readOnlyFallback;
  const engineDown = health !== undefined && !health.ok;
  const locked = !writeUnlocked || degraded || engineDown;

  const doUnlock = async () => {
    setBusy(true);
    setError(null);
    try {
      await unlockSession();
      setWriteUnlocked(true);
      setConfirmOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.health });
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  const doLock = async () => {
    setBusy(true);
    setError(null);
    try {
      await lockSession();
      setWriteUnlocked(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.health });
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

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
      {locked ? (
        <span
          className="tip inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
          aria-label="Mode: read-only"
        >
          <span className="h-2 w-2 rounded-full bg-success" aria-hidden="true" />
          Read-only
          <span className="tip-body">
            {degraded
              ? 'MetaDesk is viewing with a degraded engine — nothing on disk can change.'
              : 'MetaDesk is viewing. Nothing on disk can change until you deliberately unlock writing for this session.'}
          </span>
        </span>
      ) : (
        <span
          className="inline-flex items-center gap-1.5 rounded-md bg-warning px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-warning-foreground"
          aria-label="Mode: write unlocked"
        >
          <span className="h-2 w-2 rounded-full bg-warning-foreground" aria-hidden="true" />
          Write unlocked
          <span title="Writing stays unlocked only for this session. Every write still shows you a diff first and keeps a verified backup.">
            · session only
          </span>
        </span>
      )}

      {locked ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy || degraded || engineDown}
          onClick={() => setConfirmOpen(true)}
          title={
            degraded || engineDown
              ? 'Unlocking needs a verified engine.'
              : 'Unlock writing for this session — deliberately, and only after reading what it means.'
          }
        >
          Unlock
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void doLock()}
          title="Lock writing again — back to the read-only default. Always safe."
        >
          Lock
        </Button>
      )}

      {error !== null && (
        <div className="absolute right-3 top-12 z-40 w-96">
          <ErrorBanner error={error} context="Changing write mode" onRetry={() => setError(null)} />
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="Unlock writing for this session?"
        confirmLabel="Unlock writing"
        cancelLabel="Stay read-only"
        danger
        onConfirm={() => void doUnlock()}
        onCancel={() => setConfirmOpen(false)}
      >
        <p>
          Unlocking makes it <strong>possible</strong> for MetaDesk to change your files. What does
          not change:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Every write still shows you a side-by-side diff first — nothing moves without you reading it.</li>
          <li>Every write keeps a verified backup copy of each file before touching it.</li>
          <li>Everything lands in History and can be undone.</li>
        </ul>
        <p>
          This lasts <strong>only for this session</strong> — closing MetaDesk returns you to
          read-only automatically.
        </p>
      </ConfirmDialog>
    </div>
  );
}
