import { useState } from 'react';
import { Button } from '../components/ui/button';
import { CommandPreviewChips } from '../components/CommandPreviewChips';
import { useUiStore } from '../state/store';
import { copyText } from '../lib/clipboard';
import { navigate } from '../lib/router';

/**
 * The persistent Command Preview drawer (ux-spec): the exact exiftool
 * arguments are always visible — collapsed to a one-line summary of the next
 * queued command, expanded to per-token chips with plain-English tooltips, a
 * copy button, an Open-in-Console handoff, and a scrollable history with
 * outcomes. Read-only here by design; editing arrives with write mode.
 */
export function CommandPreviewDrawer() {
  const open = useUiStore((s) => s.drawerOpen);
  const toggleDrawer = useUiStore((s) => s.toggleDrawer);
  const nextCommand = useUiStore((s) => s.nextCommand);
  const history = useUiStore((s) => s.commandHistory);
  const setConsoleDraft = useUiStore((s) => s.setConsoleDraft);
  const [copied, setCopied] = useState(false);

  const argv = nextCommand?.argv ?? [];

  const copyCommand = async () => {
    const ok = await copyText(argv.length > 0 ? `exiftool ${argv.map(quoteToken).join(' ')}` : '');
    setCopied(ok);
    setTimeout(() => setCopied(false), 1500);
  };

  const openInConsole = () => {
    setConsoleDraft(argv);
    navigate('/console');
  };

  return (
    <section
      aria-label="Command preview"
      className="border-t border-border bg-card text-card-foreground"
    >
      <button
        type="button"
        onClick={toggleDrawer}
        aria-expanded={open}
        className="flex h-9 w-full items-center gap-3 px-3 text-left hover:bg-muted"
        title="Show the exact exiftool arguments MetaDesk runs — nothing happens without this."
      >
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {open ? '▾' : '▸'} Command preview
        </span>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {argv.length > 0
            ? `Next: exiftool ${argv.slice(0, 6).join(' ')}${argv.length > 6 ? ' …' : ''} (${nextCommand?.readOnly === false ? 'write command' : 'read only'})`
            : 'No command yet — open a folder or read a file to see one.'}
        </span>
      </button>

      {open && (
        <div className="max-h-56 overflow-auto px-3 pb-3">
          {argv.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <CommandPreviewChips argv={argv} className="flex-1" />
              <span className="flex gap-1.5">
                <Button size="sm" variant="outline" onClick={() => void copyCommand()}>
                  {copied ? 'Copied' : 'Copy command'}
                </Button>
                <Button size="sm" variant="outline" onClick={openInConsole}>
                  Open in Console
                </Button>
              </span>
            </div>
          ) : (
            <p className="py-1 text-xs text-muted-foreground">
              Every read MetaDesk runs shows up here with a plain-English explanation per token —
              the CLI teaches itself in the background.
            </p>
          )}

          {history.length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Recent commands
              </div>
              <ul className="space-y-1">
                {history.slice(0, 8).map((entry) => (
                  <li key={entry.id} className="flex items-center gap-2 text-xs">
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${entry.ok ? 'bg-success' : 'bg-destructive'}`}
                      aria-hidden="true"
                    />
                    <span className="truncate font-mono text-muted-foreground" title={entry.argv.join(' ')}>
                      {entry.argv.length > 0 ? `exiftool ${entry.argv.join(' ')}` : entry.label}
                    </span>
                    <span className="ml-auto shrink-0 text-muted-foreground/70">
                      {new Date(entry.at).toLocaleTimeString()}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** Quote a token for shell display only — execution is always argv-array. */
function quoteToken(token: string): string {
  return token.includes(' ') ? `"${token}"` : token;
}
