import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type PropsWithChildren } from 'react';
import { useIsMutating, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppContext } from '@/context/app-context';
import { useWindowVisible } from './window-visibility';
import { installedOrbisBuildOptions } from './orbis-release';
import {
  advanceCoreUpdate,
  claimCoreRefresh,
  coreJobIsActive,
  coreWatchIsActive,
  validCoreUpdate,
  type CoreUpdateStatus,
  type CoreUpdateWatch,
  type CoreUpdateOperation,
} from './core-update-state';

export type PackageUpdateJob = {
  id: string;
  kind?: 'refresh';
  state: 'queued' | 'running' | 'complete' | 'failed' | 'interrupted';
  operationCount?: number;
  startedAt?: number;
  createdAt: number;
  message?: string;
  rebootRequired?: boolean;
};
type PackageUpdateStatus = { available: boolean; job: PackageUpdateJob | null };
export type ServerRestartStatus = {
  available: boolean;
  reason?: string;
  rebootRequired?: boolean;
  job: { id: string; state: 'restarting' | 'complete' | 'failed'; createdAt: number; finishedAt?: number; message: string } | null;
};
export const serverRestartQueryKey = ['orbis-host-restart'] as const;
type AcceptedUpdate = { id: string; targetTag: string; operation?: CoreUpdateOperation };
let acceptedUpdate: AcceptedUpdate | null = null;
let updatePending = false;
export const coreUpdateIsPending = () => updatePending;
export const prepareDesktopForCoreUpdate = () =>
  Promise.all([
    import('@/modules/dashboard/pages/dashboard'),
    import('@/modules/dashboard/pages/monitor'),
    import('@/modules/app/pages/my-apps-page'),
    import('@/modules/app/pages/installed-apps-layout'),
    import('@/modules/app/pages/cluster-app-preview'),
    import('@/modules/app/pages/app-store-layout'),
    import('@/modules/app/pages/app-store-index'),
    import('@/modules/settings/pages/settings-page'),
    import('@/modules/tasks/pages/tasks'),
    import('@/modules/app/pages/app-details-page'),
    import('@/modules/app/pages/app-update-page'),
    import('@/modules/app/pages/app-edit-page'),
    import('@/modules/app/pages/custom-app-create-page'),
    import('@/modules/app/pages/custom-app-details-page'),
    import('@/routes/not-found'),
  ]);
const acceptedListeners = new Set<() => void>();
const subscribeAccepted = (listener: () => void) => {
  acceptedListeners.add(listener);
  return () => acceptedListeners.delete(listener);
};
const acceptedSnapshot = () => acceptedUpdate;
const emptyAccepted = () => null;

export function rememberAcceptedCoreUpdate(id: string, targetTag: string, operation: CoreUpdateOperation = 'update') {
  if (!validCoreUpdate(id, targetTag)) return;
  acceptedUpdate = { id, targetTag, operation };
  updatePending = true;
  for (const listener of acceptedListeners) listener();
}
function forgetAccepted(id: string) {
  if (acceptedUpdate?.id !== id) return;
  acceptedUpdate = null;
  for (const listener of acceptedListeners) listener();
}

async function readHost<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(`/api/host-updates/${path}`, {
    credentials: 'same-origin',
    signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
  });
  if (!response.ok) throw new Error('Host update status is unavailable');
  return response.json();
}
const refreshStorageKey = 'orbis-core-refreshed-jobs-v1';
const refreshedInThisPage = new Set<string>();
function readRefreshedJobs() {
  const ids = new Set(refreshedInThisPage);
  try {
    const raw = sessionStorage.getItem(refreshStorageKey);
    const saved: unknown = raw && raw.length < 2048 ? JSON.parse(raw) : null;
    if (Array.isArray(saved)) for (const id of saved.slice(-16)) if (typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id)) ids.add(id);
  } catch {
    /* A blocked session cache still has the in-page guard. */
  }
  return ids;
}
function recordRefresh(id: string) {
  refreshedInThisPage.add(id);
  const saved = [...readRefreshedJobs(), id];
  try {
    sessionStorage.setItem(refreshStorageKey, JSON.stringify([...new Set(saved)].slice(-16)));
  } catch {
    /* The in-page guard is already recorded. */
  }
}

