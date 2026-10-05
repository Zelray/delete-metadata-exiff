import { useEffect } from 'react';
import { useUiStore } from '../state/store';
import { Button } from '../components/ui/button';

/** Plain-English help for the focused panel — F1 anywhere, Esc closes. */
const HELP_SECTIONS: Array<{ panel: string; lines: string[] }> = [
  {
    panel: 'App shell',
    lines: [
      'Left rail picks the tool: Browse, Edit, Batch apply, AI scrub, Console, History, Settings.',
      'The mode pill in the top bar is the safety truth: gray Read-only, amber Write unlocked. Unlocking is deliberate, explained in plain English, and lasts only this session.',
      'While unlocked the whole window gets an amber border — you should never wonder whether writing is possible.',
      'The bottom drawer always shows the exact exiftool arguments MetaDesk is about to run, read or write.',
    ],
  },
  {
    panel: 'What a diff preview is',
    lines: [
      'Before ANY write, MetaDesk copies each file to a scratch folder, applies the edit there, and compares. What you see in the Save Review modal is exactly what will happen — no guessing.',
      'The modal shows old → new for every tag on every file, plus the literal exiftool command. If nothing would change, files are listed as "no change needed" instead of being counted as success.',
      'Red "blockers" (locked folder, no disk space) disable the write button until fixed.',
    ],
  },
  {
    panel: 'What a backup is',
    lines: [
      'Every write runs in backup mode: before a file changes, its current version is saved as filename_original — a first-generation snapshot, kept by default.',
      'MetaDesk records the backup\'s size and fingerprint (hash) in its journal, and verifies the backup matches before a file is allowed to be called "updated".',
      'If the backup cannot be verified, the file is reported as failed — honestly, even though the bytes were written.',
    ],
  },
  {
    panel: 'What undo does',
    lines: [
      'Undo reverses a change from the journal\'s before-values: the old text goes back, tags that were added are removed. It is a normal write, so it previews first and keeps a fresh backup.',
      'History shows every batch with a backup "verified" chip. "Restore last batch" is one click; undoing the same batch twice is refused (it would re-apply the change).',
      'The nuclear option — "Restore _original files" — reverts EVERYTHING since first contact, not just the last batch. It is labeled and confirmed twice for that reason.',
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
      'Badges: GPS = has location, © = has copyright, AI = generation metadata (lit by the AI scrub\'s scan).',
      'Toolbar buttons open the write tools for the selection: Edit, Batch apply, AI scrub.',
    ],
  },
  {
    panel: 'Edit panel',
    lines: [
      'An empty box means leave unchanged — nothing is written for fields you leave empty.',
      'Clearing a field is a separate red "Delete…" action with its own confirmation; it never happens by emptying a box.',
      'The GPS strip at the bottom is destructive: it lists every GPS tag per file, exports the coordinates to a sidecar first, and needs a typed phrase.',
    ],
  },
  {
    panel: 'Batch apply',
    lines: [
      'Scope is the selection or all filtered files; the "only files with GPS" / "missing Copyright" filters read the folder scan\'s badges.',
      'The date shift moves Date Taken, CreateDate, and ModifyDate together and previews old → new per file.',
      'Big batches run chunk by chunk with live progress; a failed file never stops the others.',
    ],
  },
  {
    panel: 'AI scrub',
    lines: [
      'Step 1 scans (read-only) for Stable Diffusion, ComfyUI, NovelAI, and C2PA metadata — and lights the AI badges in the grid.',
      'Step 2 shows what will be removed AND what cannot be removed (ComfyUI prompt/workflow chunks, C2PA, data hidden in pixels) — those are flagged honestly, never silently skipped.',
      'Step 3 needs the typed phrase REMOVE AI METADATA; the full original values are exported before anything is deleted.',
    ],
  },
  {
    panel: 'Results',
    lines: [
      'Three counts, always: Updated / Unchanged (nothing happened — never dressed up as success) / Needs attention.',
      'Failures come with a plain-English explanation and a suggested fix; Retry re-previews only the failed files.',
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
  {
    panel: 'Settings — Support (diagnostics bundle)',
    lines: [
      '"Create diagnostics bundle" gathers MetaDesk\'s own records into one small zip, saves it in MetaDesk\'s data folder (the exact path is shown as selectable text with a Copy button once it is built), and can also drop a copy into your browser\'s usual Downloads folder.',
      'Inside: the tail of the change journal (file paths and the tag values MetaDesk wrote — never the photos themselves), the ExifTool engine version, the app and Node version numbers, and the data-folder location.',
      'Nothing is sent anywhere by MetaDesk. The bundle stays on this computer until you choose to share it — attach it to an email or a support message yourself.',
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
          Nothing in MetaDesk changes a file without showing you the exact change first, keeping a
          verified backup, and leaving a way back.
        </p>
      </div>
    </div>
  );
}
