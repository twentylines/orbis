import {
  getEnabledAppStoresOptions,
  getInstalledAppsOptions,
  getLinksOptions,
  searchAppsInfiniteOptions,
} from '@/api-client/@tanstack/react-query.gen';
import type { QueryClient } from '@tanstack/react-query';
import type { AppCategory } from '@/types/app.types';

export async function prepareNavigationData(client: QueryClient, path: string, filters: { search: string; category?: AppCategory }) {
  if (path === '/apps') {
    const [apps] = await Promise.all([client.ensureQueryData(getInstalledAppsOptions()), client.ensureQueryData(getLinksOptions())]);
    return apps.installed.filter((app) => app.info.available).map((app) => app.info.urn);
  }
  if (path === '/app-store') {
    const [, catalogue] = await Promise.all([
      client.ensureQueryData(getEnabledAppStoresOptions()),
      client.ensureInfiniteQueryData(searchAppsInfiniteOptions({ query: { ...filters, storeId: undefined, pageSize: 24 } })),
    ]);
    return catalogue.pages[0]?.data.map((app) => app.urn) ?? [];
  }
  return [];
}
