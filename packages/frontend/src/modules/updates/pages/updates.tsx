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
  const [packageSearch, setPackageSearch] = useState('');
  const [showAllPackages, setShowAllPackages] = useState(false);
  const [selectedPackage, setSelectedPackage] = useState<string | null>(null);
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
  const systemPackages = useQuery({
    queryKey: ['orbis-host-packages'],
    queryFn: ({ signal }) => hostRequest<HostPackageInventory>('packages', undefined, signal),
    enabled: user?.operator === true,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const packageChangelog = useQuery({
    queryKey: ['orbis-host-package-changelog', selectedPackage],
    queryFn: ({ signal }) =>
      hostRequest<HostPackageChangelog>(`packages/changelog?name=${encodeURIComponent(selectedPackage ?? '')}`, undefined, signal),
    enabled: user?.operator === true && selectedPackage !== null,
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
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
  const matchingPackages = (systemPackages.data?.packages ?? []).filter((item) =>
    `${item.name} ${packageSources(item.sources)}`.toLocaleLowerCase().includes(packageSearch.trim().toLocaleLowerCase()),
  );
  const visiblePackages = showAllPackages ? matchingPackages : matchingPackages.slice(0, 12);

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
              <p>Packages, distribution changelogs, and reboot status</p>
            </div>
          </div>
          {user?.operator !== true ? <p>Host package details require an operator account.</p> : null}
          {user?.operator === true && systemPackages.isPending ? <p>Reading the host package cache…</p> : null}
          {systemPackages.isError ? <p role="alert">Host package details are unavailable. The installed host helper may need an upgrade.</p> : null}
          {systemPackages.data && !systemPackages.data.available ? (
            <p>{systemPackages.data.reason || 'This host does not have a supported package manager.'}</p>
          ) : null}
          {systemPackages.data?.available ? (
            <>
              <div className="desktop-host-package-summary">
                <div>
                  <strong>{systemPackages.data.packageCount ?? 0} available package updates</strong>
                  <span>{systemPackages.data.operatingSystem || 'Host operating system'}</span>
                </div>
                <button type="button" disabled={systemPackages.isFetching} onClick={() => void systemPackages.refetch()}>
                  {systemPackages.isFetching ? 'Checking…' : 'Check again'}
                </button>
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
                  <label className="desktop-host-package-search">
                    <span>Find a package</span>
                    <input
                      type="search"
                      value={packageSearch}
                      onChange={(event) => {
                        setPackageSearch(event.target.value);
                        setShowAllPackages(false);
                      }}
                      placeholder="Name or repository"
                    />
                  </label>
                  <ul className="desktop-host-package-list" aria-label="Available host package updates">
                    {visiblePackages.map((item) => (
                      <li className="desktop-host-package" key={item.name}>
                        <div className="desktop-host-package-title">
                          <strong>{item.name}</strong>
                          {item.security ? <span>Security</span> : null}
                        </div>
                        <p>
                          {item.installedVersion} <span aria-hidden="true">→</span> {item.candidateVersion}
                        </p>
                        <small>{packageSources(item.sources)}</small>
                        <div className="desktop-host-package-foot">
                          <span>{packageSize(item.downloadBytes)}</span>
                          <button
                            type="button"
                            aria-pressed={selectedPackage === item.name}
                            onClick={() => setSelectedPackage(selectedPackage === item.name ? null : item.name)}
                          >
                            {selectedPackage === item.name ? 'Close changelog' : 'Read changelog'}
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
                        <p>{packageChangelog.data.reason || 'No distribution changelog was supplied.'}</p>
                      ) : null}
                    </section>
                  ) : null}
                </>
              ) : (
                <p>No upgrades are listed in the current host package cache.</p>
              )}
              <p className="desktop-update-note">Package installation is unavailable in this build. This list reads the host cache only.</p>
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}
