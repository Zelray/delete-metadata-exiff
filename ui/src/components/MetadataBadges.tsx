import { Badge } from './ui/badge';
import type { FileBadges } from '../state/store';

/**
 * The grid's quick badges (ux-spec): has GPS (pin), has Copyright,
 * Edited-by-this-app, AI-generation.
 *
 * The AI badge is a placeholder by design — detection arrives with the write
 * pipeline (leaf 1.1.4) and its grid/detail surfaces (leaf 1.1.5). The render
 * hook exists now so nothing later has to be retrofitted.
 */
export interface MetadataBadgeModel extends FileBadges {
  editedCount: number | null;
}

export function GpsBadge() {
  return (
    <span className="tip">
      <Badge tone="info" aria-label="Has GPS location">GPS</Badge>
      <span className="tip-body">This file carries GPS coordinates — where it was taken.</span>
    </span>
  );
}

export function CopyrightBadge() {
  return (
    <span className="tip">
      <Badge tone="neutral" aria-label="Has copyright">©</Badge>
      <span className="tip-body">This file carries a Copyright or Artist credit.</span>
    </span>
  );
}

export function EditedBadge({ count }: { count: number }) {
  return (
    <span className="tip">
      <Badge tone="accent" aria-label={`Edited by MetaDesk, ${count} changes`}>
        Edited{count > 0 ? ` ·${count}` : ''}
      </Badge>
      <span className="tip-body">Edited by MetaDesk. The change journal arrives with write mode.</span>
    </span>
  );
}

/**
 * AI-generation badge placeholder. Renders only when a detector has flagged
 * the file (`aiGenerated === true`); detection lands in a later leaf, so the
 * badge slot is present but silent today — honest, never speculative.
 */
export function AiBadge() {
  return (
    <span className="tip">
      <Badge tone="warning" aria-label="AI generation signals found">AI</Badge>
      <span className="tip-body">
        Generation metadata from an AI tool (Stable Diffusion, ComfyUI, NovelAI, C2PA…) was
        detected in this file. Detection arrives with the write pipeline.
      </span>
    </span>
  );
}

/**
 * Legend chip shown in the grid toolbar so the badge vocabulary is
 * discoverable before any badge has lit up.
 */
export function AiBadgeLegend() {
  return (
    <span className="tip">
      <Badge tone="neutral" className="opacity-60" aria-label="AI-generated badge coming soon">
        AI · soon
      </Badge>
      <span className="tip-body">
        A badge that will mark files carrying AI-generation metadata. Detection arrives with the
        write pipeline — no files are flagged yet.
      </span>
    </span>
  );
}

/** Compose the badge row for one file from learned badge knowledge. */
export function MetadataBadgeRow({ model }: { model: MetadataBadgeModel }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {model.hasGps && <GpsBadge />}
      {model.hasCopyright && <CopyrightBadge />}
      {model.editedCount !== null && <EditedBadge count={model.editedCount} />}
      {model.aiGenerated === true && <AiBadge />}
    </div>
  );
}
