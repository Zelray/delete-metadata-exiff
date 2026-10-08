/**
 * Three-tier metadata reads, straight off the capability map:
 *
 *  - `simple`: curated human fields (MWG-consistent names) read with a
 *    restricted tag list + `-c %+.6f` so GPS comes back decimal-signed;
 *  - `all`: the standard GUI inspection payload `-j -G1 -a -struct`;
 *  - `raw`: `-j -G1 -a -n -D` merged with the `all` tier so every tag
 *    carries its raw machine value and tag id alongside the human value.
 *
 * All reads are batched: one engine round trip per ~100 files, never one
 * round trip per file. Payloads always follow the frozen shared contract
 * (MetadataPayload / SimpleFields / MetadataTag).
 */
import type {
  MetadataDepth,
  MetadataPayload,
  MetadataTag,
  SimpleFields,
  TagCatalog,
} from '@metadesk/shared';
import { buildJsonReadArgs } from '../engine/argBuilder.js';
import type { ExifToolSession } from '../engine/exiftoolSession.js';
import { lookupTag } from '../engine/tagDatabase.js';
import { normalizeExifPath } from './exifPath.js';

/** Files per engine round trip. */
const BATCH_SIZE = 100;

/**
 * Curated tag list for the `simple` tier. Names WITHOUT the leading dash —
 * the argument builder validates and prefixes them itself.
 */
const SIMPLE_TAGS: readonly string[] = [
  'XMP-dc:Title',
  'XMP-dc:Description',
  'XMP-dc:Subject',
  'XMP-dc:Creator',
  'XMP-dc:Rights',
  'XMP-xmp:Rating',
  'XMP-photoshop:DateCreated',
  'EXIF:ImageDescription',
  'EXIF:DateTimeOriginal',
  'EXIF:CreateDate',
  'EXIF:Artist',
  'EXIF:Copyright',
  'IPTC:ObjectName',
  'IPTC:Keywords',
  'IPTC:CopyrightNotice',
  'IPTC:By-line',
  'IFD0:Make',
  'IFD0:Model',
  'IFD0:Orientation',
  'ExifIFD:DateTimeOriginal',
  'ExifIFD:PixelXDimension',
  'ExifIFD:PixelYDimension',
  'File:ImageWidth',
  'File:ImageHeight',
  'GPSLatitude',
  'GPSLongitude',
  'GPSAltitude',
  'GPSDateStamp',
  'GPSTimeStamp',
  'Composite:GPSLatitude',
  'Composite:GPSLongitude',
];

export type CatalogProvider = () => Promise<TagCatalog | null>;

export class MetadataService {
  constructor(
    private readonly engine: ExifToolSession,
    private readonly getCatalog: CatalogProvider,
  ) {}

  /**
   * Read metadata for a batch of absolute paths. Returns one payload per
   * requested path, in request order, keyed by the exact path requested.
   */
  async read(
    paths: readonly string[],
    depth: MetadataDepth,
  ): Promise<Map<string, MetadataPayload>> {
    if (paths.length === 0) return new Map();
    const payloads = new Map<string, MetadataPayload>();
    for (let offset = 0; offset < paths.length; offset += BATCH_SIZE) {
      const batch = paths.slice(offset, offset + BATCH_SIZE);
      await this.readBatch(batch, depth, payloads);
    }
    return payloads;
  }

