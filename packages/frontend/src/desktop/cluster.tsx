import { createContext, useContext, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from 'react-router';
import { IconCheck, IconChevronDown, IconLayersLinked, IconPlus, IconServer, IconSwitchHorizontal } from '@tabler/icons-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { useDesktopPreferences } from './preferences';
import type { Telemetry } from './telemetry';
import { useAppContext } from '@/context/app-context';
import { useConnectionStore } from '@/stores/connection-store';
import './cluster.css';

export type ClusterServer = { id: string; name: string; url: string; role: 'admin' | 'member'; local: boolean };
export type Cluster = {
  id: string;
  name: string;
  role: 'standalone' | 'admin' | 'member';
  localId: string;
  servers: ClusterServer[];
  admin?: { id: string; name: string };
};
export type ServerReading = { cpu: number | null; memory: number | null; online?: boolean };
type ClusterContextValue = {
  data: Cluster | undefined;
  selectedId: string;
  selectedServer: ClusterServer | undefined;
  merged: boolean;
  select: (id: string) => void;
  isPending: boolean;
  isError: boolean;
  refetch: () => Promise<unknown>;
};
const ClusterContext = createContext<ClusterContextValue | null>(null);
export const clusterQueryKey = ['orbis-cluster'] as const;

export async function clusterRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/cluster${path}`, {
    method,
    credentials: 'include',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const result = (await response.json().catch(() => null)) as { message?: string | string[] } | null;
    throw new Error(typeof result?.message === 'string' ? result.message : 'The cluster request failed. Try again.');
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function ClusterProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const cluster = useQuery({
    queryKey: clusterQueryKey,
    queryFn: () => clusterRequest<Cluster>(''),
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    retry: 1,
  });
  const [selection, setSelection] = useState('');
  const localId = cluster.data?.localId ?? '';
  const selectedId =
    selection === 'all' && (cluster.data?.servers.length ?? 0) > 1
      ? 'all'
      : cluster.data?.servers.some((server) => server.id === selection)
        ? selection
        : localId;
  const selectedServer = cluster.data?.servers.find((server) => server.id === selectedId);
  useLayoutEffect(() => {
    if (localId && selectedId !== localId && (location.pathname.startsWith('/apps/') || location.pathname.startsWith('/app-store/'))) {
      setSelection(localId);
    }
  }, [localId, selectedId, location.pathname]);
  const select = (id: string) => {
    if ((id === 'all' && (cluster.data?.servers.length ?? 0) > 1) || cluster.data?.servers.some((server) => server.id === id)) {
      const opener = document.activeElement;
      setSelection(id);
      requestAnimationFrame(() => {
        if (opener?.isConnected || document.activeElement !== document.body) return;
        document.querySelector<HTMLElement>('.cluster-switcher, .desktop-dock-item[aria-current="page"]')?.focus({ preventScroll: true });
      });
      if (location.pathname.startsWith('/apps/')) void navigate('/apps');
      else if (location.pathname.startsWith('/app-store/')) void navigate('/app-store');
    }
  };
  return (
    <ClusterContext.Provider
      value={{
        data: cluster.data,
        selectedId,
        selectedServer,
        merged: selectedId === 'all',
        select,
        isPending: cluster.isPending,
        isError: cluster.isError,
        refetch: cluster.refetch,
      }}
    >
      {children}
    </ClusterContext.Provider>
  );
}

export const useOptionalCluster = () => useContext(ClusterContext);

export function ClusterConnection() {
  const { selectedServer } = useCluster();
  const { userSettings } = useAppContext();
  const hubStatus = useConnectionStore((state) => state.status);
  const remote = selectedServer && !selectedServer.local ? selectedServer : null;
  const reading = useQuery({
    queryKey: ['cluster-server', remote?.id ?? 'none', 'telemetry'],
    queryFn: () => clusterRequest<Telemetry>(`/servers/${encodeURIComponent(remote?.id ?? '')}/read/telemetry`),
    enabled: !!remote && hubStatus === 'connected',
    staleTime: 9000,
    refetchInterval: 10000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const status =
    hubStatus !== 'connected' ? hubStatus : remote ? (reading.isError ? 'reconnecting' : reading.isPending ? 'connecting' : 'connected') : hubStatus;
  let address = userSettings.internalIp;
  if (remote) {
    try {
      address = new URL(remote.url).hostname;
    } catch {
      address = '';
    }
  }
  const label = status === 'connected' ? address || 'Address unavailable' : status === 'connecting' ? 'Connecting' : 'Reconnecting';
  return (
    <output
      className="desktop-connection"
      data-connection-kind={status === 'connected' && address ? 'address' : 'status'}
      data-connection-state={status}
      aria-label={status === 'connected' && address ? `Connected to ${remote?.name ?? 'admin server'} at ${address}` : label}
      title={label}
    >
      <span className={`desktop-connection-dot is-${status}`} aria-hidden="true" />
      <span className="desktop-connection-label">{label}</span>
    </output>
  );
}

export function ClusterServerLabel() {
  const cluster = useCluster();
  const { preferences } = useDesktopPreferences();
  const name = cluster.merged
    ? (cluster.data?.name ?? preferences.serverName)
    : cluster.selectedServer && !cluster.selectedServer.local
      ? cluster.selectedServer.name
      : preferences.serverName;
  return <span title={name}>{name}</span>;
}

export function useCluster() {
  const value = useContext(ClusterContext);
  if (!value) throw new Error('ClusterProvider is missing');
  return value;
}

const percentage = (value: number | null | undefined) => (typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}%` : '—');
const percentageWidth = (value: number | null | undefined) => `${Math.min(100, Math.max(0, value ?? 0))}%`;
const serverAddress = (server: ClusterServer) => {
  try {
    return new URL(server.url).host;
  } catch {
    return server.local ? 'This server' : 'Address unavailable';
  }
};

