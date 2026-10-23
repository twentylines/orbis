import { useEffect, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { AppLogo } from '@/components/app-logo/app-logo';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { WrapWords } from '@/components/wrap-words/wrap-words';
import { clusterRequest, type ClusterServer } from './cluster';
import { ClusterInstallDialog } from './cluster-install';
import { useWindowVisible } from './window-visibility';
import './cluster-catalogue.css';

type CatalogueApp = { urn: string; name: string; short_desc: string; categories: string[] };
type Catalogue = { data: CatalogueApp[]; nextCursor: string | null; total: number };

export function ClusterCatalogue({ server }: { server: ClusterServer }) {
  const visible = useWindowVisible();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<CatalogueApp | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 320);
    return () => clearTimeout(timer);
  }, [search]);
  const catalogue = useInfiniteQuery({
    queryKey: ['cluster-catalogue', server.id, query],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      clusterRequest<Catalogue>(
        `/servers/${encodeURIComponent(server.id)}/read/catalogue?${new URLSearchParams({ search: query, cursor: pageParam })}`,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: visible,
    retry: false,
    staleTime: 30_000,
  });
  return (
    <section className="cluster-catalogue" aria-label={`Apps on ${server.name}`}>
      <div className="cluster-catalogue-toolbar">
        <Input
          label="Search this server’s apps"
          value={search}
          maxLength={160}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search apps"
        />
        <output>{catalogue.data ? `${catalogue.data.pages[0]?.total ?? 0} apps` : 'Loading catalogue…'}</output>
      </div>
      {catalogue.error ? (
        <div className="workspace-message" role="alert">
          <p>This server’s catalogue could not be loaded.</p>
          <Button onClick={() => void catalogue.refetch()}>Retry</Button>
        </div>
      ) : null}
      {catalogue.data?.pages[0]?.total === 0 ? <p>No apps match this search.</p> : null}
      <div className="cluster-catalogue-grid">
        {catalogue.data?.pages
          .flatMap((page) => page.data)
          .map((app) => (
            <button
              key={app.urn}
              type="button"
              className="cluster-catalogue-tile"
              onClick={() => setSelected(app)}
              aria-label={`Install ${app.name} on ${server.name}`}
            >
              <AppLogo size={48} url={`/api/cluster/servers/${encodeURIComponent(server.id)}/icon?urn=${encodeURIComponent(app.urn)}`} />
              <span>
                <strong>
                  <WrapWords text={app.name} />
                </strong>
                <span>
                  <WrapWords text={app.short_desc} />
                </span>
              </span>
            </button>
          ))}
      </div>
      {catalogue.hasNextPage ? (
        <Button loading={catalogue.isFetchingNextPage} onClick={() => void catalogue.fetchNextPage()}>
          Load more apps
        </Button>
      ) : null}
      {selected ? (
        <ClusterInstallDialog
          key={`${server.id}:${selected.urn}`}
          urn={selected.urn}
          name={selected.name}
          serverId={server.id}
          isOpen
          onClose={() => setSelected(null)}
        />
      ) : null}
    </section>
  );
}
