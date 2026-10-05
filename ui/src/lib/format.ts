/** Human-readable formatting helpers shared across views. */

/** 1_234_567 -> "1.2 MB" (binary units, the convention exiftool users know). */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** UTC ISO-8601 -> local, short human form. Empty-safe. */
export function formatDateTime(iso: string | undefined): string {
  if (iso === undefined || iso === '') return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "IMG_2041.jpg" -> "IMG_2041" (for list rows that repeat the extension). */
export function basename(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'));
  return idx === -1 ? filePath : filePath.slice(idx + 1);
}

/** Split an absolute path into drive + rest for the top-bar breadcrumb. */
export function pathBreadcrumb(
  folder: string | undefined,
): Array<{ label: string; value: string }> {
  if (folder === undefined || folder === '') return [];
  const normalized = folder.replace(/\//g, '\\');
  const parts = normalized.split('\\').filter((p) => p.length > 0);
  const crumbs: Array<{ label: string; value: string }> = [];
  let acc = '';
  for (const part of parts) {
    if (acc === '') {
      // First segment is the drive ("C:") — keep its trailing backslash.
      acc = part.endsWith(':') ? `${part}\\` : `\\${part}`;
    } else {
      acc = `${acc}${part}`;
      crumbs.push({ label: part, value: acc });
      continue;
    }
    crumbs.push({ label: part, value: acc });
  }
  return crumbs;
}
