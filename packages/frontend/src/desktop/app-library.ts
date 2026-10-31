import { createSearchMatcher } from '@runtipi/common/types';
export type LibrarySort = 'az' | 'za' | 'opened' | 'installed';
export type LibraryFilters = { search: string; category: string; sort: LibrarySort };
export type LibraryApp = { key: string; name: string; categories?: readonly string[]; installedAt?: number; searchText?: string };
export type OpenedApps = Record<string, number>;

const names = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const installedTime = (app: LibraryApp) => (typeof app.installedAt === 'number' && Number.isFinite(app.installedAt) ? app.installedAt : 0);
export function selectLibraryApps<T extends LibraryApp>(apps: readonly T[], filters: LibraryFilters, opened: OpenedApps) {
  const search = filters.search.trim();
  const match = createSearchMatcher(search);
  const scores = new Map(apps.map((app) => [app, match(app.name, app.searchText)]));
  return apps
    .filter((app) => {
      const category =
        !filters.category || (filters.category === 'uncategorized' ? !app.categories?.length : app.categories?.includes(filters.category));
      return category && (scores.get(app) ?? 0) > 0;
    })
    .sort((a, b) => {
      const relevance = search ? (scores.get(b) ?? 0) - (scores.get(a) ?? 0) : 0;
      if (relevance) return relevance;
      const alphabetical = names.compare(a.name, b.name) || names.compare(a.key, b.key);
      if (filters.sort === 'za') return -alphabetical;
      if (filters.sort === 'installed') return installedTime(b) - installedTime(a) || alphabetical;
      if (filters.sort === 'opened') return (opened[b.key] ?? 0) - (opened[a.key] ?? 0) || alphabetical;
      return alphabetical;
    });
}

export function readOpenedApps(raw: string | null): OpenedApps {
  try {
    if (!raw || raw.length > 100_000) return {};
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key, time]) => key.length <= 512 && typeof time === 'number' && Number.isFinite(time) && time > 0)
        .sort((a, b) => Number(b[1]) - Number(a[1]))
        .slice(0, 200),
    );
  } catch {
    return {};
  }
}

export function rememberOpenedApp(opened: OpenedApps, key: string, time: number): OpenedApps {
  return Object.fromEntries(
    Object.entries({ ...opened, [key]: time })
      .sort((a, b) => b[1] - a[1])
      .slice(0, 200),
  );
}
