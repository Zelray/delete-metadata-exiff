import type { HTMLAttributes, ReactNode } from 'react';

type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'info' | 'danger';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  children: ReactNode;
}

const toneClasses: Record<BadgeTone, string> = {
  neutral: 'bg-muted text-muted-foreground border-border',
  accent: 'bg-accent-soft text-accent border-transparent',
  success: 'bg-transparent text-success border-success/40',
  warning: 'bg-warning text-warning-foreground border-transparent',
  info: 'bg-transparent text-accent border-accent/40',
  danger: 'bg-transparent text-destructive border-destructive/40',
};

/** Small chip for states and groups. Never animated, never blinking. */
export function Badge({ tone = 'neutral', className = '', children, ...rest }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap ${toneClasses[tone]} ${className}`}
      {...rest}
    >
      {children}
    </span>
  );
}
