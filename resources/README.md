# resources/

Static, shipped-with-the-app assets that are not code:

- `help/metadesk-help.md` — the plain-English help text. It mirrors the in-app F1
  overlay (`ui/src/shell/HelpOverlay.tsx`); update both together.
- ExifTool arg-file presets and app icons arrive with later steps (presets ride the
  v1.1 Strip/Clean wizard; icons land with the Tauri wrap, buildOutline step 9).

Nothing here is executed or served dynamically — the server reads from `ui/dist`, and
the launcher from `bin/`. If you add an asset, keep it passive and document it here.
