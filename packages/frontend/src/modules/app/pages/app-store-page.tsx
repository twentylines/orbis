import { useDesktopPreferences } from '@/desktop/preferences';
import type { StoreRecommendationCategory } from '../components/store-discover/store-recommendations';
import { useAppContext } from '@/context/app-context';
import { useTasks } from '@/desktop/tasks';
import { getEnabledAppStoresOptions, getInstalledAppsOptions, searchAppsInfiniteOptions } from '@/api-client/@tanstack/react-query.gen';
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
import { keepPreviousData, useInfiniteQuery, useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useWindowVisible, WindowVisibilityContext } from '@/desktop/window-visibility';
import { storeView, storeEditorialFits } from '../components/store-discover/store-curation';
import { useTranslation } from 'react-i18next';
import { Navigate, useLocation, useParams, useSearchParams } from 'react-router';
import { StoreDiscover } from '../components/store-discover/store-discover';
import { StoreViewTransition } from '../components/store-discover/store-view-transition';
import { StoreCatalogue } from './store-catalogue';
import { nextStorePreviewHistory, type StorePreviewHistory } from './store-preview-navigation';
import './app-store-page.css';
import { ThemePacksCatalogue } from '@/modules/theme-packs/theme-packs-catalogue';

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
  const [themeSearch, setThemeSearch] = useState('');
  const view = storeView(searchParams.get('view'));
  const browsing = view === 'apps';
  const themes = view === 'themes';
  const surface = useRef<HTMLElement>(null);
  const visible = useWindowVisible();
  const { preferences, update } = useDesktopPreferences();
  const recommendationProps = {
    enabled: preferences.showStoreRecommendations,
    hiddenCategories: preferences.hiddenStoreRecommendationCategories,
    onHideCategory: (category: StoreRecommendationCategory) =>
      update({
        hiddenStoreRecommendationCategories: [...new Set([...preferences.hiddenStoreRecommendationCategories, category])],
      }),
  };
  const { user } = useAppContext();
  const installed = useQuery({ ...getInstalledAppsOptions(), enabled: visible && browsing && user.operator, staleTime: 5000 });
  const installedApps = new Set(installed.data?.installed.filter((entry) => entry.app.status !== 'missing').map((entry) => entry.info.urn) ?? []);
  const tasks = useTasks();
  for (const task of tasks.data?.tasks ?? []) {
    if (['queued', 'running', 'unconfirmed'].includes(task.status)) installedApps.add(task.appUrn);
  }
  const [editorialFits, setEditorialFits] = useState(false);
  useLayoutEffect(() => {
    const element = surface.current;
    if (!element) return;
    const catalogue = element.closest<HTMLElement>('.store-catalogue-pane');
    const update = () =>
      setEditorialFits(
        storeEditorialFits(element.clientWidth, catalogue?.clientHeight ?? 0, Number.parseFloat(getComputedStyle(document.documentElement).fontSize)),
      );
    const observer = new ResizeObserver(update);
    observer.observe(element);
    if (catalogue) observer.observe(catalogue);
    observer.observe(document.documentElement);
    update();
    return () => observer.disconnect();
  }, []);
  const visibleSearch = themes ? themeSearch : search;
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
    changeQuery((next) => next.set('view', 'discover'));
  };
  const hasFilters = Boolean(search || category || selectedStore);
  const showEditorial = visible && browsing && !params.appId && !hasFilters && preferences.showStoreRecommendations;
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
    <section
      ref={surface}
      className="orbis-store"
      data-store-facet={themes ? 'themes' : browsing ? 'apps' : 'discover'}
      data-reduced-motion={reduced ? 'true' : undefined}
      aria-label="Store catalogue"
    >
      <div className="orbis-store-toolbar">
        <div className="orbis-store-search">
          <IconSearch size={20} aria-hidden="true" />
          <Input
            value={visibleSearch}
            onChange={(event) => {
              if (themes) {
                setThemeSearch(event.target.value);
                return;
              }
              setLocalSearch(event.target.value);
              setSearch(event.target.value);
              if (!browsing) changeQuery((next) => next.set('view', 'apps'));
            }}
            aria-label={themes ? 'Search theme packs' : t('APP_STORE_SEARCH_PLACEHOLDER')}
            placeholder="Search"
          />
          {visibleSearch ? (
            <button
              type="button"
              className="orbis-store-clear-search"
              onClick={themes ? () => setThemeSearch('') : clearSearch}
              aria-label={themes ? 'Clear theme search' : 'Clear app search'}
            >
              <IconX size={18} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <SelectionGroup className="orbis-store-view-choice" role="group" aria-label="Store view">
          <button type="button" data-store-view="apps" aria-label="Apps" aria-pressed={!themes} onClick={() => browse(category)}>
            Apps
          </button>
          <button
            type="button"
            data-store-view="themes"
            aria-label="Themes"
            aria-pressed={themes}
            onClick={() => changeQuery((next) => next.set('view', 'themes'))}
          >
            Themes
          </button>
        </SelectionGroup>
        <div
          className="orbis-store-filters"
          data-inactive={themes ? 'true' : undefined}
          aria-hidden={themes || undefined}
          inert={themes || undefined}
        >
          <div className="orbis-store-category">
            <Select value={category ?? 'all'} onValueChange={(value) => browse(value === 'all' ? undefined : (value as AppCategory))}>
              <SelectTrigger aria-label="App category">
                {category ? null : (
                  <span className="orbis-store-compact-filter-name" aria-hidden="true">
                    Category
                  </span>
                )}
                <span className={category ? undefined : 'orbis-store-filter-default'}>
                  <SelectValue />
                </span>
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
                  {selectedStore ? null : (
                    <span className="orbis-store-compact-filter-name" aria-hidden="true">
                      Source
                    </span>
                  )}
                  <span className={selectedStore ? undefined : 'orbis-store-filter-default'}>
                    <SelectValue />
                  </span>
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
        </div>
        <div
          className="orbis-store-refresh"
          data-inactive={themes ? 'true' : undefined}
          aria-hidden={themes || undefined}
          inert={themes || undefined}
        >
          <RefreshAppStoresButton />
        </div>
      </div>
      <StoreViewTransition
        active={view}
        themes={<ThemePacksCatalogue surface="store" search={themeSearch} />}
        apps={
          <div className="orbis-store-catalogue" data-editorial={showEditorial ? 'true' : undefined}>
            <div className="orbis-store-results" aria-busy={updating || undefined}>
              <div className="orbis-store-result-heading">
                <div>
                  <h2>{category ? t(`APP_CATEGORY_${category.toUpperCase()}`) : search ? 'Search results' : 'Apps'}</h2>
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
                  <StoreCatalogue
                    apps={apps}
                    lastElementRef={lastElementRef}
                    collectionsAfter={editorialFits ? 8 : 16}
                    canInstall={user.operator && installed.isSuccess && tasks.isSuccess && !tasks.isError}
                    installedApps={installedApps}
                    collections={
                      <WindowVisibilityContext.Provider value={showEditorial}>
                        <StoreDiscover
                          {...recommendationProps}
                          presentation="editorial"
                          onCollections={discover}
                          key={`editorial-${selectedStore ?? 'all'}`}
                          storeId={selectedStore}
                          onBrowse={browse}
                        />
                      </WindowVisibilityContext.Provider>
                    }
                  />
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
          </div>
        }
        discover={<StoreDiscover {...recommendationProps} key={selectedStore ?? 'all'} storeId={selectedStore} onBrowse={browse} />}
      />
    </section>
  );
}
