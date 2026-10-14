import { getInstalledAppsOptions, logoutMutation } from '@/api-client/@tanstack/react-query.gen';
import { AppLogo } from '@/components/app-logo/app-logo';
import { useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { Welcome } from '@/components/welcome/welcome';
import { PageTitle } from '@/components/page-title/page-title';
import { useDesktopPreferences } from '@/desktop/preferences';
import { useConnectionStore } from '@/stores/connection-store';
import {
  IconApps,
  IconBrandAppstore,
  IconDeviceDesktopAnalytics,
  IconHome,
  IconLogout,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconX,
} from '@tabler/icons-react';
import { useIsMutating, useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import './layout.css';

const navigation = [
  { path: '/dashboard', label: 'Workspace', Icon: IconHome },
  { path: '/apps', label: 'Applications', dockLabel: 'Apps', Icon: IconApps },
  { path: '/app-store', label: 'App Store', dockLabel: 'Store', Icon: IconBrandAppstore },
  { path: '/monitor', label: 'Monitor', Icon: IconDeviceDesktopAnalytics },
  { path: '/updates', label: 'Updates', Icon: IconRefresh },
  { path: '/settings', label: 'Settings', Icon: IconSettings },
];

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
  const { preferences } = useDesktopPreferences();
  const location = useLocation();
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const busy = useIsMutating();
  const connectionStatus = useConnectionStore((state) => state.status);
  const searchableApps = useQuery({ ...getInstalledAppsOptions(), enabled: paletteOpen });
  const logout = useMutation({ ...logoutMutation(), onSuccess: () => window.location.reload() });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
      if (event.key === 'Escape') setPaletteOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (paletteOpen) searchRef.current?.focus();
  }, [paletteOpen]);

  if (!user.hasSeenWelcome) return <Welcome allowErrorMonitoring={userSettings.allowErrorMonitoring} />;

  const current = navigation.find((item) => location.pathname === item.path || location.pathname.startsWith(`${item.path}/`));
  const results = navigation.filter((item) => item.label.toLowerCase().includes(search.trim().toLowerCase()));
  const appResults = (searchableApps.data?.installed ?? [])
    .filter(({ info }) => info.available && info.name.toLowerCase().includes(search.trim().toLowerCase()))
    .slice(0, 8);
  const firstApp = appResults[0];
  const firstAppPath = firstApp
    ? (() => {
        const [appId, storeId] = firstApp.info.urn.split(':');
        return `/apps/${storeId}/${appId}`;
      })()
    : undefined;
  const go = (path: string) => {
    setPaletteOpen(false);
    setSearch('');
    navigate(path);
  };

  return (
    <div className="desktop" data-desktop-preset={preferences.preset} data-desktop-density={preferences.density}>
      <header className="desktop-system-bar">
        <Link to="/dashboard" className="desktop-brand" aria-label={`Orbis workspace on ${preferences.serverName}`}>
          <img src="/icons/orbis.svg" width={28} height={28} alt="" />
          <span className="desktop-product">Orbis</span>
          <span className="desktop-server-name">{preferences.serverName}</span>
        </Link>
        <span className="desktop-current" aria-current="page">
          {current?.label ?? 'Application'}
        </span>
        <div className="desktop-system-actions">
          <button type="button" className="desktop-search-trigger" onClick={() => setPaletteOpen(true)} aria-label="Search tools and settings">
            <IconSearch size={18} aria-hidden="true" />
            <span>Search</span>
            <kbd>⌘/Ctrl K</kbd>
          </button>
          <output className="desktop-connection" aria-label={`Live updates ${connectionStatus}`}>
            <span className={`desktop-connection-dot is-${connectionStatus}`} aria-hidden="true" />
            <span className="desktop-connection-label">
              {connectionStatus === 'connected' ? 'Connected' : connectionStatus === 'connecting' ? 'Connecting' : 'Reconnecting'}
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
            <IconLogout size={19} aria-hidden="true" />
          </button>
        </div>
      </header>

      <main className="desktop-main" id="desktop-content">
        <div className={`desktop-view ${location.pathname === '/dashboard' ? 'desktop-view-home' : 'desktop-view-app'}`}>
          {location.pathname !== '/dashboard' && location.pathname !== '/monitor' && location.pathname !== '/updates' ? (
            <div className="desktop-route-title">
              <PageTitle apps={apps} />
            </div>
          ) : null}
          {children}
        </div>
      </main>

      <nav className="desktop-dock" aria-label="Desktop tools">
        {navigation.map(({ path, label, Icon, ...item }) => (
          <Link
            key={path}
            to={path}
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

      {paletteOpen && (
        <div className="desktop-palette-backdrop">
          <button type="button" className="desktop-palette-dismiss" aria-label="Close search" onClick={() => setPaletteOpen(false)} />
          <section className="desktop-palette" role="dialog" aria-modal="true" aria-label="Search tools">
            <div className="desktop-palette-input">
              <IconSearch size={21} aria-hidden="true" />
              <input
                ref={searchRef}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    if (results[0]) go(results[0].path);
                    else if (firstAppPath) go(firstAppPath);
                  }
                }}
                placeholder="Find a tool or application"
                aria-label="Find a tool or application"
              />
              <button type="button" aria-label="Close search" onClick={() => setPaletteOpen(false)}>
                <IconX size={20} />
              </button>
            </div>
            <div className="desktop-palette-results">
              {results.map(({ path, label, Icon }) => (
                <button type="button" key={path} onClick={() => go(path)}>
                  <Icon size={20} aria-hidden="true" />
                  <span>{label}</span>
                </button>
              ))}
              {appResults.map(({ info }) => {
                const [appId, storeId] = info.urn.split(':');
                return (
                  <button type="button" key={info.urn} onClick={() => go(`/apps/${storeId}/${appId}`)}>
                    <AppLogo urn={info.urn} size={20} alt="" />
                    <span>{info.name}</span>
                  </button>
                );
              })}
              {!results.length && !appResults.length ? <p>No tools or installed applications match “{search}”.</p> : null}
            </div>
          </section>
        </div>
      )}
    </div>
  );
};
