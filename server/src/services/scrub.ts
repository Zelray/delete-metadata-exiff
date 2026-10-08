/**
 * The AI-generation metadata scrubber (leaf 1.1.4).
 *
 * DETECT scans the existing all-tier read (one `-j -G1 -a -struct` pass per
 * batch) for the Stable-Diffusion-family tag set that prior art verified in
 * the generators' own source:
 *
 *  - A1111 `parameters` PNG text chunk (exiftool exposes the lowercase chunk
 *    keyword as PNG:Parameters), with the JPEG fallback to EXIF:UserComment;
 *  - ComfyUI `prompt` / `workflow` chunks — exiftool EXTRACTS arbitrary PNG
 *    text chunks but refuses to write/delete the unlisted ones by name
 *    (PNG.pm: "The tags listed below are the only ones that can be written");
 *  - NovelAI Software/Comment/Description chunks PLUS stealth pnginfo hidden
 *    in the alpha channel, which NO metadata tool can see or remove;
 *  - generic software fingerprints (automatic1111, stable diffusion, comfyui,
 *    novelai, fooocus, invokeai, dall-e, midjourney, firefly);
 *  - XMP/IPTC description and caption fields carrying generated-text;
 *  - C2PA / JUMBF Content Credential manifests.
 *
 * HONESTY CONTRACT (copied from the commercial tools): some generators hide
 * prompts inside pixel data (NovelAI stealth alpha pnginfo) or burn invisible
 * watermarks (SynthID). Those are NOT metadata and no metadata tool can
 * remove them. MetaDesk reports the risk plainly instead of claiming a clean
 * file it cannot prove.
 *
 * WIPE rides the ordinary write pipeline — same preview, same default-mode
 * backups, same journal, same re-read verification — behind the destructive
 * gates: a typed confirmation phrase and a mandatory pre-write export of the
 * full found values to a sidecar JSON beside the journal.
 *
 * Only tags the engine can delete BY NAME are wiped. ComfyUI prompt/workflow
 * chunks, C2PA/JUMBF manifests and anything living in pixels are detected,
 * reported, and explicitly listed under "cannot be removed" — never silently
 * skipped, never removed by a group delete (forbidden in v1).
 */
import type { ScrubScope, TagEdit } from '@metadesk/shared';
import type { ExifToolSession } from '../engine/exiftoolSession.js';
import { RAW_EXTENSIONS, readAllTierByPath, writeDestructiveExport } from './destructiveFlow.js';
import { newRecordId } from './journal.js';
import { normalizeExifPath } from './exifPath.js';
import { matchesTagKey, WritePipeline, WritePipelineError, type ExecuteResult } from './writePipeline.js';

/** The phrase the user must type to run a scrub. Stable and documented. */
export const SCRUB_CONFIRMATION_PHRASE = 'REMOVE AI METADATA';

/** Software fingerprints that mark a file as AI-generated (prior-art list). */
export const AI_SOFTWARE_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = Object.freeze([
  { label: 'automatic1111', pattern: /automatic\s*1111|a1111/i },
  { label: 'stable diffusion', pattern: /stable\s*diffusion|stablediffusion/i },
  { label: 'comfyui', pattern: /comfy\s*ui|comfyui/i },
  { label: 'novelai', pattern: /novel\s*ai|novelai/i },
  { label: 'fooocus', pattern: /fooocus/i },
  { label: 'invokeai', pattern: /invoke\s*ai|invokeai/i },
  { label: 'dall-e', pattern: /dall[- ]?e|openai/i },
  { label: 'midjourney', pattern: /mid\s*journey/i },
  { label: 'firefly', pattern: /firefly|adobe\s*firefly/i },
]);

/**
 * Tags the engine can delete BY NAME, matched case-insensitively against
 * read keys. Everything else detected is reported, not wiped.
 */
export const SCRUB_WIPE_TAGS: readonly string[] = Object.freeze([
  'PNG:Parameters',
  'PNG:Comment',
  'PNG:Description',
  'PNG:Software',
  'EXIF:UserComment',
  'EXIF:Software',
  'XMP-dc:Description',
  'IPTC:Caption-Abstract',
]);

/** Additional tags worth surfacing in the report when present. */
const DETECT_NOTICE_KEYS: ReadonlyArray<{ match: RegExp; note: string }> = Object.freeze([
  {
    match: /^png:prompt$/i,
    note: 'A ComfyUI "prompt" chunk. The engine cannot delete this chunk by name (only a whole-group delete could), so MetaDesk flags it instead of pretending to remove it.',
  },
  {
    match: /^png:workflow$/i,
    note: 'A ComfyUI "workflow" chunk (the full generation graph). The engine cannot delete this chunk by name, so MetaDesk flags it instead of pretending to remove it.',
  },
]);

