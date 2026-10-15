import { getInstalledAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { AppLogo } from '@/components/app-logo/app-logo';
import { Markdown } from '@/components/markdown/markdown';
import { useAppContext } from '@/context/app-context';
import { IconArrowRight, IconBrandGithub, IconPackage, IconServerCog } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import './updates.css';

type Release = { tag: string; publishedAt: string | null; body: string; url: string; imageManifestUrl: string | null };
type Build = { version: string; commit: string | null; imageDigest: string | null; runtipiCompatibility: string | null };
type HostJob = { id: string; state: string; targetTag: string; startedAt: number; finishedAt?: number; message?: string };
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

async function hostRequest<T>(path: string, body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/host-updates/${path}`, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const message =
      typeof result === 'object' && result !== null && 'message' in result && typeof result.message === 'string' ? result.message : null;
    throw new Error(message || `Host update request failed (${response.status})`);
  }
  return result as T;
}

async function loadInstalledBuild(signal: AbortSignal): Promise<Build> {
  const response = await fetch('/api/system/build', { signal, credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Installed build check failed (${response.status})`);
  return response.json();
}

async function loadOrbisReleases(signal: AbortSignal): Promise<Release[]> {
  const response = await fetch('/api/system/orbis-release', { signal, credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Orbis release check failed (${response.status})`);
  const release: Release | null = await response.json();
  return release ? [release] : [];
}

export default function Updates() {
  const { user } = useAppContext();
  const [reviewPlan, setReviewPlan] = useState<HostPlan | null>(null);
  const apps = useQuery(getInstalledAppsOptions());
  const build = useQuery({ queryKey: ['orbis-installed-build'], queryFn: ({ signal }) => loadInstalledBuild(signal), staleTime: 30 * 60 * 1000 });
  const releases = useQuery({
    queryKey: ['orbis-github-releases'],
    queryFn: ({ signal }) => loadOrbisReleases(signal),
    staleTime: 30 * 60 * 1000,
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
    enabled: user?.operator === true,
    refetchInterval: (query) => (['running', 'recovering'].includes(query.state.data?.job?.state ?? '') ? 4000 : 30_000),
    retry: 1,
  });
  const plan = useMutation({
    mutationFn: (tag: string) => hostRequest<HostPlan>('plan', { tag }),
    onSuccess: (result) => setReviewPlan(result),
  });
  const apply = useMutation({
    mutationFn: (planId: string) => hostRequest<{ jobId: string; state: string }>('apply', { planId }),
    onSuccess: () => {
      setReviewPlan(null);
      void host.refetch();
    },
  });
  const recover = useMutation({
    mutationFn: (jobId: string) => hostRequest<{ jobId: string; state: string }>('recover', { jobId }),
    onSuccess: () => void host.refetch(),
  });
  const job = host.data?.job;
  const jobBusy = job?.state === 'running' || job?.state === 'recovering';
  const canPlan = Boolean(
    latest?.imageManifestUrl &&
      build.data &&
      latest.tag !== build.data.version &&
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

  return (
    <div className="desktop-updates">
      <div className="desktop-view-heading">
        <div>
          <p>Maintenance</p>
          <h1>Updates</h1>
        </div>
        <Link to="/dashboard">Back to workspace</Link>
      </div>
      <p className="desktop-updates-intro">
        Review changes before applying them. Application, Orbis, and host updates have separate release and rollback paths.
      </p>
      <div className="desktop-updates-grid">
        <section className="desktop-updates-card" aria-labelledby="application-updates-title">
          <div className="desktop-updates-card-head">
            <IconPackage size={22} aria-hidden="true" />
            <div>
              <h2 id="application-updates-title">Applications</h2>
              <p>Updates from your configured app stores</p>
            </div>
          </div>
          {apps.isPending ? <p>Checking installed applications…</p> : null}
          {apps.isError ? <p role="alert">Application updates could not be checked. Try again from Applications.</p> : null}
          {apps.data && available.length === 0 ? <p>Installed applications are up to date according to the current store metadata.</p> : null}
          {available.map(({ app, info, metadata }) => {
            const [appId, storeId] = info.urn.split(':');
            return (
              <Link className="desktop-update-app" to={`/apps/${storeId}/${appId}`} key={info.urn}>
                <AppLogo urn={info.urn} size={42} alt="" />
                <span>
                  <strong>{info.name}</strong>
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
          </div>
          <div className="desktop-update-build">
            {build.isPending ? 'Reading installed Orbis build…' : null}
            {build.isError ? 'Installed Orbis build metadata is unavailable.' : null}
            {build.data ? (
              <>
                <strong>Installed: {build.data.version}</strong>
                {build.data.commit ? <span>Commit {build.data.commit.slice(0, 12)}</span> : null}
                {build.data.imageDigest ? (
                  <span>Image {build.data.imageDigest}</span>
                ) : (
                  <span>Image digest was not supplied by this deployment.</span>
                )}
                {build.data.runtipiCompatibility ? <span>Runtipi compatibility: {build.data.runtipiCompatibility}</span> : null}
              </>
            ) : null}
          </div>
          {releases.isPending ? <p>Checking published Orbis releases…</p> : null}
          {releases.isError ? <p role="alert">GitHub releases are unavailable right now. You can check the repository directly.</p> : null}
          {releases.data?.length === 0 ? <p>No Orbis release has been published yet.</p> : null}
          {latest ? (
            <div className="desktop-update-release">
              <div className="desktop-update-release-title">
                <strong>{latest.tag}</strong>
                <time>{latest.publishedAt ? new Date(latest.publishedAt).toLocaleDateString() : 'Date unavailable'}</time>
              </div>
              <p>{latest.imageManifestUrl ? 'Published image manifest available.' : 'No Orbis image manifest is attached to this release.'}</p>
              <details>
                <summary>Read changelog</summary>
                {latest.body ? (
                  <Markdown content={latest.body} className="desktop-update-markdown" tabIndex={0} label={`${latest.tag} changelog`} />
                ) : (
                  <p>This release has no changelog.</p>
                )}
              </details>
              <a href={latest.url} target="_blank" rel="noreferrer">
                View release on GitHub <IconArrowRight size={16} aria-hidden="true" />
              </a>
            </div>
          ) : null}
          {user?.operator !== true ? <p className="desktop-update-note">Core updates require an operator account.</p> : null}
          {user?.operator === true && host.isPending ? <p className="desktop-update-note">Checking the local host service…</p> : null}
          {host.isError ? (
            <output className="desktop-update-note">The server may be restarting. Checking the host service again shortly.</output>
          ) : null}
          {host.data && !host.data.available ? (
            <p className="desktop-update-note">
              {host.data.reason || 'The local host service is not connected. Core updates need its verified snapshot and rollback path.'}
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
              <strong>
                {job.state === 'running' ? 'Installing' : job.state === 'recovering' ? 'Recovering' : 'Last host operation'}: {job.targetTag}
              </strong>
              <span>{job.message || (jobBusy ? 'The browser may briefly disconnect while the core restarts.' : job.state)}</span>
              {job.state === 'interrupted' ? (
                <button type="button" disabled={recover.isPending} onClick={() => recover.mutate(job.id)}>
                  {recover.isPending ? 'Starting recovery…' : 'Restore previous release'}
                </button>
              ) : null}
            </output>
          ) : null}
          {canPlan && latest && !reviewPlan ? (
            <button className="desktop-update-action" type="button" disabled={plan.isPending} onClick={() => plan.mutate(latest.tag)}>
              {plan.isPending ? 'Checking release and snapshot space…' : `Prepare update to ${latest.tag}`}
            </button>
          ) : null}
          {reviewPlan && latest?.tag === reviewPlan.targetTag ? (
            <div className="desktop-update-plan">
              <strong>Review core update</strong>
              <p>
                {reviewPlan.currentTag} to {reviewPlan.targetTag}
              </p>
              <p>Verified image: {reviewPlan.targetDigest}</p>
              <p>
                Installation snapshot estimate:{' '}
                {new Intl.NumberFormat(undefined, { style: 'unit', unit: 'megabyte', maximumFractionDigits: 0 }).format(
                  Math.ceil(reviewPlan.snapshotBytes / 1_000_000),
                )}
                . Managed apps must be stopped and will stay stopped.
              </p>
              <div className="desktop-update-plan-actions">
                <button type="button" disabled={apply.isPending} onClick={() => apply.mutate(reviewPlan.planId)}>
                  {apply.isPending ? 'Starting update…' : 'Install reviewed release'}
                </button>
                <button type="button" disabled={apply.isPending} onClick={() => setReviewPlan(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
          {plan.isError ? (
            <p className="desktop-update-note" role="alert">
              {plan.error.message}
            </p>
          ) : null}
          {apply.isError ? (
            <p className="desktop-update-note" role="alert">
              {apply.error.message}. Check the host operation status before retrying.
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
              <h2 id="host-updates-title">Host operating system</h2>
              <p>Packages, security advisories, and reboot status</p>
            </div>
          </div>
          <p>
            Host package updates cannot be read or applied by the Orbis container. This server needs a restricted host service matched to its
            operating system before Orbis can show package changelogs or apply updates.
          </p>
          <p className="desktop-update-note">No host update command is exposed to this browser.</p>
        </section>
      </div>
    </div>
  );
}
