import { getInstalledAppsOptions, getLinksOptions } from '@/api-client/@tanstack/react-query.gen';
import { AppLogo } from '@/components/app-logo/app-logo';
import { defaultDesktopPreferences, useDesktopPreferences, type WidgetId, type WorkspacePreferences } from '@/desktop/preferences';
import { loadTelemetry, telemetryQueryKey, type Telemetry } from '@/desktop/telemetry';
import { useContainerTelemetry } from '@/desktop/containers';
import { DockerHealth } from '@/components/docker-health/docker-health';
import { ContainerResources } from '@/components/container-resources/container-resources';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { useTasks, taskIsActive, taskLabels, taskStates } from '@/desktop/tasks';
import {
  IconAdjustmentsHorizontal,
  IconApps,
  IconArrowRight,
  IconArrowsDownUp,
  IconCpu,
  IconDatabase,
  IconDeviceDesktopAnalytics,
  IconPlus,
  IconPin,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router';
import './dashboard.css';

const labels: Record<WidgetId, string> = {
  applications: 'Applications',
  activity: 'System status',
  storage: 'Recent operations',
  attention: 'Needs attention',
};

const number = (value: number | null | undefined, suffix: string) =>
  typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(value < 10 ? 1 : 0)}${suffix}` : 'Unavailable';
const rate = (value: number | null) => {
  if (value === null) return 'Unavailable';
  if (value < 1024) return `${value.toFixed(0)} B/s`;
  const units = ['KB/s', 'MB/s', 'GB/s'];
  let amount = value;
  let index = -1;
  do {
    amount /= 1024;
    index++;
  } while (amount >= 1024 && index < units.length - 1);
  return `${amount.toFixed(amount < 10 ? 1 : 0)} ${units[index]}`;
};

export default function Dashboard() {
  const [editing, setEditing] = useState(false);
  const [pinPickerRequested, setPinPickerRequested] = useState(false);
  const pinHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!editing || !pinPickerRequested) return;
    let cancelled = false;
    const heading = pinHeading.current;
    const entrance = heading?.closest('.workspace-editor')?.getAnimations() ?? [];
    void Promise.all(entrance.map((animation) => animation.finished.catch(() => undefined))).then(() => {
      if (cancelled || !heading) return;
      heading.focus({ preventScroll: true });
      heading.scrollIntoView({
        block: 'start',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      });
      setPinPickerRequested(false);
    });
    return () => {
      cancelled = true;
    };
  }, [editing, pinPickerRequested]);
  const { preferences, update, syncState } = useDesktopPreferences();
  const { workspace } = preferences;
  const apps = useQuery({ ...getInstalledAppsOptions(), refetchInterval: 15000 });
  const links = useQuery({ ...getLinksOptions() });
  const containers = useContainerTelemetry();
  const tasks = useTasks();
  const system = useQuery<Telemetry>({
    queryKey: telemetryQueryKey,
    queryFn: ({ signal }) => loadTelemetry(signal),
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  });
  const installed = apps.data?.installed.filter(({ info }) => info.available) ?? [];
  const orderedInstalled = [...installed].sort((left, right) => {
    const leftPin = workspace.pinnedApps.indexOf(left.info.urn);
    const rightPin = workspace.pinnedApps.indexOf(right.info.urn);
    if (leftPin < 0 && rightPin < 0) return 0;
    if (leftPin < 0) return 1;
    if (rightPin < 0) return -1;
    return leftPin - rightPin;
  });
  const installedUrns = new Set(installed.map(({ info }) => info.urn));
  const missingPins = workspace.pinnedApps.filter((urn) => !installedUrns.has(urn));
  const visibleInstalled = workspace.showAllApps
    ? orderedInstalled
    : orderedInstalled.slice(0, Math.max(3, workspace.pinnedApps.length - missingPins.length));
  const scrollApps = workspace.showAllApps && (!workspace.hidden.includes('storage') || !workspace.hidden.includes('attention'));
  const running = installed.filter(({ app }) => app.status === 'running').length;
  const attention = installed.filter(({ app, metadata }) => app.status === 'stopped' || Number(app.version) < Number(metadata.latestVersion)).length;
  const unhealthy = new Set(containers.data?.containers.filter((item) => item.health === 'unhealthy' && item.appUrn).map((item) => item.appUrn)).size;
  const activeTasks = tasks.data?.tasks.filter(taskIsActive) ?? [];
  const disk = system.data?.filesystems.find((filesystem) => filesystem.mount === '/') ?? system.data?.filesystems[0];
  const diskAvailable = typeof disk?.sizeBytes === 'number' && disk.sizeBytes > 0 && typeof disk.usedBytes === 'number';
  const diskUsedGb = diskAvailable ? (disk?.usedBytes ?? 0) / 1024 ** 3 : null;
  const diskSizeGb = diskAvailable ? (disk?.sizeBytes ?? 0) / 1024 ** 3 : null;
  const diskPercent = diskAvailable && disk?.sizeBytes ? ((disk.usedBytes ?? 0) / disk.sizeBytes) * 100 : null;
  const memoryTotal = system.data?.memory.totalBytes;
  const memoryAvailable = typeof memoryTotal === 'number' && memoryTotal > 0 && typeof system.data?.memory.availableBytes === 'number';
  const memoryPercent = memoryAvailable ? ((memoryTotal - (system.data?.memory.availableBytes ?? 0)) / memoryTotal) * 100 : null;
  const cpuPercent = system.data?.cpu.totalPercent;
  const networkInterfaces = system.data?.network.filter((item) => item.interface !== 'lo') ?? [];
  const networkRate = (field: 'rxBytesPerSecond' | 'txBytesPerSecond') =>
    networkInterfaces.length && networkInterfaces.every((item) => item[field] !== null)
      ? networkInterfaces.reduce((sum, item) => sum + (item[field] ?? 0), 0)
      : null;

  const saveWorkspace = (next: WorkspacePreferences) => update({ workspace: next });
  const move = (id: WidgetId, direction: -1 | 1) => {
    const order = [...workspace.order];
    const index = order.indexOf(id);
    const target = index + direction;
    if (target < 0 || target >= order.length) return;
    const [item] = order.splice(index, 1);
    if (!item) return;
    order.splice(target, 0, item);
    saveWorkspace({ ...workspace, order });
  };
  const toggle = (id: WidgetId, field: 'hidden' | 'wide') => {
    const current = workspace[field];
    saveWorkspace({ ...workspace, [field]: current.includes(id) ? current.filter((item) => item !== id) : [...current, id] });
  };
  const togglePin = (urn: string) => {
    const current = workspace.pinnedApps;
    if (!current.includes(urn) && current.length >= 12) return;
    saveWorkspace({ ...workspace, pinnedApps: current.includes(urn) ? current.filter((item) => item !== urn) : [...current, urn] });
  };

  const widgets: Record<WidgetId, ReactNode> = {
    applications: (
      <section className="workspace-apps" aria-labelledby="workspace-apps-title">
        <div className="workspace-section-heading">
          <div>
            <h2 id="workspace-apps-title">Applications</h2>
          </div>
          <div className="workspace-home-app-actions">
            <Button
              size="icon"
              className="workspace-pin-trigger"
              title="Choose home apps"
              aria-label="Choose home apps"
              aria-controls="workspace-pins"
              onClick={() => {
                setEditing(true);
                setPinPickerRequested(true);
              }}
            >
              <IconPin size={18} aria-hidden="true" />
            </Button>
            <Link to="/apps" viewTransition>
              View all <IconArrowRight size={18} aria-hidden="true" />
            </Link>
          </div>
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
            <Link to="/app-store" viewTransition>
              Browse the App Store
            </Link>
          </div>
        ) : null}
        {installed.length > 0 ? (
          <section
            className="workspace-app-scroll"
            data-scroll={scrollApps}
            aria-label="Installed applications"
            tabIndex={scrollApps ? 0 : undefined}
          >
            <div className="workspace-app-list">
              {visibleInstalled.map(({ app, info, metadata }) => {
                const [appId, storeId] = info.urn.split(':');
                const appUpdate = Number(app.version) < Number(metadata.latestVersion) && app.ignoredVersion !== metadata.latestVersion;
                return (
                  <Link
                    key={info.urn}
                    to={`/apps/${storeId}/${appId}`}
                    className="workspace-app"
                    aria-label={`${info.name}, ${app.status}${appUpdate ? ', update available' : ''}${workspace.pinnedApps.includes(info.urn) ? ', pinned' : ''}`}
                  >
                    <AppLogo urn={info.urn} size={54} alt="" />
                    <span className="workspace-app-copy">
                      <strong>{info.name}</strong>
                      <small aria-hidden={!appUpdate && !workspace.pinnedApps.includes(info.urn) ? true : undefined}>
                        {`${workspace.pinnedApps.includes(info.urn) ? 'Pinned' : ''}${workspace.pinnedApps.includes(info.urn) && appUpdate ? ' · ' : ''}${appUpdate ? 'Update available' : ''}`}
                      </small>
                      <DockerHealth appUrn={info.urn} telemetry={containers.data} stale={containers.isError} />
                    </span>
                  </Link>
                );
              })}
            </div>
          </section>
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
    ),
    activity: (
      <section className="workspace-activity" aria-labelledby="workspace-activity-title">
        <div className="workspace-section-heading">
          <div>
            <h2 id="workspace-activity-title">System status</h2>
            <p>{system.data?.sampledAt ? `Sampled ${new Date(system.data.sampledAt).toLocaleTimeString()}` : 'Waiting for live sample'}</p>
          </div>
          <Link to="/monitor" viewTransition aria-label="Expand System status">
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
            <div className="workspace-gauges">
              <Link to="/monitor" viewTransition className="workspace-gauge" aria-label={`Open CPU monitor, ${number(cpuPercent, '%')}`}>
                <span className="workspace-dial" style={{ '--dial-progress': `${Math.min(100, Math.max(0, cpuPercent ?? 0))}%` } as CSSProperties}>
                  <IconCpu size={17} aria-hidden="true" />
                  <strong>{typeof cpuPercent === 'number' ? number(cpuPercent, '%') : '—'}</strong>
                </span>
                <span>{system.data ? (system.data.cpu.scope === 'host-proc' ? 'Host CPU' : 'Core CPU') : 'CPU'}</span>
              </Link>
              <Link to="/monitor" viewTransition className="workspace-gauge" aria-label={`Open memory monitor, ${number(memoryPercent, '%')}`}>
                <span className="workspace-dial" style={{ '--dial-progress': `${Math.min(100, Math.max(0, memoryPercent ?? 0))}%` } as CSSProperties}>
                  <IconDeviceDesktopAnalytics size={17} aria-hidden="true" />
                  <strong>{typeof memoryPercent === 'number' ? number(memoryPercent, '%') : '—'}</strong>
                </span>
                <span>Host memory</span>
              </Link>
            </div>
            <Link to="/monitor" viewTransition className="workspace-network">
              <span className="workspace-network-heading">
                <IconArrowsDownUp size={17} aria-hidden="true" /> Core network
              </span>
              <span className="workspace-network-rate">
                <b>↓</b> {rate(networkRate('rxBytesPerSecond'))}
              </span>
              <span className="workspace-network-rate">
                <b>↑</b> {rate(networkRate('txBytesPerSecond'))}
              </span>
            </Link>
          </div>
        )}
        <Link to="/monitor#telemetry-disks-title" className="workspace-status-storage">
          <span>
            <IconDatabase size={17} aria-hidden="true" /> Storage <IconArrowRight size={16} aria-hidden="true" />
          </span>
          <strong>
            {number(diskUsedGb, ' GB')} <small>/ {number(diskSizeGb, ' GB')}</small>
          </strong>
          <div className="workspace-meter">
            <span style={{ width: `${Math.min(100, Math.max(0, diskPercent ?? 0))}%` }} />
          </div>
          <small>Orbis core filesystem</small>
        </Link>
        <ContainerResources compact />
      </section>
    ),
    storage: (
      <section className="workspace-operations" aria-labelledby="workspace-operations-title">
        <div className="workspace-section-heading">
          <div>
            <h2 id="workspace-operations-title">Recent operations</h2>
            <p>{activeTasks.length ? `${activeTasks.length} in progress` : 'Application activity'}</p>
          </div>
          <Link to="/tasks" viewTransition>
            View all <IconArrowRight size={18} aria-hidden="true" />
          </Link>
        </div>
        {tasks.isError ? (
          <p role="alert">Operation history is unavailable.</p>
        ) : tasks.isPending ? (
          <p>Loading operations…</p>
        ) : tasks.data?.tasks.length ? (
          <ol className="workspace-recent-tasks">
            {tasks.data.tasks.slice(0, 2).map((task) => (
              <li key={task.id}>
                <Link to="/tasks" viewTransition>
                  <span>
                    <strong>
                      {taskLabels[task.action]} {installed.find(({ info }) => info.urn === task.appUrn)?.info.name ?? task.appUrn.split(':')[0]}
                    </strong>
                    <small>{new Date(task.updatedAt).toLocaleTimeString()}</small>
                  </span>
                  <b data-status={task.status}>{taskStates[task.status]}</b>
                </Link>
              </li>
            ))}
          </ol>
        ) : (
          <p className="workspace-operations-empty">
            New installs, updates, and backups appear here. Their outcomes stay available after you leave the workspace.
          </p>
        )}
      </section>
    ),
    attention: (
      <section className="workspace-attention" aria-labelledby="workspace-attention-title">
        <h2 id="workspace-attention-title">Needs attention</h2>
        {unhealthy > 0 ? (
          <p>
            {unhealthy} application{unhealthy === 1 ? '' : 's'} with an unhealthy Docker check.{' '}
            <Link to="/monitor#containers">Inspect containers</Link>
          </p>
        ) : null}
        {apps.data ? (
          <p>
            {attention
              ? `${attention} installed application${attention === 1 ? '' : 's'} stopped or ready to update.`
              : 'No stopped apps or available updates in the current app list.'}
          </p>
        ) : (
          <p>Waiting for application status.</p>
        )}
        {attention > 0 ? (
          <Link to="/apps" viewTransition>
            Review applications
          </Link>
        ) : null}
      </section>
    ),
  };

  return (
    <div className="workspace">
      <div className="workspace-heading">
        <div>
          <h1>{preferences.serverName}</h1>
          <p className="workspace-subline">{apps.data ? `${installed.length} installed · ${running} running` : 'Loading applications'}</p>
        </div>
        <div className="workspace-actions">
          <button
            type="button"
            className="workspace-edit-toggle"
            aria-expanded={editing}
            aria-controls="workspace-editor"
            onClick={() => setEditing(!editing)}
          >
            <IconAdjustmentsHorizontal size={18} aria-hidden="true" /> <span>{editing ? 'Done editing' : 'Edit workspace'}</span>
          </button>
          <Link to="/app-store" viewTransition className="workspace-add">
            <IconPlus size={18} aria-hidden="true" /> <span>Install an app</span>
          </Link>
        </div>
      </div>

      {editing ? (
        <section className="workspace-editor" id="workspace-editor" aria-labelledby="workspace-editor-title">
          <div className="workspace-editor-heading">
            <div>
              <h2 id="workspace-editor-title">Arrange widgets</h2>
              <p>Choose what appears, where it appears, and how much space it takes.</p>
            </div>
            <button
              type="button"
              onClick={() =>
                saveWorkspace({
                  ...workspace,
                  order: [...defaultDesktopPreferences.workspace.order],
                  hidden: [],
                  wide: [...defaultDesktopPreferences.workspace.wide],
                  pinnedApps: [...workspace.pinnedApps],
                })
              }
            >
              Restore layout
            </button>
          </div>
          <ol className="workspace-editor-list">
            {workspace.order.map((id, index) => (
              <li key={id}>
                <span className="workspace-editor-name">{labels[id]}</span>
                <div className="workspace-editor-controls">
                  <button type="button" onClick={() => move(id, -1)} disabled={index === 0} aria-label={`Move ${labels[id]} up`}>
                    Up
                  </button>
                  <button
                    type="button"
                    onClick={() => move(id, 1)}
                    disabled={index === workspace.order.length - 1}
                    aria-label={`Move ${labels[id]} down`}
                  >
                    Down
                  </button>
                  <button
                    type="button"
                    onClick={() => toggle(id, 'wide')}
                    aria-label={`${workspace.wide.includes(id) ? 'Make' : 'Expand'} ${labels[id]} ${workspace.wide.includes(id) ? 'standard width' : 'wide'}`}
                  >
                    {workspace.wide.includes(id) ? 'Standard' : 'Wide'}
                  </button>
                  <button
                    type="button"
                    onClick={() => toggle(id, 'hidden')}
                    aria-label={`${workspace.hidden.includes(id) ? 'Show' : 'Hide'} ${labels[id]}`}
                  >
                    {workspace.hidden.includes(id) ? 'Show' : 'Hide'}
                  </button>
                </div>
              </li>
            ))}
          </ol>
          <div className="workspace-pin-editor" id="workspace-pins">
            <div>
              <h3 ref={pinHeading} tabIndex={-1}>
                Home apps
              </h3>
              <p>Home shows three apps plus any additional pins. Choose up to 12 apps to keep first.</p>
            </div>
            <Switch
              label="Show all installed apps"
              checked={workspace.showAllApps}
              onCheckedChange={(showAllApps) => saveWorkspace({ ...workspace, showAllApps })}
              className="workspace-show-all"
            />
            {apps.isPending ? <p>Loading installed applications…</p> : null}
            {apps.isError ? <p role="alert">Applications could not be loaded. Pinning is unavailable right now.</p> : null}
            {apps.data && installed.length === 0 ? <p>Install an application to pin it here.</p> : null}
            {installed.length > 0 ? (
              <div className="workspace-pin-list">
                {installed.map(({ info }) => {
                  const pinned = workspace.pinnedApps.includes(info.urn);
                  return (
                    <button
                      key={info.urn}
                      type="button"
                      aria-pressed={pinned}
                      aria-label={`${pinned ? 'Unpin' : 'Pin'} ${info.name}`}
                      disabled={!pinned && workspace.pinnedApps.length >= 12}
                      onClick={() => togglePin(info.urn)}
                    >
                      <AppLogo urn={info.urn} size={28} alt="" />
                      <span>{info.name}</span>
                      <small>{pinned ? 'Pinned' : 'Pin'}</small>
                    </button>
                  );
                })}
              </div>
            ) : null}
            {missingPins.length > 0 ? (
              <button
                type="button"
                onClick={() => saveWorkspace({ ...workspace, pinnedApps: workspace.pinnedApps.filter((urn) => installedUrns.has(urn)) })}
              >
                Remove {missingPins.length} unavailable pin{missingPins.length === 1 ? '' : 's'}
              </button>
            ) : null}
          </div>
          <p className="workspace-editor-sync" role={syncState === 'error' ? 'alert' : undefined}>
            {syncState === 'saving'
              ? 'Saving layout…'
              : syncState === 'saved'
                ? 'Saved to your account.'
                : syncState === 'error'
                  ? 'Could not sync this layout. Changes may be lost after reload.'
                  : 'Layout is stored on this device until account sync finishes.'}
          </p>
        </section>
      ) : null}

      <div
        className="workspace-grid"
        data-more-apps={visibleInstalled.length > 3}
        data-default-layout={
          workspace.order.join(',') === 'applications,activity,storage,attention' &&
          workspace.hidden.length === 0 &&
          workspace.wide.length === 1 &&
          workspace.wide[0] === 'applications'
        }
      >
        {workspace.order
          .filter((id) => !workspace.hidden.includes(id))
          .map((id) => (
            <div className={`workspace-widget workspace-widget-${id} ${workspace.wide.includes(id) ? 'workspace-widget-wide' : ''}`} key={id}>
              {widgets[id]}
            </div>
          ))}
        {workspace.hidden.length === workspace.order.length ? (
          <div className="workspace-all-hidden">
            <strong>All widgets are hidden</strong>
            <p>Choose Edit workspace to show the views you want here.</p>
            {editing ? null : (
              <button type="button" onClick={() => setEditing(true)}>
                Edit workspace
              </button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
