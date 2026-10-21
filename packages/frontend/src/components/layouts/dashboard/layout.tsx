import { logoutMutation } from '@/api-client/@tanstack/react-query.gen';
import { useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { Welcome } from '@/components/welcome/welcome';
import { PageTitle } from '@/components/page-title/page-title';
import { useDesktopPreferences } from '@/desktop/preferences';
import { useTasks, taskIsActive } from '@/desktop/tasks';
import { CommandSearch } from '@/desktop/command-search';
import { desktopNavigation as navigation } from '@/desktop/navigation';
import { useSectionMotion } from '@/desktop/section-motion';
import { RouteSurface } from '@/desktop/route-surface';
import { AppLauncherProvider, MinimizedApps } from '@/desktop/app-launcher';
import { revealPageFocus } from '@/desktop/window-viewport';
import { ClusterConnection, ClusterProvider, ClusterServerLabel, ClusterSwitcher } from '@/desktop/cluster';
import { IconApps, IconLogout, IconMoon, IconSun, IconActivity } from '@tabler/icons-react';
import { useIsMutating, useMutation } from '@tanstack/react-query';
import { useLayoutEffect, useRef, type PropsWithChildren } from 'react';
import { Link, useLocation, useMatches } from 'react-router';
import './layout.css';

export const DashboardLayoutSuspense = ({ children }: PropsWithChildren) => {
  const { preferences, resolvedMode } = useDesktopPreferences();
  return (
    <div
      className="desktop desktop-loading orbis-theme"
      data-desktop-mode={resolvedMode}
      data-desktop-preset={preferences.preset}
      data-desktop-wallpaper={preferences.wallpaper}
    >
      <div className="desktop-system-bar">
        <span className="desktop-brand">
          <img src="/icons/orbis.svg" width={28} height={28} alt="" /> Orbis
        </span>
      </div>
      <main className="desktop-main">
        <div className="desktop-view desktop-view-loading">{children}</div>
      </main>
    </div>
  );
};

export const DashboardLayout = ({ children }: PropsWithChildren) => {
  const { userSettings, user, apps } = useAppContext();
  const { isLoggedIn } = useUserContext();
  const { preferences, resolvedMode, update } = useDesktopPreferences();
  const location = useLocation();
  const matches = useMatches();
  const dock = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!user.hasSeenWelcome) return;
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
  }, [user.hasSeenWelcome]);
  const hasPageHeading = matches.some((match) =>
    ['app-details', 'app-details-store', 'custom-app', 'app-update', 'app-store-app-update'].includes(match.id),
  );
  useSectionMotion();
  const busy = useIsMutating();
  const tasks = useTasks();
  const activeTasks = tasks.data?.tasks.filter(taskIsActive).length ?? 0;
  const logout = useMutation({ ...logoutMutation(), onSuccess: () => window.location.reload() });

  if (!user.hasSeenWelcome) return <Welcome allowErrorMonitoring={userSettings.allowErrorMonitoring} />;

  const current = navigation.find((item) => location.pathname === item.path || location.pathname.startsWith(`${item.path}/`));
  const isTool = current && current.path !== '/dashboard';
  return (
    <ClusterProvider>
      <AppLauncherProvider>
        <div
          className="desktop orbis-theme"
          data-desktop-preset={preferences.preset}
          data-desktop-mode={resolvedMode}
          data-desktop-density={preferences.density}
          data-desktop-wallpaper={preferences.wallpaper}
        >
          <header className="desktop-system-bar">
            <Link to="/dashboard" viewTransition className="desktop-brand" aria-label="Orbis workspace">
              <img src="/icons/orbis.svg" width={28} height={28} alt="" />
              <span className="desktop-product">Orbis</span>
              <span className="desktop-server-name">
                <ClusterServerLabel />
              </span>
            </Link>
            <span className="desktop-current" aria-current="page">
              {current?.label ?? 'Application'}
            </span>
            <div className="desktop-system-actions">
              <Link
                to="/tasks"
                viewTransition
                className="desktop-task-trigger"
                aria-label={`Open task centre, ${activeTasks} active operation${activeTasks === 1 ? '' : 's'}`}
                title="Task centre"
              >
                <IconActivity size={20} aria-hidden="true" />
                {activeTasks > 0 ? <span>{activeTasks}</span> : null}
              </Link>
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
              {busy > 0 ? (
                <output className="desktop-operation">
                  {busy} request{busy === 1 ? '' : 's'} in progress
                </output>
              ) : null}
              <ClusterSwitcher />
              <button
                type="button"
                className="desktop-icon-button"
                aria-label="Log out"
                disabled={!isLoggedIn || logout.isPending || busy > 0}
                onClick={() => logout.mutate({})}
              >
                <IconLogout size={20} aria-hidden="true" />
              </button>
            </div>
          </header>

          <main className="desktop-main" id="desktop-content" onFocusCapture={(event) => revealPageFocus(event.target)}>
            {isTool ? (
              <RouteSurface
                key={current.path}
                label={current?.label ?? 'Application'}
                icon={current ? <current.Icon size={19} stroke={1.8} /> : <IconApps size={19} />}
              >
                {!hasPageHeading && location.pathname.split('/').filter(Boolean).length > 1 ? (
                  <div className="desktop-route-title">
                    <PageTitle apps={apps} />
                  </div>
                ) : null}
                {children}
              </RouteSurface>
            ) : (
              <div className="desktop-view desktop-view-home">{children}</div>
            )}
          </main>

          <nav ref={dock} className="desktop-dock" aria-label="Main navigation">
            <div className="desktop-dock-main">
              {navigation
                .filter((item) => item.path !== '/tasks')
                .map(({ path, label, Icon, ...item }) => (
                  <Link
                    key={path}
                    to={path}
                    viewTransition
                    onFocus={(event) => event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })}
                    className={`desktop-dock-item ${current?.path === path ? 'is-active' : ''}`}
                    aria-label={label}
                    aria-current={current?.path === path ? 'page' : undefined}
                    title={label}
                  >
                    <span className="desktop-dock-content">
                      <Icon size={22} stroke={1.7} aria-hidden="true" />
                      <span className="desktop-dock-label">{'dockLabel' in item ? item.dockLabel : label}</span>
                    </span>
                  </Link>
                ))}
            </div>
            <MinimizedApps />
          </nav>
        </div>
      </AppLauncherProvider>
    </ClusterProvider>
  );
};