  private async readBatch(
    paths: readonly string[],
    depth: MetadataDepth,
    out: Map<string, MetadataPayload>,
  ): Promise<void> {
    const wantAll = depth === 'all';
    const wantRaw = depth === 'raw';

    // Pass 1: converted values (the simple tag list for `simple`, everything
    // for `all`/`raw`). The simple tier adds `-c %+.6f` so GPS values arrive
    // as signed decimals; the arg builder has no coord-format switch, so the
    // known options are spliced in ahead of the file list (exiftool applies
    // options wherever they appear).
    const pass1Args =
      depth === 'simple'
        ? insertBeforeFiles(buildJsonReadArgs(paths, { tags: SIMPLE_TAGS }), ['-c', '%+.6f'], paths.length)
        : buildJsonReadArgs(paths);
    const converted = await this.runJson(pass1Args);

    // Pass 2 (raw tier only): `-n -D` for machine values + tag ids.
    const rawValues = wantRaw
      ? await this.runJson(insertBeforeFiles(buildJsonReadArgs(paths, { numeric: true }), ['-D'], paths.length))
      : [];

    const catalog = wantRaw ? await this.getCatalog() : null;
    const convertedByPath = indexByPath(converted);
    const rawByPath = indexByPath(rawValues);

    for (const requestedPath of paths) {
      const source = convertedByPath.get(normalizeExifPath(requestedPath)) ?? {};
      const rawDoc = rawByPath.get(normalizeExifPath(requestedPath));
      const warnings: string[] = [];
      const errors: string[] = [];
      collectDiagnostics(source, warnings, errors);
      if (rawDoc !== undefined) collectDiagnostics(rawDoc, warnings, errors);
      if (convertedByPath.get(normalizeExifPath(requestedPath)) === undefined) {
        errors.push('exiftool returned no data for this file');
      }

      const payload: MetadataPayload = {
        filePath: requestedPath,
        depth,
        readAt: new Date().toISOString(),
        kind: kindOfPath(requestedPath),
        simple: deriveSimple(source),
        all: wantAll ? stringifyAll(source) : {},
        raw: wantRaw ? deriveRawTags(source, rawDoc, catalog) : [],
        warnings,
        errors,
      };
      out.set(requestedPath, payload);
    }
  }

  private async runJson(args: readonly string[]): Promise<Array<Record<string, unknown>>> {
    const result = await this.engine.run(args, { json: true });
    return result.json as Array<Record<string, unknown>>;
  }
}

// ---- derivation helpers ------------------------------------------------------

/** Insert extra known options before the trailing file arguments. */
function insertBeforeFiles(argv: readonly string[], extra: readonly string[], fileCount: number): string[] {
  const out = [...argv];
  out.splice(Math.max(0, out.length - fileCount), 0, ...extra);
  return out;
}

type JsonDoc = Record<string, unknown>;

function indexByPath(docs: readonly JsonDoc[]): Map<string, JsonDoc> {
  const map = new Map<string, JsonDoc>();
  for (const doc of docs) {
    const source = doc['SourceFile'];
    if (typeof source === 'string') map.set(normalizeExifPath(source), doc);
  }
  return map;
}

function collectDiagnostics(doc: JsonDoc, warnings: string[], errors: string[]): void {
  for (const [key, value] of Object.entries(doc)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    if (/error$/i.test(key)) errors.push(value);
    else if (/warning\d*$/i.test(key)) warnings.push(value);
  }
}

function kindOfPath(p: string): MetadataPayload['kind'] {
  const extension = (p.split('.').pop() ?? '').toLowerCase();
  switch (extension) {
    case 'jpg':
    case 'jpeg':
    case 'jpe':
    case 'jfif':
      return 'jpeg';
    case 'png':
      return 'png';
    case 'gif':
      return 'gif';
    case 'webp':
      return 'webp';
    case 'heic':
    case 'heif':
      return 'heic';
    case 'tif':
    case 'tiff':
      return 'tiff';
    case 'xmp':
      return 'sidecar';
    default:
      return RAW_EXTENSIONS.has(extension) ? 'raw' : 'other';
  }
}

const RAW_EXTENSIONS: ReadonlySet<string> = new Set([
  'crw', 'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng', 'raf', 'orf',
  'rw2', 'raw', 'rwl', 'dcr', 'kdc', 'mrw', 'pef', 'srw', 'x3f', '3fr', 'fff', 'iiq', 'erf',
]);

