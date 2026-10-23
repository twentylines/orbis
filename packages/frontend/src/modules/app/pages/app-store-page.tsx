import { getEnabledAppStoresOptions, searchAppsInfiniteOptions } from '@/api-client/@tanstack/react-query.gen';
import { RefreshAppStoresButton } from '@/components/refresh-app-stores/refresh-app-stores';
import { EmptyPage } from '@/components/empty-page/empty-page';
import { useInfiniteScroll } from '@/lib/hooks/use-infinite-scroll';
import { useAppStoreState } from '@/stores/app-store';
import { keepPreviousData, useInfiniteQuery, useSuspenseQuery } from '@tanstack/react-query';
import { Navigate, useParams, useSearchParams } from 'react-router';
import { StoreTile } from '../components/store-tile/store-tile';
import { useCallback, useEffect, useState } from 'react';
import { Input } from '@/components/ui/Input';
import { useTranslation } from 'react-i18next';
import { StoreSelector } from '@/components/store-selector/store-selector';
import { CategorySelector } from '@/components/category-selector/category-selector';
import { ActionBar } from '@/components/action-bar/action-bar';
import { useCluster } from '@/desktop/cluster';
import { ClusterStore } from '@/desktop/cluster-views';
import { DelayedRouteLoading } from '@/desktop/route-loading';
import { useLocation } from 'react-router';
import { nextStorePreviewHistory, type StorePreviewHistory } from './store-preview-navigation';

export const AppStorePageSuspense = () => {
  return <DelayedRouteLoading label="Loading app catalogue…" />;
};

export default () => {
  const cluster = useCluster();
  if (cluster.merged || (cluster.selectedServer && !cluster.selectedServer.local)) return <ClusterStore />;
  return <LocalStore />;
};

function LocalStore() {
  const params = useParams<{ storeId: string; appId: string }>();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();

  const selectedStore = searchParams.get('store') ?? undefined;

  const { setCategory, category, storeId, setStoreId, search: initialSearch, setSearch } = useAppStoreState();
  const [search, setLocalSearch] = useState(initialSearch);
  const { t } = useTranslation();

  useEffect(() => {
    if (selectedStore !== storeId) {
      setStoreId(selectedStore);
    }
  }, [selectedStore, setStoreId, storeId]);

  const { data: appStores } = useSuspenseQuery({
    ...getEnabledAppStoresOptions(),
  });

  const onSearch = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setLocalSearch(e.target.value);
      setSearch(e.target.value);
    },
    [setSearch],
  );

  const onSelectStore = useCallback(
    (value?: string) => {
      const options = {
        preventScrollReset: true,
        state: params.appId ? nextStorePreviewHistory(location.state as StorePreviewHistory | null, location.search, true) : undefined,
      };
      if (value) {
        setSearchParams({ store: value }, options);
      } else {
        setSearchParams({}, options);
      }
      setStoreId(value);
    },
    [location.search, location.state, params.appId, setSearchParams, setStoreId],
  );

  const { data, hasNextPage, isFetchingNextPage, isFetching, fetchNextPage } = useInfiniteQuery({
    ...searchAppsInfiniteOptions({ query: { search, category, pageSize: 24, storeId } }),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    placeholderData: keepPreviousData,
  });

  const isLoading = !data;
  const apps = data?.pages.flatMap((page) => page.data) ?? [];

  const { lastElementRef } = useInfiniteScroll({
    fetchNextPage,
    hasNextPage: Boolean(hasNextPage),
    isFetching: isFetchingNextPage || isFetching,
  });

  if (params.storeId && !params.appId) {
    return <Navigate to={`/app-store?store=${params.storeId}`} />;
  }

  const toolbar = (
    <ActionBar sticky>
      <ActionBar.Left>
        <Input value={search} onChange={onSearch} placeholder={t('APP_STORE_SEARCH_PLACEHOLDER')} />
      </ActionBar.Left>
      <ActionBar.Center>
        {appStores.appStores.length > 1 ? <StoreSelector initialValue={selectedStore} stores={appStores.appStores} onSelect={onSelectStore} /> : null}
      </ActionBar.Center>
      <ActionBar.Right>
        <CategorySelector initialValue={category} onSelect={setCategory} />
        <RefreshAppStoresButton />
      </ActionBar.Right>
    </ActionBar>
  );

  return (
    <>
      {toolbar}
      {isLoading ? (
        <AppStorePageSuspense />
      ) : apps.length ? (
        <div className="desktop-catalogue">
          <div className="desktop-catalogue-grid">
            {apps.map((app, index) => (
              <div ref={index === apps.length - 1 ? lastElementRef : null} key={app.urn} className="desktop-catalogue-item">
                <StoreTile app={app} isLoading={isLoading} />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <EmptyPage title="APP_STORE_NO_RESULTS" subtitle="APP_STORE_NO_RESULTS_SUBTITLE" />
      )}
    </>
  );
}