/** Value length shown in reports unless full values are requested. */
const VALUE_PREVIEW_LENGTH = 160;

export interface ScrubTagFinding {
  /** The tag/group key as exiftool reported it. */
  tag: string;
  /** Value (truncated unless full values were requested). */
  value: string;
  /** true when the engine can delete this tag by name. */
  removable: boolean;
  /** Plain-English note for tags that are detected but not removable. */
  note?: string;
}

export interface ScrubFileFinding {
  filePath: string;
  softwareMatches: string[];
  tags: ScrubTagFinding[];
  c2paPresent: boolean;
  jumbfPresent: boolean;
  /** PNG color type carries an alpha channel. */
  alphaChannel: boolean;
  /**
   * true when hidden pixel-level data is plausible: a PNG with an alpha
   * channel, or a NovelAI fingerprint (stealth pnginfo lives in alpha data).
   */
  possibleHiddenAlphaData: boolean;
  hiddenAlphaNote?: string;
  /** Set when the file type is excluded from scrubbing entirely (RAW). */
  blockedReason?: string;
}

export interface ScrubDetection {
  scrubId: string;
  scope: ScrubScope;
  createdAt: string;
  files: ScrubFileFinding[];
  /** Removable tags found, as (file, tag, value) rows for the confirmation UI. */
  affectedTags: Array<{ filePath: string; tag: string; value: string }>;
  /** Files with no AI metadata at all. */
  cleanFilePaths: string[];
  /** Files refused entirely (RAW protection). */
  blockedFilePaths: Array<{ filePath: string; reason: string }>;
  requiresTypedConfirmation: true;
  confirmationPhrase: string;
}

export interface ScrubWipeResult {
  detection: ScrubDetection;
  /** Path of the mandatory pre-write export beside the journal. */
  exportedValuesPath: string;
  /** The pipeline result (updated/unchanged/failed per file). */
  result: ExecuteResult;
  /** Detected-but-not-removable items, restated for the response. */
  notRemoved: Array<{ filePath: string; tag: string; reason: string }>;
}

export interface ScrubServiceOptions {
  engine: ExifToolSession;
  pipeline: WritePipeline;
  dataDir: string;
}

const DETECT_BATCH = 50;

export class ScrubService {
  private readonly engine: ExifToolSession;
  private readonly pipeline: WritePipeline;

  constructor(options: ScrubServiceOptions) {
    this.engine = options.engine;
    this.pipeline = options.pipeline;
  }

  // ---- detect -----------------------------------------------------------------

  /** Scan files for AI-generation metadata. Read-only; never touches files. */
  async detect(files: readonly string[], opts: { includeFullValues?: boolean } = {}): Promise<ScrubDetection> {
    const scrubId = newRecordId('sc');
    const findings: ScrubFileFinding[] = [];
    const affectedTags: Array<{ filePath: string; tag: string; value: string }> = [];
    const cleanFilePaths: string[] = [];
    const blockedFilePaths: Array<{ filePath: string; reason: string }> = [];

    for (let offset = 0; offset < files.length; offset += DETECT_BATCH) {
      const batch = files.slice(offset, offset + DETECT_BATCH);
      const readable: string[] = [];
      for (const filePath of batch) {
        const extension = (filePath.split('.').pop() ?? '').toLowerCase();
        if (RAW_EXTENSIONS.has(extension)) {
          blockedFilePaths.push({
            filePath,
            reason:
              'RAW files are limited to an approved safe tag set in this version; the AI scrub is not on it. Nothing was or will be changed.',
          });
          continue;
        }
        readable.push(filePath);
      }
      if (readable.length === 0) continue;

      // The existing all-tier read shape: -j -G1 -a -struct over the batch.
      const byPath = await readAllTierByPath(this.engine, readable);

      for (const filePath of readable) {
        const doc = byPath.get(normalizeExifPath(filePath));
        if (doc === undefined) {
          // Unreadable file: surface as a blocked row, not a silent skip.
          blockedFilePaths.push({
            filePath,
            reason: 'No metadata could be read from this file, so it cannot be scanned.',
          });
          continue;
        }
        const finding = this.findingForFile(filePath, doc, opts.includeFullValues === true);
        findings.push(finding);
        for (const tag of finding.tags) {
          if (tag.removable) {
            affectedTags.push({ filePath, tag: canonicalWipeTag(tag.tag), value: tag.value });
          }
        }
        if (finding.tags.length === 0 && !finding.c2paPresent && !finding.jumbfPresent) {
          cleanFilePaths.push(filePath);
        }
      }
    }

    return {
      scrubId,
      scope: 'ai-generation-metadata',
      createdAt: new Date().toISOString(),
      files: findings,
      affectedTags,
      cleanFilePaths,
      blockedFilePaths,
      requiresTypedConfirmation: true,
      confirmationPhrase: SCRUB_CONFIRMATION_PHRASE,
    };
  }