/** Pick the first present value among candidate `GROUP:Tag` keys. */
function firstValue(doc: JsonDoc, names: readonly string[]): string | undefined {
  for (const name of names) {
    for (const [key, value] of Object.entries(doc)) {
      if (key.toLowerCase() !== name.toLowerCase()) continue;
      const flattened = flattenValue(value);
      if (flattened !== undefined && flattened.length > 0) return flattened;
    }
  }
  return undefined;
}

/**
 * exiftool `-j` renders list-type tags (Creator, Keywords, ...) as JSON
 * arrays and XMP structures as nested objects. For the human tiers, lists
 * join with ", " (exiftool's console behavior) and structures stay JSON.
 */
function flattenValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value.map((item) => flattenValue(item) ?? '').filter((p) => p.length > 0);
    return parts.length > 0 ? parts.join(', ') : undefined;
  }
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return undefined;
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseFloat(value.replace(/^'?\+?/, '').replace(/'$/, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

const ORIENTATION_BY_TEXT: Readonly<Record<string, number>> = {
  'horizontal (normal)': 1,
  'mirror horizontal': 2,
  'rotate 180': 3,
  'mirror vertical': 4,
  'mirror horizontal and rotate 270 cw': 5,
  'rotate 90 cw': 6,
  'mirror horizontal and rotate 90 cw': 7,
  'rotate 270 cw': 8,
};

/**
 * Derive the curated field set from a converted `-j -G1 -a -struct` payload.
 * The simple read adds `-c %+.6f`, so GPS values arrive as signed decimals.
 */
export function deriveSimple(doc: JsonDoc): SimpleFields {
  const simple: SimpleFields = { keywords: [] };

  const title = firstValue(doc, ['XMP-dc:Title', 'IPTC:ObjectName', 'MWG:Title']);
  if (title !== undefined) simple.title = title;

  const description = firstValue(doc, [
    'XMP-dc:Description',
    'MWG:Description',
    'EXIF:ImageDescription',
    'PNG:Description',
  ]);
  if (description !== undefined) simple.description = description;

  simple.keywords = parseKeywords(doc);

  const rating = toNumber(firstValue(doc, ['XMP-xmp:Rating', 'MWG:Rating']));
  if (rating !== undefined) simple.rating = rating;

  const dateTakenRaw = firstValue(doc, [
    'ExifIFD:DateTimeOriginal',
    'EXIF:DateTimeOriginal',
    'Composite:DateTimeOriginal',
    'XMP-photoshop:DateCreated',
    'XMP-xmp:CreateDate',
    'ExifIFD:CreateDate',
  ]);
  if (dateTakenRaw !== undefined) {
    simple.dateTakenRaw = dateTakenRaw;
    simple.dateTaken = exifDateToIso(dateTakenRaw);
  }

  const creator = firstValue(doc, ['XMP-dc:Creator', 'MWG:Creator', 'EXIF:Artist', 'IPTC:By-line']);
  if (creator !== undefined) simple.creator = creator;

  const copyright = firstValue(doc, [
    'XMP-dc:Rights',
    'MWG:Copyright',
    'EXIF:Copyright',
    'IPTC:CopyrightNotice',
  ]);
  if (copyright !== undefined) simple.copyright = copyright;

  const latitude = toNumber(
    firstValue(doc, ['Composite:GPSLatitude', 'GPS:GPSLatitude']),
  );
  const longitude = toNumber(
    firstValue(doc, ['Composite:GPSLongitude', 'GPS:GPSLongitude']),
  );
  if (latitude !== undefined && longitude !== undefined) {
    simple.gps = { latitude, longitude };
    const altitude = toNumber(firstValue(doc, ['GPS:GPSAltitude']));
    if (altitude !== undefined) simple.gps.altitude = altitude;
    const dateStamp = firstValue(doc, ['GPS:GPSDateStamp']);
    const timeStamp = firstValue(doc, ['GPS:GPSTimeStamp']);
    if (dateStamp !== undefined && timeStamp !== undefined) {
      simple.gps.timestamp = `${dateStamp} ${timeStamp}`;
    }
  }

  const make = firstValue(doc, ['IFD0:Make', 'EXIF:Make']);
  const model = firstValue(doc, ['IFD0:Model', 'EXIF:Model']);
  if (make !== undefined || model !== undefined) {
    simple.camera = [make, model].filter((part) => part !== undefined).join(' ').trim();
  }

  const width =
    toNumber(firstValue(doc, ['File:ImageWidth', 'ExifIFD:PixelXDimension'])) ?? undefined;
  const height =
    toNumber(firstValue(doc, ['File:ImageHeight', 'ExifIFD:PixelYDimension'])) ?? undefined;
  if (width !== undefined) simple.width = width;
  if (height !== undefined) simple.height = height;

  const orientationText = firstValue(doc, ['IFD0:Orientation', 'EXIF:Orientation']);
  if (orientationText !== undefined) {
    const numeric = Number.parseInt(orientationText, 10);
    simple.orientation = Number.isFinite(numeric)
      ? numeric
      : ORIENTATION_BY_TEXT[orientationText.toLowerCase()];
  }

  return simple;
}

function parseKeywords(doc: JsonDoc): string[] {
  const raw = firstValue(doc, ['XMP-dc:Subject', 'MWG:Keywords', 'IPTC:Keywords']);
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return raw.map(String);
  return raw
    .split(/[,;]/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

/** exiftool dates are `YYYY:MM:DD HH:MM:SS[.ss][+TZ]`; naive ISO when no zone. */
function exifDateToIso(value: string): string | undefined {
  const match =
    /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([+-]\d{2}:\d{2})?$/.exec(
      value.trim(),
    );
  if (match === null) return undefined;
  const [, y, mo, d, h, mi, s, zone] = match;
  const base = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  return zone === undefined ? base : `${base}${zone}`;
}

/** The `all` tier: every tag as `GROUP:Tag` -> converted string value. */
function stringifyAll(doc: JsonDoc): Record<string, string> {
  const all: Record<string, string> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key === 'SourceFile') continue;
    const flattened = flattenValue(value);
    if (flattened !== undefined) all[key] = flattened;
  }
  return all;
}

/**
 * The `raw` tier: rich per-tag records built by merging the converted payload
 * (human `value`) with the `-n -D` payload (machine `raw` + numeric `id`).
 */
function deriveRawTags(
  converted: JsonDoc,
  rawDoc: JsonDoc | undefined,
  catalog: TagCatalog | null,
): MetadataTag[] {
  type RawEntry = { raw?: string; id?: string };
  const rawEntries = new Map<string, RawEntry>();
  if (rawDoc !== undefined) {
    for (const [key, value] of Object.entries(rawDoc)) {
      if (key === 'SourceFile') continue;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        rawEntries.set(key, {
          raw: obj['val'] === undefined ? undefined : String(obj['val']),
          id: obj['id'] === undefined ? undefined : String(obj['id']),
        });
      } else {
        rawEntries.set(key, { raw: String(value) });
      }
    }
  }

  const tags: MetadataTag[] = [];
  for (const [key, value] of Object.entries(converted)) {
    if (key === 'SourceFile') continue;
    const colonIndex = key.indexOf(':');
    const group = colonIndex > 0 ? key.slice(0, colonIndex) : 'Other';
    const name = colonIndex > 0 ? key.slice(colonIndex + 1) : key;
    const valueText = stringifyTagValue(value);
    const rawEntry = rawEntries.get(key);
    const isBinary = /^\(Binary data /.test(valueText);
    const found = catalog === null ? null : lookupTag(catalog, `${group}:${name}`);
    tags.push({
      group,
      name,
      value: valueText,
      raw: rawEntry?.raw,
      id: rawEntry?.id,
      binary: isBinary || (found?.info.binary === true),
      writable: found?.info.writable === true,
    });
  }
  return tags;
}

function stringifyTagValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}
