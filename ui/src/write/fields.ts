/**
 * The curated editable field set (leaf 1.1.5) — one model shared by the Edit
 * Panel and the Batch panel, mapped onto the server's whitelist
 * (engine/argBuilder.ts CURATED_FIELDS / ALLOWED_WRITE_TAGS via the MWG-cons
 * istent route: every human field writes its XMP + EXIF/IPTC partners together
 * so every app agrees).
 *
 * SAFETY SEMANTICS baked in here, not per view:
 *  - EMPTY MEANS UNCHANGED: an input left empty produces NO edit at all.
 *  - Deleting a field is a separate, explicit per-field action (op 'delete')
 *    that the UI confirms; it is never implied by an empty value.
 *  - A field cannot be both set and deleted: entering a value clears its
 *    pending delete; arming the delete clears the value.
 *
 * v1 honesty note: setting GPS *values* is not in the server's write
 * whitelist (argBuilder ALLOWED_WRITE_TAGS), so this model offers no GPS set —
 * GPS appears only as the destructive strip flow (EditPanel), which surfaces
 * the server's verdict verbatim.
 */
import type { TagEdit } from './types';

export type FieldKey =
  | 'title'
  | 'description'
  | 'keywords'
  | 'rating'
  | 'dateTaken'
  | 'copyright'
  | 'creator';

export interface FieldDef {
  key: FieldKey;
  label: string;
  /** Whitelisted tags this field writes, in MWG-consistent order. */
  tags: string[];
  /** Plain-English hint shown under the control. */
  hint: string;
  /** Label for the explicit red delete action. */
  deleteLabel: string;
  placeholder: string;
}

export const FIELD_DEFS: Record<FieldKey, FieldDef> = {
  title: {
    key: 'title',
    label: 'Title',
    tags: ['XMP-dc:Title', 'IPTC:ObjectName'],
    hint: 'The short name of the photo. Written to XMP and IPTC together.',
    deleteLabel: 'Delete Title from every selected file',
    placeholder: 'Empty = leave unchanged',
  },
  description: {
    key: 'description',
    label: 'Description',
    tags: ['XMP-dc:Description', 'EXIF:ImageDescription'],
    hint: 'Caption or longer note. Written to XMP and EXIF together (MWG sync).',
    deleteLabel: 'Delete Description from every selected file',
    placeholder: 'Empty = leave unchanged',
  },
  keywords: {
    key: 'keywords',
    label: 'Keywords',
    tags: ['XMP-dc:Subject', 'IPTC:Keywords'],
    hint: 'Adding a chip appends the word; removing a chip removes only that word. Existing keywords are kept.',
    deleteLabel: 'Delete ALL Keywords from every selected file',
    placeholder: 'Type a keyword and press Enter',
  },
  rating: {
    key: 'rating',
    label: 'Rating',
    tags: ['XMP-xmp:Rating'],
    hint: '0–5 stars, the standard XMP rating that photo apps understand.',
    deleteLabel: 'Delete Rating from every selected file',
    placeholder: 'Click the stars',
  },
  dateTaken: {
    key: 'dateTaken',
    label: 'Date Taken',
    tags: ['EXIF:DateTimeOriginal'],
    hint: 'When the shutter fired (DateTimeOriginal). Batch date-shift covers CreateDate and ModifyDate too, so the three never drift apart.',
    deleteLabel: 'Delete Date Taken from every selected file',
    placeholder: '',
  },
  copyright: {
    key: 'copyright',
    label: 'Copyright',
    tags: ['XMP-dc:Rights', 'EXIF:Copyright', 'IPTC:CopyrightNotice'],
    hint: 'Written to XMP, EXIF, and IPTC together so every app shows the same credit.',
    deleteLabel: 'Delete Copyright from every selected file',
    placeholder: 'Empty = leave unchanged',
  },
  creator: {
    key: 'creator',
    label: 'Creator',
    tags: ['XMP-dc:Creator', 'EXIF:Artist', 'IPTC:By-line'],
    hint: 'The photographer/artist. Written to XMP, EXIF, and IPTC together.',
    deleteLabel: 'Delete Creator from every selected file',
    placeholder: 'Empty = leave unchanged',
  },
};

