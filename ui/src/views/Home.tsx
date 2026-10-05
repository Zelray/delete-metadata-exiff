import { useMemo, useRef, useState, type DragEvent } from 'react';
import type { FolderScanRequest, FolderScanResult } from '@metadesk/shared';
import { useUiStore } from '../state/store';
import { useFolderScan } from '../state/queries';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input, Toggle } from '../components/ui/controls';
import { Badge } from '../components/ui/badge';
import { ErrorBanner } from '../components/ErrorBanner';
import { EmptyState } from '../components/EmptyState';
import { CommandPreviewChips } from '../components/CommandPreviewChips';
import { formatBytes } from '../lib/format';
import { copyText } from '../lib/clipboard';
import { navigate } from '../lib/router';

/** Filter chips → -ext groups (lowercase extensions, no dots). */
const TYPE_CHIPS: Array<{ id: string; label: string; extensions: string[] }> = [
  { id: 'jpg', label: 'JPG', extensions: ['jpg', 'jpeg'] },
  {
    id: 'raw',
    label: 'RAW',
    extensions: ['cr2', 'cr3', 'nef', 'arw', 'dng', 'raf', 'orf', 'rw2', 'pef', 'srw'],
  },
  { id: 'video', label: 'Video', extensions: ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'mts'] },
  { id: 'pdf', label: 'PDF', extensions: ['pdf'] },
  { id: 'heic', label: 'HEIC', extensions: ['heic', 'heif'] },
  { id: 'all', label: 'All', extensions: [] },
];

const DEFAULT_REQUEST: FolderScanRequest = {
  folder: '',
  recursive: true,
  extensions: [],
  excludeEngineArtifacts: true,
};

/**
 * Home / Folder Browser (ux-spec): one folder at a time, no library-import
 * ceremony. Recents, recursive toggle with a plain hint, type chips + custom
 * box, preflight report before the grid, and drag-drop explained honestly.
 */
