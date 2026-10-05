import { useEffect, useState } from 'react';
import { createDiagnosticsBundle, type DiagnosticsBundleResult } from '../../api/client';
import { copyText } from '../../lib/clipboard';
import { Button } from '../../components/ui/button';
import { ErrorBanner } from '../../components/ErrorBanner';

/**
 * Settings › Support (leaf 2.2.1): build a diagnostics support bundle.
 *
 * The server writes the bundle to its data folder AND streams the same bytes
 * back; this card shows the on-disk path (the part a helper actually needs),
 * never claims anything was "sent", and says plainly what is inside.
 */
export function SupportCard() {
  const [busy, setBusy] = useState(false);
  const [bundle, setBundle] = useState<DiagnosticsBundleResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [copyNote, setCopyNote] = useState<string | null>(null);

  // Each new bundle replaces the previous object URL; the last one is released
  // when this card unmounts.
  useEffect(
    () => () => {
      if (bundle !== null) URL.revokeObjectURL(bundle.blobUrl);
    },
    [bundle],
  );

  const create = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setCopyNote(null);
    try {
      setBundle(await createDiagnosticsBundle());
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  const saveCopy = (): void => {
    if (bundle === null) return;
    const anchor = document.createElement('a');
    anchor.href = bundle.blobUrl;
    anchor.download = bundle.filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  };

  const copyPath = async (): Promise<void> => {
    const savedPath = bundle?.savedPath;
    if (savedPath === null || savedPath === undefined) return;
    const copied = await copyText(savedPath);
    setCopyNote(
      copied
        ? 'Path copied to the clipboard.'
        : 'Could not copy automatically — select the path and copy it by hand.',
    );
  };

  return (
    <section className="rounded-lg border border-border px-4 py-4" aria-label="Support">
      <h2 className="text-sm font-semibold">Support</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        When something behaves oddly, this gathers MetaDesk&apos;s own records into one small zip
        you can hand to a helper.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void create()}>
          {busy ? 'Creating the bundle…' : 'Create diagnostics bundle'}
        </Button>
        <span className="text-xs text-muted-foreground">
          Builds a zip of MetaDesk&apos;s records — it fixes nothing and sends nothing.
        </span>
      </div>

      {error !== undefined && error !== null && (
        <div className="mt-2">
          <ErrorBanner error={error} context="Diagnostics bundle" onRetry={() => void create()} />
        </div>
      )}

      {bundle !== null && (
        <div
          className="mt-3 rounded border border-success/40 bg-success/5 px-3 py-2"
          role="status"
          aria-label="Diagnostics bundle result"
        >
          <div className="text-sm font-medium text-success">Diagnostics bundle created</div>
          <div className="mt-1 text-xs text-muted-foreground">Saved on this computer at:</div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="min-w-0 break-all font-mono text-xs text-foreground" data-testid="diagnostics-saved-path">
              {bundle.savedPath ?? '(MetaDesk could not report the saved location — use Save a copy below.)'}
            </span>
            {bundle.savedPath !== null && (
              <Button size="sm" variant="outline" onClick={() => void copyPath()}>
                Copy path
              </Button>
            )}
          </div>
          {copyNote !== null && <p className="mt-1 text-xs text-muted-foreground">{copyNote}</p>}
          <p className="mt-2 text-xs text-muted-foreground">
            Inside: the tail of MetaDesk&apos;s change journal (file paths and the tag values it
            wrote — never the photos), the ExifTool engine version, the app and Node version
            numbers, and the data-folder location.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Nothing was sent anywhere. The bundle stays on this computer until you choose to share
            it — attach the zip to an email or a support message yourself.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={saveCopy}>
              Save a copy…
            </Button>
            <span className="text-xs text-muted-foreground">
              also drops a copy into your browser&apos;s usual Downloads folder, in case that is
              easier to find.
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