type HostUpdateContextValue = {
  watch: CoreUpdateWatch | null;
  core: CoreUpdateStatus | undefined;
  packageJob: PackageUpdateJob | null;
  restart: ServerRestartStatus | undefined;
  restartError: boolean;
  unavailable: boolean;
};
const HostUpdateContext = createContext<HostUpdateContextValue>({
  watch: null,
  core: undefined,
  packageJob: null,
  restart: undefined,
  restartError: false,
  unavailable: false,
});

export function HostUpdateProvider({ children, suspended = false }: PropsWithChildren<{ suspended?: boolean }>) {
  const { user } = useAppContext();
  const queryClient = useQueryClient();
  const visible = useWindowVisible();
  const accepted = useSyncExternalStore(subscribeAccepted, acceptedSnapshot, emptyAccepted);
  const watchRef = useRef<CoreUpdateWatch | null>(null);
  const [watch, setWatch] = useState<CoreUpdateWatch | null>(null);
  const enabled = !suspended && visible && user.operator === true;
  const active = coreWatchIsActive(watch);
  const core = useQuery({
    queryKey: ['orbis-host-update-status'],
    queryFn: ({ signal }) => readHost<CoreUpdateStatus>('status', signal),
    enabled,
    staleTime: 3000,
    retry: false,
    refetchInterval: (query) => (active || coreJobIsActive(query.state.data?.job) ? 3000 : 30_000),
    refetchIntervalInBackground: false,
  });
  const packages = useQuery({
    queryKey: ['orbis-host-package-job'],
    queryFn: ({ signal }) => readHost<PackageUpdateStatus>('packages/job', signal),
    enabled,
    staleTime: 1500,
    retry: false,
    refetchInterval: (query) => (['queued', 'running'].includes(query.state.data?.job?.state ?? '') ? 1500 : 30_000),
    refetchIntervalInBackground: false,
  });
  const restart = useQuery({
    queryKey: serverRestartQueryKey,
    queryFn: async ({ signal }) => {
      const status = await readHost<ServerRestartStatus>('restart', signal);
      const previous = queryClient.getQueryData<ServerRestartStatus>(serverRestartQueryKey)?.job;
      return !status.available && previous?.state === 'restarting' ? { ...status, job: previous } : status;
    },
    enabled,
    staleTime: 3000,
    retry: false,
    refetchInterval: (query) => (query.state.data?.job?.state === 'restarting' ? 2000 : 30_000),
    refetchIntervalInBackground: false,
  });
  const build = useQuery({
    ...installedOrbisBuildOptions(),
    enabled: enabled && active,
    staleTime: 0,
    retry: false,
    refetchInterval: active ? 3000 : false,
    refetchIntervalInBackground: false,
  });
  useEffect(() => {
    if (suspended || user.operator !== true) return;
    let next = watchRef.current;
    if (accepted) next = advanceCoreUpdate(next, { type: 'accepted', ...accepted });
    if (core.isError) next = advanceCoreUpdate(next, { type: 'unavailable' });
    else if (core.data) next = advanceCoreUpdate(next, { type: 'status', status: core.data, buildTag: build.data?.version });
    const claimed = claimCoreRefresh(next, readRefreshedJobs());
    updatePending = coreWatchIsActive(claimed.watch);
    watchRef.current = claimed.watch;
    setWatch(claimed.watch);
    if (claimed.watch && (claimed.watch.phase === 'failed' || claimed.watch.refreshIssued)) forgetAccepted(claimed.watch.id);
    if (claimed.refresh && claimed.watch) {
      recordRefresh(claimed.watch.id);
      forgetAccepted(claimed.watch.id);
      window.location.reload();
    }
  }, [accepted, core.data, core.isError, build.data?.version, suspended, user.operator]);
  return (
    <HostUpdateContext.Provider
      value={{
        watch,
        core: core.data,
        packageJob: packages.data?.job ?? null,
        restart: restart.data,
        restartError: restart.isError,
        unavailable: core.isError,
      }}
    >
      {children}
    </HostUpdateContext.Provider>
  );
}

export const useHostUpdateWatch = () => useContext(HostUpdateContext);

export function useCoreUpdateBusy() {
  const { watch } = useHostUpdateWatch();
  const starting = useIsMutating({
    mutationKey: ['orbis-compatibility', 'update'],
    predicate: (mutation) => mutation.options.mutationKey?.[4] === 'apply',
  });
  return starting > 0 || coreWatchIsActive(watch);
}