export function Home() {
  const recents = useUiStore((s) => s.recents);
  const pushRecent = useUiStore((s) => s.pushRecent);
  const setScan = useUiStore((s) => s.setScan);
  const setSearchText = useUiStore((s) => s.setSearchText);
  const setNextCommand = useUiStore((s) => s.setNextCommand);

  const [folder, setFolder] = useState('');
  const [recursive, setRecursive] = useState(true);
  const [activeChips, setActiveChips] = useState<string[]>(['all']);
  const [customExtensions, setCustomExtensions] = useState('');
  const [request, setRequest] = useState<FolderScanRequest | null>(null);
  const [dropNotice, setDropNotice] = useState(false);
  const [copiedPattern, setCopiedPattern] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  const scanQuery = useFolderScan(request);
  const scanResult = scanQuery.data;

  const chipsAreDefault = useMemo(
    () => activeChips.length === 0 || activeChips.includes('all'),
    [activeChips],
  );

  const effectiveExtensions = useMemo(() => {
    if (chipsAreDefault && customExtensions.trim() === '') return undefined;
    const set = new Set<string>();
    if (!chipsAreDefault) {
      for (const chip of TYPE_CHIPS) {
        if (activeChips.includes(chip.id)) chip.extensions.forEach((ext) => set.add(ext));
      }
    }
    for (const ext of customExtensions.split(/[,\s]+/)) {
      const clean = ext.trim().toLowerCase().replace(/^\./, '');
      if (clean !== '') set.add(clean);
    }
    return set.size > 0 ? [...set] : undefined;
  }, [activeChips, chipsAreDefault, customExtensions]);

  const runScan = () => {
    const trimmed = folder.trim();
    if (trimmed === '') return;
    setSearchText('');
    setRequest({
      ...DEFAULT_REQUEST,
      folder: trimmed,
      recursive,
      extensions: effectiveExtensions,
    });
  };

  const openGrid = () => {
    if (request === null || scanResult === undefined) return;
    setScan(request, scanResult);
    pushRecent(scanResult.folder);
    setNextCommand(
      buildScanPreviewArgs(scanResult, request),
      `scan ${scanResult.folder}`,
      true,
    );
    navigate('/browse');
  };

  // Drag-drop honesty: browsers withhold absolute paths from web pages.
  // The Tauri wrap (later leaf) provides real paths; until then the drop zone
  // explains the situation and offers the path pattern to paste.
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDropNotice(true);
  };

  const copyPattern = async () => {
    const ok = await copyText('C:\\full\\path\\to\\your\\folder');
    setCopiedPattern(ok);
    setTimeout(() => setCopiedPattern(false), 1500);
  };

  return (
    <div
      ref={dropRef}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
      className="mx-auto max-w-3xl space-y-6 p-6"
    >
      <header className="space-y-1">
        <h1 className="text-lg font-semibold">Open a folder</h1>
        <p className="text-sm text-muted-foreground">
          One folder at a time. MetaDesk reads it read-only; nothing changes until you say so —
          and even then you preview first.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Folder path</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') runScan();
              }}
              placeholder="C:\Users\you\Pictures\2026-06 — absolute path"
              aria-label="Absolute folder path"
              spellCheck={false}
            />
            <Button variant="primary" onClick={runScan} disabled={folder.trim() === ''}>
              Scan
            </Button>
          </div>

          {/* Drop zone, explained honestly */}
          <div
            className="rounded-lg border border-dashed border-border px-4 py-3 text-xs text-muted-foreground"
            aria-label="Drag-and-drop zone"
          >
            You can also drag a folder here — but browsers hide the folder's real location from
            web pages, so MetaDesk can't get the full path that way yet. Drop anything to see the
            pattern to paste, or type the path above. (The desktop-app wrap will make drops work
            directly.)
          </div>

          {dropNotice && (
            <div className="rounded-lg border border-border bg-muted px-4 py-3 text-sm">
              <div className="font-medium">About that drop…</div>
              <p className="mt-1 text-muted-foreground">
                Windows browsers only hand over the file name, not the absolute path — an honest
                limit of the sandbox, not a bug. Paste the pattern below into the path box and
                replace the parts after the drive letter:
              </p>
              <div className="mt-2 flex items-center gap-2">
                <code className="rounded bg-card px-2 py-1 font-mono text-xs">
                  C:\full\path\to\your\folder
                </code>
                <Button size="sm" variant="outline" onClick={() => void copyPattern()}>
                  {copiedPattern ? 'Copied' : 'Copy pattern'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDropNotice(false)}>
                  Dismiss
                </Button>
              </div>
            </div>
          )}

          <Toggle
            id="recursive"
            checked={recursive}
            onChange={setRecursive}
            label="Include subfolders"
            hint="Scans every folder inside this one, all the way down (exiftool -r)."
          />

          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              File types
            </div>
            <div className="flex flex-wrap gap-1.5">
              {TYPE_CHIPS.map((chip) => {
                const active = chipsAreDefault
                  ? chip.id === 'all'
                  : activeChips.includes(chip.id);
                return (
                  <button
                    key={chip.id}
                    type="button"
                    aria-pressed={active}
                    title={
                      chip.extensions.length > 0
                        ? `Extensions: ${chip.extensions.join(', ')}`
                        : 'Every file type the scanner recognizes'
                    }
                    onClick={() => {
                      setActiveChips((current) => {
                        if (chip.id === 'all') return ['all'];
                        const withoutAll = current.filter((id) => id !== 'all');
                        return withoutAll.includes(chip.id)
                          ? withoutAll.filter((id) => id !== chip.id)
                          : [...withoutAll, chip.id];
                      });
                    }}
                    className={`rounded-full border px-3 py-1 text-xs font-medium ${
                      active
                        ? 'border-transparent bg-accent text-accent-foreground'
                        : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'
                    }`}
                  >
                    {chip.label}
                  </button>
                );
              })}
            </div>
            <Input
              value={customExtensions}
              onChange={(event) => setCustomExtensions(event.target.value)}
              placeholder="Custom extensions, comma separated — e.g. pfm, exr, xmp"
              aria-label="Custom extensions"
              spellCheck={false}
              className="h-8 text-xs"
            />
          </div>
        </CardContent>
      </Card>

      {recents.length > 0 && (
        <section aria-label="Recent folders">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Recent folders
          </div>
          <div className="flex flex-wrap gap-1.5">
            {recents.map((recent) => (
              <button
                key={recent}
                type="button"
                title={recent}
                onClick={() => {
                  setFolder(recent);
                  setSearchText('');
                  setRequest({ ...DEFAULT_REQUEST, folder: recent, recursive });
                }}
                className="max-w-80 truncate rounded-full border border-border px-3 py-1 text-xs font-mono text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {recent}
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Preflight report */}
      {request !== null && (
        <section aria-label="Preflight report">
          {scanQuery.isError && (
            <ErrorBanner
              error={scanQuery.error}
              context="Scanning the folder"
              onRetry={() => void scanQuery.refetch()}
            />
          )}
          {scanQuery.isPending && (
            <Card>
              <CardContent className="py-6 text-sm text-muted-foreground">
                Counting files and checking the folder… nothing is being modified.
              </CardContent>
            </Card>
          )}
          {scanQuery.isSuccess && scanResult !== undefined && (
            <Card>
              <CardHeader className="flex items-center justify-between">
                <CardTitle>Preflight — what's in there</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
                  <span className="text-base font-semibold">
                    {scanResult.totalFiles.toLocaleString()} files
                  </span>
                  <span className="text-muted-foreground">
                    {formatBytes(scanResult.totalBytes)}
                    {scanResult.freeBytes !== undefined && (
                      <> of space used · {formatBytes(scanResult.freeBytes)} free on the drive</>
                    )}
                  </span>
                  {scanResult.recursive && <Badge tone="neutral">subfolders included</Badge>}
                  {scanResult.entries.length === 0 && (
                    <Badge tone="warning">no recognizable media files</Badge>
                  )}
                </div>

                {scanResult.warnings.length > 0 && (
                  <ul className="list-disc space-y-1 pl-5 text-sm text-warning">
                    {scanResult.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                )}

                {scanResult.rejectedPaths.length > 0 && (
                  <details className="text-sm">
                    <summary className="cursor-pointer text-muted-foreground">
                      {scanResult.rejectedPaths.length} path(s) were refused — see why
                    </summary>
                    <ul className="mt-1 space-y-1 pl-5">
                      {scanResult.rejectedPaths.map((rejected) => (
                        <li key={rejected.path} className="font-mono text-xs">
                          {rejected.path}
                          <span className="ml-2 font-sans text-muted-foreground">
                            {rejected.reason}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}

                {scanResult.unreadableDirectories.length > 0 && (
                  <details className="text-sm">
                    <summary className="cursor-pointer text-muted-foreground">
                      {scanResult.unreadableDirectories.length} folder(s) could not be read
                    </summary>
                    <ul className="mt-1 space-y-1 pl-5">
                      {scanResult.unreadableDirectories.map((unreadable) => (
                        <li key={unreadable.path} className="font-mono text-xs">
                          {unreadable.path}
                          <span className="ml-2 font-sans text-muted-foreground">
                            {unreadable.reason}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}

                <CommandPreviewChips
                  argv={buildScanPreviewArgs(scanResult, request)}
                  className="pt-1"
                />

                <div className="flex gap-2 pt-1">
                  <Button
                    variant="primary"
                    onClick={openGrid}
                    disabled={scanResult.entries.length === 0}
                  >
                    Open grid ({scanResult.entries.length.toLocaleString()} files)
                  </Button>
                  <Button variant="ghost" onClick={() => setRequest(null)}>
                    Back
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </section>
      )}

      {request === null && recents.length === 0 && (
        <EmptyState title="Start by scanning one folder">
          Paste a path above — like <code className="font-mono text-xs">C:\Users\you\Pictures</code>{' '}
          — choose whether subfolders count, and MetaDesk will show you exactly what it found
          before opening anything.
        </EmptyState>
      )}
    </div>
  );
}

/**
 * The read command this scan stands for — shown so the CLI habit builds from
 * the very first screen (trust-and-teaching, ux-spec). Pure argv (no
 * 'exiftool' word): that's what the server would execute.
 */
function buildScanPreviewArgs(
  result: FolderScanResult,
  request: FolderScanRequest,
): string[] {
  const args = ['-j', '-G1', '-a', '-struct'];
  if (request.recursive) args.push('-r');
  if (request.extensions !== undefined && request.extensions.length > 0) {
    args.push('-ext', request.extensions.join(','));
  }
  args.push(result.folder);
  return args;
}
