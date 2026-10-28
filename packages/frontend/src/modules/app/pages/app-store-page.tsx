import { getEnabledAppStoresOptions, searchAppsInfiniteOptions } from '@/api-client/@tanstack/react-query.gen';
import { RefreshAppStoresButton } from '@/components/refresh-app-stores/refresh-app-stores';
import { Input } from '@/components/ui/Input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { SelectionGroup } from '@/components/ui/SelectionGroup/SelectionGroup';
import { useCluster } from '@/desktop/cluster';
import { ClusterStore } from '@/desktop/cluster-views';
import { useReducedMotion } from '@/desktop/motion-preferences';
import { DelayedRouteLoading } from '@/desktop/route-loading';
import { useInfiniteScroll } from '@/lib/hooks/use-infinite-scroll';
import { iconForCategory } from '@/modules/app/helpers/table-helpers';
import { useAppStoreState } from '@/stores/app-store';
import type { AppCategory } from '@/types/app.types';
import { IconArrowRight, IconSearch, IconX } from '@tabler/icons-react';
import { keepPreviousData, useInfiniteQuery, useSuspenseQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useLocation, useParams, useSearchParams } from 'react-router';
import { StoreDiscover } from '../components/store-discover/store-discover';
import { StoreViewTransition } from '../components/store-discover/store-view-transition';
import { StoreTile } from '../components/store-tile/store-tile';
import { nextStorePreviewHistory, type StorePreviewHistory } from './store-preview-navigation';
import './app-store-page.css';

export const AppStorePageSuspense = () => <DelayedRouteLoading label="Loading app catalogue…" />;

export default function AppStorePage() {
  const cluster = useCluster();
  if (cluster.merged || (cluster.selectedServer && !cluster.selectedServer.local)) return <ClusterStore />;
  return <LocalStore />;
}

