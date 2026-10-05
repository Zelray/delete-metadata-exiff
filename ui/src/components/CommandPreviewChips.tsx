import { explainArg } from '../api/argvHelp';

/**
 * argv tokens rendered as monospace chips, each with a plain-English tooltip
 * (ux-spec Command Preview Drawer). Shared by the drawer, the Console, and
 * the preflight card — one component, one teaching voice.
 */
export function CommandPreviewChips({
  argv,
  className = '',
}: {
  argv: string[];
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`}>
      {argv.map((token, index) => (
        <span
          // argv entries can repeat legitimately (two -ext chips, for example).
          key={`${index}:${token}`}
          tabIndex={0}
          className="tip inline-flex max-w-full items-center rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground cursor-help"
        >
          <span className="truncate">{token}</span>
          <span className="tip-body">{explainArg(token)}</span>
        </span>
      ))}
    </div>
  );
}
