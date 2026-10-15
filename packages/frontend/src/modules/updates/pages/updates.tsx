import { getInstalledAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { AppLogo } from '@/components/app-logo/app-logo';
import { Markdown } from '@/components/markdown/markdown';
import { IconArrowRight, IconBrandGithub, IconPackage, IconServerCog } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import './updates.css';

type Release = { tag: string; publishedAt: string | null; body: string; url: string; imageManifestUrl: string | null };
type Build = { version: string; commit: string | null; imageDigest: string | null; runtipiCompatibility: string | null };

async function loadInstalledBuild(signal: AbortSignal): Promise<Build> {
  const response = await fetch('/api/system/build', { signal, credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Installed build check failed (${response.status})`);
  return response.json();
}

async function loadOrbisReleases(signal: AbortSignal): Promise<Release[]> {
  const response = await fetch('https://api.github.com/repos/twentylines/orbis/releases?per_page=5', {
    headers: { Accept: 'application/vnd.github+json' },
    signal,
  });
  if (!response.ok) throw new Error(`GitHub release check failed (${response.status})`);
  const raw: unknown = await response.json();
  if (!Array.isArray(raw)) throw new Error('GitHub release response was invalid');
  return raw
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .filter((item) => typeof item.tag_name === 'string' && typeof item.html_url === 'string')
    .map((item) => ({
      tag: item.tag_name as string,
      publishedAt: typeof item.published_at === 'string' ? item.published_at : null,
      body: typeof item.body === 'string' ? item.body : '',
      url: item.html_url as string,
      imageManifestUrl:
        (Array.isArray(item.assets) &&
          item.assets.find(
            (asset: unknown) => typeof asset === 'object' && asset !== null && 'name' in asset && asset.name === 'release-manifest.json',
          )?.browser_download_url) ||
        null,
    }));
}

export default function Updates() {
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
                {latest.body ? <Markdown content={latest.body} className="desktop-update-markdown" /> : <p>This release has no changelog.</p>}
              </details>
              <a href={latest.url} target="_blank" rel="noreferrer">
                View release on GitHub <IconArrowRight size={16} aria-hidden="true" />
              </a>
            </div>
          ) : null}
          <p className="desktop-update-note">
            In-browser Orbis installation is unavailable until the host controller can verify image digests, check compatibility, and back up and roll
            back the installation.
          </p>
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
