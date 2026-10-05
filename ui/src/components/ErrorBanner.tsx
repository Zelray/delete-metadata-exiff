import type { ApiErrorCode } from '@metadesk/shared';
import { MetaApiError, TransportError } from '../api/client';
import { Button } from './ui/button';

/**
 * Plain-English error surfacing. The API's `message` is written for humans
 * (pathGuard copy especially) and is shown verbatim; the code only selects a
 * suggested next action so Mike always has a move to make.
 */
const RECOVERY_HINTS: Partial<Record<ApiErrorCode, string>> = {
  bad_request: 'Check the value and try again — nothing was changed.',
  not_found: 'The item is gone or was renamed. Refresh the folder to see what is there now.',
  path_rejected: 'Use a full absolute path (starting with a drive letter, like C:\\Photos).',
  read_only_mode: 'The session is read-only. Viewing works; editing is off until the engine is verified.',
  write_locked: 'A write is already in progress. Wait for it to finish before starting another.',
  engine_unavailable: 'The exiftool engine is not answering. Restart MetaDesk from the launcher, then retry.',
  engine_version_unsupported: 'This exiftool version is too old for MetaDesk. Update the bundled copy.',
  preview_required: 'MetaDesk previews before it changes anything — open the action again to build the preview.',
  unsafe_tag: 'That tag is not safe to change here. Pick it from the friendly field list instead.',
  internal_error: 'Something failed inside MetaDesk. Retry; if it repeats, copy the diagnostics bundle from Settings.',
};

export interface ErrorBannerProps {
  error: unknown;
  /** Optional retry — shown when the caller can safely re-run the read. */
  onRetry?: () => void;
  /** Context line, e.g. "Reading metadata". Shown above the message. */
  context?: string;
}

function describe(error: unknown): { message: string; hint: string } {
  if (error instanceof MetaApiError) {
    return {
      message: error.message,
      hint: RECOVERY_HINTS[error.code] ?? 'Nothing was changed. Retry the action.',
    };
  }
  if (error instanceof TransportError) {
    return {
      message: error.message,
      hint: RECOVERY_HINTS.engine_unavailable as string,
    };
  }
  if (error instanceof Error) {
    return { message: error.message, hint: 'Nothing was changed. Retry the action.' };
  }
  return { message: String(error), hint: 'Nothing was changed. Retry the action.' };
}

export function ErrorBanner({ error, onRetry, context }: ErrorBannerProps) {
  const { message, hint } = describe(error);
  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm"
    >
      {context !== undefined && (
        <div className="text-xs font-semibold uppercase tracking-wide text-destructive/80 mb-1">
          {context}
        </div>
      )}
      <div className="text-foreground">{message}</div>
      <div className="text-muted-foreground mt-1">{hint}</div>
      {onRetry !== undefined && (
        <div className="mt-2.5">
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}
