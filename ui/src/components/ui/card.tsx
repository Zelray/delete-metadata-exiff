import type { HTMLAttributes } from 'react';

/** The one surface. Cards hold one idea each; spacing is generous on purpose. */
export function Card({ className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-lg border border-border bg-card text-card-foreground ${className}`}
      {...rest}
    />
  );
}

export function CardHeader({ className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`px-5 pt-4 pb-2 ${className}`} {...rest} />;
}

export function CardTitle({ className = '', ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={`text-sm font-semibold tracking-wide ${className}`} {...rest} />;
}

export function CardContent({ className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`px-5 pb-5 pt-1 text-sm ${className}`} {...rest} />;
}
