import { useReducedMotion } from '@/desktop/motion-preferences';
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from 'react-router';
import { IconPlus, IconSwitchHorizontal, IconX } from '@tabler/icons-react';
import * as Dialog from '@radix-ui/react-dialog';
import { useDesktopPreferences } from './preferences';
import type { Telemetry } from './telemetry';
import { useAppContext } from '@/context/app-context';
import { useConnectionStore } from '@/stores/connection-store';
import { RackDeck } from './rack-deck';
import { WrapWords } from '@/components/wrap-words/wrap-words';
import { useHostUpdateWatch } from './host-update-watch';
import { coreWatchIsActive, coreUpdateTitle } from './core-update-state';
import './cluster.css';

export type ClusterServer = { id: string; name: string; url: string; role: 'admin' | 'member'; local: boolean; certificateSha256?: string };
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
    const previewId = /^\/apps\/servers\/([^/]+)\/[^/]+\/[^/]+\/?$/.exec(location.pathname)?.[1];
    const previewServer = cluster.data?.servers.find((server) => encodeURIComponent(server.id) === previewId);
    if (previewServer && selectedId !== 'all' && selectedId !== previewServer.id) {
      setSelection(previewServer.id);
    } else if (
      !previewServer &&
      localId &&
      selectedId !== localId &&
      (location.pathname.startsWith('/apps/') || location.pathname.startsWith('/app-store/'))
    ) {
      setSelection(localId);
    }
  }, [cluster.data?.servers, localId, selectedId, location.pathname]);
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
  const { watch, core, restart } = useHostUpdateWatch();
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
  const restartingServer = !remote && restart?.job?.state === 'restarting';
  const updating = !remote && coreWatchIsActive(watch);
  const updateOffline =
    updating && (hubStatus !== 'connected' || (core?.available === true && (core.coreState !== 'running' || core.coreHealth !== 'healthy')));
  const connectionState = restartingServer ? 'update-offline' : updating ? (updateOffline ? 'update-offline' : 'updating') : status;
  const label = restartingServer
    ? 'Restarting server'
    : updating
      ? updateOffline
        ? coreUpdateTitle('offline', watch?.operation)
        : coreUpdateTitle('updating', watch?.operation)
      : status === 'connected'
        ? address || 'Address unavailable'
        : status === 'connecting'
          ? 'Connecting'
          : 'Reconnecting';
  return (
    <output
      className="desktop-connection"
      data-connection-kind={!updating && !restartingServer && status === 'connected' && address ? 'address' : 'status'}
      data-connection-state={connectionState}
      aria-label={
        restartingServer
          ? `${label}. ${restart?.job?.message ?? ''}`
          : updating
            ? `${label}. ${watch?.message ?? ''}`
            : status === 'connected' && address
              ? `Connected to ${remote?.name ?? 'admin server'} at ${address}`
              : label
      }
      title={restartingServer ? restart?.job?.message : updating ? watch?.message : label}
    >
      <span className={`desktop-connection-dot is-${connectionState}`} aria-hidden="true">
        {connectionState === 'connected' ? <span className="desktop-connection-pulse" /> : null}
      </span>
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

function useRackReadings(enabled: boolean, readings?: Record<string, ServerReading>) {
  const cluster = useCluster();
  const servers = cluster.data?.servers ?? [];
  const samples = useQueries({
    queries: servers.map((server) => ({
      queryKey: ['cluster-server', server.id, 'telemetry'],
      queryFn: () => clusterRequest<Telemetry>(`/servers/${encodeURIComponent(server.id)}/read/telemetry`),
      enabled,
      staleTime: 9000,
      refetchInterval: enabled ? 10000 : false,
      refetchIntervalInBackground: false,
      retry: false,
    })),
  });
  return Object.fromEntries(
    servers.map((server, index) => {
      const query = samples[index];
      const sample = query?.isError ? undefined : query?.data;
      const total = sample?.memory.totalBytes;
      const available = sample?.memory.availableBytes;
      return [
        server.id,
        query?.isError
          ? { cpu: null, memory: null, online: false }
          : (readings?.[server.id] ??
            (sample
              ? {
                  cpu: sample.cpu.totalPercent,
                  memory: typeof total === 'number' && total > 0 && typeof available === 'number' ? (1 - available / total) * 100 : null,
                  online: true,
                }
              : undefined)),
      ];
    }),
  );
}

export function ServerSelector({
  open,
  onOpenChange,
  returnFocus,
  selectedId,
  onSelect,
  purpose = 'switch',
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  returnFocus?: () => HTMLElement | null;
  selectedId?: string;
  onSelect?: (id: string) => void;
  purpose?: 'switch' | 'install';
}) {
  const cluster = useCluster();
  const { preferences } = useDesktopPreferences();
  const readings = useRackReadings(open);
  const reduceMotion = useReducedMotion();
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!open && closing.current) clearTimeout(closing.current);
    return () => {
      if (closing.current) clearTimeout(closing.current);
    };
  }, [open]);
  const choose = (id: string) => {
    if (onSelect) onSelect(id);
    else cluster.select(id);
    if (closing.current) clearTimeout(closing.current);
    if (reduceMotion) onOpenChange(false);
    else closing.current = setTimeout(() => onOpenChange(false), 340);
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="cluster-selector-backdrop" data-purpose={purpose} />
        <Dialog.Content
          className="cluster-selector orbis-theme"
          data-purpose={purpose}
          data-desktop-preset={preferences.preset}
          onOpenAutoFocus={(event) => {
            const content = event.target;
            const rack = content instanceof HTMLElement ? content.querySelector<HTMLElement>('.cluster-rack-stage') : null;
            if (rack) {
              event.preventDefault();
              rack.focus({ preventScroll: true });
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
          <div className="cluster-selector-heading">
            <div>
              <span className="cluster-dialog-kicker">{purpose === 'install' ? 'Install on a server' : 'Switch server'}</span>
              <Dialog.Title title={cluster.data?.name || preferences.serverName}>
                <WrapWords text={cluster.data?.name || preferences.serverName} />
              </Dialog.Title>
            </div>
            <Dialog.Close className="cluster-selector-close" aria-label="Close server selector">
              <IconX size={20} aria-hidden="true" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="visually-hidden">
            {purpose === 'install'
              ? 'Select the server that will run this app.'
              : 'Browse the 3D rack and select a server to view its apps and status.'}
          </Dialog.Description>
          <div className="cluster-selector-body">
            <RackDeck
              servers={cluster.data?.servers ?? []}
              localName={preferences.serverName}
              selectedId={selectedId ?? cluster.selectedId}
              readings={readings}
              onSelect={choose}
              showMerged={purpose === 'switch'}
              entrance
            />
            {purpose === 'switch' && cluster.data?.role !== 'member' ? (
              <Link className="cluster-pair-link" to="/settings?tab=cluster" onClick={() => onOpenChange(false)}>
                <IconPlus size={17} aria-hidden="true" />
                Pair a server
              </Link>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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
  const [engaged, setEngaged] = useState(false);
  const currentReadings =
    cluster.selectedId && (cpu !== undefined || memory !== undefined)
      ? { ...readings, [cluster.selectedId]: { cpu: cpu ?? null, memory: memory ?? null, online } }
      : readings;
  const liveReadings = useRackReadings(engaged, currentReadings);
  return (
    <div className="cluster-rack">
      {cluster.data?.role !== 'standalone' ? (
        <div className="cluster-rack-caption">
          <strong>{cluster.data?.name || preferences.serverName}</strong>
          <span>
            {cluster.data?.servers.length ?? 1} server{(cluster.data?.servers.length ?? 1) === 1 ? '' : 's'}
          </span>
        </div>
      ) : null}
      {cluster.data?.servers.length ? (
        <RackDeck
          servers={cluster.data.servers}
          localName={preferences.serverName}
          selectedId={cluster.selectedId}
          readings={liveReadings}
          onSelect={cluster.select}
          onEngagedChange={setEngaged}
          standalone={cluster.data.role === 'standalone'}
        />
      ) : (
        <output className="cluster-rack-loading">{cluster.isError ? 'Server list unavailable' : 'Loading servers…'}</output>
      )}
    </div>
  );
}
