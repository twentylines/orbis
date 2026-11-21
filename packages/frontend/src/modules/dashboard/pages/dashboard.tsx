import { getInstalledAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { AppLogo } from '@/components/app-logo/app-logo';
import { defaultDesktopPreferences, useDesktopPreferences, type WidgetId, type WorkspacePreferences } from '@/desktop/preferences';
import { useContainerTelemetry } from '@/desktop/containers';
import { DockerHealth } from '@/components/docker-health/docker-health';
import { useAppLauncher } from '@/desktop/app-launcher';
import { appDestinations } from '@/desktop/app-destinations';
import { appOpeningMode, primaryAppAddress } from '@/desktop/app-opening';
import { useBlockedAppEmbeds } from '@/desktop/app-embedding';
import { useWallpaperText } from '@/desktop/wallpaper-text';
import { useDesktopWindows } from '@/desktop/window-viewport';
import { AppTabIndicator } from '@/desktop/app-tab-indicator';
import { useAppContext } from '@/context/app-context';
import { useTasks, taskIsActive, taskLabels, taskStates } from '@/desktop/tasks';
import { IconApps, IconGripVertical, IconX, IconSettings, IconDownload, IconPencil, IconCheck } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router';
import './dashboard.css';
import { useCluster } from '@/desktop/cluster';
import { ClusterApps, ClusterOverview } from '@/desktop/cluster-views';

import { homeApps } from '@/desktop/workspace-apps';
import { useWorkspaceSortable } from '@/desktop/workspace-sortable';
import { prefersReducedMotion } from '@/desktop/motion-setting';
import { sectionMotionEasing } from '@/desktop/section-motion-geometry';
import { defaultWorkspaceLayout, mergeWorkspaceOrder, toolbarActionIds, workspaceEditingEvent } from '@/desktop/workspace-layout';
import './dashboard-editing.css';
import { ApplicationResize } from './application-resize';
import { DashboardEditing, ApplicationEditing } from './dashboard-editing';

import { HomeSystemStatus } from '../components/home-system-status';
import { HomeAttention } from '../components/home-attention';
import { HomeGreeting } from './home-greeting';
import './home-heading.css';

const labels: Record<WidgetId, string> = {
  applications: 'Applications',
  activity: 'System status',
  storage: 'Recent operations',
  attention: 'Needs attention',
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

function LocalDashboard({ focusOnMount = false }: { focusOnMount?: boolean }) {
  const openApp = useAppLauncher();
  const blockedEmbeds = useBlockedAppEmbeds();
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
  const workspaceElement = useRef<HTMLDivElement>(null);
  const editToggle = useRef<HTMLButtonElement>(null);
  const headingText = useWallpaperText<HTMLHeadingElement>();
  const setHeading = useCallback(
    (element: HTMLHeadingElement | null) => {
      heading.current = element;
      headingText(element);
    },
    [headingText],
  );
  useEffect(() => {
    if (focusOnMount) heading.current?.focus({ preventScroll: true });
  }, [focusOnMount]);
  const [editing, setEditing] = useState(false);
  const editorLayout = useRef(new Map<HTMLElement, { left: number; top: number }>());
  const editorAnimations = useRef<Animation[]>([]);
  const captureEditorLayout = useCallback(() => {
    editorLayout.current.clear();
    if (!prefersReducedMotion()) {
      for (const element of document.querySelectorAll<HTMLElement>(
        '.workspace-heading-copy, .workspace-grid, .workspace-edit-toggle, .desktop-system-bar .desktop-brand, .desktop-system-actions',
      )) {
        const { left, top } = element.getBoundingClientRect();
        editorLayout.current.set(element, { left, top });
      }
    }
    for (const animation of editorAnimations.current) animation.cancel();
    editorAnimations.current = [];
  }, []);
  const changeEditing = useCallback(
    (next: boolean) => {
      captureEditorLayout();
      setEditing(next);
      window.dispatchEvent(new CustomEvent(workspaceEditingEvent, { detail: next }));
    },
    [captureEditorLayout],
  );
  useLayoutEffect(() => {
    const before = new Map(editorLayout.current);
    editorLayout.current.clear();
    if (!prefersReducedMotion() && heading.current?.closest('.workspace')?.hasAttribute('data-editing') === editing) {
      for (const [element, old] of before) {
        if (!element.isConnected) continue;
        const next = element.getBoundingClientRect();
        const x = old.left - next.left;
        const y = old.top - next.top;
        if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) continue;
        const animation = element.animate([{ transform: `translate3d(${x}px, ${y}px, 0)` }, { transform: 'translate3d(0, 0, 0)' }], {
          duration: 320,
          easing: sectionMotionEasing,
          fill: 'both',
        });
        animation.id = 'orbis-home-editor-settle';
        editorAnimations.current.push(animation);
        void animation.finished.then(
          () => animation.cancel(),
          () => undefined,
        );
      }
    }
    return () => {
      for (const animation of editorAnimations.current) animation.cancel();
      editorAnimations.current = [];
    };
  }, [editing]);
  const hasEdited = useRef(false);
  const [appSearch, setAppSearch] = useState('');
  const [appChooserOpen, setAppChooserOpen] = useState(false);
  const roomy = useDesktopWindows();
  const [saveRequested, setSaveRequested] = useState(false);
  const [appRegion, setAppRegion] = useState<HTMLElement | null>(null);
  const [scrollApps, setScrollApps] = useState(false);
  const { preferences, update, syncState, workspaceCapabilities } = useDesktopPreferences();
  const { workspace } = preferences;
  const apps = useQuery({ ...getInstalledAppsOptions(), refetchInterval: 15000 });
  const containers = useContainerTelemetry();
  const tasks = useTasks();

  const { installed, visibleInstalled, running, attentionApps } = useMemo(() => {
    const installed = apps.data?.installed.filter(({ info }) => info.available) ?? [];
    return {
      installed,
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
  const unhealthy = new Set(
    (containers.data?.available && !containers.isError ? containers.data.containers : [])
      .filter((item) => item.health === 'unhealthy' && item.appUrn)
      .map((item) => item.appUrn),
  ).size;
  const activeTasks = tasks.data?.tasks.filter(taskIsActive) ?? [];

  const saveWorkspace = (next: WorkspacePreferences) => update({ workspace: next });
  const unpinApp = (urn: string) => {
    const position = appSort.order.indexOf(urn);
    saveWorkspace({ ...workspace, pinnedApps: workspace.pinnedApps.filter((pin) => pin !== urn) });
    requestAnimationFrame(() => {
      const entries = Array.from(workspaceElement.current?.querySelectorAll<HTMLElement>('.workspace-app-entry') ?? []);
      const surviving = entries.find((entry) => entry.dataset.sortableId === urn) ?? entries[Math.min(position, entries.length - 1)];
      (
        surviving?.querySelector<HTMLButtonElement>('.workspace-app-grip') ??
        workspaceElement.current?.querySelector<HTMLElement>('.workspace-app-chooser summary')
      )?.focus({ preventScroll: true });
    });
  };
  const hideWidget = (id: WidgetId) => {
    const position = orderedWidgets.indexOf(id);
    const next = orderedWidgets[position + 1] ?? orderedWidgets[position - 1] ?? orderedWidgets[0];
    saveWorkspace({ ...workspace, hidden: [...workspace.hidden, id] });
    requestAnimationFrame(() => {
      const target = next
        ? workspaceElement.current?.querySelector<HTMLButtonElement>(`.workspace-widget[data-sortable-id="${next}"] .workspace-drag-grip`)
        : null;
      (target ?? workspaceElement.current?.querySelector<HTMLElement>('.workspace-widget-chooser summary') ?? editToggle.current)?.focus({
        preventScroll: true,
      });
    });
  };

  const movableWidgets = workspace.order.filter((id) => !workspace.hidden.includes(id) && (!roomy || id !== 'activity'));
  const widgetSort = useWorkspaceSortable(
    movableWidgets,
    (order, moved) => {
      if (movableWidgets.includes(moved)) saveWorkspace({ ...workspace, order: mergeWorkspaceOrder(workspace.order, movableWidgets, order) });
    },
    editing,
    'swap',
  );
  const orderedWidgets = mergeWorkspaceOrder(movableWidgets, movableWidgets, widgetSort.order);
  const mainWidgets = orderedWidgets.filter((id) => id !== 'activity');
  const statusVisible = !workspace.hidden.includes('activity');
  const visibleAppIds = visibleInstalled.map(({ info }) => info.urn);
  const visibleAppById = new Map(visibleInstalled.map((entry) => [entry.info.urn, entry]));
  const appSort = useWorkspaceSortable(
    visibleAppIds,
    (ordered) => saveWorkspace({ ...workspace, pinnedApps: [...ordered, ...workspace.pinnedApps.filter((urn) => !ordered.includes(urn))] }),
    editing,
  );
  const layout = workspace.layout ?? defaultWorkspaceLayout;
  useLayoutEffect(
    () => () => {
      window.dispatchEvent(new CustomEvent(workspaceEditingEvent, { detail: false }));
    },
    [],
  );
  useEffect(() => {
    if (!saveRequested) return;
    if (syncState === 'saved' || syncState === 'local') {
      changeEditing(false);
      setSaveRequested(false);
      editToggle.current?.focus({ preventScroll: true });
    } else if (syncState === 'error') setSaveRequested(false);
  }, [saveRequested, syncState, changeEditing]);

  const finishEditing = () => {
    if (saveRequested) return;
    if (!editing) {
      hasEdited.current = true;
      setAppSearch('');
      setAppChooserOpen(false);
      editToggle.current?.focus({ preventScroll: true });
      return changeEditing(true);
    }
    setSaveRequested(true);
    if (syncState === 'error') saveWorkspace({ ...workspace });
  };
  useLayoutEffect(() => {
    const region = appRegion;
    if (!region) return;
    const measure = () => {
      setScrollApps(region.scrollHeight > region.clientHeight + 1);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(region);
    const list = region.querySelector('.workspace-app-list');
    if (list) observer.observe(list);
    measure();
    return () => observer.disconnect();
  }, [appRegion]);

  const widgets: Record<WidgetId, ReactNode> = {
    applications: (
      <section className="workspace-apps" aria-labelledby="workspace-apps-title">
        <div className="workspace-section-heading">
          <div className="workspace-app-heading-text">
            <h2 id="workspace-apps-title">Applications</h2>
            {apps.data ? (
              <p className="workspace-app-counts">
                <span>{installed.length} installed</span>
                <span>{running} running</span>
              </p>
            ) : null}
          </div>
          {editing ? null : (
            <div className="workspace-home-app-actions">
              <Link to="/apps">View all</Link>
            </div>
          )}
        </div>
        {editing ? (
          <ApplicationEditing
            workspace={workspace}
            capabilities={workspaceCapabilities}
            apps={installed}
            appsReady={apps.isSuccess}
            appsFailed={apps.isError}
            search={appSearch}
            setSearch={setAppSearch}
            chooserOpen={appChooserOpen}
            setChooserOpen={setAppChooserOpen}
            canResize={roomy}
            save={saveWorkspace}
          />
        ) : null}
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
          <div className="workspace-get-started">
            <IconDownload size={44} stroke={1.5} aria-hidden="true" />
            <div>
              <h3>Get started</h3>
              <p>Download apps from the store</p>
              <Link to="/app-store" className="workspace-store-link">
                Open Store
              </Link>
            </div>
          </div>
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
              {appSort.order.map((urn) => {
                const entry = visibleAppById.get(urn);
                if (!entry) return null;
                const { app, info, metadata } = entry;
                const [appId, storeId] = info.urn.split(':');
                const launchUrl = primaryAppAddress(
                  appDestinations({ app, info, metadata }, userSettings, window.location.hostname),
                  window.location.origin,
                );
                const appUpdate = Number(app.version) < Number(metadata.latestVersion) && app.ignoredVersion !== metadata.latestVersion;
                const tabOnly = Boolean(
                  launchUrl &&
                    (appOpeningMode(preferences.appLaunch, info.urn, launchUrl, window.location.origin, true) === 'tab' ||
                      blockedEmbeds[info.urn]?.url === launchUrl),
                );
                return (
                  <div className="workspace-app-entry" key={info.urn} {...appSort.itemProps(info.urn)}>
                    {editing ? (
                      <div className="workspace-app-editbar">
                        <button className="workspace-drag-grip workspace-app-grip" type="button" {...appSort.gripProps(info.urn, info.name)}>
                          <IconGripVertical size={18} aria-hidden="true" />
                        </button>
                        {workspace.pinnedApps.includes(info.urn) ? (
                          <button type="button" className="workspace-app-unpin" aria-label={`Unpin ${info.name}`} onClick={() => unpinApp(info.urn)}>
                            <IconX size={18} aria-hidden="true" />
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    <Link
                      draggable={false}
                      tabIndex={editing ? -1 : undefined}
                      to={launchUrl ?? `/apps/${storeId}/${appId}`}
                      target={launchUrl ? '_blank' : undefined}
                      rel={launchUrl ? 'noopener noreferrer' : undefined}
                      className="workspace-app"
                      title={info.name}
                      onClick={(event) => {
                        if (editing) {
                          event.preventDefault();
                          return;
                        }
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
                      aria-label={`${info.name}, ${app.status}${tabOnly ? ', opens in a new tab' : ''}${appUpdate ? ', update available' : ''}${workspace.pinnedApps.includes(info.urn) ? ', pinned' : ''}`}
                    >
                      <AppLogo urn={info.urn} size={54} alt="" />
                      <span className="workspace-app-copy">
                        <span className="workspace-app-title">
                          <strong title={info.name}>{info.name}</strong>
                          {tabOnly ? <AppTabIndicator /> : null}
                        </span>
                        {appUpdate ? <small>Update available</small> : null}
                        <DockerHealth summary appUrn={info.urn} telemetry={containers.data} stale={containers.isError} />
                      </span>
                    </Link>
                    {editing ? null : (
                      <Link
                        className="workspace-app-manage"
                        to={`/apps/${storeId}/${appId}`}
                        aria-label={`Manage ${info.name}`}
                        title={`Manage ${info.name}`}
                      >
                        <IconSettings size={17} aria-hidden="true" />
                      </Link>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}
      </section>
    ),
    activity: <HomeSystemStatus />,
    storage: (
      <section className="workspace-operations" aria-labelledby="workspace-operations-title">
        <div className="workspace-section-heading">
          <div>
            <h2 id="workspace-operations-title">Recent operations</h2>
            <p>{activeTasks.length ? `${activeTasks.length} in progress` : 'Application activity'}</p>
          </div>
          <Link to="/tasks">View all</Link>
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
      <HomeAttention
        apps={attentionApps.map(({ info, app }) => ({ urn: info.urn, id: info.id, name: info.name, stopped: app.status === 'stopped' }))}
        unhealthy={unhealthy}
        loading={apps.isPending}
        unavailable={apps.isError}
        healthUnavailable={containers.isError || containers.data?.available === false}
        healthPending={containers.isPending}
      />
    ),
  };

  const resetLayout = () => {
    hasEdited.current = true;
    changeEditing(false);
    setSaveRequested(false);
    editToggle.current?.focus({ preventScroll: true });
    update({
      toolbarOrder: [...toolbarActionIds],
      workspace: {
        ...workspace,
        order: [...defaultDesktopPreferences.workspace.order],
        hidden: [],
        wide: [...defaultDesktopPreferences.workspace.wide],
        layout: undefined,
      },
    });
  };
  const renderWidget = (id: WidgetId) => (
    <div
      className={`workspace-widget workspace-widget-${id}`}
      key={id}
      style={
        {
          ...(layout.widgets[id] ? { '--workspace-widget-height': `${layout.widgets[id]?.height}px` } : {}),
        } as CSSProperties
      }
      data-workspace-slot={workspace.order.indexOf(id)}
      {...(movableWidgets.includes(id) ? widgetSort.itemProps(id) : {})}
    >
      {editing ? (
        <div className="workspace-widget-editbar">
          {movableWidgets.includes(id) ? (
            <button className="workspace-drag-grip" type="button" {...widgetSort.gripProps(id, labels[id])}>
              <IconGripVertical size={18} aria-hidden="true" />
            </button>
          ) : null}
          <button className="workspace-widget-hide" type="button" aria-label={`Hide ${labels[id]}`} onClick={() => hideWidget(id)}>
            <IconX size={17} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      <div className="workspace-widget-content">{widgets[id]}</div>
      {editing && roomy && id === 'applications' && workspaceCapabilities?.workspaceLayout && !appChooserOpen ? (
        <ApplicationResize
          savedHeight={layout.widgets.applications?.height}
          save={(height) =>
            saveWorkspace({
              ...workspace,
              layout: { ...layout, widgets: { ...layout.widgets, applications: { columns: layout.widgets.applications?.columns ?? 4, height } } },
            })
          }
        />
      ) : null}
    </div>
  );

  return (
    <div
      className="workspace"
      ref={workspaceElement}
      data-startup-ready={!apps.isPending}
      data-editing={editing || undefined}
      data-arranged={hasEdited.current || undefined}
      data-app-view={layout.appView}
    >
      <div className="workspace-heading">
        <HomeGreeting headingRef={setHeading} focusable={focusOnMount} />
        <div className="workspace-actions">
          {editing ? (
            <button type="button" className="workspace-reset-layout" onClick={resetLayout}>
              Reset layout
            </button>
          ) : null}
          <div className="workspace-edit-controls">
            <button
              type="button"
              className="workspace-edit-toggle"
              title={editing ? (saveRequested ? 'Saving workspace' : 'Save workspace') : 'Edit workspace'}
              aria-label={editing ? (saveRequested ? 'Saving workspace' : 'Save workspace') : 'Edit workspace'}
              aria-pressed={editing}
              ref={editToggle}
              aria-expanded={editing}
              aria-controls={editing ? 'workspace-editor workspace-grid' : 'workspace-grid'}
              onClick={finishEditing}
              aria-disabled={saveRequested}
              aria-busy={saveRequested}
            >
              {editing ? <IconCheck size={20} aria-hidden="true" /> : <IconPencil size={20} aria-hidden="true" />}
            </button>
          </div>
        </div>
      </div>

      {editing ? <DashboardEditing workspace={workspace} capabilities={workspaceCapabilities} save={saveWorkspace} syncState={syncState} /> : null}

      <span className="visually-hidden" id="workspace-move-help">
        Drag a widget or toolbar control to move it. Keyboard: Space, arrows, Enter. Escape cancels.
      </span>
      <output className="visually-hidden" aria-live="polite" aria-atomic="true">
        {widgetSort.announcement}
      </output>
      <output className="visually-hidden" aria-live="polite" aria-atomic="true">
        {appSort.announcement}
      </output>

      <div className="workspace-grid" id="workspace-grid" data-side-status={roomy && statusVisible && mainWidgets.length > 0}>
        {roomy ? (
          <>
            {mainWidgets.length ? <div className="workspace-main-stack">{mainWidgets.map(renderWidget)}</div> : null}
            {statusVisible ? renderWidget('activity') : null}
          </>
        ) : (
          orderedWidgets.map(renderWidget)
        )}
        {workspace.hidden.length === workspace.order.length ? (
          <div className="workspace-all-hidden">
            <strong>All widgets are hidden</strong>
            <p>Show widgets in Edit workspace.</p>
            {editing ? null : (
              <button type="button" onClick={finishEditing}>
                Edit workspace
              </button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
