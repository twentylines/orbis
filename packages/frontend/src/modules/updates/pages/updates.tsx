import { packageRestartRequired, packageUpdateLimit, selectedPackageNames, startPackageUpdate } from '../package-updates';
import { UpdateDownloadProgress } from '@/components/recovery-progress/update-download-progress';
import type { DownloadProgress } from '@/desktop/download-progress';
import { WrapWords } from '@/components/wrap-words/wrap-words';
import { SelectionGroup } from '@/components/ui/SelectionGroup/SelectionGroup';
import { getInstalledAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { AppLogo } from '@/components/app-logo/app-logo';
import { InstalledVersions } from '@/components/installed-versions/installed-versions';
import { OrbisReleaseNotes } from './orbis-release-notes';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/Dialog';
import { useAppContext } from '@/context/app-context';
import { DisclosureIndicator } from '@/components/ui/DisclosureIndicator/DisclosureIndicator';
import {
  IconAlertTriangle,
  IconBrandRedhat,
  IconBrandUbuntu,
  IconDeviceDesktopCog,
  IconPackage,
  IconPower,
  IconRefresh,
  IconServerCog,
  IconSettings,
} from '@tabler/icons-react';
import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import { useWindowVisible } from '@/desktop/window-visibility';
import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import './updates.css';
import { useCluster } from '@/desktop/cluster';
import { ClusterUpdates } from '@/desktop/cluster-updates';
import { UpdateAllButton } from '@/modules/app/components/update-all-button/update-all-button';
import { SystemUpdateProgress, UpdateRequestError } from './system-update-progress';
import { compatibilityReviewTime, useCompatibilityResult } from './orbis-downgrade';
import {
  rememberAcceptedCoreUpdate,
  prepareDesktopForCoreUpdate,
  useHostUpdateWatch,
  serverRestartQueryKey,
  type ServerRestartStatus,
} from '@/desktop/host-update-watch';
import { coreWatchIsActive } from '@/desktop/core-update-state';
import { installedOrbisBuildOptions, orbisReleaseErrorMessage, orbisReleasesOptions, newerOrbisRelease } from '@/desktop/orbis-release';
import { useReviewExpired } from '@/desktop/use-review-expired';
import { orbisReleaseChannelsOptions, releaseChannelErrorMessage } from '@/desktop/release-channels';
import { formatOrbisVersion } from '@/desktop/orbis-version';
import { SentinelStatus } from './sentinel-status';
import { OrbisLogo } from '@/components/orbis-logo/orbis-logo';
import debianLogo from './debian-open-use.svg';

type HostJob = {
  id: string;
  state: string;
  targetTag: string;
  startedAt: number;
  finishedAt?: number;
  message?: string;
  phase?: string | null;
  download?: DownloadProgress;
};
type HostStatus = {
  available: boolean;
  capabilities?: string[];
  enrolled?: boolean;
  currentTag?: string | null;
  currentDigest?: string | null;
  coreState?: string;
  coreHealth?: string;
  imageMatches?: boolean;
  reason?: string;
  job?: HostJob | null;
};
type HostPlan = {
  planId: string;
  currentTag: string;
  targetTag: string;
  targetDigest: string;
  snapshotBytes: number;
  appsMustBeStopped: boolean;
};
type ReleaseCompatibility = {
  tag: string;
  currentRuntipiVersion: string;
  targetRuntipiVersion: string;
  crossesRuntipiBoundary: boolean;
  hostUpdateSupported: boolean;
  warning: string | null;
};
type HostPackage = {
  name: string;
  installedVersion: string;
  candidateVersion: string;
  downloadBytes: number | null;
  security: boolean;
  sources: Array<{ origin: string | null; archive: string | null; site: string | null; trusted: boolean }>;
};
type HostPackageInventory = {
  available: boolean;
  reason?: string;
  operatingSystem?: string;
  checkedAt?: string;
  indexesUpdatedAt?: string | null;
  rebootRequired?: boolean;
  packageCount?: number;
  truncated?: boolean;
  packages?: HostPackage[];
};
type HostPackageChangelog = {
  name: string;
  candidateVersion: string;
  available: boolean;
  source: string;
  body?: string;
  truncated?: boolean;
  reason?: string;
};
type HostPackageJob = {
  id: string;
  kind?: 'refresh';
  state: 'queued' | 'running' | 'complete' | 'failed' | 'interrupted';
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  message?: string;
  rebootRequired?: boolean;
  operationCount?: number;
  output?: { text: string; bytes: number; truncated: boolean; updatedAt: number | null };
};
type HostPackageJobStatus = { available: boolean; job: HostPackageJob | null };

const distributions = [
  { name: /^ubuntu(?:\s|$)/i, brand: 'ubuntu' },
  { name: /^debian(?:\s|$)/i, brand: 'debian' },
  { name: /^red hat enterprise linux(?:\s|$)/i, brand: 'redhat' },
] as const;

function OperatingSystemArtwork({ name }: { name: string }) {
  const brand = distributions.find((distribution) => distribution.name.test(name))?.brand ?? 'system';
  return (
    <div className="desktop-updates-artwork" data-brand={brand} aria-hidden="true">
      {brand === 'ubuntu' ? (
        <IconBrandUbuntu stroke={1.75} />
      ) : brand === 'debian' ? (
        <img src={debianLogo} width={87} height={108} alt="" />
      ) : brand === 'redhat' ? (
        <IconBrandRedhat stroke={1.75} />
      ) : (
        <IconDeviceDesktopCog stroke={1.55} />
      )}
    </div>
  );
}

function packageSize(bytes: number | null): string {
  if (bytes === null) return 'Download size unavailable';
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / 1_000_000)} MB download`;
}

function packageSources(sources: HostPackage['sources']): string {
  const labels = sources.map((source) => [source.origin, source.archive].filter(Boolean).join(' · ')).filter(Boolean);
  return [...new Set(labels)].join(', ') || 'Repository unavailable';
}

async function hostRequest<T>(path: string, body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/host-updates/${path}`, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(
        path === 'plan' || path.startsWith('downgrade/')
          ? 110_000
          : path === 'packages/plan' || path === 'packages/apply' || path === 'packages/refresh'
            ? 70_000
            : path === 'packages'
              ? 40_000
              : 20_000,
      ),
    ]),
  });
  const result: unknown = await response.json().catch(() => null);
  if (response.ok && (!result || typeof result !== 'object'))
    throw new Error('The host returned an incomplete response. Check its status before retrying.');
  if (!response.ok) {
    const message =
      typeof result === 'object' && result !== null && 'message' in result && typeof result.message === 'string' ? result.message : null;
    const error = new Error(message || `Host update request failed (${response.status})`);
    throw Object.assign(error, {
      canForce: response.status === 400 && typeof result === 'object' && result !== null && 'canForce' in result && result.canForce === true,
    });
  }
  return result as T;
}