  // ---- wipe ---------------------------------------------------------------------

  /**
   * Wipe the removable AI-generation tags through the write pipeline with the
   * full destructive gate set. `confirm` must equal the confirmation phrase.
   */
  async wipe(files: readonly string[], confirm: string): Promise<ScrubWipeResult> {
    if (confirm !== SCRUB_CONFIRMATION_PHRASE) {
      throw new WritePipelineError(
        'destructive_confirmation_required',
        `Removing AI metadata is destructive and one-way once backups are gone. Type "${SCRUB_CONFIRMATION_PHRASE}" to confirm. Nothing was written.`,
      );
    }

    // Full values for the export; the report truncates.
    const detection = await this.detect(files, { includeFullValues: true });
    const wipeTargets = [...new Set(detection.affectedTags.map((row) => row.filePath))];
    if (wipeTargets.length === 0) {
      throw new WritePipelineError(
        'validation',
        'No removable AI-generation metadata was found in the selected files. Nothing to wipe.',
        { blockedFilePaths: detection.blockedFilePaths },
      );
    }

    // Mandatory pre-write export of the FULL values being destroyed (req #14
    // pattern): the only copy of the prompts after the wipe is this file.
    const scrubId = detection.scrubId;
    const exportPath = await writeDestructiveExport(this.pipeline.journal, scrubId, {
      scrubId,
      scope: detection.scope,
      exportedAt: new Date().toISOString(),
      confirmationPhrase: SCRUB_CONFIRMATION_PHRASE,
      values: detection.affectedTags,
      notRemovable: detection.files.flatMap((f) =>
        f.tags.filter((t) => !t.removable).map((t) => ({ filePath: f.filePath, tag: t.tag, note: t.note })),
      ),
      hiddenDataWarnings: detection.files
        .filter((f) => f.possibleHiddenAlphaData || f.c2paPresent || f.jumbfPresent)
        .map((f) => ({
          filePath: f.filePath,
          possibleHiddenAlphaData: f.possibleHiddenAlphaData,
          c2paPresent: f.c2paPresent,
          jumbfPresent: f.jumbfPresent,
        })),
    });

    // One shared delete list (tags found anywhere); files without a given tag
    // classify as 'unchanged' — visible in the results, never hidden.
    const edits: TagEdit[] = [
      ...new Set(detection.affectedTags.map((row) => canonicalWipeTag(row.tag))),
    ].map((tag) => ({ tag, op: 'delete' as const }));

    const envelope = await this.pipeline.preview({
      files: wipeTargets,
      edits,
      mode: 'scrub',
      description: `AI-metadata scrub: remove ${edits.length} tag type(s) from ${wipeTargets.length} file(s)`,
      destructive: {
        scope: 'ai-generation-metadata',
        confirmationPhrase: SCRUB_CONFIRMATION_PHRASE,
        allowedDeleteTags: SCRUB_WIPE_TAGS,
      },
      scrubId,
    });
    this.pipeline.setDestructiveExport(envelope.preview.previewId, exportPath);
    const result = await this.pipeline.execute(envelope.preview.previewId, {
      destructive: { confirmationPhrase: confirm },
    });

    const notRemoved = detection.files.flatMap((f) =>
      [
        ...f.tags.filter((t) => !t.removable).map((t) => ({ filePath: f.filePath, tag: t.tag, reason: t.note ?? 'Not removable by name.' })),
        ...(f.possibleHiddenAlphaData
          ? [
              {
                filePath: f.filePath,
                tag: '(pixel data / alpha channel)',
                reason:
                  f.hiddenAlphaNote ??
                  'Some tools hide prompts in pixel data (alpha channel) or burn watermarks (SynthID). No metadata tool can remove these; MetaDesk flags the risk instead of claiming a clean file.',
              },
            ]
          : []),
        ...(f.c2paPresent || f.jumbfPresent
          ? [
              {
                filePath: f.filePath,
                tag: f.c2paPresent ? 'C2PA manifest' : 'JUMBF structure',
                reason:
                  'Content Credentials (C2PA) live in a JUMBF structure that can only be removed with a group delete, which this version refuses. Flagged, not removed.',
              },
            ]
          : []),
      ],
    );

    return { detection, exportedValuesPath: exportPath, result, notRemoved };
  }

  // ---- internals -----------------------------------------------------------------

