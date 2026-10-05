# MetaDesk — plain-English help

This is the same text as the in-app help (press **F1** anywhere, **Esc** closes), plus
the getting-started sections. Nothing in MetaDesk changes a file without showing you the
exact change first, keeping a verified backup, and leaving a way back.

## Starting and stopping MetaDesk

- Double-click **`bin\metadesk.cmd`**. A small console window opens while the app runs;
  your browser opens MetaDesk at a private address only this computer can see.
- **Closing that console window stops MetaDesk cleanly** — it finishes up and shuts its
  engine down properly, never leaving stray processes behind. Ctrl+C in that window does
  the same.
- Starting it a second time while it is already open does **not** start a second copy; it
  just opens the running app in your browser again.
- To stop it from any other console window: `node bin\metadesk.mjs --stop`.
- Your runtime files (port bookkeeping, journal, caches) live in `app\data`. You never
  need to touch that folder.

## First run and the health check

- The bundled ExifTool engine is detected automatically; within a minute a version chip
  appears once the handshake succeeds.
- Three safety cards are shown once: **starts read-only**, **every write keeps a
  backup**, **you preview before anything changes**.
- You can optionally pick a default folder, then you land on Home in READ-ONLY mode.
- If the engine handshake fails, a Read-Only Mode banner appears — **viewing still
  works, editing stays locked** — with Retry and Choose-path buttons.

## App shell

- Left rail picks the tool: Browse, Edit, Batch apply, AI scrub, Console, History,
  Settings.
- The mode pill in the top bar is the safety truth: gray Read-only, amber Write
  unlocked. Unlocking is deliberate, explained in plain English, and lasts only this
  session.
- While unlocked the whole window gets an amber border — you should never wonder whether
  writing is possible.
- The bottom drawer always shows the exact exiftool arguments MetaDesk is about to run,
  read or write.

## What a diff preview is

- Before ANY write, MetaDesk copies each file to a scratch folder, applies the edit
  there, and compares. What you see in the Save Review modal is exactly what will
  happen — no guessing.
- The modal shows old → new for every tag on every file, plus the literal exiftool
  command. If nothing would change, files are listed as "no change needed" instead of
  being counted as success.
- Red "blockers" (locked folder, no disk space) disable the write button until fixed.

## What a backup is

- Every write runs in backup mode: before a file changes, its current version is saved
  as filename_original — a first-generation snapshot, kept by default.
- MetaDesk records the backup's size and fingerprint (hash) in its journal, and verifies
  the backup matches before a file is allowed to be called "updated".
- If the backup cannot be verified, the file is reported as failed — honestly, even
  though the bytes were written.

## What undo does

- Undo reverses a change from the journal's before-values: the old text goes back, tags
  that were added are removed. It is a normal write, so it previews first and keeps a
  fresh backup.
- History shows every batch with a backup "verified" chip. "Restore last batch" is one
  click; undoing the same batch twice is refused (it would re-apply the change).
- The nuclear option — "Restore _original files" — reverts EVERYTHING since first
  contact, not just the last batch. It is labeled and confirmed twice for that reason.

## Browse

- Paste an absolute folder path (C:\Photos\2026), toggle subfolders, pick file types,
  then scan.
- The preflight card shows the count and any warnings before the grid opens.

## File grid

- Click a card to inspect it; Ctrl-click adds to the selection; Shift-click selects the
  range.
- Badges: GPS = has location, © = has copyright, AI = generation metadata (lit by the AI
  scrub's scan).
- Toolbar buttons open the write tools for the selection: Edit, Batch apply, AI scrub.

## Edit panel

- An empty box means leave unchanged — nothing is written for fields you leave empty.
- Clearing a field is a separate red "Delete…" action with its own confirmation; it
  never happens by emptying a box.
- The GPS strip at the bottom is destructive: it lists every GPS tag per file, exports
  the coordinates to a sidecar first, and needs a typed phrase.

## Batch apply

- Scope is the selection or all filtered files; the "only files with GPS" / "missing
  Copyright" filters read the folder scan's badges.
- The date shift moves Date Taken, CreateDate, and ModifyDate together and previews
  old → new per file.
- Big batches run chunk by chunk with live progress; a failed file never stops the
  others.

## AI scrub

- Step 1 scans (read-only) for Stable Diffusion, ComfyUI, NovelAI, and C2PA metadata —
  and lights the AI badges in the grid.
- Step 2 shows what will be removed AND what cannot be removed (ComfyUI prompt/workflow
  chunks, C2PA, data hidden in pixels) — those are flagged honestly, never silently
  skipped.
- Step 3 needs the typed phrase REMOVE AI METADATA; the full original values are
  exported before anything is deleted.

## Results

- Three counts, always: Updated / Unchanged (nothing happened — never dressed up as
  success) / Needs attention.
- Failures come with a plain-English explanation and a suggested fix; Retry re-previews
  only the failed files.

## Detail viewer

- Three depths: Simple (friendly fields) → All tags → Raw values.
- Search filters tags across every group and auto-expands matches.
- GPS shows a map link; binary tags (thumbnails) get Extract buttons.

## Console

- Type any read command; it runs through a strict validator that refuses write-class
  flags.
- Unrecognized tokens become tag names in real exiftool — the GUI validates so nothing
  silently no-ops.
