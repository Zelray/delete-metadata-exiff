import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { FileEntry, FileKind } from '@metadesk/shared';
import { useUiStore, type FileBadges } from '../state/store';
import { useThumbnail } from '../state/queries';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Checkbox, Segmented } from '../components/ui/controls';
import { Skeleton } from '../components/ui/skeleton';
import { EmptyState } from '../components/EmptyState';
import {
  AiBadgeLegend,
  CopyrightBadge,
  GpsBadge,
  MetadataBadgeRow,
} from '../components/MetadataBadges';
import { formatBytes, formatDateTime, basename } from '../lib/format';
import { navigate } from '../lib/router';

type SortKey = 'name' | 'dateTaken' | 'type' | 'size';

const KIND_LABELS: Record<FileKind, string> = {
  jpeg: 'JPEG',
  png: 'PNG',
  tiff: 'TIFF',
  webp: 'WebP',
  heic: 'HEIC',
  gif: 'GIF',
  raw: 'RAW',
  video: 'Video',
  sidecar: 'Sidecar',
  other: 'File',
};

/**
 * File Grid / Library View (ux-spec): thumbnail cards from embedded previews
 * loaded lazily, quick badges, filename filter, sort, multi-select with
 * click/ctrl/shift/select-all, live counter, and a grid/compact density
 * toggle. Virtualized so ten thousand files scroll calmly.
 */
