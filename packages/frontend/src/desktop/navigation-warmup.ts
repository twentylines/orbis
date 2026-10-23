import { getInstalledAppsOptions, searchAppsInfiniteOptions } from '@/api-client/@tanstack/react-query.gen';
import { useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useAppStoreState } from '@/stores/app-store';

export function useNavigationWarmup() {
  const client = useQueryClient();
  const requested = useRef(new Set<string>());
  const images = useRef(new Set<string>());
  return (path: string) => {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (connection?.saveData || ['slow-2g', '2g'].includes(connection?.effectiveType ?? '') || document.visibilityState !== 'visible') return;
    if (!['/apps', '/app-store'].includes(path) || requested.current.has(path)) return;
    requested.current.add(path);
    const warm = async () => {
      const { search, category, storeId } = useAppStoreState.getState();
      const urns =
        path === '/apps'
          ? (await client.ensureQueryData(getInstalledAppsOptions())).installed.filter((app) => app.info.available).map((app) => app.info.urn)
          : ((
              await client.ensureInfiniteQueryData(searchAppsInfiniteOptions({ query: { search, category, storeId, pageSize: 24 } }))
            ).pages[0]?.data.map((app) => app.urn) ?? []);
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
  };
}
