import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ThumbnailInfo } from '@metadesk/shared';
import { subscribeEvents } from '../api/client';
import { queryKeys } from '../state/queries';
import { useUiStore } from '../state/store';

/**
 * Live event wire. Connects once per app lifetime, feeds the status strip's
 * background progress, refreshes health on health events, and patches the
 * thumbnail cache when the server finishes extracting a preview.
 *
 * Reconnects with a calm backoff — the app degrades to polling-style reads,
 * never to a broken-looking UI.
 */
export function SseBridge() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let closed = false;

    const connect = () => {
      if (closed) return;
      unsubscribe = subscribeEvents((event) => {
        attempt = 0; // healthy traffic resets backoff
        switch (event.type) {
          case 'hello':
          case 'health':
            queryClient.setQueryData(queryKeys.health, event.health);
            break;
          case 'scan-progress':
            useUiStore.getState().setScanProgress({
              scanId: event.scanId,
              filesScanned: event.filesScanned,
              currentDirectory: event.currentDirectory,
            });
            break;
          case 'scan-complete':
            useUiStore.getState().setScanProgress(null);
            break;
          case 'thumbnail-ready': {
            const info: ThumbnailInfo = {
              filePath: event.filePath,
              url: event.url,
              source: 'thumbnail',
              cached: true,
            };
            queryClient.setQueryData(queryKeys.thumbnail(event.filePath), info);
            break;
          }
          default:
            // metadata-ready / write-progress / batch-complete arrive with the
            // write leaves; unknown events are ignored, never fatal.
            break;
        }
      }, onDisconnected);
    };

    const onDisconnected = () => {
      if (closed) return;
      attempt += 1;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
      retryTimer = setTimeout(connect, delay);
    };

    connect();

    return () => {
      closed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      unsubscribe?.();
    };
  }, [queryClient]);

  return null;
}
