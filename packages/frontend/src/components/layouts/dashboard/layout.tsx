import { StartupSurface } from '@/components/startup/startup-surface';
import { OrbisLogo } from '@/components/orbis-logo/orbis-logo';
import { animateSessionExit, rememberLogout } from '@/desktop/session-motion';
import toast from 'react-hot-toast';
import { useReducedMotion } from '@/desktop/motion-preferences';
import { logout } from '@/api-client';
import { useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { PageTitle } from '@/components/page-title/page-title';
import { useDesktopPreferences } from '@/desktop/preferences';
import { DesktopWallpaper } from '@/desktop/wallpaper';
import { useTasks, taskIsActive } from '@/desktop/tasks';
import { CommandSearch } from '@/desktop/command-search';
import { desktopNavigation as navigation } from '@/desktop/navigation';
import { useSectionMotion } from '@/desktop/section-motion';
import { RouteSurface } from '@/desktop/route-surface';
import { DelayedRouteLoading } from '@/desktop/route-loading';
import { AppLauncherProvider, MinimizedApps } from '@/desktop/app-launcher';
import { HostUpdateProvider, useHostUpdateWatch } from '@/desktop/host-update-watch';
import { coreWatchIsActive, coreUpdateTitle } from '@/desktop/core-update-state';
import { prefersReducedMotion } from '@/desktop/motion-setting';
import { ErrorBoundary } from 'react-error-boundary';
import { Button } from '@/components/ui/Button';
import { DockActivity } from '@/desktop/desktop-activity';
import { DockGlass } from '@/desktop/dock-companion';
import { DockSelection } from '@/desktop/dock-selection';
import { useNavigationWarmup } from '@/desktop/navigation-warmup';
import { OrbisUpdateNotice } from '@/desktop/orbis-update-notice';
import { revealPageFocus } from '@/desktop/window-viewport';
import { ClusterConnection, ClusterProvider, ClusterServerLabel, ClusterSwitcher } from '@/desktop/cluster';
import { IconLogout, IconMoon, IconSun, IconActivity } from '@tabler/icons-react';
import { useIsMutating, QueryErrorResetBoundary } from '@tanstack/react-query';
import { lazy, Suspense, useLayoutEffect, useRef, useState, type PropsWithChildren } from 'react';
import { Link, useLocation, useMatches, useNavigation } from 'react-router';
import './layout.css';

const Welcome = lazy(() => import('@/components/welcome/welcome').then((module) => ({ default: module.Welcome })));

export const DashboardLayoutSuspense = () => {
  const { setWorkspaceLoading } = useDesktopPreferences();
  useLayoutEffect(() => {
    setWorkspaceLoading(true);
    return () => setWorkspaceLoading(false);
  }, [setWorkspaceLoading]);
  return null;
};

export const DashboardLayout = ({ children }: PropsWithChildren) => {
  const { userSettings, apps } = useAppContext();
  const { isLoggedIn } = useUserContext();
  const { preferences, resolvedMode, update, requiresOnboarding } = useDesktopPreferences();
  const location = useLocation();
  const matches = useMatches();
  const routeNavigation = useNavigation();
  const [loggingOff, setLoggingOff] = useState(false);
  const leaving = useRef(false);
  const desktop = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const dock = useRef<HTMLElement>(null);
  const warmNavigation = useNavigationWarmup();
  useLayoutEffect(() => {
    if (requiresOnboarding) return;
    const element = dock.current;
    if (!element) return;
    const root = document.documentElement;
    const property = '--orbis-dock-height';
    const previous = root.style.getPropertyValue(property);
    const bar = document.querySelector<HTMLElement>('.desktop-system-bar');
    const barProperty = '--orbis-bar-bottom';
    const previousBar = root.style.getPropertyValue(barProperty);
    const measure = () => {
      if (element.offsetHeight) root.style.setProperty(property, `${element.offsetHeight}px`);
      if (bar?.offsetHeight) root.style.setProperty(barProperty, `${Math.ceil(Number.parseFloat(getComputedStyle(bar).top) + bar.offsetHeight)}px`);
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.closest('#desktop-content')) revealPageFocus(active);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (bar) observer.observe(bar);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      if (previous) root.style.setProperty(property, previous);
      else root.style.removeProperty(property);
      if (previousBar) root.style.setProperty(barProperty, previousBar);
      else root.style.removeProperty(barProperty);
    };
  }, [requiresOnboarding]);
  const hasPageHeading = matches.some((match) =>
    ['app-details', 'app-details-store', 'custom-app', 'cluster-app-preview', 'app-update', 'app-store-app-update'].includes(match.id),
  );
  useSectionMotion(!requiresOnboarding);
  const busy = useIsMutating();
  const tasks = useTasks();
  const activeTasks = tasks.data?.tasks.filter(taskIsActive).length ?? 0;
  const handleLogout = async () => {
    if (leaving.current) return;
    leaving.current = true;
    toast.dismiss();
    setLoggingOff(true);
    rememberLogout(true);
    const exit = animateSessionExit(desktop.current, Boolean(reduceMotion));
    try {
      await Promise.all([logout({ throwOnError: true }), exit.finished]);
      rememberLogout(true);
      window.location.replace('/login');
    } catch {
      exit.cancel();
      rememberLogout(false);
      leaving.current = false;
      setLoggingOff(false);
      toast.error('Unable to log out. Try again.');
    }
  };

  if (requiresOnboarding)
    return (
      <Suspense fallback={<DashboardLayoutSuspense />}>
        <Welcome allowErrorMonitoring={userSettings.allowErrorMonitoring} />
      </Suspense>
    );

  const current = navigation.find((item) => location.pathname === item.path || location.pathname.startsWith(`${item.path}/`));
  const pendingPath = routeNavigation.location?.pathname;
  const pendingSection = pendingPath ? navigation.find((item) => pendingPath === item.path || pendingPath.startsWith(`${item.path}/`)) : undefined;
  const dockSection = pendingSection ?? current;
  const isTool = dockSection && dockSection.path !== '/dashboard';
  const sectionLabel = dockSection?.label ?? 'Application';
  const routeContent = <DesktopRouteContent label={sectionLabel}>{children}</DesktopRouteContent>;
  return (
    <HostUpdateProvider suspended={loggingOff}>
      <ClusterProvider>
        <AppLauncherProvider>
          <div
            ref={desktop}
            className="desktop orbis-theme"
            data-session-state={loggingOff ? 'logging-out' : undefined}
            data-desktop-preset={preferences.preset}
            data-desktop-mode={resolvedMode}
            data-desktop-density={preferences.density}
            data-desktop-wallpaper={preferences.wallpaper}
          >
            <DesktopWallpaper />
            <header className="desktop-system-bar">
              <Link to="/dashboard" className="desktop-brand" aria-label="Orbis workspace">
                <OrbisLogo size={28} />
                <span className="desktop-product">Orbis</span>
                <span className="desktop-server-name">
                  <ClusterServerLabel />
                </span>
              </Link>
              <span className="desktop-current" aria-current="page">
                <span className="desktop-current-label" data-descenders={/[gjpqy]/.test(sectionLabel)}>
                  {sectionLabel}
                </span>
              </span>
              <div className="desktop-system-actions">
                <Link
                  to="/tasks"
                  className="desktop-task-trigger"
                  aria-label={`Open task centre, ${activeTasks} active operation${activeTasks === 1 ? '' : 's'}`}
                  title="Task centre"
                >
                  <IconActivity size={20} aria-hidden="true" />
                  {activeTasks > 0 ? <span>{activeTasks}</span> : null}
                </Link>
                <OrbisUpdateNotice />
                <button
                  type="button"
                  className="desktop-mode-toggle"
                  aria-label={`Switch to ${resolvedMode === 'dark' ? 'light' : 'dark'} mode`}
                  aria-pressed={resolvedMode === 'dark'}
                  title={`Switch to ${resolvedMode === 'dark' ? 'light' : 'dark'} mode`}
                  onClick={() => update({ mode: resolvedMode === 'dark' ? 'light' : 'dark' })}
                >
                  {resolvedMode === 'dark' ? <IconSun size={20} aria-hidden="true" /> : <IconMoon size={20} aria-hidden="true" />}
                </button>
                <CommandSearch />
                <ClusterConnection />
                <ClusterSwitcher />
                <button
                  type="button"
                  className="desktop-icon-button"
                  aria-label="Log out"
                  disabled={!isLoggedIn || loggingOff || busy > 0}
                  onClick={() => void handleLogout()}
                >
                  <IconLogout size={20} aria-hidden="true" />
                </button>
              </div>
            </header>

            <main
              className="desktop-main"
              id="desktop-content"
              aria-busy={routeNavigation.state !== 'idle'}
              onFocusCapture={(event) => {
                if (event.target.matches(':focus-visible')) revealPageFocus(event.target);
              }}
            >
              {isTool ? (
                <RouteSurface
                  section={pendingPath ?? location.pathname}
                  pending={Boolean(pendingSection && pendingPath !== location.pathname)}
                  label={dockSection.label}
                  icon={<dockSection.Icon size={19} stroke={1.8} />}
                >
                  {!pendingSection && !hasPageHeading && location.pathname.split('/').filter(Boolean).length > 1 ? (
                    <div className="desktop-route-title">
                      <PageTitle apps={apps} />
                    </div>
                  ) : null}
                  {routeContent}
                </RouteSurface>
              ) : (
                <div className="desktop-view desktop-view-home">{routeContent}</div>
              )}
            </main>

            <nav ref={dock} className="desktop-dock" aria-label="Main navigation">
              <DockGlass />
              <DockActivity />
              <div className="desktop-dock-main">
                <DockSelection path={dockSection?.path} reduced={Boolean(reduceMotion)} />
                {navigation
                  .filter((item) => item.path !== '/tasks')
                  .map(({ path, label, Icon, ...item }) => (
                    <Link
                      key={path}
                      to={path}
                      prefetch="intent"
                      onPointerEnter={() => warmNavigation(path)}
                      onTouchStart={() => warmNavigation(path)}
                      onFocus={(event) => {
                        warmNavigation(path);
                        event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
                      }}
                      className={`desktop-dock-item ${dockSection?.path === path ? 'is-active' : ''}`}
                      aria-label={label}
                      aria-current={current?.path === path ? 'page' : undefined}
                      aria-busy={pendingSection?.path === path || undefined}
                      title={label}
                    >
                      <span className="desktop-dock-content">
                        <span className="desktop-dock-icon">
                          <Icon size={22} stroke={1.7} aria-hidden="true" />
                        </span>
                        <span className="desktop-dock-label">{'dockLabel' in item ? item.dockLabel : label}</span>
                      </span>
                    </Link>
                  ))}
              </div>
              <MinimizedApps />
            </nav>
            {loggingOff ? <StartupSurface loggingOff /> : null}
            {loggingOff ? null : <RestartUpdateCover />}
          </div>
        </AppLauncherProvider>
      </ClusterProvider>
    </HostUpdateProvider>
  );
};