function ServerModule({
  server,
  reading,
  selected,
  onClick,
  className = '',
  opensSelector,
  expanded,
}: {
  server: ClusterServer;
  reading?: ServerReading;
  selected: boolean;
  onClick?: () => void;
  className?: string;
  opensSelector?: boolean;
  expanded?: boolean;
}) {
  const { preferences } = useDesktopPreferences();
  const name = server.local ? preferences.serverName : server.name;
  return (
    <button
      type="button"
      className={`cluster-module ${className}`}
      aria-pressed={opensSelector ? undefined : selected}
      aria-haspopup={opensSelector ? 'dialog' : undefined}
      aria-expanded={opensSelector ? expanded : undefined}
      onClick={onClick}
      onFocus={(event) => {
        if (event.currentTarget.matches(':focus-visible'))
          event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'instant' });
      }}
      aria-label={`${name}, ${server.role === 'admin' ? 'admin server' : 'paired server'}${selected ? ', selected' : ''}`}
    >
      <span className="cluster-module-top" aria-hidden="true" />
      <span className="cluster-module-side" aria-hidden="true" />
      <span className="cluster-module-front">
        <span className="cluster-module-heading">
          <IconServer size={20} aria-hidden="true" />
          <span>{name}</span>
          {selected ? <IconCheck size={17} aria-hidden="true" /> : null}
        </span>
        <span className="cluster-module-address" title={serverAddress(server)}>
          {serverAddress(server)}
        </span>
        <span className="cluster-module-meters">
          <span>
            <span>CPU</span>
            <b>{percentage(reading?.cpu)}</b>
            <i aria-hidden="true">
              <span style={{ width: percentageWidth(reading?.cpu) }} />
            </i>
          </span>
          <span>
            <span>Memory</span>
            <b>{percentage(reading?.memory)}</b>
            <i aria-hidden="true">
              <span style={{ width: percentageWidth(reading?.memory) }} />
            </i>
          </span>
        </span>
        <span className="cluster-module-footer">
          <span>{server.role === 'admin' ? 'Admin server' : 'Member server'}</span>
          {reading?.online === false ? <span>Offline</span> : server.local ? <span>Local</span> : null}
        </span>
      </span>
    </button>
  );
}

