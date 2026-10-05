/**
 * Engine-layer types: the tag catalog parsed from `-listx`, the typed edit
 * intents the argument builder accepts, and in-band exiftool diagnostics.
 *
 * Nothing in this module ever becomes a shell string. Every user-supplied
 * string in a request arrives in a named field and can only ever be projected
 * into the VALUE slot of one argument.
 */
import type { TagEditOperation } from './write.js';

/** One tag from the `-listx` XML database. */
export interface TagInfo {
  /** Real tag name as exiftool spells it, e.g. "DateTimeOriginal". */
  name: string;
  /** Group names this tag belongs to, keyed by family number. */
  groups: Record<string, string>;
  /** Writable in some form (`-listw` semantics from the Writable attribute). */
  writable: boolean;
  /** Protected: needs an explicit group prefix to be written. */
  protected: boolean;
  /** List-type (e.g. Keywords, Subject). */
  list: boolean;
  /** Binary data tag (thumbnails, previews, ICC). */
  binary: boolean;
  /** Mandatory: auto-created when its table is created. */
  mandatory: boolean;
  /** Permanent: editable in place, never individually created/deleted. */
  permanent: boolean;
  /** Unsafe: can alter image appearance; skipped by wildcards. */
  unsafe: boolean;
  /** Avoid: skipped in bulk copies. */
  avoid: boolean;
  /** Human description, when the database supplies one. */
  description?: string;
  /** Notes string from the XML, verbatim. */
  notes?: string;
}

/** The parsed `-listx` catalog. */
export interface TagCatalog {
  /** Engine version the catalog was built from. */
  exiftoolVersion: string;
  /** UTC ISO-8601 build time. */
  builtAt: string;
  /** Tags keyed by lowercase `family1:TagName`, e.g. `"iptc:keywords"`. */
  tags: Record<string, TagInfo>;
  /** Lowercase bare tag name -> every catalog key carrying it. */
  nameIndex: Record<string, string[]>;
}

/** Whitelist key for the curated human-facing field set. */
export type CuratedFieldKey =
  | 'title'
  | 'description'
  | 'keywords'
  | 'rating'
  | 'dateTaken'
  | 'gpsLatitude'
  | 'gpsLongitude'
  | 'copyright'
  | 'creator';

/** A fully typed, validated write intent — the ONLY input the argument
 *  builder accepts for writes. Constructed exclusively by the server from
 *  validated API payloads; never from raw command text. */
export interface TagWriteIntent {
  /** Curated field or validated catalog tag, group-qualified. */
  tag: string;
  op: TagEditOperation;
  /**
   * VALUE slot contents. The builder rejects embedded newlines and leading
   * `-`; an absent value with `op: 'delete'` produces the bare `-TAG=`
   * deletion form, and nothing else ever does.
   */
  value?: string;
}

/**
 * An in-band problem reported by exiftool for one file. These arrive inside
 * the JSON payload (or stderr text), never as an exit code, and are the only
 * source of truth for per-file success or failure.
 */
export interface ExifDiagnostic {
  severity: 'error' | 'warning' | 'minor';
  message: string;
  /** The file the diagnostic applies to, when known. */
  sourceFile?: string;
}

/** Result of the `-ver` health handshake. */
export interface EngineVersionInfo {
  ok: boolean;
  version: string;
  readOnlyFallback: boolean;
  reason?: string;
}

/** A single completed engine request, resolved after `{readyN}`. */
export interface EngineRequestResult<T = unknown> {
  /** The numbered execute token this response belongs to. */
  executeNumber: number;
  /** Parsed `-j` JSON objects, when the command produced JSON. */
  json: T[];
  /** Raw stdout captured between the request and `{readyN}`. */
  stdout: string;
  /** stderr for this command, when any. */
  stderr: string;
  /** In-band diagnostics extracted from the payload/stderr. */
  diagnostics: ExifDiagnostic[];
}
