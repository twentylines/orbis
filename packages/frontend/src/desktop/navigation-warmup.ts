import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStoreState } from '@/stores/app-store';
import { observeNavigationPreload } from './navigation-preload';
import { prepareNavigationData } from './navigation-data';

export function useNavigationPreload(enabled: boolean) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setReady(false);
      return;
    }
    return observeNavigationPreload(setReady);
  }, [enabled]);
  return enabled && ready;
}

export function useNavigationWarmup(eager = false) {
  const client = useQueryClient();
  const requested = useRef(new Set<string>());
  const images = useRef(new Set<string>());
  const warmNavigation = useCallback(
    (path: string) => {
      const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
      if (connection?.saveData || ['slow-2g', '2g'].includes(connection?.effectiveType ?? '') || document.visibilityState !== 'visible') return;
      if (!['/apps', '/app-store'].includes(path) || requested.current.has(path)) return;
      requested.current.add(path);
      const warm = async () => {
        const { search, category } = useAppStoreState.getState();
        const urns = await prepareNavigationData(client, path, { search, category });
        for (const urn of urns.slice(0, 12)) {
          if (images.current.has(urn)) continue;
          images.current.add(urn);
          const image = new Image();
          image.decoding = 'async';
          image.fetchPriority = 'low';
          image.src = `/api/marketplace/apps/${encodeURIComponent(urn)}/image`;
          void image.decode().catch(() => undefined);
        }
      };
      void warm().catch(() => requested.current.delete(path));
    },
    [client],
  );
  useEffect(() => {
    if (!eager) return;
    warmNavigation('/apps');
    warmNavigation('/app-store');
  }, [eager, warmNavigation]);
  return warmNavigation;
}
