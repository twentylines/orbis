import type { MouseEvent } from 'react';
import { Link } from 'react-router';
import { useQueries } from '@tanstack/react-query';
import { IconArrowRight, IconBrandDocker, IconExternalLink, IconRefresh, IconServer } from '@tabler/icons-react';
import type { ContainerTelemetry, DockerApps } from '@runtipi/common/schemas';
import type { GetAppDto } from '@/api-client';
import { AppLogo } from '@/components/app-logo/app-logo';
import { DockerHealth } from '@/components/docker-health/docker-health';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { WrapWords } from '@/components/wrap-words/wrap-words';
import { appDestinations, type AppDestinationData } from './app-destinations';
import { useAppLauncher, useOpenedApps } from './app-launcher';
import { AppLibraryControls, useLibraryFilters } from './app-library-controls';
import { selectLibraryApps } from './app-library';
import { appDockerHealth } from './container-health';
import { clusterRequest, ServerRack, useCluster, type ClusterServer, type ServerReading } from './cluster';
import { useDesktopPreferences } from './preferences';
import type { Telemetry } from './telemetry';
import { formatUptime } from './uptime';
import { useWindowVisible } from './window-visibility';
import './cluster-views.css';
import { ClusterCatalogue } from './cluster-catalogue';

export type ClusterManagedApp = AppDestinationData & {
  app: NonNullable<AppDestinationData['app']> & Pick<NonNullable<GetAppDto['app']>, 'id' | 'version' | 'ignoredVersion' | 'createdAt'>;
  info: AppDestinationData['info'] & Pick<GetAppDto['info'], 'urn' | 'name' | 'available' | 'categories'>;
  metadata: AppDestinationData['metadata'] & Pick<GetAppDto['metadata'], 'latestVersion'>;
};
type ServerApps = { installed: ClusterManagedApp[]; addresses: { localDomain?: string; sslPort?: number } };
const percent = (value: number | null | undefined) => (typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}%` : 'Unavailable');
export const clusterResourceBytes = (value: number | null) => {
  if (value === null || !Number.isFinite(value) || value < 0) return 'Unavailable';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log2(Math.max(1, value)) / 10));
  return `${(value / 1024 ** index).toFixed(index > 0 ? 1 : 0)} ${units[index]}`;
};
const memoryPercent = (sample?: Telemetry) => {
  const total = sample?.memory.totalBytes;
  const available = sample?.memory.availableBytes;
  return typeof total === 'number' && Number.isFinite(total) && total > 0 && typeof available === 'number' && available >= 0 && available <= total
    ? ((total - available) / total) * 100
    : null;
};
const statusLabel = (value: string) => `${value[0]?.toUpperCase() ?? ''}${value.slice(1).replaceAll('_', ' ')}`;
const serverPath = (server: ClusterServer, path: string) => {
  if (server.local) return path;
  try {
    const url = new URL(server.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return new URL(path, url.origin).href;
  } catch {
    return null;
  }
};
const serverHostname = (server: ClusterServer) => {
  if (server.local) return typeof window === 'undefined' ? '' : window.location.hostname;
  try {
    return new URL(server.url).hostname;
  } catch {
    return '';
  }
};
const serverAddress = (server: ClusterServer) => {
  if (server.local) return typeof window === 'undefined' ? 'This server' : window.location.host;
  try {
    return new URL(server.url).host;
  } catch {
    return 'Address unavailable';
  }
};
function useScopedServers() {
  const cluster = useCluster();
  return { cluster, servers: cluster.merged ? (cluster.data?.servers ?? []) : cluster.selectedServer ? [cluster.selectedServer] : [] };
}
function useServerReadings<T>(servers: ClusterServer[], resource: string, interval: number) {
  const visible = useWindowVisible();
  return useQueries({
    queries: servers.map((server) => ({
      queryKey: ['cluster-server', server.id, resource],
      queryFn: () => clusterRequest<T>(`/servers/${encodeURIComponent(server.id)}/read/${resource}`),
      enabled: visible,
      refetchInterval: interval,
      refetchIntervalInBackground: false,
      staleTime: interval - 1000,
      retry: 1,
    })),
  });
}

export function ClusterOverview() {
  const { cluster, servers } = useScopedServers();
  const { preferences } = useDesktopPreferences();
  const queries = useServerReadings<Telemetry>(servers, 'telemetry', 10000);
  const responding = queries.filter((query) => !query.isError && query.data).length;
  const pending = queries.some((query) => query.isPending);
  const readings = Object.fromEntries(
    servers.map((server, index): [string, ServerReading] => {
      const query = queries[index];
      const sample = query?.isError ? undefined : query?.data;
      return [server.id, { cpu: sample?.cpu.totalPercent ?? null, memory: memoryPercent(sample), online: query?.isPending ? undefined : !!sample }];
    }),
  );
  if (cluster.isError) {
    return (
      <p className="workspace-message" role="alert">
        The server list could not be loaded. <Button onClick={() => void cluster.refetch()}>Retry</Button>
      </p>
    );
  }
  if (!servers.length) return <output className="cluster-view-loading">Loading servers…</output>;
  return (
    <section className="cluster-overview" aria-label="Cluster status">
      <div className="cluster-overview-hero">
        <div className="cluster-overview-copy">
          <h2 title={cluster.data?.name || preferences.serverName}>
            <WrapWords text={cluster.data?.name || preferences.serverName} />
          </h2>
          <p>{pending ? 'Checking server connections…' : `${responding} of ${servers.length} servers responding`}</p>
          <div className="cluster-overview-counts">
            <div>
              <span>Servers</span>
              <strong>{servers.length}</strong>
            </div>
            <div>
              <span>Available</span>
              <strong>{pending ? '—' : responding}</strong>
            </div>
            <div>
              <span>Unavailable</span>
              <strong>{pending ? '—' : servers.length - responding}</strong>
            </div>
          </div>
          <Link to="/updates" className="cluster-view-text-link">
            Review updates <IconArrowRight size={17} aria-hidden="true" />
          </Link>
        </div>
        <ServerRack readings={readings} />
      </div>
      <div className="cluster-summary-grid">
        {servers.map((server, index) => {
          const query = queries[index];
          const sample = query?.isError ? undefined : query?.data;
          const name = server.local ? preferences.serverName : server.name;
          return (
            <div key={server.id} className="cluster-summary-card" data-unavailable={query?.isError || undefined}>
              <button type="button" className="cluster-summary-select" onClick={() => cluster.select(server.id)} aria-label={`View ${name} status`}>
                <IconServer size={23} aria-hidden="true" />
                <span>
                  <strong title={name}>
                    <WrapWords text={name} />
                  </strong>
                  <span title={serverAddress(server)}>{serverAddress(server)}</span>
                </span>
                <IconArrowRight size={18} aria-hidden="true" />
              </button>
              <div className="cluster-summary-readings">
                <div>
                  <span>CPU</span>
                  <strong>{percent(sample?.cpu.totalPercent)}</strong>
                </div>
                <div>
                  <span>Memory</span>
                  <strong>{percent(memoryPercent(sample))}</strong>
                </div>
                <div>
                  <span>Uptime</span>
                  <strong>{formatUptime(sample?.cpu.uptimeSeconds)}</strong>
                </div>
              </div>
              {query?.isError ? (
                <p className="cluster-server-unavailable" role="alert">
                  Readings unavailable.{' '}
                  <button type="button" onClick={() => void query.refetch()}>
                    Retry
                  </button>
                </p>
              ) : null}
              {query?.isPending ? <output>Reading status…</output> : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function ClusterApps({ compact = false }: { compact?: boolean } = {}) {
  const { cluster, servers } = useScopedServers();
  const { preferences } = useDesktopPreferences();
  const openApp = useAppLauncher();
  const { filters, change } = useLibraryFilters();
  const opened = useOpenedApps();
  const apps = useServerReadings<ServerApps>(servers, 'apps', 30000);
  const docker = useServerReadings<DockerApps>(servers, 'docker-apps', 30000);
  const containers = useServerReadings<ContainerTelemetry>(servers, 'containers', 30000);
  const serverName = (server: ClusterServer) => (server.local ? preferences.serverName : server.name);
  const managed = servers.flatMap((server, index) =>
    (apps[index]?.data?.installed ?? []).map((entry) => ({
      server,
      index,
      entry,
      key: server.local ? entry.info.urn : `${server.id}/${entry.info.urn}`,
      name: entry.info.name,
      categories: entry.info.categories,
      installedAt: entry.app.createdAt * 1000,
      searchText: serverName(server),
    })),
  );
  const detected = servers.flatMap((server, index) =>
    (docker[index]?.data?.apps ?? []).map((entry) => ({
      server,
      index,
      entry,
      key: `${server.id}/docker/${entry.id}`,
      name: entry.name,
      searchText: serverName(server),
    })),
  );
  const managedMatches = selectLibraryApps(managed, filters, opened);
  const detectedMatches = selectLibraryApps(detected, filters, opened);
  const pending = apps.some((query) => query.isPending) || docker.some((query) => query.isPending);
  const launch = (event: MouseEvent<HTMLAnchorElement>, server: ClusterServer, entry: ClusterManagedApp, logoUrl: string, launchUrl?: string) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (apps[servers.findIndex((item) => item.id === server.id)]?.isError) return;
    const [appName, store] = entry.info.urn.split(':');
    const manageUrl = serverPath(server, `/apps/${encodeURIComponent(store ?? '')}/${encodeURIComponent(appName ?? '')}`);
    if (
      manageUrl &&
      openApp({
        urn: `${server.id}/${entry.info.urn}`,
        name: entry.info.name,
        recentKey: server.local ? entry.info.urn : `${server.id}/${entry.info.urn}`,
        serverName: serverName(server),
        logoUrl,
        launchUrl,
        manageUrl,
        status: entry.app.status,
      })
    )
      event.preventDefault();
  };
  if (cluster.isError)
    return (
      <p className="workspace-message" role="alert">
        The server list could not be loaded. <Button onClick={() => void cluster.refetch()}>Retry</Button>
      </p>
    );
  return (
    <section className={`cluster-apps ${compact ? 'is-compact' : ''}`} aria-label="Apps across servers">
      <header className="cluster-apps-heading">
        <div>
          {compact ? <h2>Applications</h2> : null}
          <p>
            {cluster.merged ? cluster.data?.name : servers[0] ? serverName(servers[0]) : 'Loading servers…'} · {managed.length + detected.length} apps
            {pending ? ' loaded' : ''}
          </p>
        </div>
        <Button asChild>
          <Link to="/updates">
            Updates <IconArrowRight size={17} aria-hidden="true" />
          </Link>
        </Button>
      </header>
      {compact ? (
        <Input
          name="cluster-app-search"
          label="Find an app"
          type="search"
          value={filters.search}
          onChange={(event) => change('q', event.target.value)}
          placeholder="Search"
        />
      ) : (
        <AppLibraryControls filters={filters} change={change} categories={managed.flatMap((entry) => entry.categories ?? [])} />
      )}
      {servers.map((server, index) =>
        apps[index]?.isError || docker[index]?.isError ? (
          <div className="cluster-inventory-error" role="alert" key={server.id}>
            <div>
              <strong>{serverName(server)}</strong>
              <p>
                {apps[index]?.isError && docker[index]?.isError
                  ? 'App inventories are unavailable.'
                  : apps[index]?.isError
                    ? 'The Orbis app inventory is unavailable.'
                    : 'The Docker app inventory is unavailable.'}{' '}
                Previous entries may be out of date.
              </p>
            </div>
            <Button
              onClick={() => {
                void apps[index]?.refetch();
                void docker[index]?.refetch();
              }}
            >
              <IconRefresh size={17} aria-hidden="true" /> Retry
            </Button>
          </div>
        ) : null,
      )}
      {pending || !servers.length ? <output className="cluster-view-loading">Loading apps…</output> : null}
      {!pending &&
      servers.length > 0 &&
      managed.length + detected.length === 0 &&
      apps.every((query) => !query.isError) &&
      docker.every((query) => !query.isError) ? (
        <p className="cluster-view-empty">No apps found on {cluster.merged ? 'these servers' : 'this server'}.</p>
      ) : null}
      {(filters.search || filters.category) && managed.length + detected.length > 0 && managedMatches.length + detectedMatches.length === 0 ? (
        <p className="cluster-view-empty">No apps match this search.</p>
      ) : null}
      <ul className="cluster-app-grid">
        {managedMatches.map(({ entry, server, index }) => {
          const inventory = apps[index];
          const stale = inventory?.isError ?? false;
          const containerQuery = containers[index];
          const telemetry = containerQuery?.data;
          const liveContainers =
            !stale && !containerQuery?.isError && telemetry?.available ? telemetry.containers.filter((item) => item.appUrn === entry.info.urn) : [];
          const health = !stale && !containerQuery?.isError && telemetry?.available ? appDockerHealth(liveContainers) : undefined;
          const cpu =
            liveContainers.length && liveContainers.every((item) => item.statsAvailable && item.cpuPercent !== null)
              ? liveContainers.reduce((sum, item) => sum + (item.cpuPercent ?? 0), 0)
              : null;
          const memory =
            liveContainers.length && liveContainers.every((item) => item.statsAvailable && item.memoryBytes !== null)
              ? liveContainers.reduce((sum, item) => sum + (item.memoryBytes ?? 0), 0)
              : null;
          const logoUrl = server.local
            ? `/api/marketplace/apps/${encodeURIComponent(entry.info.urn)}/image`
            : `/api/cluster/servers/${encodeURIComponent(server.id)}/icon?urn=${encodeURIComponent(entry.info.urn)}`;
          const [appName, store] = entry.info.urn.split(':');
          const manageUrl = serverPath(server, `/apps/${encodeURIComponent(store ?? '')}/${encodeURIComponent(appName ?? '')}`);
          const launchUrl =
            stale || !entry.info.available ? undefined : appDestinations(entry, inventory?.data?.addresses ?? {}, serverHostname(server))[0]?.url;
          const updateAvailable = entry.app.version < entry.metadata.latestVersion && entry.app.ignoredVersion !== entry.metadata.latestVersion;
          return (
            <li className="cluster-app-card" key={`${server.id}/${entry.info.urn}`} data-server-id={server.id} data-stale={stale || undefined}>
              <div className="cluster-app-identity">
                <AppLogo urn={entry.info.urn} url={logoUrl} size={48} />
                <div>
                  <h3>
                    {manageUrl ? (
                      <Link
                        to={manageUrl}
                        title={entry.info.name}
                        target={server.local ? undefined : '_blank'}
                        rel={server.local ? undefined : 'noopener noreferrer'}
                        onClick={(event) => launch(event, server, entry, logoUrl, launchUrl)}
                      >
                        <WrapWords text={entry.info.name} />
                      </Link>
                    ) : (
                      <WrapWords text={entry.info.name} />
                    )}
                  </h3>
                  <span className="cluster-app-server">
                    <IconServer size={14} aria-hidden="true" />
                    <span title={serverName(server)}>
                      <WrapWords text={serverName(server)} />
                    </span>
                  </span>
                </div>
              </div>
              <div className="cluster-app-health">
                {!stale && entry.app.status !== 'running' && health?.label.toLocaleLowerCase() !== entry.app.status ? (
                  <span>{statusLabel(entry.app.status)}</span>
                ) : null}
                <DockerHealth appUrn={entry.info.urn} telemetry={telemetry} stale={stale || containerQuery?.isError} />
              </div>
              {stale ? (
                <p className="cluster-app-notice">Previous app inventory</p>
              ) : entry.info.available ? (
                updateAvailable ? (
                  <p className="cluster-app-notice">Update available</p>
                ) : null
              ) : (
                <p className="cluster-app-notice">App configuration unavailable</p>
              )}
              <dl className="cluster-app-resources">
                <div>
                  <dt>CPU</dt>
                  <dd>{percent(cpu)}</dd>
                </div>
                <div>
                  <dt>Memory</dt>
                  <dd>{clusterResourceBytes(memory)}</dd>
                </div>
              </dl>
              <div className="cluster-app-actions">
                {launchUrl ? (
                  <Button asChild intent="primary">
                    <a
                      href={launchUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(event) => launch(event, server, entry, logoUrl, launchUrl)}
                    >
                      Open <IconExternalLink size={16} aria-hidden="true" />
                    </a>
                  </Button>
                ) : null}
                {manageUrl ? (
                  <Button asChild>
                    <Link to={manageUrl} target={server.local ? undefined : '_blank'} rel={server.local ? undefined : 'noopener noreferrer'}>
                      Manage
                    </Link>
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
        {detectedMatches.map(({ entry, server, index }) => {
          const manageUrl = serverPath(server, '/apps#docker-apps-title');
          const stale = docker[index]?.isError ?? false;
          return (
            <li
              className="cluster-app-card cluster-detected-app"
              key={`${server.id}/docker/${entry.id}`}
              data-server-id={server.id}
              data-stale={stale || undefined}
            >
              <div className="cluster-app-identity">
                <span className="cluster-docker-icon">
                  <IconBrandDocker size={30} stroke={1.5} aria-hidden="true" />
                </span>
                <div>
                  <h3 title={entry.name}>
                    <WrapWords text={entry.name} />
                  </h3>
                  <span className="cluster-app-server">
                    <IconServer size={14} aria-hidden="true" />
                    <span title={serverName(server)}>
                      <WrapWords text={serverName(server)} />
                    </span>
                  </span>
                </div>
              </div>
              <p className="cluster-docker-count">
                {stale ? 'Last inventory: ' : ''}
                {entry.running} running · {entry.containers.length} {entry.containers.length === 1 ? 'container' : 'containers'}
              </p>
              <p className="cluster-app-notice">{stale ? 'Docker inventory unavailable' : 'Detected Docker app'}</p>
              <div className="cluster-app-actions">
                {manageUrl ? (
                  <Button asChild>
                    <Link
                      to={manageUrl}
                      target={server.local ? undefined : '_blank'}
                      rel={server.local ? undefined : 'noopener noreferrer'}
                      aria-label={`Manage ${entry.name} on ${serverName(server)}`}
                    >
                      Manage
                    </Link>
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function ClusterStore() {
  const { cluster, servers } = useScopedServers();
  const { preferences } = useDesktopPreferences();
  if (cluster.isError) {
    return (
      <p className="workspace-message" role="alert">
        The server list could not be loaded. <Button onClick={() => void cluster.refetch()}>Retry</Button>
      </p>
    );
  }
  return (
    <section className="cluster-store" aria-label="Choose an app store">
      <div className="cluster-overview-hero">
        <div className="cluster-overview-copy">
          <h2>Install apps on a server</h2>
          <p>Installation uses the selected server’s own app store.</p>
        </div>
        <ServerRack />
      </div>
      {servers.length ? null : <output className="cluster-view-loading">Loading servers…</output>}
      {servers.length === 1 && servers[0] ? (
        <ClusterCatalogue key={servers[0].id} server={servers[0]} />
      ) : (
        <div className="cluster-summary-grid">
          {servers.map((server) => {
            const name = server.local ? preferences.serverName : server.name;
            const storeUrl = serverPath(server, '/app-store');
            return (
              <article key={server.id} className="cluster-summary-card cluster-store-card">
                <div className="cluster-app-identity">
                  <span className="cluster-docker-icon">
                    <IconServer size={27} aria-hidden="true" />
                  </span>
                  <div>
                    <h3 title={name}>
                      <WrapWords text={name} />
                    </h3>
                    <span className="cluster-store-address" title={serverAddress(server)}>
                      {serverAddress(server)}
                    </span>
                  </div>
                </div>
                <p>{server.role === 'admin' ? 'Admin server' : 'Paired server'}</p>
                {storeUrl ? (
                  <Button intent="primary" onClick={() => cluster.select(server.id)} aria-label={`Browse apps on ${name}`}>
                    Browse apps <IconArrowRight size={17} aria-hidden="true" />
                  </Button>
                ) : (
                  <p>Server address unavailable.</p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
