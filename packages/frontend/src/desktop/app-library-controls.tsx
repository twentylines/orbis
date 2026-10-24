import { useLayoutEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { LibraryFilters, LibrarySort } from './app-library';
import { IconChevronDown, IconSearch, IconX } from '@tabler/icons-react';
import { openCommandSearch } from './command-search-event';
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
    <fieldset className="app-library-controls" aria-label="App library controls">
      <button
        type="button"
        className="btn app-library-find"
        onClick={(event) => {
          event.currentTarget.focus({ preventScroll: true });
          openCommandSearch();
        }}
        aria-haspopup="dialog"
      >
        <IconSearch size={17} aria-hidden="true" />
        Find an app
      </button>
      <label>
        <span className="visually-hidden">Category</span>
        <span className="app-library-select">
          <select className="form-select" aria-label="Category" value={filters.category} onChange={(event) => change('category', event.target.value)}>
            <option value="">All categories</option>
            {[...new Set([...categories, 'uncategorized', ...(filters.category ? [filters.category] : [])])].sort().map((category) => (
              <option key={category} value={category}>
                {category === 'uncategorized'
                  ? 'Uncategorized'
                  : t(`APP_CATEGORY_${category.toUpperCase()}`, { defaultValue: category.replaceAll('-', ' ') })}
              </option>
            ))}
          </select>
          <IconChevronDown size={18} aria-hidden="true" />
        </span>
      </label>
      <label>
        <span className="visually-hidden">Sort by</span>
        <span className="app-library-select">
          <select
            className="form-select"
            aria-label="Sort by"
            value={filters.sort}
            onChange={(event) => change('sort', event.target.value as LibrarySort)}
          >
            <option value="az">A–Z</option>
            <option value="za">Z–A</option>
            <option value="opened">Last opened</option>
            <option value="installed">Newest first</option>
          </select>
          <IconChevronDown size={18} aria-hidden="true" />
        </span>
      </label>
      {filters.search ? (
        <button
          type="button"
          className="btn app-library-clear"
          aria-label="Clear search filter"
          title={filters.search}
          onClick={() => change('q', '')}
        >
          <span>{filters.search}</span>
          <IconX size={16} aria-hidden="true" />
        </button>
      ) : null}
    </fieldset>
  );
}