function LocalStore() {
  const params = useParams<{ storeId: string; appId: string }>();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedStore = searchParams.get('store') ?? undefined;
  const { setCategory, category, storeId, setStoreId, search: querySearch, setSearch } = useAppStoreState();
  const [search, setLocalSearch] = useState(querySearch);
  const browsing = searchParams.get('view') === 'apps';
  const reduced = useReducedMotion();
  const { t } = useTranslation();
  const { data: appStores } = useSuspenseQuery(getEnabledAppStoresOptions());

  useEffect(() => {
    if (selectedStore !== storeId) setStoreId(selectedStore);
  }, [selectedStore, setStoreId, storeId]);

  const changeQuery = useCallback(
    (update: (next: URLSearchParams) => void) => {
      const next = new URLSearchParams(searchParams);
      update(next);
      setSearchParams(next, {
        preventScrollReset: true,
        state: params.appId ? nextStorePreviewHistory(location.state as StorePreviewHistory | null, location.search, true) : undefined,
      });
    },
    [searchParams, setSearchParams, params.appId, location.state, location.search],
  );
  const clearSearch = () => {
    setLocalSearch('');
    setSearch('');
  };
  const browse = (nextCategory?: AppCategory) => {
    setCategory(nextCategory);
    changeQuery((next) => next.set('view', 'apps'));
  };
  const discover = () => {
    changeQuery((next) => next.delete('view'));
  };
  const hasFilters = Boolean(search || category || selectedStore);
  const clearFilters = () => {
    clearSearch();
    setCategory(undefined);
    changeQuery((next) => {
      next.delete('store');
      next.set('view', 'apps');
    });
  };
  const { data, hasNextPage, isFetchingNextPage, isFetching, isError, isFetchNextPageError, isPlaceholderData, refetch, fetchNextPage } =
    useInfiniteQuery({
      ...searchAppsInfiniteOptions({ query: { search: querySearch, category, pageSize: 24, storeId: selectedStore } }),
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      placeholderData: keepPreviousData,
      enabled: browsing,
    });
  const apps = data?.pages.flatMap((page) => page.data) ?? [];
  const total = data?.pages[0]?.total ?? 0;
  const updating = isPlaceholderData || search !== querySearch || (isFetching && !isFetchingNextPage);
  const moreAllowed = useRef(false);
  const requestMore = useRef(fetchNextPage);
  moreAllowed.current = browsing && !isError && !updating;
  requestMore.current = fetchNextPage;
  const loadMore = useCallback(() => {
    if (moreAllowed.current) void requestMore.current();
  }, []);
  const { lastElementRef } = useInfiniteScroll({
    fetchNextPage: loadMore,
    hasNextPage: Boolean(hasNextPage) && !isError && !updating,
    isFetching: isFetchingNextPage || isFetching || !browsing,
  });

  if (params.storeId && !params.appId) return <Navigate to={`/app-store?store=${encodeURIComponent(params.storeId)}`} />;
  return (
    <section className="orbis-store" data-reduced-motion={reduced ? 'true' : undefined} aria-label="App catalogue">
      <div className="orbis-store-search-row">
        <div className="orbis-store-search">
          <IconSearch size={20} aria-hidden="true" />
          <Input
            value={search}
            onChange={(event) => {
              setLocalSearch(event.target.value);
              setSearch(event.target.value);
              if (!browsing) changeQuery((next) => next.set('view', 'apps'));
            }}
            aria-label={t('APP_STORE_SEARCH_PLACEHOLDER')}
            placeholder={t('APP_STORE_SEARCH_PLACEHOLDER')}
          />
          {search ? (
            <button type="button" className="orbis-store-clear-search" onClick={clearSearch} aria-label="Clear app search">
              <IconX size={18} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        {appStores.appStores.length > 1 || selectedStore ? (
          <div className="orbis-store-source">
            <Select
              value={selectedStore ?? ''}
              onValueChange={(value) =>
                changeQuery((next) => {
                  if (value) next.set('store', value);
                  else next.delete('store');
                })
              }
            >
              <SelectTrigger aria-label="App repository">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">All repositories</SelectItem>
                {appStores.appStores.map((store) => (
                  <SelectItem key={store.slug} value={store.slug}>
                    {store.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <RefreshAppStoresButton />
      </div>
      <div className="orbis-store-navigation">
        <SelectionGroup className="orbis-store-view-choice" role="group" aria-label="Store view">
          <button type="button" data-store-view="discover" aria-pressed={!browsing} onClick={discover}>
            Discover
          </button>
          <button type="button" data-store-view="apps" aria-pressed={browsing} onClick={() => browse(category)}>
            All apps
          </button>
        </SelectionGroup>
        {browsing ? (
          <div className="orbis-store-category">
            <Select value={category ?? 'all'} onValueChange={(value) => browse(value === 'all' ? undefined : (value as AppCategory))}>
              <SelectTrigger aria-label="App category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {iconForCategory.map((item) => {
                  const CategoryIcon = item.icon;
                  return (
                    <SelectItem key={item.id} value={item.id}>
                      <span className="orbis-store-category-option">
                        <CategoryIcon size={18} aria-hidden="true" />
                        {t(`APP_CATEGORY_${item.id.toUpperCase()}`)}
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>
      <StoreViewTransition
        active={browsing ? 'apps' : 'discover'}
        apps={
          <div className="orbis-store-results" aria-busy={updating || undefined}>
            <div className="orbis-store-result-heading">
              <div>
                <h3 className="visually-hidden">{category ? t(`APP_CATEGORY_${category.toUpperCase()}`) : search ? 'Search results' : 'All apps'}</h3>
                <p aria-live="polite">
                  {updating
                    ? 'Updating results…'
                    : data
                      ? `${total.toLocaleString()} ${total === 1 ? 'app' : 'apps'}`
                      : isError
                        ? 'Results unavailable'
                        : 'Loading apps…'}
                </p>
              </div>
              {hasFilters ? (
                <button type="button" onClick={clearFilters}>
                  Clear filters <IconX size={16} aria-hidden="true" />
                </button>
              ) : null}
            </div>
            {isError ? (
              <div className="orbis-store-message" role="alert">
                <p>
                  {isFetchNextPageError
                    ? 'More apps could not be loaded.'
                    : data
                      ? 'The catalogue could not be refreshed. The last loaded results are shown.'
                      : 'The app catalogue could not be loaded.'}
                </p>
                <button type="button" onClick={() => void (isFetchNextPageError ? fetchNextPage() : refetch())}>
                  Try again <IconArrowRight size={18} aria-hidden="true" />
                </button>
              </div>
            ) : null}
            {!data && !isError ? (
              <AppStorePageSuspense />
            ) : apps.length ? (
              <>
                <div className="orbis-store-grid">
                  {apps.map((app, index) => (
                    <div ref={index === apps.length - 1 ? lastElementRef : null} key={app.urn} className="orbis-store-grid-item">
                      <StoreTile app={app} isLoading={false} />
                    </div>
                  ))}
                </div>
                {hasNextPage ? (
                  <div className="orbis-store-pagination">
                    <span>
                      {apps.length.toLocaleString()} of {total.toLocaleString()} apps loaded
                    </span>
                    <button type="button" disabled={isFetching || updating} onClick={() => void fetchNextPage()}>
                      {isFetchingNextPage ? 'Loading more apps…' : 'Load more apps'}
                    </button>
                  </div>
                ) : null}
              </>
            ) : data && !isError ? (
              <div className="orbis-store-message">
                <p>{hasFilters ? t('APP_STORE_NO_RESULTS_SUBTITLE') : 'No apps are available from the enabled repositories.'}</p>
                {hasFilters ? (
                  <button type="button" onClick={clearFilters}>
                    Show all apps <IconArrowRight size={18} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        }
        discover={<StoreDiscover key={selectedStore ?? 'all'} storeId={selectedStore} onBrowse={browse} />}
      />
    </section>
  );
}
