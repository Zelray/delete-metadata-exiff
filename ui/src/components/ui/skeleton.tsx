/** Loading placeholder — a quiet pulse, never a spinner storm. */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton rounded ${className}`} aria-hidden="true" />;
}
