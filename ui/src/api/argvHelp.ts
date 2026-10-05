/**
 * Plain-English explanations for exiftool argument tokens.
 *
 * This is the Command Preview drawer's teaching layer (ux-spec: each token
 * gets a plain-English tooltip, e.g. "-G1 = label each value with where it
 * lives, e.g. XMP-dc"). Read-class flags only for now; write-class entries
 * arrive with the write leaf.
 */
const EXPLANATIONS: Record<string, string> = {
  '-j': 'Output JSON — one machine-readable record per file.',
  '-J': 'Output JSON with richer structure (EXIF as nested objects).',
  '-G1': 'Label each value with where it lives, e.g. XMP-dc:Description.',
  '-G': 'Label each value with its group family (shorter than -G1).',
  '-a': 'Allow duplicate tags to be reported (nothing is hidden).',
  '-struct': 'Output structured XMP fields in full, not flattened.',
  '-n': 'Raw machine values — no pretty-printing (e.g. unformatted dates).',
  '-r': 'Recurse into subfolders.',
  '-ext': 'Only touch files with these extensions.',
  '--ext': 'Exclude files with these extensions.',
  '-fast': 'Skip work that is expensive — a faster, partial scan.',
  '-fast4': 'Fastest scan: file system info plus the biggest embedded preview only.',
  '-ver': 'Print the exiftool version and exit.',
  '-listx': 'List the full tag database in XML (every tag exiftool knows).',
  '-listw': 'List tags that are writable.',
  '-list': 'List general tag names.',
  '-b': 'Output binary data (thumbnails, previews) as raw bytes.',
  '-s': 'Short tag names — the internal key, not the friendly description.',
  '-S': 'Short tag names, no descriptions, tab-separated.',
  '-T': 'Table output — one line per file, tab-separated.',
  '-c': 'Coordinate format for GPS values (e.g. decimal degrees).',
  '-gps:all': 'Every GPS tag the file carries.',
  '-api': 'Engine-level options (timezone, large-file support, ...).',
  '-charset': 'Character encoding — MetaDesk always uses UTF-8 filenames.',
  '-charset filename=UTF8': 'Treat filenames as UTF-8 so every Windows name round-trips.',
  '-ee': 'Extract embedded data from inside documents (e.g. video tracks).',
  '-D': 'Show decimal tag ID next to each value.',
  '-H': 'Show hexadecimal tag ID next to each value.',
  '-x': 'Exclude a specific tag from the output.',
  '-if': 'Only process files matching a condition.',
  '-X': 'RDF/XML output format.',
  '-h': 'HTML output format.',
  '-csv': 'CSV output format.',
  '-t': 'Print a header row of tag names (table modes).',
  '-q': 'Quiet mode — suppress informational messages.',
  '-v': 'Verbose — more detail about what exiftool is doing.',
};

/** Fallback explanation for tokens with no curated entry. */
export function explainArg(token: string): string {
  if (token in EXPLANATIONS) return EXPLANATIONS[token] as string;
  if (token.startsWith('-')) {
    return `exiftool option ${token} — passed through exactly as typed; the server's read-only validator gates every command.`;
  }
  if (/^[A-Za-z]:\\/.test(token) || token.startsWith('\\\\')) {
    return 'An absolute path — the only safe way to name a file for exiftool (a path starting with a drive letter can never be mistaken for an option).';
  }
  return 'A plain value (file name, folder, or tag name) passed to exiftool as-is.';
}

/** Known-token lookup for tests and autocomplete-style affordances. */
export function hasCuratedExplanation(token: string): boolean {
  return token in EXPLANATIONS;
}