/** What the user staged, before any preview exists. */
export interface StagedEdits {
  title: string;
  description: string;
  /** New keywords to append (each becomes += on both keyword tags). */
  addKeywords: string[];
  /** Existing keywords to remove (each becomes -= on both keyword tags). */
  removeKeywords: string[];
  rating: string;
  /** datetime-local string, e.g. "2026-06-01T14:30". */
  dateTaken: string;
  /** Timezone decision for the date write (TIMEZONES id). */
  timezone: string;
  copyright: string;
  creator: string;
  /** Fields armed for explicit deletion. */
  deletes: FieldKey[];
}

export function emptyStagedEdits(): StagedEdits {
  return {
    title: '',
    description: '',
    addKeywords: [],
    removeKeywords: [],
    rating: '',
    dateTaken: '',
    timezone: 'none',
    copyright: '',
    creator: '',
    deletes: [],
  };
}

/** True when nothing at all is staged — the honest "nothing to save" state. */
export function isStagedEmpty(staged: StagedEdits): boolean {
  return buildTagEdits(staged).length === 0;
}

/** Convert staged edits to server TagEdit ops. Order: sets, then deletes. */
export function buildTagEdits(staged: StagedEdits): TagEdit[] {
  const edits: TagEdit[] = [];
  const armed = new Set(staged.deletes);

  if (staged.title.trim() !== '' && !armed.has('title')) {
    for (const tag of FIELD_DEFS.title.tags) edits.push({ tag, op: 'set', value: staged.title.trim() });
  }
  if (staged.description.trim() !== '' && !armed.has('description')) {
    for (const tag of FIELD_DEFS.description.tags) {
      edits.push({ tag, op: 'set', value: staged.description.trim() });
    }
  }
  for (const keyword of staged.addKeywords) {
    for (const tag of FIELD_DEFS.keywords.tags) edits.push({ tag, op: 'append', value: keyword });
  }
  for (const keyword of staged.removeKeywords) {
    for (const tag of FIELD_DEFS.keywords.tags) edits.push({ tag, op: 'remove', value: keyword });
  }
  if (staged.rating !== '' && !armed.has('rating')) {
    for (const tag of FIELD_DEFS.rating.tags) edits.push({ tag, op: 'set', value: staged.rating });
  }
  if (staged.dateTaken !== '' && !armed.has('dateTaken')) {
    const value = formatDateForExif(staged.dateTaken, staged.timezone);
    for (const tag of FIELD_DEFS.dateTaken.tags) edits.push({ tag, op: 'set', value });
  }
  if (staged.copyright.trim() !== '' && !armed.has('copyright')) {
    for (const tag of FIELD_DEFS.copyright.tags) {
      edits.push({ tag, op: 'set', value: staged.copyright.trim() });
    }
  }
  if (staged.creator.trim() !== '' && !armed.has('creator')) {
    for (const tag of FIELD_DEFS.creator.tags) edits.push({ tag, op: 'set', value: staged.creator.trim() });
  }

  // Explicit deletes LAST and only for fields with no staged value.
  for (const key of staged.deletes) {
    if (key === 'keywords') {
      // Deleting all keywords wipes both list tags; staged adds are refused
      // upstream (the delete chip is disabled while adds/removes exist).
      if (staged.addKeywords.length > 0 || staged.removeKeywords.length > 0) continue;
    } else if (hasStagedValue(staged, key)) {
      continue;
    }
    for (const tag of FIELD_DEFS[key].tags) edits.push({ tag, op: 'delete' });
  }
  return edits;
}

function hasStagedValue(staged: StagedEdits, key: FieldKey): boolean {
  switch (key) {
    case 'title':
      return staged.title.trim() !== '';
    case 'description':
      return staged.description.trim() !== '';
    case 'keywords':
      return staged.addKeywords.length > 0 || staged.removeKeywords.length > 0;
    case 'rating':
      return staged.rating !== '';
    case 'dateTaken':
      return staged.dateTaken !== '';
    case 'copyright':
      return staged.copyright.trim() !== '';
    case 'creator':
      return staged.creator.trim() !== '';
  }
}

// ---- dates and timezones -----------------------------------------------------

