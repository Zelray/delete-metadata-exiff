import type { ReactNode } from 'react';
import { EmptyState } from '../components/EmptyState';
import { Badge } from '../components/ui/badge';

/**
 * Honest route placeholders for the write-side leaves (1.1.5): /edit,
 * /batch, /history, /settings. They never pretend to work — each says what
 * will arrive and why it is safe to be missing today.
 */
function StubPanel({
  title,
  when,
  children,
}: {
  title: string;
  when: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <header className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">{title}</h1>
        <Badge tone="neutral">arrives with write mode</Badge>
      </header>
      <EmptyState title={`Nothing here yet — by design`}>
        {children}
        <div className="mt-2 text-xs text-muted-foreground">Scheduled: {when}</div>
      </EmptyState>
    </div>
  );
}

export function EditStub() {
  return (
    <StubPanel
      title="Edit"
      when="write surfaces leaf"
    >
      The friendly form (Title, Description, Keywords, Rating, Date Taken, GPS, Copyright,
      Creator) lands together with its safety machinery: the mandatory diff-before-write review,
      automatic _original backups, and verification after every write.
    </StubPanel>
  );
}

export function BatchStub() {
  return (
    <StubPanel
      title="Batch apply"
      when="write surfaces leaf"
    >
      Apply one set of edits to a selection or the whole folder, with honest three-valued results
      (updated / unchanged / needs attention) and a retry list.
    </StubPanel>
  );
}

export function HistoryStub() {
  return (
    <StubPanel
      title="History"
      when="write surfaces leaf"
    >
      Every change with its backup status, one-click undo from the journal, and the clearly
      labeled “restore from _original” for reverting everything since first contact. Once the
      first write happens, entries appear here.
    </StubPanel>
  );
}

export function SettingsStub() {
  return (
    <StubPanel
      title="Settings"
      when="write surfaces leaf"
    >
      Engine path with Verify, defaults (folder, theme, density, date format), MWG sync, and the
      hard-floored safety toggles (diff-before-write always on, backups always on, typed
      confirmation for destructive operations). The engine is already verified read-only today —
      the version chip in the status strip is that handshake.
    </StubPanel>
  );
}
