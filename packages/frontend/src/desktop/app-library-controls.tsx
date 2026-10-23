import { useLayoutEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { LibraryFilters, LibrarySort } from './app-library';
import './app-library.css';

export function useLibraryFilters() {
  const [params, setParams] = useSearchParams();
  const latestParams = useRef(params);
  useLayoutEffect(() => {
    latestParams.current = params;
  }, [params]);
  const sort = params.get('sort');
  const filters: LibraryFilters = {
    search: params.get('q') ?? '',
    category: params.get('category') ?? '',
    sort: sort === 'za' || sort === 'opened' || sort === 'installed' ? sort : 'az',
  };
  const change = (key: 'q' | 'category' | 'sort', value: string) => {
    const next = new URLSearchParams(latestParams.current);
    if (value) next.set(key, value);
    else next.delete(key);
    latestParams.current = next;
    setParams(next, { replace: true, preventScrollReset: true });
  };
  return { filters, change };
}

export function AppLibraryControls({
  filters,
  change,
  categories,
}: {
  filters: LibraryFilters;
  change: (key: 'q' | 'category' | 'sort', value: string) => void;
  categories: string[];
}) {
  const { t } = useTranslation();
  return (
    <search className="app-library-controls" aria-label="Filter apps">
      <label>
        <span>Find an app</span>
        <input type="search" placeholder="Search apps" value={filters.search} onChange={(event) => change('q', event.target.value)} />
      </label>
      <label>
        <span>Category</span>
        <select value={filters.category} onChange={(event) => change('category', event.target.value)}>
          <option value="">All categories</option>
          {[...new Set([...categories, 'uncategorized', ...(filters.category ? [filters.category] : [])])].sort().map((category) => (
            <option key={category} value={category}>
              {category === 'uncategorized'
                ? 'Uncategorized'
                : t(`APP_CATEGORY_${category.toUpperCase()}`, { defaultValue: category.replaceAll('-', ' ') })}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Sort by</span>
        <select value={filters.sort} onChange={(event) => change('sort', event.target.value as LibrarySort)}>
          <option value="az">A–Z</option>
          <option value="za">Z–A</option>
          <option value="opened">Last opened</option>
          <option value="installed">Newest first</option>
        </select>
      </label>
    </search>
  );
}
