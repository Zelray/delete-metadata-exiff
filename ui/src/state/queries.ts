/**
 * TanStack Query hooks — the server-state layer.
 * Keys are stable so the SSE bridge can patch caches as events arrive.
 */
import { useQuery } from '@tanstack/react-query';
import type {
  FolderScanRequest,
  FolderScanResult,
  HealthInfo,
  MetadataDepth,
  MetadataPayload,
  ThumbnailInfo,
} from '@metadesk/shared';
import { getHealth, getMetadata, getThumbnail, scanFolder } from '../api/client';

export const queryKeys = {
  health: ['health'] as const,
  scan: (request: FolderScanRequest) => ['scan', request] as const,
  metadata: (path: string, depth: MetadataDepth) => ['metadata', path, depth] as const,
  thumbnail: (path: string) => ['thumbnail', path] as const,
};

export function useHealth() {
  return useQuery<HealthInfo>({
    queryKey: queryKeys.health,
    queryFn: getHealth,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useFolderScan(request: FolderScanRequest | null) {
  return useQuery<FolderScanResult>({
    queryKey: request === null ? ['scan', 'idle'] : queryKeys.scan(request),
    queryFn: () => {
      if (request === null) return Promise.reject(new Error('No folder request'));
      return scanFolder(request);
    },
    enabled: request !== null,
    staleTime: 60_000,
    retry: 0,
  });
}

export function useMetadata(filePath: string | null, depth: MetadataDepth) {
  return useQuery<MetadataPayload>({
    queryKey: filePath === null ? ['metadata', 'idle', depth] : queryKeys.metadata(filePath, depth),
    queryFn: () => {
      if (filePath === null) return Promise.reject(new Error('No file selected'));
      return getMetadata(filePath, depth);
    },
    enabled: filePath !== null,
    staleTime: 30_000,
    retry: 0,
  });
}

/**
 * One embedded-preview thumbnail. `enabled` is driven by viewport visibility
 * so the grid loads lazily (ux-spec: skeletons, never a frozen window).
 */
export function useThumbnail(filePath: string | null, enabled: boolean) {
  return useQuery<ThumbnailInfo>({
    queryKey: filePath === null ? ['thumbnail', 'idle'] : queryKeys.thumbnail(filePath),
    queryFn: () => {
      if (filePath === null) return Promise.reject(new Error('No file'));
      return getThumbnail(filePath);
    },
    enabled: enabled && filePath !== null,
    staleTime: Infinity,
    retry: 0,
  });
}
