/**
 * Metadata read payload and the three disclosure depth tiers.
 */
import type { FileKind } from './files.js';

/** How much metadata a read returns. */
export type MetadataDepth = 'simple' | 'all' | 'raw';

/** One metadata tag as read from a file. */
export interface MetadataTag {
  /** Family-1 group name, e.g. "EXIF", "XMP-dc", "PNG". */
  group: string;
  /** Real tag key, e.g. "CreateDate". */
  name: string;
  /** Human-converted value (exiftool default output). */
  value: string;
  /** Raw machine value (`-n`), present in the `raw` tier. */
  raw?: string;
  /** Numeric or string tag ID, when the format exposes one. */
  id?: string;
  /** true when the value came back flagged as binary data. */
  binary: boolean;
  /** Writable per the tag catalog; unknown tags report false. */
  writable: boolean;
}

/**
 * The three-tier metadata payload for one file.
 *
 * - `simple`: the curated human-facing field set (title, description,
 *   keywords, rating, date taken, GPS, copyright, creator...).
 * - `all`: every tag exiftool reports, keyed as `GROUP:Tag`.
 * - `raw`: the `all` tier plus raw machine values and tag IDs.
 */
export interface MetadataPayload {
  filePath: string;
  depth: MetadataDepth;
  /** UTC ISO-8601 time the payload was read. */
  readAt: string;
  kind: FileKind;
  /** Curated friendly fields; only populated for `simple` and `all`. */
  simple: SimpleFields;
  /** Every tag, keyed `GROUP:Tag`. Only populated for `all` and `raw`. */
  all: Record<string, string>;
  /** Rich per-tag records; only populated for `raw`. */
  raw: MetadataTag[];
  /** In-band problems reported by exiftool for this file. */
  warnings: string[];
  errors: string[];
}

/** The curated human-facing field set (MWG-consistent names). */
export interface SimpleFields {
  title?: string;
  description?: string;
  keywords: string[];
  rating?: number;
  /** UTC ISO-8601 rendering of the capture date, when present. */
  dateTaken?: string;
  /** Original exiftool value string for the capture date. */
  dateTakenRaw?: string;
  creator?: string;
  copyright?: string;
  gps?: GpsInfo;
  /** Camera make/model summary. */
  camera?: string;
  /** Pixel dimensions, when determinable. */
  width?: number;
  height?: number;
  orientation?: number;
}

export interface GpsInfo {
  latitude: number;
  longitude: number;
  altitude?: number;
  /** Raw GPS date/time value as stored. */
  timestamp?: string;
}

/** Embedded-preview extraction descriptor. */
export interface ThumbnailInfo {
  filePath: string;
  /** URL of the cached JPEG served by the server. */
  url: string;
  width?: number;
  height?: number;
  /** Which embedded image the thumbnail came from. */
  source: 'thumbnail' | 'preview' | 'jpg-from-raw' | 'native';
  sizeBytes?: number;
  /** true when a cached copy already existed and was reused. */
  cached: boolean;
}
