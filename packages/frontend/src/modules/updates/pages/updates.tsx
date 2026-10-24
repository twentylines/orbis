import { WrapWords } from '@/components/wrap-words/wrap-words';
import { getInstalledAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { AppLogo } from '@/components/app-logo/app-logo';
import { OrbisReleaseNotes } from './orbis-release-notes';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/Dialog';
import { useAppContext } from '@/context/app-context';
import { IconArrowRight, IconBrandGithub, IconPackage, IconServerCog } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useWindowVisible } from '@/desktop/window-visibility';
import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import './updates.css';
import { useCluster } from '@/desktop/cluster';
import { ClusterUpdates } from '@/desktop/cluster-updates';
import { UpdateAllButton } from '@/modules/app/components/update-all-button/update-all-button';
import { UpdateTerminal } from './update-terminal';
import { OrbisDowngrade } from './orbis-downgrade';
import {
  rememberAcceptedCoreUpdate,
  prepareDesktopForCoreUpdate,
  useHostUpdateWatch,
  serverRestartQueryKey,
  type ServerRestartStatus,
} from '@/desktop/host-update-watch';
import { coreWatchIsActive } from '@/desktop/core-update-state';
import { installedOrbisBuildOptions, orbisReleasesOptions, newerOrbisRelease } from '@/desktop/orbis-release';

type HostJob = { id: string; state: string; targetTag: string; startedAt: number; finishedAt?: number; message?: string; phase?: string | null };
type HostStatus = {
  available: boolean;
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
type HostPackagePlan = {
  planId: string;
  createdAt: number;
  selected: HostPackage[];
  operations: Array<{ name: string; installedVersion: string | null; candidateVersion: string; action: 'install' | 'upgrade' }>;
};
type HostPackageJob = {
  id: string;
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
        path === 'plan' || path.startsWith('downgrade/') ? 110_000 : path === 'packages/plan' || path === 'packages/apply' ? 70_000 : 20_000,
      ),
    ]),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const message =
      typeof result === 'object' && result !== null && 'message' in result && typeof result.message === 'string' ? result.message : null;
    throw new Error(message || `Host update request failed (${response.status})`);
  }
  return result as T;
}

export default function Updates() {
  const cluster = useCluster();
  if (cluster.merged || (cluster.selectedServer && !cluster.selectedServer.local)) return <ClusterUpdates />;
  return <LocalUpdates />;
}

