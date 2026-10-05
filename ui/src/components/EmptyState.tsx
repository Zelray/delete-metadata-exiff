import type { ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  children?: ReactNode;
}

/** Calm empty state: one sentence of orientation, one suggested move. */
export function EmptyState({ title, children }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-8 py-12 text-center">
      <div className="text-sm font-semibold text-foreground">{title}</div>
      {children !== undefined && (
        <div className="max-w-md text-sm text-muted-foreground">{children}</div>
      )}
    </div>
  );
}
