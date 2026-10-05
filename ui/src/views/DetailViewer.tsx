import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { MetadataDepth, MetadataPayload } from '@metadesk/shared';
import { useMetadata, useThumbnail } from '../state/queries';
import { useUiStore, type FileBadges } from '../state/store';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input, Segmented } from '../components/ui/controls';
import { Skeleton } from '../components/ui/skeleton';
import { ErrorBanner } from '../components/ErrorBanner';
import { downloadBinary } from '../api/client';
import { formatDateTime, basename } from '../lib/format';
import { coordinatesForCopy, formatGpsLine, osmLink, toDms } from '../lib/gps';
import { copyText } from '../lib/clipboard';
import { navigate } from '../lib/router';

type Depth = Exclude<MetadataDepth, never>;
type ExtractState = { tag: string; busy: boolean; done: boolean; error: string | null };

/**
 * Detail Viewer / Inspector (ux-spec): large preview + file facts, collapsible
 * metadata groups with human names, three depths (Simple → All tags → Raw),
 * search-as-you-type across every group, GPS with an Open-map link, and
 * Extract buttons for binary tags. Lives in the right rail; the grid keeps
 * its place behind it.
 */
export function DetailViewer({ filePath, onClose }: { filePath: string; onClose: () => void }) {
  const [depth, setDepth] = useState<Depth>('simple');
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const noteBadges = useUiStore((s) => s.noteBadges);
  const [extracts, setExtracts] = useState<Record<string, ExtractState>>({});

  const query = useMetadata(filePath, depth);
  const payload = query.data;

  // Feed the grid's badge knowledge as soon as a file is understood.
  useEffect(() => {
    if (payload === undefined) return;
    const learned = badgesFromPayload(payload);
    noteBadges(filePath, learned);
  }, [payload, filePath, noteBadges]);

  const groups = useMemo(() => groupTags(payload), [payload]);

  // Search-as-you-type: filter rows, auto-expand groups with matches.
  const needle = search.trim().toLowerCase();
  const filteredGroups = useMemo(() => {
    if (needle === '') return groups;
    return groups
      .map((group) => ({
        ...group,
        rows: group.rows.filter(
          (row) =>
            row.name.toLowerCase().includes(needle) ||
            row.value.toLowerCase().includes(needle) ||
            row.group.toLowerCase().includes(needle),
        ),
      }))
      .filter((group) => group.rows.length > 0);
  }, [groups, needle]);

  useEffect(() => {
    if (needle === '') return;
    setCollapsed((current) => {
      const next = { ...current };
      for (const group of filteredGroups) next[group.key] = false;
      return next;
    });
  }, [needle, filteredGroups]);

  const extract = async (tag: string) => {
    setExtracts((current) => ({ ...current, [tag]: { tag, busy: true, done: false, error: null } }));
    try {
      await downloadBinary(filePath, tag);
      setExtracts((current) => ({ ...current, [tag]: { tag, busy: false, done: true, error: null } }));
    } catch (error) {
      setExtracts((current) => ({
        ...current,
        [tag]: { tag, busy: false, done: false, error: String(error) },
      }));
    }
  };

  return (
    <aside
      aria-label={`Inspector for ${basename(filePath)}`}
      className="flex h-full w-[30rem] shrink-0 flex-col border-l border-border bg-card"
    >
      {/* Header: preview + facts */}
      <div className="border-b border-border p-4">
        <div className="mb-3 flex items-start justify-between gap-2">
          <h2 className="min-w-0 truncate text-sm font-semibold" title={filePath}>
            {basename(filePath)}
          </h2>
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close inspector">
            Close
          </Button>
        </div>
        <DetailPreview filePath={filePath} payload={payload} />
        {payload !== undefined && (
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <Fact label="Type" value={payload.kind.toUpperCase()} />
            <Fact
              label="Read"
              value={new Date(payload.readAt).toLocaleTimeString()}
            />
            <Fact
              label="Depth"
              value={depth === 'simple' ? 'Simple' : depth === 'all' ? 'All tags' : 'Raw values'}
            />
            <Fact
              label="Size on disk"
              value={payload.kind === 'other' ? '—' : 'see grid'}
            />
          </dl>
        )}
      </div>

      {/* Depth toggle + search */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <Segmented<Depth>
          ariaLabel="Metadata depth"
          value={depth}
          onChange={(next) => {
            setDepth(next);
            setSearch('');
          }}
          options={[
            { value: 'simple', label: 'Simple', title: '~15 friendly fields' },
            { value: 'all', label: 'All tags', title: 'Every tag, grouped' },
            { value: 'raw', label: 'Raw', title: 'Machine values + tag IDs + extractable binaries' },
          ]}
        />
        <div className="min-w-0 flex-1">
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={depth === 'simple' ? 'Search (All tags / Raw)' : 'Search tags…'}
            aria-label="Search tags"
            disabled={depth === 'simple'}
            className="h-7 text-xs"
          />
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {query.isError && (
          <ErrorBanner
            error={query.error}
            context="Reading metadata"
            onRetry={() => void query.refetch()}
          />
        )}
        {query.isPending && (
          <div className="space-y-3">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-4 w-2/3" />
            <p className="text-xs text-muted-foreground">Reading the file… nothing is modified.</p>
          </div>
        )}

        {payload !== undefined && (
          <div className="space-y-3">
            {(payload.warnings.length > 0 || payload.errors.length > 0) && (
              <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
                {payload.errors.map((e) => (
                  <div key={e} className="text-destructive">{e}</div>
                ))}
                {payload.warnings.map((w) => (
                  <div key={w} className="text-foreground">{w}</div>
                ))}
              </div>
            )}

            {depth === 'simple' ? (
              <SimpleView payload={payload} />
            ) : (
              <>
                {needle !== '' && (
                  <p className="text-xs text-muted-foreground">
                    {filteredGroups.reduce((sum, g) => sum + g.rows.length, 0)} tag(s) match “{search}”
                    across all groups.
                  </p>
                )}
                {filteredGroups.map((group) => {
                  const isCollapsed = collapsed[group.key] === true;
                  return (
                    <section key={group.key} className="rounded-lg border border-border">
                      <button
                        type="button"
                        aria-expanded={!isCollapsed}
                        onClick={() =>
                          setCollapsed((current) => ({ ...current, [group.key]: !isCollapsed }))
                        }
                        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted"
                      >
                        <span className="text-xs" aria-hidden="true">
                          {isCollapsed ? '▸' : '▾'}
                        </span>
                        <span className="text-sm font-medium">{group.label}</span>
                        <span className="ml-auto text-xs text-muted-foreground">
                          {group.rows.length} tag{group.rows.length === 1 ? '' : 's'}
                        </span>
                      </button>
                      {!isCollapsed && (
                        <ul className="divide-y divide-border border-t border-border">
                          {group.rows.map((row) => (
                            <TagRow
                              key={row.id}
                              row={row}
                              needle={needle}
                              extractState={extracts[row.id]}
                              onExtract={() => void extract(row.id)}
                            />
                          ))}
                        </ul>
                      )}
                    </section>
                  );
                })}
                {filteredGroups.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    No tags match. In Raw view every tag the file carries appears — including
                    duplicates (labeled Copy1/Copy2) and binary tags with Extract buttons.
                  </p>
                )}
              </>
            )}

            {/* Reserved write-side actions — honest placeholders, not dead buttons */}
            <div className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
              “Validate this file” and “Diff against _original” arrive in a later leaf. Editing and
              the GPS strip live in the Edit panel; “Remove GPS” there is the same action.
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium" title={value}>
        {value}
      </dd>
    </div>
  );
}

/** The big preview slot: server thumbnail, or a calm placeholder per kind. */
function DetailPreview({
  filePath,
  payload,
}: {
  filePath: string;
  payload: MetadataPayload | undefined;
}) {
  const showPreview = payload?.kind !== 'video' && payload?.kind !== 'other';

  return (
    <div className="flex h-56 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted">
      {payload === undefined ? (
        <Skeleton className="h-full w-full rounded" />
      ) : showPreview ? (
        <EmbeddedPreview filePath={filePath} />
      ) : (
        <div className="text-center text-xs text-muted-foreground">
          {payload.kind === 'video'
            ? 'Video first-frame preview arrives with the write leaf.'
            : 'No preview for this file type.'}
        </div>
      )}
    </div>
  );
}

function EmbeddedPreview({ filePath }: { filePath: string }) {
  const { data, isError } = useThumbnail(filePath, true);
  if (isError) {
    return <div className="text-xs text-muted-foreground">No embedded preview available.</div>;
  }
  if (data === undefined) {
    return <Skeleton className="h-full w-full rounded" />;
  }
  return (
    <img
      src={data.url}
      alt="Large preview"
      className="max-h-full max-w-full object-contain"
      loading="lazy"
    />
  );
}

/** Curated Simple view (~15 friendly fields, ux-spec). */
function SimpleView({ payload }: { payload: MetadataPayload }) {
  const s = payload.simple;
  const [showRawDate, setShowRawDate] = useState(false);
  const aiFlag = useUiStore((state) => state.badges[payload.filePath]?.aiGenerated ?? null);
  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-border px-3 py-3">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Summary
        </h3>
        <dl className="space-y-1.5 text-sm">
          <SimpleRow label="Title" value={s.title} />
          <SimpleRow label="Description" value={s.description} />
          <SimpleRow label="Creator" value={s.creator} />
          <SimpleRow label="Copyright" value={s.copyright} />
          <div className="flex gap-3 text-sm">
            <dt className="w-24 shrink-0 text-muted-foreground">Keywords</dt>
            <dd className="min-w-0">
              {s.keywords.length > 0 ? (
                <span className="flex flex-wrap gap-1">
                  {s.keywords.map((keyword) => (
                    <Badge key={keyword} tone="neutral">
                      {keyword}
                    </Badge>
                  ))}
                </span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </dd>
          </div>
          <SimpleRow
            label="Rating"
            value={s.rating !== undefined ? '★'.repeat(s.rating) + '☆'.repeat(Math.max(0, 5 - s.rating)) : undefined}
          />
          <SimpleRow
            label="Date taken"
            value={
              s.dateTaken === undefined
                ? undefined
                : showRawDate
                  ? (s.dateTakenRaw ?? s.dateTaken)
                  : formatDateTime(s.dateTaken)
            }
            action={
              s.dateTakenRaw !== undefined && s.dateTakenRaw !== '' ? (
                <Button size="sm" variant="ghost" onClick={() => setShowRawDate(!showRawDate)}>
                  {showRawDate ? 'Local time' : 'Stored value'}
                </Button>
              ) : undefined
            }
          />
          <SimpleRow label="Camera" value={s.camera} />
          <SimpleRow
            label="Dimensions"
            value={
              s.width !== undefined && s.height !== undefined
                ? `${s.width} × ${s.height}${s.orientation !== undefined ? ` (orientation ${s.orientation})` : ''}`
                : undefined
            }
          />
        </dl>
      </section>

      {s.gps !== undefined && <GpsCard gps={s.gps} />}

      {/* AI-generation section: honest tri-state from the scrub detector. */}
      {aiFlag === true ? (
        <section className="rounded-lg border border-warning/50 bg-warning/10 px-3 py-2.5 text-xs">
          <div className="mb-0.5 font-medium text-warning">AI-generation signals detected</div>
          This file carries generation metadata from an AI tool (Stable Diffusion, ComfyUI,
          NovelAI, C2PA family). Open the AI scrub to see exactly what was found — the detection
          pass is read-only.
          <div className="mt-1.5">
            <Button size="sm" variant="outline" onClick={() => navigate('/scrub')}>
              Open AI scrub
            </Button>
          </div>
        </section>
      ) : (
        <section className="rounded-lg border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">
          <div className="mb-0.5 font-medium text-foreground">AI-generation info</div>
          {aiFlag === false
            ? 'The AI scrub scanned this file and found no AI-generation metadata.'
            : 'No AI scan has seen this file yet. The read-only detection pass in the AI scrub (left rail) lights this section up when it finds generation metadata.'}
        </section>
      )}
    </div>
  );
}

function SimpleRow({
  label,
  value,
  action,
}: {
  label: string;
  value?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex gap-3 text-sm">
      <dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{value === undefined || value === '' ? <span className="text-muted-foreground">—</span> : value}</dd>
      {action !== undefined && <dd className="shrink-0">{action}</dd>}
    </div>
  );
}

/** GPS as coordinates + map link + copy (ux-spec intuitive win). */
export function GpsCard({ gps }: { gps: { latitude: number; longitude: number; altitude?: number; timestamp?: string } }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="rounded-lg border border-border px-3 py-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        GPS
      </h3>
      <div className="text-sm">
        <div className="font-medium">{formatGpsLine(gps)}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {toDms(gps.latitude, 'lat')} · {toDms(gps.longitude, 'lon')}
          {gps.altitude !== undefined && ` · altitude ${gps.altitude} m`}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <a
            href={osmLink(gps)}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-7 items-center rounded-md border border-border px-2.5 text-xs font-medium hover:bg-muted"
          >
            Open map
          </a>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void copyText(coordinatesForCopy(gps)).then((ok) => {
                setCopied(ok);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? 'Copied' : 'Copy coordinates'}
          </Button>
        </div>
      </div>
    </section>
  );
}

// --- Group model -----------------------------------------------------------

interface GroupModel {
  key: string;
  label: string;
  rows: RowModel[];
}

interface RowModel {
  /** Stable key: group:name:occurrence */
  id: string;
  group: string;
  name: string;
  value: string;
  raw?: string;
  binary: boolean;
  occurrence: number;
}

const GROUP_ORDER = ['GPS', 'EXIF', 'XMP', 'IPTC', 'File', 'Composite', 'MakerNotes'];

function bucketFor(group: string): string {
  if (group.startsWith('XMP')) return 'XMP';
  if (/^(EXIF|IFD0|ExifIFD|InteropIFD|GPS)$/.test(group)) return group === 'GPS' ? 'GPS' : 'EXIF';
  if (group.startsWith('IPTC')) return 'IPTC';
  if (group === 'File' || group === 'System') return 'File';
  if (group === 'Composite') return 'Composite';
  if (
    group === 'MakerNotes' ||
    group === 'MakerUnknown' ||
    /^(Canon|Nikon|Sony|FujiFilm|Olympus|Pentax|Panasonic|Leica|Ricoh|Casio|Kodak|Minolta|Sigma|Apple|GoPro|DJI)$/.test(group)
  ) {
    return 'MakerNotes';
  }
  return group;
}

/** Build collapsible groups from whichever tier the payload carries. */
function groupTags(payload: MetadataPayload | undefined): GroupModel[] {
  if (payload === undefined) return [];

  const rowsByKey = new Map<string, RowModel>();
  const push = (group: string, name: string, value: string, raw: string | undefined, binary: boolean) => {
    const bucket = bucketFor(group);
    const existing = rowsByKey.get(`${bucket}:${name}`);
    const occurrence = existing === undefined ? 1 : existing.occurrence + 1;
    rowsByKey.set(`${bucket}:${name}`, {
      id: `${bucket}:${name}:${occurrence}`,
      group,
      name: occurrence > 1 ? `${name} (Copy${occurrence})` : name,
      value,
      raw,
      binary,
      occurrence,
    });
  };

  if (payload.raw.length > 0) {
    for (const tag of payload.raw) {
      push(tag.group, tag.name, tag.value, tag.raw, tag.binary);
    }
  } else {
    for (const [key, value] of Object.entries(payload.all)) {
      const separator = key.indexOf(':');
      const group = separator === -1 ? key : key.slice(0, separator);
      const name = separator === -1 ? key : key.slice(separator + 1);
      push(group, name, value, undefined, false);
    }
  }

  const buckets = new Map<string, RowModel[]>();
  for (const row of rowsByKey.values()) {
    const bucket = row.id.slice(0, row.id.lastIndexOf(':'));
    const list = buckets.get(bucket);
    if (list === undefined) buckets.set(bucket, [row]);
    else list.push(row);
  }

  return [...buckets.entries()]
    .map(([key, rows]) => ({
      key,
      label: key,
      rows: rows.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => {
      const ai = GROUP_ORDER.indexOf(a.key);
      const bi = GROUP_ORDER.indexOf(b.key);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.key.localeCompare(b.key);
    });
}

/** One tag row: name, human value (raw on toggle), group chip, copy/extract. */
function TagRow({
  row,
  needle,
  extractState,
  onExtract,
}: {
  row: RowModel;
  needle: string;
  extractState?: ExtractState;
  onExtract: () => void;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const display = showRaw && row.raw !== undefined ? row.raw : row.value;

  return (
    <li className="px-3 py-2 text-sm">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 break-words font-medium">
          <Highlight text={row.name} needle={needle} />
        </span>
        <Badge tone="neutral" className="shrink-0 font-mono">
          {row.group}
        </Badge>
      </div>
      <div className="mt-0.5 flex items-start gap-2">
        <span className="min-w-0 flex-1 break-words text-muted-foreground">
          {row.binary ? (
            <span className="text-xs italic">binary data (thumbnail / preview / ICC)</span>
          ) : (
            <Highlight text={display} needle={needle} />
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {row.raw !== undefined && (
            <Button size="sm" variant="ghost" onClick={() => setShowRaw(!showRaw)}>
              {showRaw ? 'Human' : 'Raw'}
            </Button>
          )}
          {!row.binary && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void copyText(display).then((ok) => {
                  setCopied(ok);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          )}
          {row.binary && (
            <Button size="sm" variant="outline" onClick={onExtract} disabled={extractState?.busy === true}>
              {extractState?.busy === true
                ? 'Extracting…'
                : extractState?.done === true
                  ? 'Extracted'
                  : 'Extract'}
            </Button>
          )}
        </span>
      </div>
      {extractState?.error != null && (
        <div className="mt-1 text-xs text-destructive">{extractState.error}</div>
      )}
    </li>
  );
}

/** Wrap needle matches in <mark> for search-as-you-type. */
function Highlight({ text, needle }: { text: string; needle: string }) {
  if (needle === '') return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let found = lower.indexOf(needle);
  let key = 0;
  while (found !== -1) {
    if (found > cursor) parts.push(text.slice(cursor, found));
    parts.push(<mark key={key++} className="rounded bg-accent-soft px-0.5 text-foreground">{text.slice(found, found + needle.length)}</mark>);
    cursor = found + needle.length;
    found = lower.indexOf(needle, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

/** Learn grid badges from any tier of the payload. */
function badgesFromPayload(payload: MetadataPayload): FileBadges {
  let hasGps = payload.simple.gps !== undefined;
  let hasCopyright =
    payload.simple.copyright !== undefined && payload.simple.copyright !== '';
  if (payload.raw.length > 0) {
    for (const tag of payload.raw) {
      if (/^GPS/i.test(tag.group)) hasGps = true;
      if (/^(copyright|artist|credit|by-line)$/i.test(tag.name)) hasCopyright = true;
    }
  } else {
    for (const key of Object.keys(payload.all)) {
      if (/^GPS:/i.test(key) || /:GPS/i.test(key)) hasGps = true;
      if (/(^|:)(copyright|artist|by-line|credit)$/i.test(key)) hasCopyright = true;
    }
  }
  return { hasGps, hasCopyright, aiGenerated: null };
}