export function FileGrid({ onOpenDetail }: { onOpenDetail: (path: string) => void }) {
  const scanRequest = useUiStore((s) => s.scanRequest);
  const scanResult = useUiStore((s) => s.scanResult);
  const selectedPaths = useUiStore((s) => s.selectedPaths);
  const toggleSelected = useUiStore((s) => s.toggleSelected);
  const setSelection = useUiStore((s) => s.setSelection);
  const searchText = useUiStore((s) => s.searchText);
  const density = useUiStore((s) => s.density);
  const setDensity = useUiStore((s) => s.setDensity);
  const badges = useUiStore((s) => s.badges);

  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [badgeFilter, setBadgeFilter] = useState<'none' | 'gps' | 'copyright'>('none');
  const parentRef = useRef<HTMLDivElement>(null);
  const lastIndexRef = useRef<number>(-1);

  const entries = scanResult?.entries ?? [];

  const filtered = useMemo(() => {
    const needle = searchText.trim().toLowerCase();
    let list = entries;
    if (needle !== '') {
      list = list.filter((entry) => entry.name.toLowerCase().includes(needle));
    }
    if (badgeFilter !== 'none') {
      list = list.filter((entry) => {
        const known = badges[entry.path];
        if (known === undefined) return false;
        return badgeFilter === 'gps' ? known.hasGps : known.hasCopyright;
      });
    }
    const sorted = [...list];
    sorted.sort((a, b) => {
      switch (sortKey) {
        case 'name':
          return a.name.localeCompare(b.name, undefined, { numeric: true });
        case 'type':
          return a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name);
        case 'size':
          return b.sizeBytes - a.sizeBytes;
        case 'dateTaken':
          // Capture-date order uses metadata already read this session; files
          // not yet inspected fall back to their modified time.
          return a.modifiedAt.localeCompare(b.modifiedAt);
      }
    });
    return sorted;
  }, [entries, searchText, badgeFilter, sortKey, badges]);

  const columns = density === 'compact' ? 6 : 4;
  const rows = useMemo(() => {
    const chunked: FileEntry[][] = [];
    for (let i = 0; i < filtered.length; i += columns) {
      chunked.push(filtered.slice(i, i + columns));
    }
    return chunked;
  }, [filtered, columns]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => (density === 'compact' ? 150 : 236),
    overscan: 4,
  });

  // Selection helpers: ctrl toggles, shift selects the range from the last click.
  const handleCardClick = (entry: FileEntry, index: number, event: React.MouseEvent) => {
    if (event.shiftKey && lastIndexRef.current !== -1) {
      const start = Math.min(lastIndexRef.current, index);
      const end = Math.max(lastIndexRef.current, index);
      const range = filtered.slice(start, end + 1).map((e) => e.path);
      const merged = new Set(useUiStore.getState().selectedPaths);
      range.forEach((path) => merged.add(path));
      setSelection([...merged]);
    } else if (event.ctrlKey || event.metaKey) {
      toggleSelected(entry.path);
      lastIndexRef.current = index;
    } else {
      onOpenDetail(entry.path);
      lastIndexRef.current = index;
    }
  };

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((entry) => selectedPaths.includes(entry.path));

  if (scanRequest === null || scanResult === undefined) {
    return (
      <div className="p-6">
        <EmptyState title="No folder is open">
          Pick a folder in Browse first — MetaDesk keeps one folder in view at a time so nothing
          gets lost.
        </EmptyState>
        <div className="mt-4 text-center">
          <Button variant="primary" size="sm" onClick={() => navigate('/')}>
            Go to Browse
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar: filter, badge legend, sort, density, selection counter */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card px-4 py-2 text-xs">
        <span className="text-muted-foreground">
          {filtered.length.toLocaleString()} of {entries.length.toLocaleString()} files
        </span>
        {selectedPaths.length > 0 && (
          <span className="font-semibold text-accent">
            {selectedPaths.length.toLocaleString()} selected
          </span>
        )}

        <span className="ml-auto flex items-center gap-1.5" aria-label="Badge legend">
          <span className="tip">
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              Badges: <GpsBadge /> <CopyrightBadge /> <AiBadgeLegend />
            </span>
          </span>
        </span>

        <label className="flex items-center gap-1.5 text-muted-foreground">
          Badge filter
          <select
            value={badgeFilter}
            onChange={(event) => setBadgeFilter(event.target.value as typeof badgeFilter)}
            className="h-7 rounded border border-input bg-card px-1.5 text-xs"
            aria-label="Filter by badge"
          >
            <option value="none">All files</option>
            <option value="gps">Has GPS (seen this session)</option>
            <option value="copyright">Has copyright (seen this session)</option>
          </select>
        </label>

        <label className="flex items-center gap-1.5 text-muted-foreground">
          Sort
          <select
            value={sortKey}
            onChange={(event) => setSortKey(event.target.value as SortKey)}
            className="h-7 rounded border border-input bg-card px-1.5 text-xs"
            aria-label="Sort files"
          >
            <option value="name">Name</option>
            <option value="dateTaken">Date (oldest first)</option>
            <option value="type">Type</option>
            <option value="size">Size (largest first)</option>
          </select>
        </label>

        <Segmented
          ariaLabel="Density"
          value={density}
          onChange={setDensity}
          options={[
            { value: 'comfortable', label: 'Grid', title: 'Comfortable thumbnails' },
            { value: 'compact', label: 'List', title: 'Compact density' },
          ]}
        />

        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            setSelection(allFilteredSelected ? [] : filtered.map((entry) => entry.path))
          }
          disabled={filtered.length === 0}
        >
          {allFilteredSelected ? 'Clear selection' : 'Select all shown'}
        </Button>
      </div>

      {/* Virtualized grid */}
      <div ref={parentRef} className="min-h-0 flex-1 overflow-auto p-4">
        {filtered.length === 0 ? (
          <EmptyState title={entries.length === 0 ? 'This folder has no recognized media files' : 'Nothing matches the filter'}>
            {entries.length === 0
              ? 'Try another folder, include subfolders, or widen the file-type chips in Browse.'
              : 'Clear the search box or the badge filter to see the whole folder again.'}
          </EmptyState>
        ) : (
          <div
            style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
            role="list"
            aria-label="Files"
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const rowEntries = rows[virtualRow.index];
              if (rowEntries === undefined) return null;
              return (
                <div
                  key={virtualRow.key}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  className={`grid gap-3 pb-3 ${density === 'compact' ? 'grid-cols-6' : 'grid-cols-4'}`}
                  role="presentation"
                >
                  {rowEntries.map((entry) => {
                    const index = filtered.indexOf(entry);
                    return (
                      <FileCard
                        key={entry.path}
                        entry={entry}
                        compact={density === 'compact'}
                        selected={selectedPaths.includes(entry.path)}
                        badgeModel={badges[entry.path]}
                        onClick={(event) => handleCardClick(entry, index, event)}
                        onCheckboxChange={() => toggleSelected(entry.path)}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

interface FileCardProps {
  entry: FileEntry;
  compact: boolean;
  selected: boolean;
  badgeModel: FileBadges | undefined;
  onClick: (event: React.MouseEvent) => void;
  onCheckboxChange: (checked: boolean) => void;
}

/** One thumbnail card: lazy preview, badges, honest skeletons. */
function FileCard({ entry, compact, selected, badgeModel, onClick, onCheckboxChange }: FileCardProps) {
  const [visible, setVisible] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const showThumbnails = !compact;

  // Lazy: the thumbnail request only fires once the card scrolls into view.
  useEffect(() => {
    if (!showThumbnails || visible) return;
    const element = cardRef.current;
    if (element === null) return;
    const observer = new IntersectionObserver(
      (observed) => {
        if (observed.some((o) => o.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '300px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [showThumbnails, visible]);

  const thumbnail = useThumbnail(showThumbnails && visible ? entry.path : null, visible && showThumbnails);
  const kindBadge = ['raw', 'video', 'sidecar'].includes(entry.kind) ? KIND_LABELS[entry.kind] : null;

  return (
    <div
      ref={cardRef}
      role="listitem"
      onClick={onClick}
      className={`group flex cursor-pointer flex-col rounded-lg border bg-card p-2 text-left transition-none ${
        selected ? 'border-accent ring-1 ring-accent' : 'border-border hover:border-accent/50'
      }`}
      title={`${entry.path}\n${formatBytes(entry.sizeBytes)} · modified ${formatDateTime(entry.modifiedAt)}`}
    >
      {showThumbnails && (
        <div className="mb-2 flex h-36 items-center justify-center overflow-hidden rounded bg-muted">
          {thumbnail.isPending && <Skeleton className="h-full w-full rounded" />}
          {thumbnail.isError && <KindIcon kind={entry.kind} />}
          {thumbnail.data !== undefined && (
            <img
              src={thumbnail.data.url}
              alt={`Preview of ${entry.name}`}
              loading="lazy"
              className="max-h-full max-w-full object-contain"
            />
          )}
        </div>
      )}

      <div className="flex items-start gap-2">
        <Checkbox
          checked={selected}
          onChange={onCheckboxChange}
          onClick={(event) => event.stopPropagation()}
          ariaLabel={`Select ${entry.name}`}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium" title={entry.name}>
            {basename(entry.name)}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {formatBytes(entry.sizeBytes)} · {formatDateTime(entry.modifiedAt)}
          </div>
        </div>
        {kindBadge !== null && !compact && <Badge tone="neutral">{kindBadge}</Badge>}
      </div>

      {entry.warnings.length > 0 && (
        <div className="mt-1 text-[10px] text-warning" title={entry.warnings.join('\n')}>
          ⚠ {entry.warnings.length} warning(s)
        </div>
      )}

      {!compact && (
        <div className="mt-1.5">
          {badgeModel !== undefined ? (
            <MetadataBadgeRow model={{ ...badgeModel, editedCount: null }} />
          ) : (
            <div className="text-[10px] leading-4 text-muted-foreground/50">
              Badges appear as files are inspected
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Fallback when no preview exists (or extraction failed). */
function KindIcon({ kind }: { kind: FileKind }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground">
      <span className="text-[11px] font-semibold uppercase tracking-widest">
        {KIND_LABELS[kind]}
      </span>
      <span className="text-[10px]">no embedded preview</span>
    </div>
  );
}
