import { useLayoutEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { LibraryFilters } from './app-library';
import { IconApps, IconSearch, IconX } from '@tabler/icons-react';
import { iconForCategory } from '@/modules/app/helpers/table-helpers';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { openCommandSearch } from './command-search-event';
import './app-library.css';

function ControlLabel({ children }: { children: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const label = ref.current;
    if (!label) return;
    const context = document.createElement('canvas').getContext('2d');
    if (!context) return;
    let active = true;
    let frame = 0;
    const align = () => {
      if (!active) return;
      const baseline = label.querySelector('.app-library-label-baseline')?.getBoundingClientRect().top;
      if (baseline === undefined) return;
      const style = getComputedStyle(label);
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const metrics = context.measureText(children);
      const bounds = label.getBoundingClientRect();
      const inkCenter = baseline + (metrics.actualBoundingBoxDescent - metrics.actualBoundingBoxAscent) / 2;
      label.style.setProperty('--library-label-y', `${(bounds.top + bounds.bottom) / 2 - inkCenter}px`);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(align);
    };
    align();
    const observer = new ResizeObserver(schedule);
    observer.observe(label);
    void document.fonts.ready.then(() => {
      if (active) schedule();
    });
    document.fonts.addEventListener('loadingdone', schedule);
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.fonts.removeEventListener('loadingdone', schedule);
      label.style.removeProperty('--library-label-y');
    };
  }, [children]);
  return (
    <span className="app-library-control-label" ref={ref}>
      {children}
      <i className="app-library-label-baseline" aria-hidden="true" />
    </span>
  );
}

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
  const categoryLabel = filters.category
    ? filters.category === 'uncategorized'
      ? 'Uncategorized'
      : t(`APP_CATEGORY_${filters.category.toUpperCase()}`, { defaultValue: filters.category.replaceAll('-', ' ') })
    : 'All categories';
  const CategoryIcon = filters.category ? (iconForCategory.find(({ id }) => id === filters.category)?.icon ?? IconApps) : null;
  const sortLabel = { az: 'A–Z', za: 'Z–A', opened: 'Last opened', installed: 'Newest first' }[filters.sort];
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
        <ControlLabel>Find an app</ControlLabel>
      </button>
      <Select value={filters.category || '__all__'} onValueChange={(value) => change('category', value === '__all__' ? '' : value)}>
        <SelectTrigger fitContent className="app-library-select" aria-label="Category" value={filters.category || '__all__'}>
          <SelectValue>
            <span className="d-flex align-items-center gap-2">
              {CategoryIcon ? <CategoryIcon size={20} aria-hidden="true" /> : null}
              <ControlLabel>{categoryLabel}</ControlLabel>
            </span>
          </SelectValue>
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
          <SelectValue>
            <ControlLabel>{sortLabel}</ControlLabel>
          </SelectValue>
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