function ServerSelector({
  open,
  onOpenChange,
  readings,
  returnFocus,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  readings?: Record<string, ServerReading>;
  returnFocus?: () => HTMLElement | null;
}) {
  const cluster = useCluster();
  const { preferences } = useDesktopPreferences();
  const servers = cluster.data?.servers ?? [];
  const samples = useQueries({
    queries: servers.map((server) => ({
      queryKey: ['cluster-server', server.id, 'telemetry'],
      queryFn: () => clusterRequest<Telemetry>(`/servers/${encodeURIComponent(server.id)}/read/telemetry`),
      enabled: open,
      staleTime: 9000,
      refetchInterval: open ? 10000 : false,
      refetchIntervalInBackground: false,
      retry: false,
    })),
  });
  const liveReadings = Object.fromEntries(
    servers.map((server, index) => {
      const query = samples[index];
      const sample = query?.isError ? undefined : query?.data;
      const total = sample?.memory.totalBytes;
      const available = sample?.memory.availableBytes;
      return [
        server.id,
        sample
          ? {
              cpu: sample.cpu.totalPercent,
              memory: typeof total === 'number' && total > 0 && typeof available === 'number' ? (1 - available / total) * 100 : null,
              online: true,
            }
          : query?.isError
            ? { cpu: null, memory: null, online: false }
            : readings?.[server.id],
      ];
    }),
  );
  const choose = (id: string) => {
    cluster.select(id);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="cluster-selector"
        size="lg"
        onOpenAutoFocus={(event) => {
          const content = event.target;
          const selected = content instanceof HTMLElement ? content.querySelector<HTMLButtonElement>('[aria-pressed="true"]') : null;
          if (selected) {
            event.preventDefault();
            requestAnimationFrame(() => {
              if (!selected.isConnected) return;
              selected.focus({ preventScroll: true });
              selected.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'instant' });
            });
          }
        }}
        onCloseAutoFocus={(event) => {
          const opener = returnFocus?.();
          const target = opener?.isConnected
            ? opener
            : document.querySelector<HTMLElement>('.cluster-switcher, .desktop-dock-item[aria-current="page"]');
          if (target) {
            event.preventDefault();
            target.focus({ preventScroll: true });
          }
        }}
      >
        <DialogHeader>
          <div>
            <span className="cluster-dialog-kicker">Switch server</span>
            <DialogTitle>{cluster.data?.name || preferences.serverName}</DialogTitle>
          </div>
        </DialogHeader>
        <DialogDescription>Choose a server to view its apps and status.</DialogDescription>
        <section className="cluster-selection-rack" aria-label="Servers">
          {(cluster.data?.servers.length ?? 0) > 1 ? (
            <button type="button" className="cluster-merged-card" aria-pressed={cluster.merged} onClick={() => choose('all')}>
              <IconLayersLinked size={30} aria-hidden="true" />
              <strong>All servers</strong>
              <span>{cluster.data?.servers.length} servers · merged apps and updates</span>
              {cluster.merged ? <IconCheck size={18} aria-hidden="true" /> : null}
            </button>
          ) : null}
          {cluster.data?.servers.map((server, index) => (
            <div key={server.id} className="cluster-selection-slot" style={{ '--cluster-order': index } as CSSProperties}>
              <ServerModule
                server={server}
                reading={liveReadings[server.id]}
                selected={cluster.selectedId === server.id}
                onClick={() => choose(server.id)}
              />
            </div>
          ))}
          {cluster.data?.role !== 'member' ? (
            <Link className="cluster-pair-card" to="/settings?tab=cluster" onClick={() => onOpenChange(false)}>
              <IconPlus size={28} aria-hidden="true" />
              <strong>Pair a server</strong>
              <span>Add another homelab to this cluster</span>
            </Link>
          ) : null}
        </section>
      </DialogContent>
    </Dialog>
  );
}

export function ClusterSwitcher() {
  const cluster = useCluster();
  const opener = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if ((cluster.data?.servers.length ?? 0) < 2) return null;
  return (
    <>
      <button
        type="button"
        className="desktop-icon-button cluster-switcher"
        ref={opener}
        aria-label={`Switch server in ${cluster.data?.name}`}
        title="Switch server"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <IconSwitchHorizontal size={20} aria-hidden="true" />
      </button>
      <ServerSelector open={open} onOpenChange={setOpen} returnFocus={() => opener.current} />
    </>
  );
}

export function ServerRack({
  readings,
  cpu,
  memory,
  online,
}: {
  readings?: Record<string, ServerReading>;
  cpu?: number | null;
  memory?: number | null;
  online?: boolean;
}) {
  const cluster = useCluster();
  const { preferences } = useDesktopPreferences();
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const openSelector = () => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  };
  const server = cluster.selectedServer ?? cluster.data?.servers.find((item) => item.local);
  const currentReadings =
    cluster.selectedId && (cpu !== undefined || memory !== undefined)
      ? { ...readings, [cluster.selectedId]: { cpu: cpu ?? null, memory: memory ?? null, online } }
      : readings;
  return (
    <div className="cluster-rack">
      <div className="cluster-rack-caption">
        <strong>{cluster.data?.name || preferences.serverName}</strong>
        <span>
          {cluster.merged ? 'All servers' : `${cluster.data?.servers.length ?? 1} server${(cluster.data?.servers.length ?? 1) === 1 ? '' : 's'}`}
        </span>
      </div>
      <div className="cluster-rack-stage" data-count={Math.min(3, cluster.data?.servers.length ?? 1)}>
        <span className="cluster-rack-shadow" aria-hidden="true" />
        {(cluster.data?.servers.length ?? 0) > 1 ? <span className="cluster-rack-back cluster-rack-back-one" aria-hidden="true" /> : null}
        {(cluster.data?.servers.length ?? 0) > 2 ? <span className="cluster-rack-back cluster-rack-back-two" aria-hidden="true" /> : null}
        {server ? (
          <ServerModule
            server={server}
            reading={currentReadings?.[server.id]}
            selected={false}
            opensSelector
            expanded={open}
            onClick={openSelector}
          />
        ) : (
          <output className="cluster-rack-loading">{cluster.isError ? 'Server list unavailable' : 'Loading servers…'}</output>
        )}
      </div>
      <button type="button" className="cluster-rack-open" onClick={openSelector} disabled={!server} aria-haspopup="dialog" aria-expanded={open}>
        {cluster.merged ? 'Choose a server' : 'Switch or pair a server'}
        <IconChevronDown size={16} aria-hidden="true" />
      </button>
      <ServerSelector open={open} onOpenChange={setOpen} readings={currentReadings} returnFocus={() => opener.current} />
    </div>
  );
}
