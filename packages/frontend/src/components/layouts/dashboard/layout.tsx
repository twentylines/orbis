import { logoutMutation } from '@/api-client/@tanstack/react-query.gen';
import { useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { Welcome } from '@/components/welcome/welcome';
import { PageTitle } from '@/components/page-title/page-title';
import { useDesktopPreferences } from '@/desktop/preferences';
import { useConnectionStore } from '@/stores/connection-store';
import { useTasks, taskIsActive } from '@/desktop/tasks';
import { CommandSearch } from '@/desktop/command-search';
import { desktopNavigation as navigation } from '@/desktop/navigation';
import { useSectionMotion } from '@/desktop/section-motion';
import { RouteWindow, type RouteWindowControls } from '@/desktop/route-window';
import { isWindowMinimized, windowSearch } from '@/desktop/window-navigation';
import { desktopWindowIds, type DesktopWindowId } from '@runtipi/common/schemas';
import { IconApps, IconLogout, IconMoon, IconSun, IconActivity } from '@tabler/icons-react';
import { useIsMutating, useMutation } from '@tanstack/react-query';
import { useRef, type PropsWithChildren } from 'react';
import { Link, useLocation, useMatches } from 'react-router';
import './layout.css';

export const DashboardLayoutSuspense = ({ children }: PropsWithChildren) => {
  const { preferences } = useDesktopPreferences();
  return (
    <div
      className="desktop desktop-loading orbis-theme"
      data-desktop-mode={preferences.mode}
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
  const { preferences, update } = useDesktopPreferences();
  const location = useLocation();
  const matches = useMatches();
  const windowControls = useRef<RouteWindowControls | null>(null);
  const hasPageHeading = matches.some((match) =>
    ['app-details', 'app-details-store', 'custom-app', 'app-update', 'app-store-app-update'].includes(match.id),
  );
  useSectionMotion();
  const busy = useIsMutating();
  const tasks = useTasks();
  const activeTasks = tasks.data?.tasks.filter(taskIsActive).length ?? 0;
  const connectionStatus = useConnectionStore((state) => state.status);
  const serverAddress = userSettings.internalIp || 'Address unavailable';
  const connectionLabel = connectionStatus === 'connected' ? serverAddress : connectionStatus === 'connecting' ? 'Connecting' : 'Reconnecting';
  const logout = useMutation({ ...logoutMutation(), onSuccess: () => window.location.reload() });

  if (!user.hasSeenWelcome) return <Welcome allowErrorMonitoring={userSettings.allowErrorMonitoring} />;

  const current = navigation.find((item) => location.pathname === item.path || location.pathname.startsWith(`${item.path}/`));
  const windowId = current?.path.slice(1) as DesktopWindowId;
  const isTool = desktopWindowIds.includes(windowId);
  const minimized = isTool && isWindowMinimized(location.search);
  return (
    <div
      className="desktop orbis-theme"
      data-desktop-preset={preferences.preset}
      data-desktop-mode={preferences.mode}
      data-desktop-density={preferences.density}
      data-desktop-wallpaper={preferences.wallpaper}
    >
      <header className="desktop-system-bar">
        <Link
          to="/dashboard"
          viewTransition={!isTool}
          onClick={(event) => {
            if (isTool) {
              event.preventDefault();
              windowControls.current?.minimize();
            }
          }}
          className="desktop-brand"
          aria-label={`Orbis workspace on ${preferences.serverName}`}
        >
          <img src="/icons/orbis.svg" width={28} height={28} alt="" />
          <span className="desktop-product">Orbis</span>
          <span className="desktop-server-name">{preferences.serverName}</span>
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
            aria-label={`Switch to ${preferences.mode === 'dark' ? 'light' : 'dark'} mode`}
            aria-pressed={preferences.mode === 'dark'}
            title={`Switch to ${preferences.mode === 'dark' ? 'light' : 'dark'} mode`}
            onClick={() => update({ mode: preferences.mode === 'dark' ? 'light' : 'dark' })}
          >
            {preferences.mode === 'dark' ? <IconSun size={20} aria-hidden="true" /> : <IconMoon size={20} aria-hidden="true" />}
            <span>{preferences.mode === 'dark' ? 'Light' : 'Dark'}</span>
          </button>
          <CommandSearch />
          <output
            className="desktop-connection"
            aria-label={connectionStatus === 'connected' ? `Connected to server ${serverAddress}` : connectionLabel}
            title={connectionLabel}
          >
            <span className={`desktop-connection-dot is-${connectionStatus}`} aria-hidden="true" />
            <span className="desktop-connection-label">{connectionLabel}</span>
          </output>
          {busy > 0 ? (
            <output className="desktop-operation">
              {busy} request{busy === 1 ? '' : 's'} in progress
            </output>
          ) : null}
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

      <main className="desktop-main" id="desktop-content">
        {isTool ? (
          <RouteWindow
            key={windowId}
            id={windowId}
            label={current?.label ?? 'Application'}
            icon={current ? <current.Icon size={19} stroke={1.8} /> : <IconApps size={19} />}
            controlsRef={windowControls}
          >
            {!hasPageHeading && location.pathname.split('/').filter(Boolean).length > 1 ? (
              <div className="desktop-route-title">
                <PageTitle apps={apps} />
              </div>
            ) : null}
            {children}
          </RouteWindow>
        ) : (
          <div className="desktop-view desktop-view-home">{children}</div>
        )}
      </main>

      <nav className="desktop-dock" aria-label="Desktop tools">
        {navigation
          .filter((item) => item.path !== '/tasks')
          .map(({ path, label, Icon, ...item }) => (
            <Link
              key={path}
              to={
                minimized && current?.path === path
                  ? { pathname: location.pathname, search: windowSearch(location.search, false), hash: location.hash }
                  : path
              }
              viewTransition={!(isTool && path === '/dashboard') && !(minimized && current?.path === path)}
              onClick={(event) => {
                if (isTool && path === '/dashboard') {
                  event.preventDefault();
                  windowControls.current?.minimize();
                }
              }}
              onFocus={(event) => event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })}
              className={`desktop-dock-item ${current?.path === path ? (minimized ? 'is-minimized' : 'is-active') : ''}`}
              aria-label={label}
              aria-current={current?.path === path ? 'page' : undefined}
              title={minimized && current?.path === path ? `Restore ${label}` : label}
            >
              <Icon size={22} stroke={1.7} aria-hidden="true" />
              <span>{'dockLabel' in item ? item.dockLabel : label}</span>
            </Link>
          ))}
      </nav>
    </div>
  );
};
