import { useEffect, type ReactNode } from 'react';
import { Button } from './ui/button';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** true for destructive confirmations — the confirm button renders danger-red. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The one confirmation dialog (ux-spec: proportionate friction, calm motion).
 * Cancel is the safe default; focus starts on it so Enter cancels and the
 * deliberate click lands on the confirm button.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-lg rounded-lg border border-border bg-card p-5 shadow-xl">
        <h2 className="text-base font-semibold">{title}</h2>
        <div className="mt-2 space-y-2 text-sm text-muted-foreground">{children}</div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} autoFocus>
            {cancelLabel}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
