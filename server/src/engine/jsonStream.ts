/**
 * Split a stream of concatenated JSON documents into individual values.
 *
 * `exiftool -j` emits one JSON document per command (an array of per-file
 * objects). Depending on version and command shape the text may be a single
 * array or several documents back to back, so the parser below walks the text
 * tracking string/escape state and bracket depth, then `JSON.parse`s each
 * top-level slice. No third-party dependency, and it never executes text.
 */
export function parseJsonDocuments(text: string): unknown[] {
  const documents: unknown[] = [];
  const trimmed = text.trim();
  if (trimmed.length === 0) return documents;

  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;

  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{' || ch === '[') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }

    if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const slice = trimmed.slice(start, i + 1);
        try {
          const parsed = JSON.parse(slice) as unknown;
          // `exiftool -j` wraps per-file objects in a single top-level array;
          // flatten one level so callers always receive a flat object list.
          if (Array.isArray(parsed)) documents.push(...parsed);
          else documents.push(parsed);
        } catch {
          // A malformed slice is surfaced as unparsed text by the caller via
          // the raw stdout field; never throw away the whole response here.
        }
        start = -1;
      }
      continue;
    }
  }

  return documents;
}

/**
 * Extract in-band exiftool diagnostics from parsed JSON objects.
 *
 * exiftool reports per-file problems as `Error` / `Warning` keys INSIDE the
 * JSON payload (sometimes group-prefixed, e.g. `EXIF:Warning`), never as an
 * exit code. Minor warnings are reported as text ending in `(minor)`.
 */
export function extractDiagnostics(objects: readonly unknown[]): ExifDiagnosticLite[] {
  const found: ExifDiagnosticLite[] = [];
  const seen = new Set<string>();

  for (const obj of objects) {
    if (obj === null || typeof obj !== 'object') continue;
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof value !== 'string' || value.length === 0) continue;
      const isWarning = /warning$/i.test(key) || /warning\d*$/i.test(key);
      const isError = /error$/i.test(key);
      if (!isWarning && !isError) continue;
      const severity: ExifDiagnosticLite['severity'] = isError
        ? 'error'
        : /\(minor\)$/i.test(value)
          ? 'minor'
          : 'warning';
      const dedupeKey = `${severity}:${key}:${value}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const sourceFile = (obj as Record<string, unknown>).SourceFile;
      found.push({
        severity,
        message: value,
        key,
        sourceFile: typeof sourceFile === 'string' ? sourceFile : undefined,
      });
    }
  }

  return found;
}

export interface ExifDiagnosticLite {
  severity: 'error' | 'warning' | 'minor';
  message: string;
  /** The JSON key the diagnostic arrived under. */
  key: string;
  sourceFile?: string;
}
