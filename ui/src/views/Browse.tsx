import { useEffect, useState } from 'react';
import { FileGrid } from './FileGrid';
import { DetailViewer } from './DetailViewer';
import { useUiStore } from '../state/store';
import { EmptyState } from '../components/EmptyState';
import { navigate } from '../lib/router';

/**
 * The Browse work zone: the file grid fills the center; selecting a file
 * opens the Detail Viewer as the right rail (ux-spec's fixed three-zone
 * frame). Keyboard: Escape closes the inspector.
 */
export function Browse() {
  const scanResult = useUiStore((s) => s.scanResult);
  const clearSelection = useUiStore((s) => s.clearSelection);
  const [detailPath, setDetailPath] = useState<string | null>(null);

  useEffect(() => {
    if (scanResult === null) return;
    // A scan result that no longer contains the open file closes the rail.
    if (detailPath !== null && !scanResult.entries.some((entry) => entry.path === detailPath)) {
      setDetailPath(null);
    }
  }, [scanResult, detailPath]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && detailPath !== null) setDetailPath(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detailPath]);

  if (scanResult === null) {
    return (
      <div className="p-6">
        <EmptyState title="No folder is open yet">
          Head to the folder browser to pick one — MetaDesk shows you a preflight report before
          the grid opens.
        </EmptyState>
        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="text-sm text-accent underline-offset-2 hover:underline"
          >
            Open the folder browser
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1">
        <FileGrid
          onOpenDetail={(path) => {
            setDetailPath(path);
            clearSelection();
          }}
        />
      </div>
      {detailPath !== null && (
        <DetailViewer filePath={detailPath} onClose={() => setDetailPath(null)} />
      )}
    </div>
  );
}
