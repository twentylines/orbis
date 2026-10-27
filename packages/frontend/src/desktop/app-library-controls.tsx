import { useLayoutEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { LibraryFilters } from './app-library';
import { IconApps, IconSearch, IconX } from '@tabler/icons-react';
import { iconForCategory } from '@/modules/app/helpers/table-helpers';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
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
      <Select value={filters.category || '__all__'} onValueChange={(value) => change('category', value === '__all__' ? '' : value)}>
        <SelectTrigger fitContent className="app-library-select" aria-label="Category" value={filters.category || '__all__'}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">All categories</SelectItem>
          {[...new Set([...categories, 'uncategorized', ...(filters.category ? [filters.category] : [])])].sort().map((category) => {
            const CategoryIcon = iconForCategory.find(({ id }) => id === category)?.icon ?? IconApps;
            const label =
              category === 'uncategorized'
                ? 'Uncategorized'
                : t(`APP_CATEGORY_${category.toUpperCase()}`, { defaultValue: category.replaceAll('-', ' ') });
            return (
              <SelectItem key={category} value={category} textValue={label}>
                <span className="d-flex align-items-center gap-2">
                  <CategoryIcon size={20} aria-hidden="true" />
                  {label}
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      <Select value={filters.sort} onValueChange={(value) => change('sort', value)}>
        <SelectTrigger fitContent className="app-library-select" aria-label="Sort by" value={filters.sort}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="az">A–Z</SelectItem>
          <SelectItem value="za">Z–A</SelectItem>
          <SelectItem value="opened">Last opened</SelectItem>
          <SelectItem value="installed">Newest first</SelectItem>
        </SelectContent>
      </Select>
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
