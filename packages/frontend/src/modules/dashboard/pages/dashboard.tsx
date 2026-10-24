import { getInstalledAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { AppLogo } from '@/components/app-logo/app-logo';
import { defaultDesktopPreferences, useDesktopPreferences, type WidgetId, type WorkspacePreferences } from '@/desktop/preferences';
import { loadTelemetry, telemetryQueryKey, type Telemetry } from '@/desktop/telemetry';
import { formatUptime } from '@/desktop/uptime';
import { useContainerTelemetry } from '@/desktop/containers';
import { DockerHealth } from '@/components/docker-health/docker-health';
import { ContainerResources } from '@/components/container-resources/container-resources';
import { useAppLauncher } from '@/desktop/app-launcher';
import { appDestinations } from '@/desktop/app-destinations';
import { primaryAppAddress } from '@/desktop/app-opening';
import { useAppContext } from '@/context/app-context';
import { Switch } from '@/components/ui/Switch';
import { useTasks, taskIsActive, taskLabels, taskStates } from '@/desktop/tasks';
import {
  IconAdjustmentsHorizontal,
  IconApps,
  IconArrowRight,
  IconArrowsDownUp,
  IconDeviceDesktopAnalytics,
  IconPin,
  IconClock,
  IconGripVertical,
  IconArrowUp,
  IconArrowDown,
  IconX,
  IconAlertCircle,
  IconSettings,
  IconDownload,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { WrapWords } from '@/components/wrap-words/wrap-words';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type DragEvent } from 'react';
import { Link } from 'react-router';
import './dashboard.css';
import { useCluster } from '@/desktop/cluster';
import { ClusterApps, ClusterOverview } from '@/desktop/cluster-views';

import { homeApps, maximumHomePins, moveHomePin, placeHomePin, workspaceRows } from '@/desktop/workspace-apps';
import { useHostReadings } from '../components/host-devices';
import { SystemGauges } from '../components/system-gauges';
import { statusBytes, statusNetwork } from '../components/system-readings';

const labels: Record<WidgetId, string> = {
  applications: 'Applications',
  activity: 'System status',
  storage: 'Recent operations',
  attention: 'Needs attention',
};

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

export default function Dashboard({ focusOnMount = false }: { focusOnMount?: boolean }) {
  const cluster = useCluster();
  if (cluster.merged || (cluster.selectedServer && !cluster.selectedServer.local))
    return (
      <div className="cluster-home">
        <ClusterOverview />
        <ClusterApps compact />
      </div>
    );
  return <LocalDashboard focusOnMount={focusOnMount} />;
}

function ReorderTools({
  name,
  index,
  count,
  move,
  remove,
}: {
  name: string;
  index: number;
  count: number;
  move: (direction: -1 | 1) => void;
  remove?: () => void;
}) {
  return (
    <div className="workspace-reorder-tools">
      <button type="button" disabled={index === 0} aria-label={`Move ${name} earlier`} onClick={() => move(-1)}>
        <IconArrowUp size={17} aria-hidden="true" />
      </button>
      <button type="button" disabled={index === count - 1} aria-label={`Move ${name} later`} onClick={() => move(1)}>
        <IconArrowDown size={17} aria-hidden="true" />
      </button>
      {remove ? (
        <button type="button" aria-label={`Unpin ${name}`} onClick={remove}>
          <IconX size={17} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

function LocalDashboard({ focusOnMount = false }: { focusOnMount?: boolean }) {
  const openApp = useAppLauncher();
  const { userSettings, user } = useAppContext();
  const startedKey = `orbis-home-started-v1:${user.id}`;
  const [hasStarted, setHasStarted] = useState(() => {
    try {
      return localStorage.getItem(startedKey) === '1';
    } catch {
      return false;
    }
  });
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusOnMount) heading.current?.focus({ preventScroll: true });
  }, [focusOnMount]);
  const [editing, setEditing] = useState(false);
  const [dragged, setDragged] = useState<{ kind: 'pin' | 'widget'; id: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [arrangeAnnouncement, setArrangeAnnouncement] = useState('');
  const [saveRequested, setSaveRequested] = useState(false);
  const [appRegion, setAppRegion] = useState<HTMLElement | null>(null);
  const [scrollApps, setScrollApps] = useState(false);
  const { preferences, update, syncState } = useDesktopPreferences();
  const { workspace } = preferences;
  const longServerName = preferences.serverName.length > 16 || preferences.serverName.split(/\s+/).some((word) => word.length > 7);
  const apps = useQuery({ ...getInstalledAppsOptions(), refetchInterval: 15000 });
  const host = useHostReadings();
  const containers = useContainerTelemetry();
  const tasks = useTasks();
  const system = useQuery<Telemetry>({
    queryKey: telemetryQueryKey,
    queryFn: ({ signal }) => loadTelemetry(signal),
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  });
  const { installed, installedUrns, missingPins, visibleInstalled, running, attentionApps } = useMemo(() => {
    const installed = apps.data?.installed.filter(({ info }) => info.available) ?? [];
    const installedUrns = new Set(installed.map(({ info }) => info.urn));
    return {
      installed,
      installedUrns,
      missingPins: workspace.pinnedApps.filter((urn) => !installedUrns.has(urn)),
      visibleInstalled: homeApps(installed, workspace.pinnedApps, workspace.showAllApps),
      running: installed.filter(({ app }) => app.status === 'running').length,
      attentionApps: installed.filter(
        ({ app, metadata }) =>
          app.status === 'stopped' || (Number(app.version) < Number(metadata.latestVersion) && app.ignoredVersion !== metadata.latestVersion),
      ),
    };
  }, [apps.data, workspace.pinnedApps, workspace.showAllApps]);
  const usedHome = (apps.data?.installed.length ?? 0) > 0 || (tasks.data?.tasks.length ?? 0) > 0;
  const checkingFirstHome = apps.data?.installed.length === 0 && !hasStarted && !usedHome && tasks.isPending;
  useEffect(() => {
    if (!usedHome || hasStarted) return;
    setHasStarted(true);
    try {
      localStorage.setItem(startedKey, '1');
    } catch {
      // Installed apps and task history still suppress the first-run card when storage is unavailable.
    }
  }, [usedHome, hasStarted, startedKey]);
  const attention = attentionApps.length;
  const unhealthy = new Set(containers.data?.containers.filter((item) => item.health === 'unhealthy' && item.appUrn).map((item) => item.appUrn)).size;
  const activeTasks = tasks.data?.tasks.filter(taskIsActive) ?? [];
  const currentHost = host.data?.available && !host.data.stale && !host.isError ? host.data : null;
  const hostDisk = currentHost?.filesystems.find((filesystem) => filesystem.mount === '/');
  const disk = hostDisk ?? system.data?.filesystems.find((filesystem) => filesystem.mount === '/') ?? system.data?.filesystems[0];
  const diskLabel = hostDisk ? 'Storage' : 'Core storage';
  const memoryTotal = system.data?.memory.totalBytes;
  const memoryFree = system.data?.memory.availableBytes;
  const memoryAvailable =
    typeof memoryTotal === 'number' &&
    Number.isFinite(memoryTotal) &&
    memoryTotal > 0 &&
    typeof memoryFree === 'number' &&
    Number.isFinite(memoryFree) &&
    memoryFree >= 0 &&
    memoryFree <= memoryTotal;
  const memoryUsed = memoryAvailable ? memoryTotal - memoryFree : null;
  const cpuPercent = system.data?.cpu.totalPercent;
  const network = statusNetwork(host.isError ? undefined : host.data, system.data);

  const saveWorkspace = (next: WorkspacePreferences) => update({ workspace: next });
  const move = (id: WidgetId, direction: -1 | 1) => {
    const order = moveHomePin(workspace.order, id, direction);
    if (order === workspace.order) return;
    saveWorkspace({ ...workspace, order });
    setArrangeAnnouncement(`${labels[id]} moved to position ${order.indexOf(id) + 1}.`);
  };
  const toggle = (id: WidgetId, field: 'hidden' | 'wide') => {
    const current = workspace[field];
    saveWorkspace({ ...workspace, [field]: current.includes(id) ? current.filter((item) => item !== id) : [...current, id] });
  };
  const togglePin = (urn: string) => {
    const current = workspace.pinnedApps;
    if (!current.includes(urn) && current.length >= maximumHomePins) return;
    saveWorkspace({ ...workspace, pinnedApps: current.includes(urn) ? current.filter((item) => item !== urn) : [...current, urn] });
  };

  const savePinOrder = (pins: string[], moved: string) => {
    if (pins === workspace.pinnedApps) return;
    saveWorkspace({ ...workspace, pinnedApps: pins });
    const name = installed.find(({ info }) => info.urn === moved)?.info.name ?? moved;
    setArrangeAnnouncement(`${name} moved to position ${pins.indexOf(moved) + 1}.`);
  };
  useEffect(() => {
    if (!saveRequested) return;
    if (syncState === 'saved' || syncState === 'local') {
      setEditing(false);
      setSaveRequested(false);
    } else if (syncState === 'error') setSaveRequested(false);
  }, [saveRequested, syncState]);

  const finishEditing = () => {
    if (saveRequested) return;
    if (!editing) return setEditing(true);
    setSaveRequested(true);
    if (syncState === 'error') saveWorkspace({ ...workspace });
  };
  const startDrag = (event: DragEvent<HTMLElement>, kind: 'pin' | 'widget', id: string) => {
    event.dataTransfer.setData(`application/x-orbis-${kind}`, id);
    event.dataTransfer.effectAllowed = 'move';
    const card = event.currentTarget.closest('li');
    if (card) event.dataTransfer.setDragImage(card, card.clientWidth / 2, 28);
    setDragged({ kind, id });
  };
  const finishDrag = () => {
    setDragged(null);
    setDropTarget(null);
  };
  const dropEvents = (kind: 'pin' | 'widget', before: string | null) => ({
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes(`application/x-orbis-${kind}`)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setDropTarget(`${kind}:${before ?? 'end'}`);
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropTarget(null);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      const source = event.dataTransfer.getData(`application/x-orbis-${kind}`);
      if (!source) return;
      event.preventDefault();
      if (kind === 'pin') savePinOrder(placeHomePin(workspace.pinnedApps, source, before), source);
      else {
        const id = workspace.order.find((id) => id === source);
        const target = before === null ? null : workspace.order.find((id) => id === before);
        if (id && target !== undefined) {
          const order = placeHomePin(workspace.order, id, target);
          if (order !== workspace.order) {
            saveWorkspace({ ...workspace, order });
            setArrangeAnnouncement(`${labels[id]} moved to position ${order.indexOf(id) + 1}.`);
          }
        }
      }
      finishDrag();
    },
  });
  const defaultColumns =
    workspace.order.join(',') === 'applications,activity,storage,attention' && workspace.wide.length === 1 && workspace.wide[0] === 'applications';
  useLayoutEffect(() => {
    const region = appRegion;
    if (!region || visibleInstalled.length === 0 || workspace.hidden.includes('applications')) return;
    const desktop = window.matchMedia('(min-width: 760px) and (min-height: 640px)');
    const auxiliary = defaultColumns ? region.closest('.workspace-main-stack')?.querySelector<HTMLElement>('.workspace-auxiliary') : null;
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (!desktop.matches) {
        region.style.removeProperty('--workspace-app-max-height');
        auxiliary?.style.removeProperty('--workspace-auxiliary-max-height');
        setScrollApps(false);
        return;
      }
      const dock = document.querySelector<HTMLElement>('.desktop-dock');
      const dockSpace = editing ? 0 : dock ? dock.getBoundingClientRect().height + (Number.parseFloat(getComputedStyle(dock).bottom) || 0) : 96;
      const top = region.getBoundingClientRect().top + window.scrollY;
      const budget = Math.max(0, window.innerHeight - top - dockSpace - 24);
      const list = region.querySelector<HTMLElement>('.workspace-app-list');
      const firstApp = list?.querySelector<HTMLElement>('.workspace-app');
      const rowGap = list ? Number.parseFloat(getComputedStyle(list).rowGap) || 0 : 0;
      const minimumApps = firstApp && list ? Math.min(list.scrollHeight + 8, firstApp.offsetHeight * 3 + rowGap * 2 + 8) : 160;
      const auxiliaryLimit = Math.max(240, budget - minimumApps - 18);
      const auxiliaryHeight = auxiliary ? Math.max(0, ...Array.from(auxiliary.children, (widget) => widget.firstElementChild?.scrollHeight ?? 0)) : 0;
      const auxiliarySpace = auxiliaryHeight > 0 ? Math.min(auxiliaryHeight + 2, auxiliaryLimit) + 18 : 0;
      const available = Math.max(minimumApps, Math.floor(budget - auxiliarySpace));
      auxiliary?.style.setProperty('--workspace-auxiliary-max-height', `${Math.floor(auxiliaryLimit)}px`);
      region.style.setProperty('--workspace-app-max-height', `${available}px`);
      setScrollApps(region.scrollHeight > region.clientHeight + 1);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    const targets = [
      region.querySelector('.workspace-app-list'),
      region.closest('.workspace-apps')?.querySelector('.workspace-section-heading'),
      region.closest('.workspace')?.querySelector('.workspace-heading'),
      region.closest('.workspace-main-stack')?.querySelector('.workspace-auxiliary'),
      document.querySelector('.desktop-dock'),
    ];
    for (const target of targets) if (target) observer.observe(target);
    window.addEventListener('resize', schedule);
    desktop.addEventListener('change', schedule);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      desktop.removeEventListener('change', schedule);
      cancelAnimationFrame(frame);
      auxiliary?.style.removeProperty('--workspace-auxiliary-max-height');
    };
  }, [appRegion, editing, visibleInstalled.length, defaultColumns, workspace.hidden]);

  useLayoutEffect(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    const card = active.closest<HTMLElement>('[data-arrange-kind]');
    if (!card) return;
    const present =
      card.dataset.arrangeKind === 'pin'
        ? workspace.pinnedApps.includes(card.dataset.arrangeId ?? '')
        : workspace.order.some((id) => id === card.dataset.arrangeId);
    if (present) active.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }, [workspace.pinnedApps, workspace.order]);
  const widgets: Record<WidgetId, ReactNode> = {
    applications: (
      <section className="workspace-apps" aria-labelledby="workspace-apps-title">
        <div className="workspace-section-heading">
          <div>
            <h2 id="workspace-apps-title">Applications</h2>
          </div>
          <div className="workspace-home-app-actions">
            <Link to="/apps">
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
        {checkingFirstHome ? (
          <div className="workspace-empty" aria-busy="true">
            <span className="visually-hidden">Loading your workspace</span>
          </div>
        ) : null}
        {apps.data && apps.data.installed.length === 0 && !hasStarted && !usedHome && tasks.isSuccess ? (
          <Link to="/app-store" className="workspace-get-started">
            <IconDownload size={44} stroke={1.5} aria-hidden="true" />
            <div>
              <h3>Get started</h3>
              <p>Download apps from the store</p>
              <span>
                Open Store <IconArrowRight size={18} aria-hidden="true" />
              </span>
            </div>
          </Link>
        ) : apps.data && installed.length === 0 && !checkingFirstHome ? (
          <div className="workspace-empty">
            <IconApps size={28} stroke={1.5} aria-hidden="true" />
            <strong>No apps installed</strong>
            <p>Install an app from the App Store.</p>
            <Link to="/app-store">Open App Store</Link>
          </div>
        ) : null}
        {installed.length > 0 ? (
          <section
            className="workspace-app-scroll"
            ref={setAppRegion}
            data-scroll={scrollApps}
            aria-label="Installed applications"
            tabIndex={scrollApps ? 0 : undefined}
          >
            <div className="workspace-app-list">
              {visibleInstalled.map(({ app, info, metadata }) => {
                const [appId, storeId] = info.urn.split(':');
                const launchUrl = primaryAppAddress(
                  appDestinations({ app, info, metadata }, userSettings, window.location.hostname),
                  window.location.origin,
                );
                const appUpdate = Number(app.version) < Number(metadata.latestVersion) && app.ignoredVersion !== metadata.latestVersion;
                return (
                  <div className="workspace-app-entry" key={info.urn}>
                    <Link
                      draggable={false}
                      to={launchUrl ?? `/apps/${storeId}/${appId}`}
                      target={launchUrl ? '_blank' : undefined}
                      rel={launchUrl ? 'noopener noreferrer' : undefined}
                      className="workspace-app"
                      onClick={(event) => {
                        if (
                          !event.metaKey &&
                          !event.ctrlKey &&
                          !event.shiftKey &&
                          !event.altKey &&
                          event.button === 0 &&
                          openApp({ ...info, launchUrl })
                        )
                          event.preventDefault();
                      }}
                      aria-label={`${info.name}, ${app.status}${appUpdate ? ', update available' : ''}${workspace.pinnedApps.includes(info.urn) ? ', pinned' : ''}`}
                    >
                      <AppLogo urn={info.urn} size={54} alt="" />
                      <span className="workspace-app-copy">
                        <strong title={info.name}>{info.name}</strong>
                        {appUpdate ? <small>Update available</small> : null}
                        <DockerHealth appUrn={info.urn} telemetry={containers.data} stale={containers.isError} />
                      </span>
                    </Link>
                    <Link
                      className="workspace-app-manage"
                      to={`/apps/${storeId}/${appId}`}
                      aria-label={`Manage ${info.name}`}
                      title={`Manage ${info.name}`}
                    >
                      <IconSettings size={17} aria-hidden="true" />
                    </Link>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}
      </section>
    ),
    activity: (
      <section className="workspace-activity" aria-labelledby="workspace-activity-title">
        <div className="workspace-section-heading">
          <div>
            <h2 id="workspace-activity-title">System status</h2>
          </div>
          <Link to="/monitor" aria-label="Expand System status">
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
            <SystemGauges
              cpu={cpuPercent ?? null}
              clockGHz={system.data?.cpu.reportedClockGHz}
              memoryUsed={memoryUsed}
              memoryTotal={memoryAvailable ? memoryTotal : null}
              diskUsed={disk?.usedBytes ?? null}
              diskTotal={disk?.sizeBytes ?? null}
              diskLabel={diskLabel}
            />
            <div className="workspace-uptime">
              <span>
                <IconClock size={18} aria-hidden="true" /> Uptime
              </span>
              <strong>{system.data ? formatUptime(system.data.cpu.uptimeSeconds) : '—'}</strong>
            </div>
            <section className="workspace-network" aria-label={network?.label ?? 'Network'}>
              <span className="workspace-network-heading">
                <IconArrowsDownUp size={17} aria-hidden="true" /> {network?.label ?? 'Network'}
              </span>
              {network ? (
                <strong className="workspace-network-interface" title={network.interface}>
                  {network.interface}
                  {network.speedMbps !== null ? (
                    <small>{network.speedMbps >= 1000 ? `${(network.speedMbps / 1000).toFixed(1)} Gbps` : `${network.speedMbps} Mbps`} link</small>
                  ) : null}
                </strong>
              ) : null}
              <div className="workspace-network-direction">
                <small>Download</small>
                <strong className="workspace-network-rate">{rate(network?.rxBytesPerSecond ?? null)}</strong>
                {network ? <small>{statusBytes(network.receivedBytes)} received</small> : null}
              </div>
              <div className="workspace-network-direction">
                <small>Upload</small>
                <strong className="workspace-network-rate">{rate(network?.txBytesPerSecond ?? null)}</strong>
                {network ? <small>{statusBytes(network.transmittedBytes)} sent</small> : null}
              </div>
            </section>
          </div>
        )}
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
          <Link to="/tasks">
            View all <IconArrowRight size={18} aria-hidden="true" />
          </Link>
        </div>
        {tasks.isError ? (
          <p role="alert">Operation history is unavailable.</p>
        ) : tasks.isPending ? (
          <p>Loading operations…</p>
        ) : tasks.data?.tasks.length ? (
          <ol className="workspace-recent-tasks">
            {tasks.data.tasks.slice(0, 6).map((task) => {
              const name = installed.find(({ info }) => info.urn === task.appUrn)?.info.name ?? task.displayName ?? task.appUrn.split(':')[0];
              const title = `${taskLabels[task.action]} ${name}`;
              const time = new Date(task.updatedAt).toLocaleTimeString();
              return (
                <li key={task.id}>
                  <Link to="/tasks" aria-label={`${title}, ${taskStates[task.status]}, ${time}`} title={title}>
                    <span>
                      <strong>
                        {taskLabels[task.action]} <span className="workspace-recent-app-name">{name}</span>
                      </strong>
                      <small>{time}</small>
                    </span>
                    <b data-status={task.status}>{taskStates[task.status]}</b>
                  </Link>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="workspace-operations-empty">No recent operations.</p>
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
              : 'No stopped apps or available updates.'}
          </p>
        ) : (
          <p>Waiting for application status.</p>
        )}
        {attention > 0 ? (
          <>
            <ul className="workspace-attention-apps">
              {attentionApps.slice(0, 6).map(({ info, app }) => (
                <li key={info.urn}>
                  <Link to={`/apps/${encodeURIComponent(info.urn.split(':')[1] ?? '')}/${encodeURIComponent(info.id)}`}>
                    <span title={info.name}>{info.name}</span>
                    <small>{app.status === 'stopped' ? 'Stopped' : 'Update available'}</small>
                  </Link>
                </li>
              ))}
            </ul>
            <Link to="/apps">Review applications</Link>
          </>
        ) : null}
      </section>
    ),
  };

  return (
    <div className="workspace">
      <div className="workspace-heading">
        <div>
          <h1
            ref={heading}
            tabIndex={focusOnMount ? -1 : undefined}
            data-long-name={longServerName}
            title={preferences.serverName}
            aria-label={preferences.serverName}
          >
            <WrapWords text={preferences.serverName} />
          </h1>
          <p className="workspace-subline">{apps.data ? `${installed.length} installed · ${running} running` : 'Loading applications'}</p>
        </div>
        <div className="workspace-actions">
          <button
            type="button"
            className="workspace-edit-toggle"
            aria-expanded={editing}
            aria-controls="workspace-editor"
            onClick={finishEditing}
            aria-disabled={saveRequested}
            aria-busy={saveRequested}
          >
            <IconAdjustmentsHorizontal size={18} aria-hidden="true" />{' '}
            <span>{editing ? (saveRequested ? 'Saving…' : 'Save') : 'Edit workspace'}</span>
          </button>
        </div>
      </div>

      {editing ? (
        <section className="workspace-editor" id="workspace-editor" aria-labelledby="workspace-editor-title">
          <div className="workspace-editor-heading">
            <div>
              <h2 id="workspace-editor-title">Edit workspace</h2>
              <p id="workspace-arrange-help">Drag a grip to move a card before another. Use the arrow buttons on a keyboard or touch screen.</p>
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
          <h3 className="workspace-editor-section-title">Widgets</h3>
          <ol className="workspace-editor-list" aria-label="Widget order">
            {workspace.order.map((id, index) => {
              const Icon = { applications: IconApps, activity: IconDeviceDesktopAnalytics, storage: IconClock, attention: IconAlertCircle }[id];
              return (
                <li
                  key={id}
                  data-arrange-kind="widget"
                  data-arrange-id={id}
                  data-dragging={dragged?.kind === 'widget' && dragged.id === id}
                  data-drop={dropTarget === `widget:${id}`}
                  {...dropEvents('widget', id)}
                >
                  <div className="workspace-arrange-card-heading">
                    <button
                      className="workspace-drag-grip"
                      type="button"
                      draggable
                      aria-label={`Drag ${labels[id]}`}
                      aria-describedby="workspace-arrange-help"
                      onDragStart={(event) => startDrag(event, 'widget', id)}
                      onDragEnd={finishDrag}
                    >
                      <IconGripVertical size={18} aria-hidden="true" />
                    </button>
                    <span className="workspace-arrange-position">{index + 1}</span>
                  </div>
                  <div className="workspace-widget-preview" aria-hidden="true">
                    <Icon size={30} />
                    <i />
                    <i />
                  </div>
                  <strong className="workspace-editor-name">{labels[id]}</strong>
                  <Switch
                    label={
                      <>
                        <span aria-hidden="true">Visible</span>
                        <span className="visually-hidden">Show {labels[id]}</span>
                      </>
                    }
                    checked={!workspace.hidden.includes(id)}
                    onCheckedChange={() => toggle(id, 'hidden')}
                  />
                  <div className="workspace-arrange-card-footer">
                    <ReorderTools name={labels[id]} index={index} count={workspace.order.length} move={(direction) => move(id, direction)} />
                    <button
                      type="button"
                      className="workspace-width-toggle"
                      aria-pressed={workspace.wide.includes(id)}
                      onClick={() => toggle(id, 'wide')}
                      aria-label={`Wide ${labels[id]}`}
                    >
                      Wide
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
          <div
            className="workspace-drop-end"
            data-active={dragged?.kind === 'widget'}
            data-drop={dropTarget === 'widget:end'}
            {...dropEvents('widget', null)}
          >
            Move widget to end
          </div>
          <div className="workspace-pin-editor" id="workspace-pins">
            <div>
              <h3>Home apps</h3>
              <p>Choose apps, then arrange their icons in the order you want on Home.</p>
            </div>
            <Switch
              label="Show all installed apps"
              checked={workspace.showAllApps}
              onCheckedChange={(showAllApps) => saveWorkspace({ ...workspace, showAllApps })}
              className="workspace-show-all"
            />
            {apps.isPending ? <p>Loading installed applications…</p> : null}
            {apps.isError ? <p role="alert">Applications could not be loaded. Pinning is unavailable right now.</p> : null}
            {apps.data && installed.length === 0 ? <p>Install an app before pinning it.</p> : null}
            {workspace.pinnedApps.length ? (
              <>
                <ol className="workspace-pin-order" aria-label="Home app order">
                  {workspace.pinnedApps.map((urn, index) => {
                    const entry = installed.find(({ info }) => info.urn === urn);
                    const name = entry?.info.name ?? urn;
                    return (
                      <li
                        key={urn}
                        data-arrange-kind="pin"
                        data-arrange-id={urn}
                        data-dragging={dragged?.kind === 'pin' && dragged.id === urn}
                        data-drop={dropTarget === `pin:${urn}`}
                        {...dropEvents('pin', urn)}
                      >
                        <div className="workspace-arrange-card-heading">
                          <button
                            className="workspace-drag-grip"
                            type="button"
                            draggable
                            aria-label={`Drag ${name}`}
                            aria-describedby="workspace-arrange-help"
                            onDragStart={(event) => startDrag(event, 'pin', urn)}
                            onDragEnd={finishDrag}
                          >
                            <IconGripVertical size={18} aria-hidden="true" />
                          </button>
                          <span className="workspace-arrange-position">{index + 1}</span>
                        </div>
                        <AppLogo urn={urn} size={44} alt="" />
                        <span className="workspace-pin-order-name" title={name}>
                          {name}
                          {entry ? null : <small>Unavailable</small>}
                        </span>
                        <ReorderTools
                          name={name}
                          index={index}
                          count={workspace.pinnedApps.length}
                          move={(direction) => savePinOrder(moveHomePin(workspace.pinnedApps, urn, direction), urn)}
                          remove={() => togglePin(urn)}
                        />
                      </li>
                    );
                  })}
                </ol>
                <div
                  className="workspace-drop-end"
                  data-active={dragged?.kind === 'pin'}
                  data-drop={dropTarget === 'pin:end'}
                  {...dropEvents('pin', null)}
                >
                  Move app to end
                </div>
              </>
            ) : null}
            {installed.length > 0 ? (
              <details className="workspace-app-chooser">
                <summary>Add apps</summary>
                <div className="workspace-pin-list">
                  {installed
                    .filter(({ info }) => !workspace.pinnedApps.includes(info.urn))
                    .map(({ info }) => {
                      const pinned = workspace.pinnedApps.includes(info.urn);
                      return (
                        <button
                          key={info.urn}
                          type="button"
                          aria-pressed={pinned}
                          aria-label={`${pinned ? 'Unpin' : 'Pin'} ${info.name}`}
                          disabled={!pinned && workspace.pinnedApps.length >= maximumHomePins}
                          onClick={() => togglePin(info.urn)}
                        >
                          <AppLogo urn={info.urn} size={28} alt="" />
                          <span>{info.name}</span>
                          <IconPin size={16} aria-hidden="true" />
                        </button>
                      );
                    })}
                </div>
                {installed.every(({ info }) => workspace.pinnedApps.includes(info.urn)) ? <p>All installed apps are on Home.</p> : null}
              </details>
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
          <output className="visually-hidden">{arrangeAnnouncement}</output>
          <p className="workspace-editor-sync" role={syncState === 'error' ? 'alert' : undefined}>
            {syncState === 'saving'
              ? 'Saving layout…'
              : syncState === 'saved'
                ? 'Saved to your account.'
                : syncState === 'error'
                  ? 'Could not save this layout. Select Save to retry.'
                  : 'Layout is stored on this device until account sync finishes.'}
          </p>
        </section>
      ) : null}

      <div
        className="workspace-grid"
        data-default-columns={defaultColumns}
        data-status-visible={!workspace.hidden.includes('activity')}
        data-main-visible={['applications', 'storage', 'attention'].some((id) => !workspace.hidden.includes(id as WidgetId))}
      >
        {defaultColumns ? (
          <>
            {['applications', 'storage', 'attention'].some((id) => !workspace.hidden.includes(id as WidgetId)) ? (
              <div className="workspace-main-stack">
                {workspace.hidden.includes('applications') ? null : (
                  <div className="workspace-widget workspace-widget-applications">{widgets.applications}</div>
                )}
                <div className="workspace-auxiliary">
                  {(['storage', 'attention'] as const)
                    .filter((id) => !workspace.hidden.includes(id))
                    .map((id) => (
                      <div className={`workspace-widget workspace-widget-${id}`} key={id}>
                        {widgets[id]}
                      </div>
                    ))}
                </div>
              </div>
            ) : null}
            {workspace.hidden.includes('activity') ? null : <div className="workspace-widget workspace-widget-activity">{widgets.activity}</div>}
          </>
        ) : (
          workspaceRows(
            workspace.order.filter((id) => !workspace.hidden.includes(id)),
            workspace.wide,
          ).map((row) => (
            <div className="workspace-custom-row" key={row.join(',')}>
              {row.map((id) => (
                <div className={`workspace-widget workspace-widget-${id} ${workspace.wide.includes(id) ? 'workspace-widget-wide' : ''}`} key={id}>
                  {widgets[id]}
                </div>
              ))}
            </div>
          ))
        )}
        {workspace.hidden.length === workspace.order.length ? (
          <div className="workspace-all-hidden">
            <strong>All widgets are hidden</strong>
            <p>Show widgets in Edit workspace.</p>
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