function RestartUpdateCover() {
  const { watch, packageJob, unavailable, restart } = useHostUpdateWatch();
  const { preferences } = useDesktopPreferences();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [restartId, setRestartId] = useState<string | null>(null);
  const restartActive = restart?.job?.state === 'restarting';
  const pendingRestartId = restartActive ? restart?.job?.id : null;
  const restartAvailable = restart?.available;
  useLayoutEffect(() => {
    if (pendingRestartId) {
      setRestartId(pendingRestartId);
      return;
    }
    if (!restartId || !restartAvailable) return;
    const timer = window.setTimeout(() => setRestartId(null), prefersReducedMotion() ? 0 : 420);
    return () => window.clearTimeout(timer);
  }, [pendingRestartId, restartAvailable, restartId]);
  if (restartActive || restartId) {
    const finished = !restartActive && restart?.available;
    return (
      <StartupSurface
        appearance={preferences}
        status={{
          title: finished ? (restart?.job?.state === 'failed' ? 'Restart could not start' : 'Server reconnected') : 'Restarting the server',
          message: finished
            ? restart?.job?.message || 'The server is ready.'
            : 'Applications will return when the server is ready. Reconnecting automatically.',
        }}
        completing={finished}
        revealing={finished}
        overlay
      />
    );
  }
  if (coreWatchIsActive(watch) && watch) {
    const restarting = watch.phase === 'offline' || watch.phase === 'checking' || watch.phase === 'ready';
    if (!restarting && dismissed === watch.id) return null;
    return (
      <StartupSurface appearance={preferences} status={{ title: coreUpdateTitle(watch.phase, watch.operation), message: watch.message }} overlay>
        {restarting ? null : (
          <button type="button" className="orbis-startup-return" onClick={() => setDismissed(watch.id)}>
            Keep using Orbis
          </button>
        )}
      </StartupSurface>
    );
  }
  if (unavailable && packageJob && ['queued', 'running'].includes(packageJob.state)) {
    return (
      <StartupSurface
        appearance={preferences}
        status={{ title: 'Restarting the server', message: 'The system update is restarting services. Reconnecting automatically.' }}
        overlay
      />
    );
  }
  return null;
}