  private findingForFile(
    filePath: string,
    doc: Record<string, unknown>,
    includeFullValues: boolean,
  ): ScrubFileFinding {
    const entries = Object.entries(doc).filter(([key]) => key !== 'SourceFile');

    // Software fingerprints over every value in the file.
    const softwareMatches: string[] = [];
    for (const [key, value] of entries) {
      if (key === 'SourceFile' || typeof value !== 'string') continue;
      for (const { label, pattern } of AI_SOFTWARE_PATTERNS) {
        if (pattern.test(value) && !softwareMatches.includes(label)) softwareMatches.push(label);
      }
    }

    const isPng = entries.some(([key]) => /^png:/i.test(key)) || /\.png$/i.test(filePath);
    const colorType = entries.find(([key]) => /^png:colou?rtype$/i.test(key));
    const colorTypeValue = colorType !== undefined ? String(doc[colorType[0]] ?? '') : '';
    const alphaChannel = /alpha/i.test(colorTypeValue) || /^[46]$/.test(colorTypeValue.trim());

    const tags: ScrubTagFinding[] = [];
    const seen = new Set<string>();
    for (const wipeTag of SCRUB_WIPE_TAGS) {
      for (const [key, value] of entries) {
        if (!matchesTagKey(key, wipeTag)) continue;
        if (seen.has(key.toLowerCase())) continue;
        seen.add(key.toLowerCase());
        const raw = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
        if (raw.length === 0) continue;
        tags.push({
          tag: key,
          value: includeFullValues ? raw : `${raw.slice(0, VALUE_PREVIEW_LENGTH)}${raw.length > VALUE_PREVIEW_LENGTH ? '…' : ''}`,
          removable: true,
        });
      }
    }
    for (const { match, note } of DETECT_NOTICE_KEYS) {
      for (const [key, value] of entries) {
        if (!match.test(key)) continue;
        const raw = typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
        if (raw.length === 0) continue;
        tags.push({
          tag: key,
          value: includeFullValues ? raw : `${raw.slice(0, VALUE_PREVIEW_LENGTH)}${raw.length > VALUE_PREVIEW_LENGTH ? '…' : ''}`,
          removable: false,
          note,
        });
      }
    }

    const c2paPresent = entries.some(
      ([key, value]) =>
        /c2pa/i.test(key) ||
        (typeof value === 'string' && /c2pa\.org/i.test(value)),
    );
    const jumbfPresent = entries.some(([key]) => /jumbf/i.test(key));

    const novelAI = softwareMatches.includes('novelai');
    const possibleHiddenAlphaData = isPng && (alphaChannel || novelAI);
    const hiddenAlphaNote =
      possibleHiddenAlphaData
        ? novelAI
          ? 'This file carries a NovelAI fingerprint. NovelAI hides generation data in the alpha channel ("stealth pnginfo") where metadata tools cannot see or remove it.'
          : 'This PNG has an alpha channel. Some tools hide generation data in alpha-channel pixels ("stealth pnginfo"); metadata tools cannot see or remove it.'
        : undefined;

    return {
      filePath,
      softwareMatches,
      tags,
      c2paPresent,
      jumbfPresent,
      alphaChannel,
      possibleHiddenAlphaData,
      ...(hiddenAlphaNote !== undefined ? { hiddenAlphaNote } : {}),
    };
  }
}

/**
 * Family-1 group -> the wipe-tag group base it belongs to. A detected
 * `IFD0:Software` must map to the `EXIF:Software` wipe tag, not to
 * `PNG:Software` — matching by bare tag name alone would collapse distinct
 * groups and silently fail to delete.
 */
const GROUP_TO_BASE: Readonly<Record<string, string>> = Object.freeze({
  exif: 'exif',
  ifd0: 'exif',
  exififd: 'exif',
  gps: 'exif',
  subifd: 'exif',
  interopifd: 'exif',
  png: 'png',
  iptc: 'iptc',
  'xmp-dc': 'xmp-dc',
  'xmp-xmp': 'xmp-xmp',
  'xmp-photoshop': 'xmp-photoshop',
  'xmp-mwg-rs': 'xmp-mwg-rs',
});

/** Map a detected read key to the canonical write-form wipe tag. */
function canonicalWipeTag(detectedTag: string): string {
  const colonIndex = detectedTag.indexOf(':');
  const group = (colonIndex > 0 ? detectedTag.slice(0, colonIndex) : '').toLowerCase();
  const bare = (detectedTag.split(':').pop() ?? '').toLowerCase();
  const base = GROUP_TO_BASE[group];
  if (base !== undefined) {
    for (const wipeTag of SCRUB_WIPE_TAGS) {
      const wipeColon = wipeTag.indexOf(':');
      const wipeGroup = (wipeColon > 0 ? wipeTag.slice(0, wipeColon) : '').toLowerCase();
      if (wipeGroup === base && (wipeTag.split(':').pop() ?? '').toLowerCase() === bare) {
        return wipeTag;
      }
    }
  }
  for (const wipeTag of SCRUB_WIPE_TAGS) {
    if ((wipeTag.split(':').pop() ?? '').toLowerCase() === bare) return wipeTag;
  }
  return detectedTag;
}