export default function Updates() {
  const cluster = useCluster();
  if (cluster.merged || (cluster.selectedServer && !cluster.selectedServer.local)) return <ClusterUpdates />;
  return <LocalUpdates />;
}

function LocalUpdates() {
  const tabsId = useId();
  const [section, setSection] = useState<'system' | 'apps'>('system');
  const [coreReview, setCoreReview] = useState<ReleaseCompatibility | null>(null);
  const coreReviewIntent = useRef(0);
  const coreUpdateRequested = useRef(false);
  const coreReviewButton = useRef<HTMLButtonElement>(null);
  const entry = useLocation().key;
  const lastEntry = useRef(entry);
  const visible = useWindowVisible();
  const { user, version } = useAppContext();
  const { watch, restart, restartError } = useHostUpdateWatch();
  const queryClient = useQueryClient();
  const restarting = coreWatchIsActive(watch) && watch?.phase === 'offline';
  const [restartPlan, setRestartPlan] = useState<{ planId: string; expiresAt: number; rebootRequired: boolean } | null>(null);
  const restartReviewIntent = useRef(0);
  const restartReviewButton = useRef<HTMLButtonElement>(null);
  // The host restart protocol timestamps are Unix seconds.
  const restartReviewExpired = useReviewExpired(restartPlan ? restartPlan.expiresAt * 1000 : undefined);
  const closeRestartReview = () => {
    restartReviewIntent.current += 1;
    setRestartPlan(null);
  };
  const systemActionFocus = useRef<{ control: HTMLButtonElement; kind: 'refresh' | 'restart' } | null>(null);
  const reviewRestart = useMutation({
    meta: { invalidates: false },
    mutationFn: () => hostRequest<NonNullable<typeof restartPlan>>('restart/plan', {}),
    onMutate: () => ({ intent: ++restartReviewIntent.current }),
    onSuccess: (value, _variables, context) => {
      if (context?.intent === restartReviewIntent.current) {
        applyRestart.reset();
        setRestartPlan(value);
      }
    },
  });
  const applyRestart = useMutation({
    mutationFn: (planId: string) => hostRequest<{ jobId: string; state: 'restarting' }>('restart/apply', { planId }),
    onSuccess: (result) => {
      setRestartPlan(null);
      queryClient.setQueryData<ServerRestartStatus>(serverRestartQueryKey, {
        available: true,
        job: {
          id: result.jobId,
          state: 'restarting',
          createdAt: Date.now() / 1000,
          message: 'The page will reload automatically when the server is ready.',
        },
      });
      void queryClient.invalidateQueries({ queryKey: serverRestartQueryKey });
    },
    onError: () => {
      setRestartPlan(null);
      void queryClient.invalidateQueries({ queryKey: serverRestartQueryKey });
    },
  });
  const [coreRequestStage, setCoreRequestStage] = useState<'checking' | 'starting' | null>(null);
  const [packageSearch, setPackageSearch] = useState('');
  const [showAllPackages, setShowAllPackages] = useState(false);
  const [selectedPackage, setSelectedPackage] = useState<string | null>(null);
  const systemPackages = useQuery({
    queryKey: ['orbis-host-packages'],
    queryFn: ({ signal }) => hostRequest<HostPackageInventory>('packages', undefined, signal),
    enabled: visible && user?.operator === true,
    staleTime: 60_000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    retry: false,
  });
  const [chosenPackages, setSelectedPackages] = useState<string[] | null>(null);
  const selectedPackages = useMemo(
    () => selectedPackageNames(systemPackages.data?.packages ?? [], chosenPackages),
    [systemPackages.data?.packages, chosenPackages],
  );
  const [packageRequestStage, setPackageRequestStage] = useState<'checking' | 'starting'>('checking');
  const lastReviewScope = useRef({ section, entry });
  useLayoutEffect(() => {
    const previous = lastReviewScope.current;
    if (previous.section !== section || previous.entry !== entry) {
      lastReviewScope.current = { section, entry };
      setCoreReview(null);
      setRestartPlan(null);
    }
    return () => {
      coreReviewIntent.current += 1;
      restartReviewIntent.current += 1;
    };
  }, [section, entry]);
  const lastRefreshedCoreJob = useRef<string | null>(null);
  const lastRefreshedPackageJob = useRef<string | null>(null);
  const apps = useQuery({
    ...getInstalledAppsOptions(),
    enabled: visible,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });
  const build = useQuery({
    ...installedOrbisBuildOptions(),
    enabled: visible,
    staleTime: 60_000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });
  const channels = useQuery({ ...orbisReleaseChannelsOptions(), enabled: visible });
  const lastCoreReview = useCompatibilityResult<ReleaseCompatibility>('update', user.id, build.data?.version ?? '');
  const checkingCore = lastCoreReview?.status === 'pending';
  const releases = useQuery({
    ...orbisReleasesOptions(channels.data?.current),
    enabled: visible && Boolean(channels.data) && !channels.isError,
    staleTime: 60_000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });
  const available =
    apps.data?.installed.filter(
      ({ app, metadata }) => Number(app.version) < Number(metadata.latestVersion) && app.ignoredVersion !== metadata.latestVersion,
    ) ?? [];
  const latest = channels.isError || releases.isError ? undefined : releases.data?.[0];
  const orbisUpdateAvailable = !build.isError && newerOrbisRelease(latest, build.data?.version);
  const host = useQuery({
    queryKey: ['orbis-host-update-status'],
    queryFn: ({ signal }) => hostRequest<HostStatus>('status', undefined, signal),
    enabled: visible && user?.operator === true,
    refetchInterval: (query) => (['running', 'recovering'].includes(query.state.data?.job?.state ?? '') ? 4000 : 30_000),
    retry: 1,
  });
  const packageChangelog = useQuery({
    queryKey: ['orbis-host-package-changelog', selectedPackage],
    queryFn: ({ signal }) =>
      hostRequest<HostPackageChangelog>(`packages/changelog?name=${encodeURIComponent(selectedPackage ?? '')}`, undefined, signal),
    enabled: visible && user?.operator === true && selectedPackage !== null,
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  useEffect(() => {
    if (lastEntry.current === entry) return;
    lastEntry.current = entry;
    void apps.refetch();
    void build.refetch();
    if (channels.data && !channels.isError) void releases.refetch();
    if (user?.operator === true) void systemPackages.refetch();
  }, [entry, apps.refetch, build.refetch, channels.data, channels.isError, releases.refetch, systemPackages.refetch, user?.operator]);
  const packageJob = useQuery({
    queryKey: ['orbis-host-package-job'],
    queryFn: ({ signal }) => hostRequest<HostPackageJobStatus>('packages/job', undefined, signal),
    enabled: visible && user?.operator === true,
    refetchInterval: (query) => (['queued', 'running'].includes(query.state.data?.job?.state ?? '') ? 1500 : 30_000),
    retry: 1,
  });
  const refreshPackages = useMutation({
    mutationFn: () => hostRequest<{ jobId: string; state: string }>('packages/refresh', {}),
    retry: false,
    onMutate: () => {
      setSelectedPackages(null);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['orbis-host-package-job'] }),
  });
  useEffect(() => {
    const previous = systemActionFocus.current;
    if (!previous) return;
    const pending = previous.kind === 'refresh' ? refreshPackages.isPending : reviewRestart.isPending;
    if (pending) return;
    const failed = previous.kind === 'refresh' ? refreshPackages.isError : reviewRestart.isError;
    systemActionFocus.current = null;
    if (failed && section === 'system' && document.activeElement === document.body && previous.control.isConnected && !previous.control.disabled) {
      previous.control.focus();
    }
  }, [section, refreshPackages.isPending, refreshPackages.isError, reviewRestart.isPending, reviewRestart.isError]);
  const installPackages = useMutation({
    meta: { invalidates: false },
    mutationFn: (names: string[]) => {
      const inventory = systemPackages.data?.packages ?? [];
      const selected = names.map((name) => inventory.find((item) => item.name === name));
      if (selected.some((item) => !item)) throw new Error('The package list changed. Check for updates before trying again.');
      return startPackageUpdate(selected as HostPackage[], hostRequest, setPackageRequestStage);
    },
    retry: false,
    onSuccess: async (result) => {
      await queryClient.cancelQueries({ queryKey: ['orbis-host-package-job'] });
      queryClient.setQueryData<HostPackageJobStatus>(['orbis-host-package-job'], {
        available: true,
        job: { id: result.jobId, state: result.state, createdAt: Date.now() / 1000 },
      });
      setSelectedPackages(null);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['orbis-host-package-job'] }),
  });
  const reviewCore = useMutation({
    meta: { invalidates: false },
    mutationKey: ['orbis-compatibility', 'update', user.id, build.data?.version ?? ''],
    gcTime: compatibilityReviewTime,
    onMutate: () => ({ intent: ++coreReviewIntent.current }),
    mutationFn: async (tag: string) => {
      const result = await hostRequest<ReleaseCompatibility>(`release-compatibility?tag=${encodeURIComponent(tag)}`);
      if (
        result.tag !== tag ||
        typeof result.currentRuntipiVersion !== 'string' ||
        typeof result.targetRuntipiVersion !== 'string' ||
        typeof result.crossesRuntipiBoundary !== 'boolean' ||
        typeof result.hostUpdateSupported !== 'boolean' ||
        (result.warning !== null && typeof result.warning !== 'string') ||
        result.crossesRuntipiBoundary !== (result.currentRuntipiVersion !== result.targetRuntipiVersion) ||
        (result.hostUpdateSupported && (result.crossesRuntipiBoundary || result.currentRuntipiVersion !== '4.10.1'))
      )
        throw new Error('The release compatibility check could not be verified. Try again before updating.');
      return result;
    },
    onSuccess: (result, _variables, context) => {
      if (context?.intent === coreReviewIntent.current) setCoreReview(result);
    },
    retry: false,
  });
  const updateCore = useMutation({
    mutationKey: ['orbis-compatibility', 'update', user.id, build.data?.version ?? '', 'apply'],
    gcTime: compatibilityReviewTime,
    mutationFn: async (tag: string) => {
      setCoreRequestStage('checking');
      const checked = await hostRequest<HostPlan>('plan', { tag });
      if (checked.targetTag !== tag) throw new Error('The checked release changed. Refresh before updating.');
      await prepareDesktopForCoreUpdate();
      setCoreRequestStage('starting');
      return hostRequest<{ jobId: string; state: string }>('apply', { planId: checked.planId });
    },
    onSuccess: (result, tag) => {
      setCoreReview(null);
      rememberAcceptedCoreUpdate(result.jobId, tag);
    },
    onSettled: () => {
      coreUpdateRequested.current = false;
      setCoreRequestStage(null);
      void host.refetch();
    },
    retry: false,
  });
  const coreUpdateKey = ['orbis-compatibility', 'update', user.id, build.data?.version ?? '', 'apply'];
  const coreUpdates = useMutationState({
    filters: { mutationKey: coreUpdateKey, exact: true },
    select: (mutation) => ({ status: mutation.state.status, error: mutation.state.error, submittedAt: mutation.state.submittedAt }),
  });
  const coreUpdatePending = updateCore.isPending || coreUpdates.some((mutation) => mutation.status === 'pending');
  const lastCoreUpdate = [...coreUpdates].sort((a, b) => b.submittedAt - a.submittedAt)[0];
  const recover = useMutation({
    mutationFn: (jobId: string) => hostRequest<{ jobId: string; state: string }>('recover', { jobId }),
    onSuccess: () => void host.refetch(),
  });
  const job = user.operator ? host.data?.job : undefined;
  const corePhase = (
    {
      preparing: 'Checking the release and backup storage…',
      downloading: 'Downloading the verified Orbis image…',
      pulled: 'Image downloaded. Preparing the backup…',
      stopping: 'Backing up control data. Apps keep running.',
      stopped: 'Control services paused for backup…',
      snapshotting: 'Backing up control data…',
      'snapshot-ready': 'Backup verified. Applying the update…',
      staged: 'Starting Orbis and checking server health…',
    } as Record<string, string>
  )[job?.phase ?? ''];
  const jobBusy = job?.state === 'running' || job?.state === 'recovering';
  const canPlan = Boolean(
    build.data &&
      orbisUpdateAvailable &&
      user?.operator === true &&
      !host.isError &&
      host.data?.available &&
      host.data.enrolled &&
      host.data.imageMatches &&
      host.data.coreState === 'running' &&
      host.data.coreHealth === 'healthy' &&
      host.data.currentTag === build.data.version &&
      !jobBusy &&
      job?.state !== 'interrupted',
  );
  const matchingPackages = (systemPackages.data?.packages ?? []).filter((item) =>
    `${item.name} ${packageSources(item.sources)}`.toLocaleLowerCase().includes(packageSearch.trim().toLocaleLowerCase()),
  );
  const visiblePackages = showAllPackages ? matchingPackages : matchingPackages.slice(0, 12);
  const latestPackageJob = user.operator ? packageJob.data?.job : null;
  const packageJobState = latestPackageJob?.state;
  const packageJobBusy = packageJobState === 'queued' || packageJobState === 'running';
  const failedRefresh = packageJob.data?.job?.kind === 'refresh' && (packageJobState === 'failed' || packageJobState === 'interrupted');
  const packageJobNeedsInspection = !failedRefresh && (packageJobState === 'failed' || packageJobState === 'interrupted');
  const packageControlsBlocked =
    refreshPackages.isPending ||
    installPackages.isPending ||
    packageJob.isPending ||
    packageJob.isError ||
    packageJobBusy ||
    packageJobNeedsInspection ||
    jobBusy ||
    job?.state === 'interrupted';
  const packageStatusUnavailable = user.operator && (systemPackages.isError || packageJob.isError || systemPackages.data?.available === false);
  const packageInventory = user.operator && !systemPackages.isError && systemPackages.data?.available ? systemPackages.data : undefined;
  const osName = packageInventory?.operatingSystem?.trim() ?? '';
  const refreshSupported = host.data?.capabilities?.includes('packages.refresh.v1') === true;
  const packageUpdateBlocked =
    packageControlsBlocked ||
    host.isError ||
    !host.data?.available ||
    !host.data.enrolled ||
    !host.data.imageMatches ||
    host.data.coreHealth !== 'healthy' ||
    host.data.coreState !== 'running' ||
    !packageJob.data?.available ||
    !systemPackages.data?.available;
  const missingHostFeatures = host.data?.available
    ? [refreshSupported ? null : 'checking for system updates', host.data.capabilities?.includes('restart.v1') ? null : 'server restarts'].filter(
        (feature): feature is string => feature !== null,
      )
    : [];
  const matchingSelection =
    matchingPackages.length > 0 &&
    matchingPackages.length <= packageUpdateLimit &&
    matchingPackages.every((item) => selectedPackages.includes(item.name));
  const matchingSelectionExceedsLimit = new Set([...selectedPackages, ...matchingPackages.map((item) => item.name)]).size > packageUpdateLimit;
  useEffect(() => {
    if (job?.state === 'complete' && job.id !== lastRefreshedCoreJob.current) {
      lastRefreshedCoreJob.current = job.id;
      void build.refetch();
    }
  }, [job?.id, job?.state, build.refetch]);
  useEffect(() => {
    const completedId = packageJobState === 'complete' ? packageJob.data?.job?.id : null;
    if (completedId && completedId !== lastRefreshedPackageJob.current) {
      lastRefreshedPackageJob.current = completedId;
      void systemPackages.refetch();
      void queryClient.invalidateQueries({ queryKey: serverRestartQueryKey });
    }
  }, [packageJob.data?.job?.id, packageJobState, systemPackages.refetch, queryClient]);

  return (
    <div className="desktop-updates">
      <div className="desktop-updates-toolbar">
        <SelectionGroup className="desktop-updates-tabs" role="tablist" aria-label="Update views">
          {(
            [
              { key: 'system', label: 'System', Icon: IconServerCog, count: null },
              { key: 'apps', label: 'Applications', Icon: IconPackage, count: apps.isError ? null : apps.data ? available.length : null },
            ] as const
          ).map(({ key, label, Icon, count }, index, tabs) => (
            <button
              type="button"
              role="tab"
              key={key}
              id={`${tabsId}-${key}-tab`}
              aria-controls={`${tabsId}-${key}-panel`}
              aria-selected={section === key}
              aria-label={count ? `${label}, ${count} available updates` : undefined}
              tabIndex={section === key ? 0 : -1}
              onClick={() => setSection(key)}
              onKeyDown={(event) => {
                const nextIndex =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? tabs.length - 1
                      : event.key === 'ArrowRight' || event.key === 'ArrowLeft'
                        ? 1 - index
                        : null;
                if (nextIndex === null) return;
                event.preventDefault();
                const next = tabs[nextIndex];
                if (!next) return;
                setSection(next.key);
                document.getElementById(`${tabsId}-${next.key}-tab`)?.focus();
              }}
            >
              <Icon size={18} aria-hidden="true" />
              <span>{label}</span>
              {count ? (
                <span className="desktop-updates-tab-count" aria-hidden="true">
                  {count}
                </span>
              ) : null}
            </button>
          ))}
        </SelectionGroup>
        <Link className="desktop-update-action secondary desktop-updates-settings" to="/settings?tab=updates">
          <IconSettings size={18} aria-hidden="true" /> Update settings
        </Link>
      </div>
      <div className="desktop-update-views">
        <section
          className="desktop-updates-card desktop-updates-apps"
          id={`${tabsId}-apps-panel`}
          role="tabpanel"
          aria-labelledby={`${tabsId}-apps-tab`}
          hidden={section !== 'apps'}
        >
          <div className="desktop-updates-card-head">
            <span className="desktop-updates-card-icon">
              <IconPackage size={20} aria-hidden="true" />
            </span>
            <h2>Applications</h2>
          </div>
          {!apps.isError && available.length > 0 && user.operator ? (
            <div className="desktop-update-actions">
              <UpdateAllButton />
            </div>
          ) : null}
          {apps.isPending ? <p>Checking installed applications…</p> : null}
          {apps.isError ? <p role="alert">Application updates could not be checked. Try again from Applications.</p> : null}
          {!apps.isError && apps.data && available.length === 0 ? <p>No application updates found.</p> : null}
          <div className="desktop-updates-app-list">
            {!apps.isError &&
              available.map(({ app, info, metadata }) => {
                const [appId, storeId] = info.urn.split(':');
                return (
                  <Link className="desktop-update-app" to={`/apps/${storeId}/${appId}`} key={info.urn}>
                    <AppLogo urn={info.urn} size={42} alt="" />
                    <span>
                      <strong title={info.name}>{info.name}</strong>
                      <small>
                        Version {app.version} → {metadata.latestVersion}
                      </small>
                    </span>
                  </Link>
                );
              })}
          </div>
          <Link className="desktop-update-action secondary desktop-updates-app-link" to="/apps">
            Manage applications
          </Link>
        </section>

        <div
          className="desktop-updates-grid"
          id={`${tabsId}-system-panel`}
          role="tabpanel"
          aria-labelledby={`${tabsId}-system-tab`}
          hidden={section !== 'system'}
        >
          <section className="desktop-updates-card" aria-labelledby={`${tabsId}-orbis-title`}>
            <div className="desktop-updates-product">
              <div className="desktop-updates-card-head desktop-updates-product-head">
                <h2 id={`${tabsId}-orbis-title`}>Orbis</h2>
              </div>
              <div className="desktop-updates-product-content">
                <Dialog
                  open={coreReview !== null}
                  onOpenChange={(open) => {
                    if (!open && !coreUpdatePending) setCoreReview(null);
                  }}
                >
                  <DialogContent className="desktop-update-review-dialog" closeDisabled={coreUpdatePending} restoreFocusTo={coreReviewButton}>
                    <DialogHeader>
                      <DialogTitle>{coreReview?.crossesRuntipiBoundary ? 'Runtipi version changes' : 'Update Orbis?'}</DialogTitle>
                      <DialogDescription>
                        {build.data?.version ? formatOrbisVersion(build.data.version) : 'Installed version'} →{' '}
                        {coreReview?.tag ? formatOrbisVersion(coreReview.tag) : 'Selected release'}
                      </DialogDescription>
                    </DialogHeader>
                    {/* biome-ignore lint/a11y/noNoninteractiveTabindex: The update details scroll independently and need native keyboard access. */}
                    <section className="modal-body" tabIndex={0} aria-label="Update details">
                      {coreReview?.warning ? (
                        <div className="desktop-update-risk" role="note">
                          <strong>{coreReview.crossesRuntipiBoundary ? 'Downgrade boundary' : 'Host updater unavailable'}</strong>
                          <p>{coreReview.warning}</p>
                        </div>
                      ) : null}
                      {coreReview?.hostUpdateSupported ? (
                        <ol className="desktop-update-process">
                          <li>
                            <strong>Verify</strong>
                            <span>Check the published release, image, and available backup storage.</span>
                          </li>
                          <li>
                            <strong>Back up and install</strong>
                            <span>Create a verified recovery snapshot, then switch Orbis to {coreReview?.tag}.</span>
                          </li>
                          <li>
                            <strong>Reconnect</strong>
                            <span>Check server health and reconnect automatically. Restore the previous release if startup fails.</span>
                          </li>
                        </ol>
                      ) : null}
                    </section>
                    <DialogFooter className="desktop-update-plan-actions">
                      <button type="button" disabled={coreUpdatePending} onClick={() => setCoreReview(null)}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={!coreReview?.hostUpdateSupported || coreReview.crossesRuntipiBoundary || !canPlan || coreUpdatePending}
                        onClick={() => {
                          if (
                            !coreReview?.hostUpdateSupported ||
                            coreReview.crossesRuntipiBoundary ||
                            coreUpdateRequested.current ||
                            queryClient.isMutating({ mutationKey: coreUpdateKey, exact: true })
                          )
                            return;
                          coreUpdateRequested.current = true;
                          const tag = coreReview.tag;
                          setCoreReview(null);
                          setCoreRequestStage('checking');
                          updateCore.mutate(tag);
                        }}
                      >
                        {coreUpdatePending ? (coreRequestStage === 'checking' ? 'Checking update…' : 'Starting update…') : 'Update Orbis'}
                      </button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
                {lastCoreReview?.status === 'error' ? <p role="alert">{lastCoreReview.error?.message}</p> : null}
                <div className="desktop-update-summary">
                  <div aria-live="polite">
                    {build.data && !build.isError ? (
                      <p>
                        Installed <strong>{formatOrbisVersion(build.data.version)}</strong>
                      </p>
                    ) : null}
                    {build.isPending ? <output>Reading installed version…</output> : null}
                    {build.isError ? <p role="alert">The installed version could not be loaded.</p> : null}
                    {latest ? (
                      <p>
                        {orbisUpdateAvailable ? (
                          <>
                            Update available <strong>{formatOrbisVersion(latest.tag)}</strong>
                          </>
                        ) : build.data?.version === latest.tag && !build.isError ? (
                          'On the latest release'
                        ) : (
                          <>
                            Latest release <strong>{formatOrbisVersion(latest.tag)}</strong>
                          </>
                        )}
                        {channels.data ? <> · {channels.data.current === 'nightly' ? 'Nightly' : 'Stable'}</> : null}
                      </p>
                    ) : null}
                  </div>
                  {latest && orbisUpdateAvailable ? (
                    <button
                      className="desktop-update-action desktop-system-update-primary"
                      type="button"
                      disabled={!canPlan || checkingCore || coreUpdatePending}
                      onClick={(event) => {
                        updateCore.reset();
                        coreReviewButton.current = event.currentTarget;
                        reviewCore.mutate(latest.tag);
                      }}
                    >
                      {checkingCore ? 'Preparing update…' : coreUpdatePending ? 'Starting update…' : 'Update Orbis'}
                    </button>
                  ) : null}
                  {build.isError ? (
                    <button
                      type="button"
                      className="desktop-update-action secondary"
                      disabled={build.isFetching}
                      onClick={() => void build.refetch()}
                    >
                      <IconRefresh size={17} aria-hidden="true" />
                      {build.isFetching ? 'Loading version…' : 'Retry version check'}
                    </button>
                  ) : null}
                </div>
                <div className="desktop-orbis-release-state" aria-live="polite" aria-busy={channels.isFetching || releases.isFetching}>
                  {channels.isPending ? <output>Checking the selected release channel…</output> : null}
                  {channels.isError ? (
                    <>
                      <p role="alert">
                        {releaseChannelErrorMessage(channels.error, 'The selected release channel could not be checked.')} Latest release information
                        is hidden until status recovers.
                      </p>
                      <button
                        className="desktop-update-action secondary desktop-orbis-release-retry"
                        type="button"
                        onClick={() => void channels.refetch()}
                        disabled={channels.isFetching}
                      >
                        {channels.isFetching ? 'Checking channel…' : 'Retry'}
                      </button>
                    </>
                  ) : null}
                  {channels.data && !channels.isError && releases.isPending ? <output>Checking published Orbis releases…</output> : null}
                  {channels.data && !channels.isError && releases.isError ? (
                    <>
                      <p role="alert">
                        {orbisReleaseErrorMessage(
                          releases.error,
                          'Published Orbis releases could not be checked. No current or latest release is shown.',
                        )}
                      </p>
                      <button
                        className="desktop-update-action secondary desktop-orbis-release-retry"
                        type="button"
                        onClick={() => void releases.refetch()}
                        disabled={releases.isFetching}
                      >
                        {releases.isFetching ? 'Checking releases…' : 'Retry'}
                      </button>
                    </>
                  ) : null}
                  {channels.data && !channels.isError && releases.data?.length === 0 ? <p>No published Orbis releases.</p> : null}
                </div>
              </div>
              <div className="desktop-updates-artwork" data-brand="orbis" aria-hidden="true">
                <OrbisLogo size={176} plain />
              </div>
            </div>
            {latest?.priority === 'critical' && orbisUpdateAvailable ? (
              <div className="desktop-critical-update" role="note" aria-label="Critical update">
                <IconAlertTriangle size={22} aria-hidden="true" />
                <div>
                  <strong>Critical update</strong>
                  <p>This release includes security fixes. Review the release notes and install the update.</p>
                </div>
              </div>
            ) : null}
            {user?.operator !== true ? <p className="desktop-update-note">Sign in with an administrator account to update Orbis.</p> : null}
            {user?.operator === true && host.isPending ? <p className="desktop-update-note">Checking the local host service…</p> : null}
            {host.isError ? (
              <output className="desktop-update-note">{restarting ? watch.message : 'Waiting for the update service to respond.'}</output>
            ) : null}
            {host.data && !host.data.available ? (
              <p className="desktop-update-note">
                {restarting ? watch.message : host.data.reason || 'Host service disconnected. Connect it before updating Orbis.'}
              </p>
            ) : null}
            {host.data?.available && !host.data.enrolled ? (
              <p className="desktop-update-note">This installation is not enrolled for host updates.</p>
            ) : null}
            {host.data?.available && host.data.enrolled && !host.data.imageMatches ? (
              <p className="desktop-update-note" role="alert">
                The installed Orbis image differs from the one registered with the host service. Resolve the mismatch before updating.
              </p>
            ) : null}
            {job && job.state !== 'complete' ? (
              <section className={`desktop-update-job ${jobBusy ? 'is-busy' : ''}`} aria-label="Orbis update status" aria-live="polite">
                <strong>{job.state === 'running' ? 'Installing Orbis' : job.state === 'recovering' ? 'Recovering Orbis' : 'Last update'}</strong>
                <span>{job.message || corePhase || (jobBusy ? 'The page will reload automatically when the server is ready.' : job.state)}</span>
                {jobBusy && job.download ? <UpdateDownloadProgress value={job.download} /> : null}
                {job.state === 'interrupted' ? (
                  <button type="button" disabled={recover.isPending} onClick={() => recover.mutate(job.id)}>
                    {recover.isPending ? 'Starting recovery…' : 'Restore previous release'}
                  </button>
                ) : null}
              </section>
            ) : null}
            {coreUpdatePending ? (
              <output className="desktop-update-note" aria-live="polite">
                {coreRequestStage === 'checking'
                  ? 'Checking the release and backup storage…'
                  : coreRequestStage === 'starting'
                    ? 'Starting the update. The page will reload automatically when Orbis is ready.'
                    : 'Preparing the update…'}
              </output>
            ) : null}
            {lastCoreUpdate?.status === 'error' ? (
              <p className="desktop-update-note" role="alert">
                {lastCoreUpdate.error instanceof Error ? lastCoreUpdate.error.message : 'The update could not be started.'} Check the update status
                before retrying.
              </p>
            ) : null}
            {recover.isError ? (
              <p className="desktop-update-note" role="alert">
                {recover.error.message}
              </p>
            ) : null}
            {build.data || job?.state === 'complete' ? (
              <details className="desktop-system-update-details desktop-orbis-update-details">
                <summary>
                  <DisclosureIndicator size={17} />
                  Installed build details
                </summary>
                {build.data ? (
                  <div className="desktop-update-build">
                    <InstalledVersions
                      orbis={build.data.version}
                      runtipi={build.data.runtipiCompatibility || version.current}
                      channel={channels.isError ? 'unavailable' : (channels.data?.current ?? (channels.isPending ? 'loading' : 'unavailable'))}
                    />
                    <section className="desktop-update-build-details" aria-label="Build details">
                      <h3>Build details</h3>
                      {build.data.commit ? (
                        <div className="desktop-update-image">
                          <span>Commit</span>
                          <code>{build.data.commit.slice(0, 12)}</code>
                        </div>
                      ) : null}
                      {build.data.imageDigest ? (
                        <div className="desktop-update-image">
                          <span>Image</span>
                          <code title={build.data.imageDigest}>{build.data.imageDigest}</code>
                        </div>
                      ) : (
                        <span>Image digest unavailable.</span>
                      )}
                    </section>
                  </div>
                ) : null}
                {job?.state === 'complete' ? (
                  <section className="desktop-update-job" aria-label="Last Orbis update">
                    <strong>Last update complete</strong>
                    {job.message ? <span>{job.message}</span> : null}
                  </section>
                ) : null}
              </details>
            ) : null}
          </section>

          <section className="desktop-updates-card desktop-updates-host" aria-labelledby={`${tabsId}-os-title`}>
            <div className="desktop-updates-product">
              <div className="desktop-updates-card-head desktop-updates-product-head">
                <h2 id={`${tabsId}-os-title`}>Operating system</h2>
              </div>
              <div className="desktop-updates-product-content">
                {user.operator && !packageStatusUnavailable && systemPackages.data?.available ? (
                  <div className="desktop-update-summary">
                    <div aria-live="polite">
                      <p>
                        <strong>
                          {systemPackages.data.packageCount
                            ? `${systemPackages.data.packageCount} update${systemPackages.data.packageCount === 1 ? '' : 's'} available`
                            : 'No updates found'}
                        </strong>
                      </p>
                      {osName ? <p>{osName}</p> : null}
                      {packageInventory?.checkedAt ? (
                        <p className="desktop-host-package-times">
                          Last checked <time dateTime={packageInventory.checkedAt}>{new Date(packageInventory.checkedAt).toLocaleString()}</time>
                        </p>
                      ) : null}
                      {packageRestartRequired(systemPackages.data, restart) ? <p>Restart required</p> : null}
                    </div>
                  </div>
                ) : null}
                {user.operator ? (
                  <div className="desktop-update-actions desktop-host-update-actions">
                    {(systemPackages.data?.packageCount ?? 0) > 0 ? (
                      <button
                        type="button"
                        className="desktop-update-action desktop-system-update-primary"
                        aria-describedby={packageStatusUnavailable ? undefined : `${tabsId}-package-update-effects`}
                        disabled={
                          selectedPackages.length === 0 ||
                          packageUpdateBlocked ||
                          reviewRestart.isPending ||
                          applyRestart.isPending ||
                          coreWatchIsActive(watch)
                        }
                        onClick={() => installPackages.mutate([...selectedPackages])}
                      >
                        {installPackages.isPending
                          ? packageRequestStage === 'checking'
                            ? 'Checking updates…'
                            : 'Starting update…'
                          : (systemPackages.data?.packageCount ?? 0) > packageUpdateLimit
                            ? `Update ${selectedPackages.length} packages`
                            : 'Update system'}
                      </button>
                    ) : null}

                    <button
                      type="button"
                      className="desktop-update-action desktop-update-check"
                      aria-describedby={missingHostFeatures.length ? `${tabsId}-host-help` : undefined}
                      disabled={
                        !refreshSupported ||
                        host.isError ||
                        !host.data?.enrolled ||
                        !host.data.imageMatches ||
                        host.data.coreHealth !== 'healthy' ||
                        host.data.coreState !== 'running' ||
                        packageControlsBlocked ||
                        installPackages.isPending ||
                        reviewRestart.isPending ||
                        applyRestart.isPending ||
                        coreWatchIsActive(watch)
                      }
                      onClick={(event) => {
                        systemActionFocus.current =
                          document.activeElement === event.currentTarget ? { control: event.currentTarget, kind: 'refresh' } : null;
                        refreshPackages.mutate();
                      }}
                    >
                      <IconRefresh size={17} aria-hidden="true" />
                      <span className="desktop-update-check-label">
                        <span className="desktop-update-check-reserve" aria-hidden="true">
                          Check for updates
                        </span>
                        <span>
                          {refreshPackages.isPending || (packageJobBusy && packageJob.data?.job?.kind === 'refresh')
                            ? 'Checking…'
                            : 'Check for updates'}
                        </span>
                      </span>
                    </button>
                    {packageRestartRequired(systemPackages.data, restart) ? (
                      <button
                        type="button"
                        className="desktop-update-action"
                        aria-describedby={missingHostFeatures.length ? `${tabsId}-host-help` : undefined}
                        disabled={
                          !restart?.available ||
                          restartError ||
                          reviewRestart.isPending ||
                          applyRestart.isPending ||
                          restart.job?.state === 'restarting' ||
                          packageControlsBlocked ||
                          coreWatchIsActive(watch)
                        }
                        onClick={(event) => {
                          systemActionFocus.current =
                            document.activeElement === event.currentTarget ? { control: event.currentTarget, kind: 'restart' } : null;
                          restartReviewButton.current = event.currentTarget;
                          reviewRestart.mutate();
                        }}
                      >
                        <IconPower size={17} aria-hidden="true" />
                        {reviewRestart.isPending ? 'Checking…' : 'Restart'}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {user.operator && !packageStatusUnavailable && systemPackages.data?.packageCount ? (
                  <p className="desktop-update-note" id={`${tabsId}-package-update-effects`}>
                    {selectedPackages.length} selected
                    {systemPackages.data.packageCount > packageUpdateLimit ? ` · Up to ${packageUpdateLimit} per update` : ''}. Services may restart.
                    The server will not reboot automatically. Package changes have no automatic rollback.
                  </p>
                ) : null}
              </div>
              <OperatingSystemArtwork name={osName} />
            </div>
            {refreshPackages.isError ? <UpdateRequestError error={refreshPackages.error} /> : null}
            {installPackages.isError ? <UpdateRequestError error={installPackages.error} /> : null}
            {user.operator && restart?.available === false && !missingHostFeatures.length && !packageStatusUnavailable ? (
              <p className="desktop-update-note">{restart.reason}</p>
            ) : null}
            {restartError && !packageStatusUnavailable ? <p role="alert">Restart status could not be checked. Reconnecting to the server.</p> : null}
            {restart?.job?.state === 'failed' ? <p role="alert">{restart.job.message}</p> : null}
            {reviewRestart.isError || applyRestart.isError ? (
              <p role="alert">Restart could not be started. Check the server status before trying again.</p>
            ) : null}
            <Dialog
              open={Boolean(restartPlan)}
              onOpenChange={(open) => {
                if (!open && !applyRestart.isPending) closeRestartReview();
              }}
            >
              <DialogContent closeDisabled={applyRestart.isPending} restoreFocusTo={restartReviewButton}>
                <DialogHeader>
                  <DialogTitle>Restart this server?</DialogTitle>
                  <DialogDescription>
                    Applications will stop while the server restarts. This page reloads automatically when the server is ready.
                  </DialogDescription>
                </DialogHeader>
                {restartReviewExpired || reviewRestart.isError || applyRestart.isError ? (
                  <div className="modal-body">
                    {restartReviewExpired ? <output>Restart details expired. Check again before continuing.</output> : null}
                    {reviewRestart.isError || applyRestart.isError ? (
                      <p role="alert">Restart could not be started. Check the server status before trying again.</p>
                    ) : null}
                  </div>
                ) : null}
                <DialogFooter className="desktop-update-plan-actions">
                  <button type="button" disabled={applyRestart.isPending} onClick={closeRestartReview}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={applyRestart.isPending || reviewRestart.isPending || !restartPlan}
                    onClick={() => {
                      if (!restartPlan) return;
                      if (restartReviewExpired || reviewRestart.isError || applyRestart.isError || restartPlan.expiresAt * 1000 <= Date.now()) {
                        applyRestart.reset();
                        reviewRestart.mutate();
                      } else applyRestart.mutate(restartPlan.planId);
                    }}
                  >
                    {applyRestart.isPending ? 'Restarting…' : reviewRestart.isPending ? 'Checking…' : 'Restart'}
                  </button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            {user?.operator !== true ? <p>Host package details require an operator account.</p> : null}
            {user?.operator === true && systemPackages.isPending ? <p>Reading the host package cache…</p> : null}
            {packageStatusUnavailable ? (
              <div className="desktop-host-package-error" role="alert">
                <p>
                  {systemPackages.data?.available === false
                    ? systemPackages.data.reason || 'This host does not have a supported package manager.'
                    : 'System updates are unavailable. Check the server connection and try again.'}
                </p>
                <button
                  type="button"
                  className="desktop-update-action"
                  disabled={systemPackages.isFetching || packageJob.isFetching || host.isFetching}
                  onClick={() => {
                    void Promise.all([systemPackages.refetch(), packageJob.refetch(), host.refetch()]);
                  }}
                >
                  <IconRefresh size={17} aria-hidden="true" />
                  {systemPackages.isFetching || packageJob.isFetching || host.isFetching ? 'Reconnecting…' : 'Retry system updates'}
                </button>
              </div>
            ) : null}
            {packageJobNeedsInspection ? (
              <p role="alert" className="desktop-update-note">
                A previous package installation needs attention. Review its terminal output and repair APT on the host before updating or restarting.
              </p>
            ) : null}
            {failedRefresh ? (
              <output className="desktop-update-note">
                The package list check failed. Review the terminal output, then use Check for updates to retry. Installed packages were not changed by
                this check.
              </output>
            ) : null}
            {latestPackageJob ? <SystemUpdateProgress job={latestPackageJob} /> : null}
            {user.operator && systemPackages.data?.available ? (
              <details className="desktop-system-update-details">
                <summary>
                  <DisclosureIndicator size={17} />
                  {(systemPackages.data?.packageCount ?? 0) > 0 ? 'Package details and exclusions' : 'Package details'}
                </summary>
                {systemPackages.data?.available ? (
                  <p className="desktop-host-package-times">
                    {systemPackages.data.indexesUpdatedAt
                      ? `Package lists last changed ${new Date(systemPackages.data.indexesUpdatedAt).toLocaleString()}.`
                      : 'Package list age unavailable.'}
                    {systemPackages.data.rebootRequired ? ' A reboot request is recorded on this host.' : ''}
                  </p>
                ) : null}
                {systemPackages.data?.truncated ? <output>Showing the first 1,000 packages. Check the host for the complete list.</output> : null}
                {!!systemPackages.data?.packageCount && systemPackages.data.available ? (
                  <>
                    <p className="desktop-update-note">
                      {systemPackages.data.packageCount > packageUpdateLimit
                        ? `The first ${packageUpdateLimit} updates are selected for this transaction.`
                        : 'All available updates are selected by default.'}{' '}
                      Clear a package to exclude it from this update.
                    </p>
                    <div className="desktop-host-package-toolbar">
                      <label className="desktop-host-package-search">
                        <span>Filter package details</span>
                        <input
                          type="search"
                          placeholder="Name or repository"
                          value={packageSearch}
                          onChange={(event) => {
                            setPackageSearch(event.target.value);
                            setShowAllPackages(false);
                          }}
                        />
                      </label>
                      <div className="desktop-host-package-selection">
                        <strong>
                          {selectedPackages.length} of {systemPackages.data.packageCount ?? 0} selected
                        </strong>
                        <div>
                          <button
                            type="button"
                            disabled={
                              matchingPackages.length === 0 || (!matchingSelection && matchingSelectionExceedsLimit) || packageControlsBlocked
                            }
                            onClick={() => {
                              const names = matchingPackages.map((item) => item.name);
                              setSelectedPackages(
                                matchingSelection
                                  ? selectedPackages.filter((name) => !names.includes(name))
                                  : [...new Set([...selectedPackages, ...names])],
                              );
                            }}
                          >
                            {matchingSelection
                              ? packageSearch
                                ? 'Clear matching'
                                : 'Clear selection'
                              : packageSearch
                                ? 'Select matching'
                                : 'Select all'}
                          </button>
                        </div>
                      </div>
                    </div>
                    {(systemPackages.data.packages?.length ?? 0) > packageUpdateLimit ? (
                      <p className="desktop-update-note">
                        Up to {packageUpdateLimit} packages can be updated at a time. Remaining updates will be listed after installation.
                      </p>
                    ) : null}
                    <ul className="desktop-host-package-list" aria-label="Available host package updates">
                      {visiblePackages.map((item) => (
                        <li className="desktop-host-package" key={item.name}>
                          <label className="desktop-host-package-title">
                            <input
                              type="checkbox"
                              aria-label={`Select ${item.name} for update`}
                              checked={selectedPackages.includes(item.name)}
                              disabled={
                                installPackages.isPending ||
                                packageJob.isPending ||
                                packageJob.isError ||
                                packageJobBusy ||
                                packageJobNeedsInspection ||
                                (!selectedPackages.includes(item.name) && selectedPackages.length >= packageUpdateLimit)
                              }
                              onChange={(event) => {
                                setSelectedPackages(
                                  event.target.checked ? [...selectedPackages, item.name] : selectedPackages.filter((name) => name !== item.name),
                                );
                              }}
                            />
                            <strong title={item.name}>
                              {[...item.name.matchAll(/[^:-]*[:-]|[^:-]+$/g)].map((part) => (
                                <Fragment key={part.index}>
                                  <WrapWords text={part[0]} />
                                  <wbr />
                                </Fragment>
                              ))}
                            </strong>
                            {item.security ? <span>Security</span> : null}
                          </label>
                          <p className="desktop-host-package-versions">
                            <code title={item.installedVersion}>{item.installedVersion}</code>
                            <span aria-hidden="true">→</span>
                            <code title={item.candidateVersion}>{item.candidateVersion}</code>
                          </p>
                          <small>{packageSources(item.sources)}</small>
                          <div className="desktop-host-package-foot">
                            <span>{packageSize(item.downloadBytes)}</span>
                            <button
                              type="button"
                              aria-pressed={selectedPackage === item.name}
                              onClick={() => setSelectedPackage(selectedPackage === item.name ? null : item.name)}
                            >
                              {selectedPackage === item.name ? 'Hide changes' : 'View changes'}
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                    {matchingPackages.length === 0 ? <p>No packages match that search.</p> : null}
                    {!showAllPackages && matchingPackages.length > visiblePackages.length ? (
                      <button className="desktop-host-package-more" type="button" onClick={() => setShowAllPackages(true)}>
                        Show all {matchingPackages.length} matching packages
                      </button>
                    ) : null}
                    {selectedPackage ? (
                      <section className="desktop-host-changelog" aria-label={`${selectedPackage} changelog`}>
                        <div>
                          <strong>{selectedPackage} changelog</strong>
                          <button type="button" onClick={() => setSelectedPackage(null)} aria-label="Close package changelog">
                            Close
                          </button>
                        </div>
                        {packageChangelog.isPending ? <p>Reading the distribution changelog…</p> : null}
                        {packageChangelog.isError ? <p role="alert">The distribution changelog could not be read.</p> : null}
                        {packageChangelog.data?.available ? (
                          <>
                            <p>
                              {packageChangelog.data.source} · candidate {packageChangelog.data.candidateVersion}
                              {packageChangelog.data.truncated ? ' · Showing the first part' : ''}
                            </p>
                            <textarea
                              className="desktop-host-changelog-body"
                              aria-label="Distribution changelog text"
                              readOnly
                              spellCheck={false}
                              value={packageChangelog.data.body}
                            />
                          </>
                        ) : null}
                        {packageChangelog.data && !packageChangelog.data.available ? (
                          <p>{packageChangelog.data.reason || 'No distribution changelog available.'}</p>
                        ) : null}
                      </section>
                    ) : null}
                  </>
                ) : null}
              </details>
            ) : null}
          </section>
          <SentinelStatus active={visible && section === 'system'}>
            {user.operator ? (
              <div id={`${tabsId}-host-help`} className="desktop-sentinel-connection">
                <h3>System connection</h3>
                {host.isPending ? <output>Checking connection…</output> : null}
                {host.isError ? <p role="alert">{restarting ? watch.message : 'Waiting for the system service to respond.'}</p> : null}
                {!host.isError && host.data ? (
                  host.data.available ? (
                    missingHostFeatures.length ? (
                      <>
                        <p>
                          <strong>System service update needed</strong>
                        </p>
                        <p>Update the system service to enable {missingHostFeatures.join(' and ')}.</p>
                        <a
                          className="desktop-update-action secondary"
                          href="https://github.com/twentylines/orbis/blob/main/HOST-SERVICE.md#upgrade-an-installed-helper"
                          target="_blank"
                          rel="noreferrer"
                        >
                          View setup guide
                        </a>
                      </>
                    ) : (
                      <p>
                        <strong>Connected</strong>
                      </p>
                    )
                  ) : (
                    <p>{restarting ? watch.message : host.data.reason || 'System service disconnected.'}</p>
                  )
                ) : null}
              </div>
            ) : null}
          </SentinelStatus>
          {latest ? (
            <div className="desktop-updates-card desktop-updates-release">
              <OrbisReleaseNotes latest={latest} installed={build.data?.version} channel={channels.data?.current} compact />
              {latest.imageManifestUrl ? null : <p>No Orbis image manifest is attached to this release.</p>}
              <a href={latest.url} target="_blank" rel="noreferrer" className="desktop-update-action secondary">
                View release on GitHub
              </a>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
