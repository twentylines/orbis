import { createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AppLaunchRequest } from './app-window-state';
import { appEmbeddingBoundary, type AppEmbeddingCheck } from './app-opening';

type BlockedApps = Record<string, { url: string; reason: string }>;
const EmbeddingContext = createContext<{ blocked: BlockedApps; report: (urn: string, url: string) => void }>({
  blocked: {},
  report: () => undefined,
});

export function AppEmbeddingProvider({ children }: PropsWithChildren) {
  const [blocked, setBlocked] = useState<BlockedApps>({});
  const report = useCallback((urn: string, url: string) => {
    setBlocked((previous) => {
      const current = previous[urn];
      const boundary = appEmbeddingBoundary(url, window.location.origin);
      if (boundary) {
        if (current?.url === url && current.reason === boundary.reason) return previous;
        return { ...previous, [urn]: { url, reason: boundary.reason } };
      }
      if (!current || current.url !== url) return previous;
      const next = { ...previous };
      delete next[urn];
      return next;
    });
  }, []);
  const value = useMemo(() => ({ blocked, report }), [blocked, report]);
  return <EmbeddingContext.Provider value={value}>{children}</EmbeddingContext.Provider>;
}

export const useBlockedAppEmbeds = () => useContext(EmbeddingContext).blocked;

export function useAppEmbedding(request: AppLaunchRequest, enabled: boolean) {
  const { report } = useContext(EmbeddingContext);
  const url = request.launchUrl ?? '';
  const check = useQuery({
    queryKey: ['app-embedding', request.urn, url, window.location.origin],
    enabled,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async ({ signal }): Promise<AppEmbeddingCheck> => {
      if (!url || request.urn.includes('/')) return { status: 'unknown', reason: 'unverified-destination' };
      const params = new URLSearchParams({ destination: url, parentOrigin: window.location.origin });
      try {
        const response = await fetch(`/api/apps/${encodeURIComponent(request.urn)}/embedding-compatibility?${params}`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
        });
        if (!response.ok) return { status: 'unknown', reason: 'check-unavailable' };
        const value: unknown = await response.json();
        if (value && typeof value === 'object' && 'status' in value && 'reason' in value) {
          const { status, reason } = value;
          if (['blocked', 'not-blocked-by-headers', 'unknown'].includes(String(status)) && typeof reason === 'string')
            return { status: status as AppEmbeddingCheck['status'], reason };
        }
      } catch {
        if (signal.aborted) throw new Error('Window compatibility check canceled.');
      }
      return { status: 'unknown', reason: 'check-unavailable' };
    },
  });
  useEffect(() => {
    report(request.urn, url);
  }, [request.urn, url, report]);
  return check;
}
