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
import { IconApps, IconLogout, IconMoon, IconSun, IconX, IconActivity } from '@tabler/icons-react';
import { useIsMutating, useMutation } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { Link, useLocation, useMatches } from 'react-router';
import './layout.css';

export const DashboardLayoutSuspense = ({ children }: PropsWithChildren) => (
  <div className="desktop desktop-loading">
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

export const DashboardLayout = ({ children }: PropsWithChildren) => {
  const { userSettings, user, apps } = useAppContext();
  const { isLoggedIn } = useUserContext();
  const { preferences, update } = useDesktopPreferences();
  const location = useLocation();
  const matches = useMatches();
  const isAppDetail = matches.some((match) => ['app-details', 'app-details-store', 'custom-app'].includes(match.id));
  useSectionMotion();
  const busy = useIsMutating();
  const tasks = useTasks();
  const activeTasks = tasks.data?.tasks.filter(taskIsActive).length ?? 0;
  const connectionStatus = useConnectionStore((state) => state.status);
  const serverAddress = userSettings.internalIp || 'Address unavailable';
  const logout = useMutation({ ...logoutMutation(), onSuccess: () => window.location.reload() });

  if (!user.hasSeenWelcome) return <Welcome allowErrorMonitoring={userSettings.allowErrorMonitoring} />;

  const current = navigation.find((item) => location.pathname === item.path || location.pathname.startsWith(`${item.path}/`));
  return (
    <div
      className="desktop"
      data-desktop-preset={preferences.preset}
      data-desktop-mode={preferences.mode}
      data-desktop-density={preferences.density}
      data-desktop-wallpaper={preferences.wallpaper}
    >
      <header className="desktop-system-bar">
        <Link to="/dashboard" viewTransition className="desktop-brand" aria-label={`Orbis workspace on ${preferences.serverName}`}>
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
            aria-label={`Server ${serverAddress}; live updates ${connectionStatus}`}
            title={`${serverAddress} · ${connectionStatus}`}
          >
            <span className={`desktop-connection-dot is-${connectionStatus}`} aria-hidden="true" />
            <span className="desktop-connection-label">
              {serverAddress}
              {connectionStatus !== 'connected' ? <small>{connectionStatus === 'connecting' ? 'Connecting' : 'Reconnecting'}</small> : null}
            </span>
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
        <div className={`desktop-view ${location.pathname === '/dashboard' ? 'desktop-view-home' : 'desktop-view-app'}`}>
          {location.pathname !== '/dashboard' ? (
            <div className="desktop-window-bar">
              <span className="desktop-window-icon" aria-hidden="true">
                {current ? <current.Icon size={19} stroke={1.8} /> : <IconApps size={19} />}
              </span>
              <div className="desktop-window-label">
                <h1>{current?.label ?? 'Application'}</h1>
                <span>{preferences.serverName} / Orbis</span>
              </div>
              <Link to="/dashboard" viewTransition className="desktop-window-close" aria-label="Back to workspace" title="Back to workspace">
                <IconX size={18} aria-hidden="true" />
              </Link>
            </div>
          ) : null}
          {!isAppDetail && location.pathname.split('/').filter(Boolean).length > 1 ? (
            <div className="desktop-route-title">
              <PageTitle apps={apps} />
            </div>
          ) : null}
          {children}
        </div>
      </main>

      <nav className="desktop-dock" aria-label="Desktop tools">
        {navigation
          .filter((item) => item.path !== '/tasks')
          .map(({ path, label, Icon, ...item }) => (
            <Link
              key={path}
              to={path}
              viewTransition
              className={`desktop-dock-item ${current?.path === path ? 'is-active' : ''}`}
              aria-label={label}
              aria-current={current?.path === path ? 'page' : undefined}
              title={label}
            >
              <Icon size={22} stroke={1.7} aria-hidden="true" />
              <span>{'dockLabel' in item ? item.dockLabel : label}</span>
            </Link>
          ))}
      </nav>
    </div>
  );
};
