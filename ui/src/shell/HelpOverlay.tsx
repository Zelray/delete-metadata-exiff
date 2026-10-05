import { useEffect } from 'react';
import { useUiStore } from '../state/store';
import { Button } from '../components/ui/button';

/** Plain-English help for the focused panel — F1 anywhere, Esc closes. */
const HELP_SECTIONS: Array<{ panel: string; lines: string[] }> = [
  {
    panel: 'App shell',
    lines: [
      'Left rail picks the tool: Browse (folders + grid), Console (raw read commands), and the panels arriving with write mode.',
      'The mode pill in the top bar is the safety truth: gray Read-only, amber Write unlocked.',
      'The bottom drawer always shows the exact exiftool arguments MetaDesk is about to run.',
    ],
  },
  {
    panel: 'Browse',
    lines: [
      'Paste an absolute folder path (C:\\Photos\\2026), toggle subfolders, pick file types, then scan.',
      'The preflight card shows the count and any warnings before the grid opens.',
    ],
  },
  {
    panel: 'File grid',
    lines: [
      'Click a card to inspect it; Ctrl-click adds to the selection; Shift-click selects the range.',
      'Badges: GPS = has location, © = has copyright, AI = generation metadata (arriving).',
    ],
  },
  {
    panel: 'Detail viewer',
    lines: [
      'Three depths: Simple (friendly fields) → All tags → Raw values.',
      'Search filters tags across every group and auto-expands matches.',
      'GPS shows a map link; binary tags (thumbnails) get Extract buttons.',
    ],
  },
  {
    panel: 'Console',
    lines: [
      'Type any read command; it runs through a strict validator that refuses write-class flags.',
      'Unrecognized tokens become tag names in real exiftool — the GUI validates so nothing silently no-ops.',
    ],
  },
];

export function HelpOverlay() {
  const open = useUiStore((s) => s.helpOpen);
  const setOpen = useUiStore((s) => s.setHelpOpen);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label="Plain-English help"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div className="max-h-[80vh] w-full max-w-2xl overflow-auto rounded-lg border border-border bg-card p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">What this panel does</h2>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Close (Esc)
          </Button>
        </div>
        <div className="space-y-4">
          {HELP_SECTIONS.map((section) => (
            <section key={section.panel}>
              <h3 className="text-sm font-semibold text-accent">{section.panel}</h3>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                {section.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <p className="mt-5 text-xs text-muted-foreground">
          Nothing in MetaDesk changes a file without showing you the exact command first.
        </p>
      </div>
    </div>
  );
}