function LocalUpdates() {
  const entry = useLocation().key;
  const lastEntry = useRef(entry);
  const visible = useWindowVisible();
  const { user } = useAppContext();
  const { watch, restart, restartError } = useHostUpdateWatch();
  const queryClient = useQueryClient();
  const restarting = coreWatchIsActive(watch) && watch?.phase === 'offline';
  const [restartPlan, setRestartPlan] = useState<{ planId: string; expiresAt: number; rebootRequired: boolean } | null>(null);
  const reviewRestart = useMutation({
    mutationFn: () => hostRequest<NonNullable<typeof restartPlan>>('restart/plan', {}),
    onSuccess: setRestartPlan,
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
          message: 'The server is restarting. Reconnecting automatically.',
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
  const [selectedPackages, setSelectedPackages] = useState<string[]>([]);
  const [reviewPackagePlan, setReviewPackagePlan] = useState<HostPackagePlan | null>(null);
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
  const releases = useQuery({
    ...orbisReleasesOptions(),
    enabled: visible,
    staleTime: 60_000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });
  const available =
    apps.data?.installed.filter(
      ({ app, metadata }) => Number(app.version) < Number(metadata.latestVersion) && app.ignoredVersion !== metadata.latestVersion,
    ) ?? [];
  const latest = releases.data?.[0];
  const host = useQuery({
    queryKey: ['orbis-host-update-status'],
    queryFn: ({ signal }) => hostRequest<HostStatus>('status', undefined, signal),
    enabled: visible && user?.operator === true,
    refetchInterval: (query) => (['running', 'recovering'].includes(query.state.data?.job?.state ?? '') ? 4000 : 30_000),
    retry: 1,
  });
  const systemPackages = useQuery({
    queryKey: ['orbis-host-packages'],
    queryFn: ({ signal }) => hostRequest<HostPackageInventory>('packages', undefined, signal),
    enabled: visible && user?.operator === true,
    staleTime: 60_000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    retry: false,
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
    void releases.refetch();
    if (user?.operator === true) void systemPackages.refetch();
  }, [entry, apps.refetch, build.refetch, releases.refetch, systemPackages.refetch, user?.operator]);
  const packageJob = useQuery({
    queryKey: ['orbis-host-package-job'],
    queryFn: ({ signal }) => hostRequest<HostPackageJobStatus>('packages/job', undefined, signal),
    enabled: visible && user?.operator === true,
    refetchInterval: (query) => (['queued', 'running'].includes(query.state.data?.job?.state ?? '') ? 1500 : 30_000),
    retry: 1,
  });
  const planPackages = useMutation({
    mutationFn: (names: string[]) => hostRequest<HostPackagePlan>('packages/plan', { names }),
    onSuccess: (result) => setReviewPackagePlan(result),
  });
  const applyPackages = useMutation({
    mutationFn: (planId: string) => hostRequest<{ jobId: string; state: string }>('packages/apply', { planId }),
    retry: false,
    onSuccess: () => {
      setReviewPackagePlan(null);
      setSelectedPackages([]);
      void packageJob.refetch();
    },
  });
  const updateCore = useMutation({
    mutationFn: async (tag: string) => {
      setCoreRequestStage('checking');
      const checked = await hostRequest<HostPlan>('plan', { tag });
      if (checked.targetTag !== tag) throw new Error('The checked release changed. Refresh before updating.');
      await prepareDesktopForCoreUpdate();
      setCoreRequestStage('starting');
      return hostRequest<{ jobId: string; state: string }>('apply', { planId: checked.planId });
    },
    onSuccess: (result, tag) => rememberAcceptedCoreUpdate(result.jobId, tag),
    onSettled: () => {
      setCoreRequestStage(null);
      void host.refetch();
    },
    retry: false,
  });
  const recover = useMutation({
    mutationFn: (jobId: string) => hostRequest<{ jobId: string; state: string }>('recover', { jobId }),
    onSuccess: () => void host.refetch(),
  });
  const job = host.data?.job;
  const corePhase = (
    {
      preparing: 'Checking the release and backup storage…',
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
      newerOrbisRelease(latest, build.data.version) &&
      user?.operator === true &&
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
  const packageJobState = packageJob.data?.job?.state;
  const packageJobBusy = packageJobState === 'queued' || packageJobState === 'running';
  const packageJobNeedsInspection = packageJobState === 'failed' || packageJobState === 'interrupted';
  const matchingSelection =
    matchingPackages.length > 0 && matchingPackages.length <= 250 && matchingPackages.every((item) => selectedPackages.includes(item.name));
  const matchingSelectionExceedsLimit = new Set([...selectedPackages, ...matchingPackages.map((item) => item.name)]).size > 250;
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
    }
  }, [packageJob.data?.job?.id, packageJobState, systemPackages.refetch]);

  return (
    <div className="desktop-updates">
      <div className="desktop-updates-grid">
        <section className="desktop-updates-card" aria-labelledby="application-updates-title">
          <div className="desktop-updates-card-head">
            <IconPackage size={22} aria-hidden="true" />
            <div>
              <h2 id="application-updates-title">Applications</h2>
              <p>Updates from your configured app stores</p>
            </div>
          </div>
          {available.length > 0 && user.operator ? (
            <div className="desktop-update-actions">
              <UpdateAllButton />
            </div>
          ) : null}
          {apps.isPending ? <p>Checking installed applications…</p> : null}
          {apps.isError ? <p role="alert">Application updates could not be checked. Try again from Applications.</p> : null}
          {apps.data && available.length === 0 ? <p>No app updates in the cached catalogue.</p> : null}
          {available.map(({ app, info, metadata }) => {
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
                <IconArrowRight size={18} aria-hidden="true" />
              </Link>
            );
          })}
          <Link className="desktop-update-link" to="/apps">
            Manage applications <IconArrowRight size={16} aria-hidden="true" />
          </Link>
        </section>

        <section className="desktop-updates-card" aria-labelledby="orbis-updates-title">
          <div className="desktop-updates-card-head">
            <IconBrandGithub size={22} aria-hidden="true" />
            <div>
              <h2 id="orbis-updates-title">Orbis</h2>
              <p>Release notes from the Orbis GitHub repository</p>
            </div>
            {canPlan && latest ? (
              <button className="desktop-update-action" type="button" disabled={updateCore.isPending} onClick={() => updateCore.mutate(latest.tag)}>
                {updateCore.isPending ? 'Updating…' : 'Update'}
              </button>
            ) : null}
          </div>
          <div className="desktop-update-build">
            {build.isPending ? 'Reading installed Orbis build…' : null}
            {build.isError ? 'Installed Orbis build metadata is unavailable.' : null}
            {build.data ? (
              <>
                <strong>
                  Installed:{' '}
                  <span title={build.data.version}>
                    <WrapWords text={build.data.version} />
                  </span>
                </strong>
                {build.data.commit ? <span>Commit {build.data.commit.slice(0, 12)}</span> : null}
                {build.data.imageDigest ? (
                  <div className="desktop-update-image">
                    <span>Image</span>
                    <code title={build.data.imageDigest}>{build.data.imageDigest}</code>
                  </div>
                ) : (
                  <span>Image digest unavailable.</span>
                )}
              </>
            ) : null}
          </div>
          {releases.isPending ? <p>Checking published Orbis releases…</p> : null}
          {releases.isError ? <p role="alert">GitHub releases are unavailable right now. You can check the repository directly.</p> : null}
          {releases.data?.length === 0 ? <p>No published Orbis releases.</p> : null}
          {latest ? (
            <div className="desktop-update-release">
              <div className="desktop-update-release-title">
                <strong>{latest.tag === build.data?.version ? 'Current release' : latest.tag}</strong>
                <time>{latest.publishedAt ? new Date(latest.publishedAt).toLocaleDateString() : 'Date unavailable'}</time>
              </div>
              {latest.imageManifestUrl ? null : <p>No Orbis image manifest is attached to this release.</p>}
              <OrbisReleaseNotes latest={latest} installed={build.data?.version} />
              <a href={latest.url} target="_blank" rel="noreferrer">
                View release on GitHub <IconArrowRight size={16} aria-hidden="true" />
              </a>
            </div>
          ) : null}
          {user?.operator === true && build.data ? (
            <OrbisDowngrade
              installed={build.data.version}
              enabled={Boolean(
                host.data?.available &&
                  host.data.enrolled &&
                  host.data.imageMatches &&
                  host.data.coreState === 'running' &&
                  host.data.coreHealth === 'healthy' &&
                  !jobBusy &&
                  job?.state !== 'interrupted' &&
                  !updateCore.isPending,
              )}
              request={hostRequest}
            />
          ) : null}
          {user?.operator !== true ? <p className="desktop-update-note">Core updates require an operator account.</p> : null}
          {user?.operator === true && host.isPending ? <p className="desktop-update-note">Checking the local host service…</p> : null}
          {host.isError ? (
            <output className="desktop-update-note">
              {restarting ? watch.message : 'The host service could not be reached. Checking again shortly.'}
            </output>
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
              The running core does not match its enrolled image. Inspect the host before updating.
            </p>
          ) : null}
          {latest && build.data?.version === latest.tag ? (
            <p className="desktop-update-note">This server is on the latest published Orbis release.</p>
          ) : null}
          {job ? (
            <output className={`desktop-update-job ${jobBusy ? 'is-busy' : ''}`} aria-live="polite">
              <strong>{job.state === 'running' ? 'Installing Orbis' : job.state === 'recovering' ? 'Recovering Orbis' : 'Last update'}</strong>
              <span>{job.message || corePhase || (jobBusy ? 'The server will reconnect automatically after restart.' : job.state)}</span>
              {job.state === 'interrupted' ? (
                <button type="button" disabled={recover.isPending} onClick={() => recover.mutate(job.id)}>
                  {recover.isPending ? 'Starting recovery…' : 'Restore previous release'}
                </button>
              ) : null}
            </output>
          ) : null}
          {coreRequestStage ? (
            <output className="desktop-update-note" aria-live="polite">
              {coreRequestStage === 'checking'
                ? 'Checking the release and backup storage…'
                : 'Starting the update. The server will reconnect automatically.'}
            </output>
          ) : null}
          {updateCore.isError ? (
            <p className="desktop-update-note" role="alert">
              {updateCore.error.message} Check the update status before retrying.
            </p>
          ) : null}
          {recover.isError ? (
            <p className="desktop-update-note" role="alert">
              {recover.error.message}
            </p>
          ) : null}
        </section>

        <section className="desktop-updates-card desktop-updates-host" aria-labelledby="host-updates-title">
          <div className="desktop-updates-card-head">
            <IconServerCog size={22} aria-hidden="true" />
            <div>
              <h2 id="host-updates-title">System updates</h2>
              <p>Install operating system updates and follow the live terminal output.</p>
            </div>
            {user.operator ? (
              <button
                type="button"
                className="desktop-update-action"
                disabled={
                  !restart?.available ||
                  restartError ||
                  reviewRestart.isPending ||
                  applyRestart.isPending ||
                  restart.job?.state === 'restarting' ||
                  packageJobBusy ||
                  jobBusy ||
                  coreWatchIsActive(watch)
                }
                onClick={() => reviewRestart.mutate()}
              >
                {reviewRestart.isPending ? 'Reviewing restart…' : 'Restart server'}
              </button>
            ) : null}
          </div>
          {user.operator && restart?.available === false ? <p className="desktop-update-note">{restart.reason}</p> : null}
          {restartError ? <p role="alert">Restart status could not be checked. Reconnecting to the server.</p> : null}
          {restart?.job?.state === 'failed' ? <p role="alert">{restart.job.message}</p> : null}
          {reviewRestart.isError || applyRestart.isError ? <p role="alert">{reviewRestart.error?.message || applyRestart.error?.message}</p> : null}
          <Dialog
            open={Boolean(restartPlan)}
            onOpenChange={(open) => {
              if (!open && !applyRestart.isPending) setRestartPlan(null);
            }}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Restart this server?</DialogTitle>
                <DialogDescription>
                  Applications will stop while the server restarts. Orbis reconnects automatically when it is ready.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter className="desktop-update-plan-actions">
                <button type="button" disabled={applyRestart.isPending} onClick={() => setRestartPlan(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={applyRestart.isPending || !restartPlan}
                  onClick={() => {
                    if (restartPlan) applyRestart.mutate(restartPlan.planId);
                  }}
                >
                  {applyRestart.isPending ? 'Restarting…' : 'Restart server'}
                </button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          {user?.operator !== true ? <p>Host package details require an operator account.</p> : null}
          {user?.operator === true && systemPackages.isPending ? <p>Reading the host package cache…</p> : null}
          {systemPackages.isError ? (
            <div className="desktop-host-package-error" role="alert">
              <p>System updates could not be loaded. Check the server connection and try again.</p>
              <button type="button" className="desktop-update-action" onClick={() => void systemPackages.refetch()}>
                Retry system updates
              </button>
            </div>
          ) : null}
          {systemPackages.data && !systemPackages.data.available ? (
            <p>{systemPackages.data.reason || 'This host does not have a supported package manager.'}</p>
          ) : null}
          {packageJob.isError ? <p role="alert">The host package job status is unavailable. Check it again before starting an update.</p> : null}
          {packageJob.data?.job ? (
            <output className={`desktop-host-package-job ${packageJobBusy ? 'is-busy' : ''}`} aria-live="polite">
              <strong>
                Host package operation: {packageJob.data.job.state} · {packageJob.data.job.operationCount ?? 0} planned changes
              </strong>
              <span>{packageJob.data.job.message || (packageJobBusy ? 'APT is working on the host. This page can be closed.' : '')}</span>
              {packageJob.data.job.rebootRequired ? <span>The host requests a reboot. Orbis has not rebooted it.</span> : null}
            </output>
          ) : null}
          {packageJob.data?.job ? <UpdateTerminal output={packageJob.data.job.output} state={packageJob.data.job.state} /> : null}
          {systemPackages.data?.available ? (
            <>
              <div className="desktop-host-package-summary">
                <div>
                  <strong>{systemPackages.data.packageCount ?? 0} available package updates</strong>
                  <span>{systemPackages.data.operatingSystem || 'Host operating system'}</span>
                </div>
                {systemPackages.data.rebootRequired ? <span className="desktop-host-reboot">Restart required</span> : null}
              </div>
              <p className="desktop-host-package-times">
                {systemPackages.data.checkedAt ? `Checked ${new Date(systemPackages.data.checkedAt).toLocaleString()}. ` : ''}
                {systemPackages.data.indexesUpdatedAt
                  ? `Package lists last changed ${new Date(systemPackages.data.indexesUpdatedAt).toLocaleString()}.`
                  : 'Package list age unavailable.'}
                {systemPackages.data.rebootRequired ? ' A reboot request is recorded on this host.' : ''}
              </p>
              {systemPackages.data.truncated ? <output>Showing the first 1,000 packages. Check the host for the complete list.</output> : null}
              {(systemPackages.data.packageCount ?? 0) > 0 ? (
                <>
                  <div className="desktop-host-package-toolbar">
                    <label className="desktop-host-package-search">
                      <span>Find packages</span>
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
                            matchingPackages.length === 0 ||
                            (!matchingSelection && matchingSelectionExceedsLimit) ||
                            packageJob.isPending ||
                            packageJob.isError ||
                            packageJobBusy ||
                            packageJobNeedsInspection
                          }
                          onClick={() => {
                            const names = matchingPackages.map((item) => item.name);
                            setSelectedPackages(
                              matchingSelection
                                ? selectedPackages.filter((name) => !names.includes(name))
                                : [...new Set([...selectedPackages, ...names])],
                            );
                            setReviewPackagePlan(null);
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
                        <button
                          type="button"
                          disabled={
                            selectedPackages.length === 0 ||
                            planPackages.isPending ||
                            packageJob.isPending ||
                            packageJob.isError ||
                            packageJobBusy ||
                            packageJobNeedsInspection ||
                            jobBusy ||
                            job?.state === 'interrupted'
                          }
                          onClick={() => planPackages.mutate(selectedPackages)}
                        >
                          {planPackages.isPending ? 'Checking updates…' : 'Update selected'}
                        </button>
                      </div>
                    </div>
                  </div>
                  {planPackages.isError ? <p role="alert">{planPackages.error.message}</p> : null}
                  {applyPackages.isError ? <p role="alert">{applyPackages.error.message}. Check the host package job before trying again.</p> : null}
                  <Dialog
                    open={Boolean(reviewPackagePlan)}
                    onOpenChange={(open) => {
                      if (!open && !applyPackages.isPending) setReviewPackagePlan(null);
                    }}
                  >
                    <DialogContent size="lg" className="desktop-package-review">
                      <DialogHeader>
                        <DialogTitle>Update system packages</DialogTitle>
                        <DialogDescription>
                          {reviewPackagePlan?.selected.length ?? 0} selected updates · {reviewPackagePlan?.operations.length ?? 0} package changes
                        </DialogDescription>
                      </DialogHeader>
                      <div className="desktop-host-package-plan">
                        <textarea
                          readOnly
                          spellCheck={false}
                          aria-label="Planned package changes"
                          value={
                            reviewPackagePlan?.operations
                              .map(
                                (operation) =>
                                  `${operation.action === 'install' ? 'Install' : 'Upgrade'} ${operation.name}: ${operation.installedVersion ? `${operation.installedVersion} → ` : ''}${operation.candidateVersion}`,
                              )
                              .join('\n') ?? ''
                          }
                        />
                        <p>
                          Services may restart during installation. The host will not reboot automatically. Package changes have no automatic
                          rollback.
                        </p>
                      </div>
                      <DialogFooter className="desktop-update-plan-actions">
                        <button type="button" disabled={applyPackages.isPending} onClick={() => setReviewPackagePlan(null)}>
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={applyPackages.isPending || !reviewPackagePlan}
                          onClick={() => {
                            if (reviewPackagePlan) applyPackages.mutate(reviewPackagePlan.planId);
                          }}
                        >
                          {applyPackages.isPending ? 'Starting update…' : 'Install updates'}
                        </button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                  <ul className="desktop-host-package-list" aria-label="Available host package updates">
                    {visiblePackages.map((item) => (
                      <li className="desktop-host-package" key={item.name}>
                        <label className="desktop-host-package-title">
                          <input
                            type="checkbox"
                            aria-label={`Select ${item.name} for update`}
                            checked={selectedPackages.includes(item.name)}
                            disabled={
                              packageJob.isPending ||
                              packageJob.isError ||
                              packageJobBusy ||
                              packageJobNeedsInspection ||
                              (!selectedPackages.includes(item.name) && selectedPackages.length >= 250)
                            }
                            onChange={(event) => {
                              setSelectedPackages(
                                event.target.checked ? [...selectedPackages, item.name] : selectedPackages.filter((name) => name !== item.name),
                              );
                              setReviewPackagePlan(null);
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
              ) : (
                <p>No package updates in the local cache.</p>
              )}
              <p className="desktop-update-note">Available updates come from the server’s package lists.</p>
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}
