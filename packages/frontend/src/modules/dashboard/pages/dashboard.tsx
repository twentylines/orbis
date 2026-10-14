import { getInstalledAppsOptions, getLinksOptions, systemLoadOptions } from '@/api-client/@tanstack/react-query.gen';
import { AppLogo } from '@/components/app-logo/app-logo';
import { IconApps, IconArrowRight, IconCpu, IconDatabase, IconDeviceDesktopAnalytics, IconPlus } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import './dashboard.css';

const number = (value: number | undefined, suffix: string) =>
  typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(value < 10 ? 1 : 0)}${suffix}` : 'Unavailable';

export default function Dashboard() {
  const apps = useQuery({ ...getInstalledAppsOptions(), refetchInterval: 15000 });
  const links = useQuery({ ...getLinksOptions() });
  const system = useQuery({ ...systemLoadOptions(), refetchInterval: 5000, refetchIntervalInBackground: false });
  const installed = apps.data?.installed.filter(({ info }) => info.available) ?? [];
  const running = installed.filter(({ app }) => app.status === 'running').length;
  const attention = installed.filter(({ app, metadata }) => app.status === 'stopped' || Number(app.version) < Number(metadata.latestVersion)).length;
  const diskAvailable = Boolean(system.data && system.data.diskSize > 0);
  const memoryAvailable = Boolean(system.data && system.data.memoryTotal > 0);

  return (
    <div className="workspace">
      <div className="workspace-heading">
        <div>
          <p className="workspace-eyebrow">Workspace</p>
          <h1>Your server</h1>
        </div>
        <Link to="/app-store" className="workspace-add">
          <IconPlus size={18} aria-hidden="true" /> Install an app
        </Link>
      </div>

      <div className="workspace-grid">
        <section className="workspace-apps" aria-labelledby="workspace-apps-title">
          <div className="workspace-section-heading">
            <div>
              <h2 id="workspace-apps-title">Applications</h2>
              <p>{apps.data ? `${running} running · ${installed.length} installed` : 'Loading installed applications'}</p>
            </div>
            <Link to="/apps">
              View all <IconArrowRight size={18} aria-hidden="true" />
            </Link>
          </div>
          {apps.isError ? (
            <div className="workspace-message" role="alert">
              Applications could not be loaded.{' '}
              <button type="button" onClick={() => apps.refetch()}>
                Retry
              </button>
            </div>
          ) : null}
          {apps.isPending ? (
            <div className="workspace-app-skeleton">
              <span className="visually-hidden">Loading applications</span>
              <span />
              <span />
              <span />
              <span />
            </div>
          ) : null}
          {apps.data && installed.length === 0 ? (
            <div className="workspace-empty">
              <IconApps size={28} stroke={1.5} aria-hidden="true" />
              <strong>No applications installed</strong>
              <p>Open the App Store to add your first service.</p>
              <Link to="/app-store">Browse the App Store</Link>
            </div>
          ) : null}
          {installed.length > 0 ? (
            <div className="workspace-app-list">
              {installed.slice(0, 8).map(({ app, info, metadata }) => {
                const [appId, storeId] = info.urn.split(':');
                const update = Number(app.version) < Number(metadata.latestVersion) && app.ignoredVersion !== metadata.latestVersion;
                return (
                  <Link
                    key={info.urn}
                    to={`/apps/${storeId}/${appId}`}
                    className="workspace-app"
                    aria-label={`${info.name}, ${app.status}${update ? ', update available' : ''}`}
                  >
                    <AppLogo urn={info.urn} size={46} alt="" />
                    <span className="workspace-app-copy">
                      <strong>{info.name}</strong>
                      <small>{update ? 'Update available' : app.status}</small>
                    </span>
                    <span className={`workspace-app-status ${app.status}`} aria-hidden="true" />
                  </Link>
                );
              })}
            </div>
          ) : null}
          {links.data?.links?.length ? (
            <div className="workspace-links">
              <h3>Links</h3>
              {links.data.links.slice(0, 4).map((link) => (
                <a key={link.id} href={link.url} target="_blank" rel="noreferrer">
                  {link.title}
                  <IconArrowRight size={16} aria-hidden="true" />
                </a>
              ))}
            </div>
          ) : null}
        </section>

        <div className="workspace-side">
          <section className="workspace-activity" aria-labelledby="workspace-activity-title">
            <div className="workspace-section-heading">
              <div>
                <h2 id="workspace-activity-title">System activity</h2>
                <p>{system.dataUpdatedAt ? `Sampled ${new Date(system.dataUpdatedAt).toLocaleTimeString()}` : 'Waiting for live sample'}</p>
              </div>
              <Link to="/monitor" aria-label="Open System Monitor">
                <IconDeviceDesktopAnalytics size={21} aria-hidden="true" />
              </Link>
            </div>
            {system.isError ? (
              <div className="workspace-message" role="alert">
                System readings are unavailable.{' '}
                <button type="button" onClick={() => system.refetch()}>
                  Retry
                </button>
              </div>
            ) : (
              <div className="workspace-metrics">
                <Link to="/monitor" className="workspace-metric">
                  <IconCpu size={20} aria-hidden="true" />
                  <span>CPU load</span>
                  <strong>{number(system.data?.cpuLoad, '%')}</strong>
                  <div className="workspace-meter">
                    <span style={{ width: `${Math.min(100, Math.max(0, system.data?.cpuLoad ?? 0))}%` }} />
                  </div>
                </Link>
                <Link to="/monitor" className="workspace-metric">
                  <IconDeviceDesktopAnalytics size={20} aria-hidden="true" />
                  <span>Memory</span>
                  <strong>{memoryAvailable ? number(system.data?.percentUsedMemory, '%') : 'Unavailable'}</strong>
                  <div className="workspace-meter">
                    <span style={{ width: `${memoryAvailable ? Math.min(100, Math.max(0, system.data?.percentUsedMemory ?? 0)) : 0}%` }} />
                  </div>
                </Link>
              </div>
            )}
          </section>
          <Link to="/monitor" className="workspace-storage">
            <div className="workspace-storage-top">
              <IconDatabase size={22} aria-hidden="true" />
              <span>Runtime filesystem</span>
              <IconArrowRight size={18} aria-hidden="true" />
            </div>
            <strong>{diskAvailable ? `${system.data?.diskUsed} GB` : 'Unavailable'}</strong>
            <small>{diskAvailable ? `of ${system.data?.diskSize} GB used in the Orbis core container` : 'Waiting for a filesystem reading'}</small>
            <div className="workspace-meter">
              <span style={{ width: `${diskAvailable ? Math.min(100, Math.max(0, system.data?.percentUsed ?? 0)) : 0}%` }} />
            </div>
          </Link>
          <section className="workspace-attention" aria-labelledby="workspace-attention-title">
            <h2 id="workspace-attention-title">Needs attention</h2>
            {apps.data ? (
              <p>
                {attention
                  ? `${attention} installed application${attention === 1 ? '' : 's'} stopped or ready to update.`
                  : 'No stopped apps or available updates in the current app list.'}
              </p>
            ) : (
              <p>Waiting for application status.</p>
            )}
            {attention > 0 ? <Link to="/apps">Review applications</Link> : null}
          </section>
        </div>
      </div>
    </div>
  );
}