/** Explicit timezone decisions (requirement #13: never implicit). */
export const TIMEZONES: Array<{ id: string; label: string }> = [
  { id: 'none', label: 'No timezone marker (plain local time)' },
  { id: 'local', label: "This computer's timezone" },
  { id: '+00:00', label: 'UTC (+00:00)' },
  { id: '-08:00', label: 'UTC-08:00 (Pacific)' },
  { id: '-07:00', label: 'UTC-07:00 (Mountain)' },
  { id: '-06:00', label: 'UTC-06:00 (Central)' },
  { id: '-05:00', label: 'UTC-05:00 (Eastern)' },
  { id: '+01:00', label: 'UTC+01:00 (Central Europe)' },
  { id: '+02:00', label: 'UTC+02:00 (Eastern Europe)' },
  { id: '+03:00', label: 'UTC+03:00' },
  { id: '+04:00', label: 'UTC+04:00' },
  { id: '+05:30', label: 'UTC+05:30 (India)' },
  { id: '+08:00', label: 'UTC+08:00 (China/Singapore)' },
  { id: '+09:00', label: 'UTC+09:00 (Japan/Korea)' },
  { id: '+10:00', label: 'UTC+10:00 (Australia East)' },
];

/** This computer's current UTC offset as ±HH:MM. */
export function localOffsetSuffix(): string {
  const minutes = -new Date().getTimezoneOffset();
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

/**
 * "2026-06-01T14:30" (+ timezone decision) -> the EXIF-stored form
 * "2026:06:01 14:30:00" with the chosen offset appended (or none).
 */
export function formatDateForExif(datetimeLocal: string, timezone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(datetimeLocal);
  if (match === null) return datetimeLocal;
  const [, y, mo, d, h, mi, s] = match;
  let suffix = '';
  if (timezone === 'local') suffix = localOffsetSuffix();
  else if (timezone !== 'none' && /^[+-]\d{2}:\d{2}$/.test(timezone)) suffix = timezone;
  return `${y}:${mo}:${d} ${h}:${mi}:${s ?? '00'}${suffix}`;
}

/** The tz note shown next to a staged date ("+02:00 will be stored"). */
export function dateNoteFor(timezone: string): string {
  if (timezone === 'none') return 'Stored without a timezone marker, exactly as typed.';
  if (timezone === 'local') return `Stored as typed plus this computer's offset (${localOffsetSuffix()}).`;
  return `Stored as typed plus the ${timezone} offset.`;
}

export type ShiftUnit = 'minutes' | 'hours' | 'days';

/** Parse an EXIF-stored date "YYYY:MM:DD HH:MM:SS[+HH:MM]" -> Date + suffix. */
export function parseExifDate(value: string): { date: Date; suffix: string } | null {
  const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})([+-]\d{2}:\d{2})?/.exec(value.trim());
  if (match === null) return null;
  const [, y, mo, d, h, mi, s, suffix] = match;
  const date = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
  );
  if (Number.isNaN(date.getTime())) return null;
  return { date, suffix: suffix ?? '' };
}

/** Date -> "YYYY:MM:DD HH:MM:SS" (suffix re-appended by the caller). */
export function formatExifDate(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}:${p(date.getMonth() + 1)}:${p(date.getDate())} ` +
    `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
  );
}

/**
 * Shift one stored date by a duration. Wall-clock arithmetic (a +2h shift
 * means the clock reads two hours later — DST gaps are not re-normalized),
 * with the chosen timezone marker appended when requested.
 */
export function shiftExifDate(
  value: string,
  shift: { amount: number; unit: ShiftUnit },
  timezone: string,
): string | null {
  const parsed = parseExifDate(value);
  if (parsed === null) return null;
  const date = parsed.date;
  if (shift.unit === 'minutes') date.setMinutes(date.getMinutes() + shift.amount);
  else if (shift.unit === 'hours') date.setHours(date.getHours() + shift.amount);
  else date.setDate(date.getDate() + shift.amount);
  let suffix = parsed.suffix;
  if (timezone === 'none') suffix = '';
  else if (timezone === 'local') suffix = localOffsetSuffix();
  else if (/^[+-]\d{2}:\d{2}$/.test(timezone)) suffix = timezone;
  return `${formatExifDate(date)}${suffix}`;
}

// ---- batching math ------------------------------------------------------------

/** Server chunk size (writePipeline DEFAULT_CHUNK_SIZE) — for honest previews. */
export const SERVER_CHUNK_SIZE = 200;

/** How many execution chunks a batch of N files needs (basename splits aside). */
export function chunkEstimate(fileCount: number): number {
  if (fileCount <= 0) return 0;
  return Math.ceil(fileCount / SERVER_CHUNK_SIZE);
}

/** Human list of the tags one field writes ("XMP-dc:Title, IPTC:ObjectName"). */
export function fieldTagList(key: FieldKey): string {
  return FIELD_DEFS[key].tags.join(', ');
}
