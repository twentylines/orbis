import { AppLogo } from '@/components/app-logo/app-logo';
import { DockerHealth } from '@/components/docker-health/docker-health';
import { Button } from '@/components/ui/Button';
import { useAppLauncher } from '@/desktop/app-launcher';
import { appDestinations } from '@/desktop/app-destinations';
import { clusterRequest, useCluster, type ClusterServer } from '@/desktop/cluster';
import { serverPath, type ClusterManagedApp } from '@/desktop/cluster-views';
import { DelayedRouteLoading } from '@/desktop/route-loading';
import { useWindowVisible } from '@/desktop/window-visibility';
import { IconArrowLeft, IconExternalLink } from '@tabler/icons-react';
import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ContainerTelemetry } from '@runtipi/common/schemas';
import { Link, useParams } from 'react-router';
import AppDetailsPage from './app-details-page';
import CustomAppDetailsPage from './custom-app-details-page';
import { useStorePreview } from './store-preview-context';
import '../containers/app-workspace/app-workspace.css';

type ServerApps = { installed: ClusterManagedApp[]; addresses: { localDomain?: string; sslPort?: number } };

export default function ClusterAppPreview() {
  const { serverId, appId, storeId } = useParams<{ serverId: string; appId: string; storeId: string }>();
  const cluster = useCluster();
  const server = cluster.data?.servers.find((entry) => entry.id === serverId);
  if (cluster.isPending) return <DelayedRouteLoading label="Loading paired server…" />;
  if (!server || !appId || !storeId) return <UnavailablePreview>This server is no longer paired.</UnavailablePreview>;
  if (server.local) return storeId === '_user' ? <CustomAppDetailsPage /> : <AppDetailsPage />;
  return <PairedAppPreview server={server} urn={`${appId}:${storeId}`} />;
}

function PairedAppPreview({ server, urn }: { server: ClusterServer; urn: string }) {
  const visible = useWindowVisible();
  const preview = useStorePreview();
  const openApp = useAppLauncher();
  const inventory = useSuspenseQuery({
    queryKey: ['cluster-server', server.id, 'apps'],
    queryFn: () => clusterRequest<ServerApps>(`/servers/${encodeURIComponent(server.id)}/read/apps`),
    refetchInterval: visible ? 30_000 : false,
    refetchIntervalInBackground: false,
    staleTime: 29_000,
    retry: false,
  });
  const containers = useQuery({
    queryKey: ['cluster-server', server.id, 'containers'],
    queryFn: () => clusterRequest<ContainerTelemetry>(`/servers/${encodeURIComponent(server.id)}/read/containers`),
    enabled: visible,
    refetchInterval: visible ? 30_000 : false,
    refetchIntervalInBackground: false,
    staleTime: 29_000,
    retry: false,
  });
  const entry = inventory.data.installed.find((app) => app.info.urn === urn);
  const [appId, storeId] = urn.split(':');
  const manageUrl = serverPath(
    server,
    `/apps/${storeId === '_user' ? '' : `${encodeURIComponent(storeId ?? '')}/`}${encodeURIComponent(appId ?? '')}`,
  );
  const logoUrl = `/api/cluster/servers/${encodeURIComponent(server.id)}/icon?urn=${encodeURIComponent(urn)}`;
  const hostname = manageUrl ? new URL(manageUrl).hostname : '';
  const launchUrl =
    entry && manageUrl && !inventory.isError && entry.info.available ? appDestinations(entry, inventory.data.addresses, hostname)[0]?.url : undefined;
  if (!entry) return <UnavailablePreview>This app is no longer installed on {server.name}.</UnavailablePreview>;
  return (
    <div className="app-workspace" data-testid="paired-app-details">
      <Link
        className="app-workspace-back"
        to={preview?.closePath ?? '/apps'}
        onClick={(event) => {
          if (preview && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
            event.preventDefault();
            preview.close();
          }
        }}
      >
        <IconArrowLeft size={16} aria-hidden="true" /> Apps
      </Link>
      <header className="app-workspace-hero">
        <div className="app-workspace-logo">
          <AppLogo urn={urn} url={logoUrl} size={96} alt="" />
        </div>
        <div className="app-workspace-identity">
          <h2>{entry.info.name}</h2>
          <p>Installed on {server.name}</p>
          <div className="app-workspace-state">
            <DockerHealth appUrn={urn} telemetry={containers.data} stale={containers.isError || inventory.isError} />
          </div>
        </div>
        <div className="app-workspace-controls">
          {launchUrl ? (
            <Button asChild>
              <a
                href={launchUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => {
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  if (
                    openApp({
                      urn: `${server.id}/${urn}`,
                      name: entry.info.name,
                      recentKey: `${server.id}/${urn}`,
                      serverName: server.name,
                      logoUrl,
                      launchUrl,
                      manageUrl: manageUrl ?? undefined,
                      status: entry.app.status,
                    })
                  )
                    event.preventDefault();
                }}
              >
                Open app <IconExternalLink size={16} aria-hidden="true" />
              </a>
            </Button>
          ) : null}
        </div>
      </header>
      <dl className="app-workspace-facts">
        <div>
          <dt>Server</dt>
          <dd>{server.name}</dd>
        </div>
        <div>
          <dt>Installed revision</dt>
          <dd>{entry.app.version}</dd>
        </div>
        <div>
          <dt>Store</dt>
          <dd>{storeId === '_user' ? 'Custom application' : storeId}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{inventory.isError ? 'Unavailable' : entry.app.status.replaceAll('_', ' ')}</dd>
        </div>
      </dl>
      {inventory.isError ? <p role="alert">The paired server is unavailable. Showing the previous app inventory.</p> : null}
      <p>App settings and additional details are available on {server.name}.</p>
      {manageUrl ? (
        <Button asChild>
          <a href={manageUrl} target="_blank" rel="noopener noreferrer">
            Manage on {server.name} <IconExternalLink size={16} aria-hidden="true" />
          </a>
        </Button>
      ) : null}
    </div>
  );
}

function UnavailablePreview({ children }: { children: ReactNode }) {
  const preview = useStorePreview();
  return (
    <div className="store-preview-error" role="alert">
      <p>{children}</p>
      <button type="button" onClick={preview?.close}>
        Back to Apps
      </button>
    </div>
  );
}