function DesktopRouteContent({ children, label }: PropsWithChildren<{ label: string }>) {
  const location = useLocation();
  const navigation = useNavigation();
  const { watch } = useHostUpdateWatch();
  const pending = Boolean(navigation.location && navigation.location.pathname !== location.pathname);
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <ErrorBoundary
          onReset={reset}
          resetKeys={[location.pathname + location.search]}
          fallbackRender={({ resetErrorBoundary }) => (
            <output className="desktop-section-unavailable">
              <span>
                {coreWatchIsActive(watch)
                  ? 'The server is restarting. This section will be available when the update finishes.'
                  : 'This section could not be loaded.'}
              </span>
              <Button onClick={resetErrorBoundary}>Retry</Button>
            </output>
          )}
        >
          <div className="desktop-route-content" data-pending={pending || undefined}>
            <div className="desktop-route-children" inert={pending || undefined} aria-hidden={pending || undefined}>
              <Suspense
                fallback={
                  <div className="desktop-route-placeholder">
                    <DelayedRouteLoading label={`Loading ${label.toLowerCase()}…`} />
                  </div>
                }
              >
                {children}
              </Suspense>
            </div>
            {pending ? (
              <div className="desktop-route-wait desktop-route-placeholder">
                <DelayedRouteLoading label={`Loading ${label.toLowerCase()}…`} />
              </div>
            ) : null}
          </div>
        </ErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  );
}
