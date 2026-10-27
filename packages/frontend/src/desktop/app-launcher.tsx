import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type PropsWithChildren,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router';
import { IconX } from '@tabler/icons-react';
import { AppLogo } from '@/components/app-logo/app-logo';
import { Button } from '@/components/ui/Button';
import { useAppContext } from '@/context/app-context';
import type { DesktopWindowBounds } from '@runtipi/common/schemas';
import { useDesktopWindows } from './window-viewport';
import { DockCompanion } from './dock-companion';
import { useDesktopPreferences } from './preferences';
import { appAddress, appOpeningMode } from './app-opening';
import { readOpenedApps, rememberOpenedApp, type OpenedApps } from './app-library';
import { appWindowReducer, appWorkspace, type AppLaunchRequest } from './app-window-state';
import { AppWindow } from './app-window';
import { useAppWindowArea } from './app-window-area';
import { useAppTrayLayout } from './app-tray-layout';
import { AppSplitPicker } from './app-split-picker';
import { AppSplitDivider } from './app-split-divider';
import { dockFlightTargetLeft } from './dock-motion-geometry';
import { desktopNavigation } from './navigation';
import { AppEmbeddingProvider } from './app-embedding';
import { appLaunchEvent } from './app-launch-event';
import './app-launcher.css';

const dockFocusTarget = () =>
  document.querySelector<HTMLElement>('.desktop-dock-item[aria-current="page"]') ?? document.querySelector<HTMLElement>('.desktop-dock-item');
const AppLauncherContext = createContext<(request: AppLaunchRequest) => boolean>(() => false);
const AppTrayContext = createContext<ReactNode>(null);
const OpenedAppsContext = createContext<OpenedApps>({});
export const useOpenedApps = () => useContext(OpenedAppsContext);
export const useAppLauncher = () => useContext(AppLauncherContext);
export const MinimizedApps = () => useContext(AppTrayContext);

export function AppLauncherProvider({ children }: PropsWithChildren) {
  const desktop = useDesktopWindows();
  const location = useLocation();
  const section = desktopNavigation.find(({ path }) => location.pathname === path || location.pathname.startsWith(`${path}/`))?.path ?? '/dashboard';
  const { preferences, update } = useDesktopPreferences();
  const windowsEnabled = desktop && preferences.appLaunch.mode !== 'tab';
  const latestPreferences = useRef(preferences);
  latestPreferences.current = preferences;
  const { user } = useAppContext();
  const recentStorageKey = `orbis-opened-apps-v1:${user.id}`;
  const [opened, setOpened] = useState<OpenedApps>(() => {
    try {
      return readOpenedApps(localStorage.getItem(recentStorageKey));
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(recentStorageKey, JSON.stringify(opened));
    } catch {
      /* App launch works with storage blocked. */
    }
  }, [opened, recentStorageKey]);
  const [state, dispatch] = useReducer(appWindowReducer, { windows: [], section });
  const latestState = useRef(state);
  latestState.current = state;
  const workspace = appWorkspace(state);
  const split =
    workspace.split && state.windows.some(({ request, status }) => request.urn === workspace.split?.anchor && status === 'visible')
      ? workspace.split
      : undefined;
  const [tray, setTray] = useState<HTMLElement | null>(null);
  const ratio = workspace.ratio ?? 0.5;
  const area = useAppWindowArea();
  const origins = useRef(new Map<string, { bounds: DOMRect; opacity?: number }>());
  const openers = useRef(new Map<string, HTMLElement>());
  const minimized = useMemo(() => state.windows.filter(({ status }) => status === 'minimized' || status === 'minimizing'), [state.windows]);
  useAppTrayLayout(desktop, minimized.length, tray);
  const trayButton = useCallback(
    (urn: string) =>
      [...(tray?.querySelectorAll<HTMLButtonElement>('[data-minimized-app]') ?? [])].find((button) => button.dataset.minimizedApp === urn),
    [tray],
  );
  const remember = useCallback(
    (request: AppLaunchRequest) => setOpened((previous) => rememberOpenedApp(previous, request.recentKey ?? request.urn, Date.now())),
    [],
  );
  const captureOpener = useCallback((urn: string) => {
    if (document.activeElement instanceof HTMLElement) openers.current.set(urn, document.activeElement);
  }, []);
  const openApp = useCallback(
    (request: AppLaunchRequest) => {
      const url = appAddress(request.preferredUrl ?? request.launchUrl);
      if (!url) return false;
      remember(request);
      if (appOpeningMode(preferences.appLaunch, request.urn, url, window.location.origin, desktop) === 'tab') {
        window.open(url, '_blank', 'noopener,noreferrer');
        dispatch({ type: 'remove', urn: request.urn });
        origins.current.delete(request.urn);
        openers.current.delete(request.urn);
      } else {
        captureOpener(request.urn);
        const origin = trayButton(request.urn)?.getBoundingClientRect();
        if (origin) origins.current.set(request.urn, { bounds: origin });
        else origins.current.delete(request.urn);
        dispatch({ type: 'open', request: { ...request, launchUrl: url } });
      }
      return true;
    },
    [desktop, preferences.appLaunch, remember, trayButton, captureOpener],
  );
  useEffect(() => {
    const launch = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const request = event.detail as AppLaunchRequest | undefined;
      if (request && typeof request.urn === 'string' && typeof request.name === 'string' && openApp(request)) event.preventDefault();
    };
    window.addEventListener(appLaunchEvent, launch);
    return () => window.removeEventListener(appLaunchEvent, launch);
  }, [openApp]);
  const restoreFocus = (urn: string, preferTray = false) => {
    const opener = openers.current.get(urn);
    requestAnimationFrame(() => {
      const surviving = document.querySelector<HTMLElement>('.orbis-app-launcher:not([hidden]):not([inert]) .app-launcher-close');
      const target =
        document.querySelector<HTMLElement>('.app-split-picker input') ??
        (preferTray ? trayButton(urn) : null) ??
        surviving ??
        (opener?.isConnected && !opener.closest('[hidden],[inert]') ? opener : null) ??
        dockFocusTarget();
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    });
  };
  const remove = (urn: string, completed = false) => {
    if (completed && !latestState.current.windows.some((item) => item.request.urn === urn && item.status === 'closing')) return;
    dispatch({ type: completed ? 'closed' : 'remove', urn });
    restoreFocus(urn);
    origins.current.delete(urn);
    openers.current.delete(urn);
  };
  useLayoutEffect(() => {
    if (!windowsEnabled) return;
    for (const item of latestState.current.windows) {
      const leaving = item.status === 'visible' && item.section !== section;
      const returning = item.section === section && item.automatic && ['minimizing', 'minimized'].includes(item.status);
      if (!leaving && !returning) continue;
      const panel = document.querySelector<HTMLElement>(`[data-app-window="${CSS.escape(item.request.urn)}"]`);
      const moving = leaving || item.status === 'minimizing';
      const origin = moving && panel ? panel : trayButton(item.request.urn);
      if (origin)
        origins.current.set(item.request.urn, {
          bounds: origin.getBoundingClientRect(),
          opacity: moving ? Number(getComputedStyle(origin).opacity) : 0.35,
        });
    }
    dispatch({ type: 'visit', section });
  }, [windowsEnabled, section, trayButton]);

  useEffect(() => {
    if (windowsEnabled) return;
    if (document.activeElement instanceof Element && document.activeElement.closest('.orbis-app-launcher,.orbis-app-tray,.app-split-picker'))
      dockFocusTarget()?.focus({ preventScroll: true });
    dispatch({ type: 'hide' });
  }, [windowsEnabled]);
  const saveBounds = (urn: string, bounds: DesktopWindowBounds) => {
    const current = latestPreferences.current;
    const next = {
      ...current,
      appLaunch: { ...current.appLaunch, apps: { ...current.appLaunch.apps, [urn]: { ...current.appLaunch.apps[urn], bounds } } },
    };
    latestPreferences.current = next;
    update({ appLaunch: next.appLaunch });
  };
  const flightTarget = (urn: string) => {
    const button = trayButton(urn);
    const dock = tray?.closest<HTMLElement>('.desktop-dock');
    const primary = dock?.querySelector<HTMLElement>('.desktop-dock-main');
    const wrapper = tray?.closest<HTMLElement>('.desktop-dock-companion');
    const inner = wrapper?.firstElementChild;
    if (!button || !dock || !primary || !wrapper || !inner) return button?.getBoundingClientRect();
    const box = button.getBoundingClientRect();
    const gap = Number.parseFloat(getComputedStyle(dock).columnGap) || 12;
    const leftSpace = [...dock.querySelectorAll<HTMLElement>(':scope > .desktop-dock-companion[data-side="left"]')].reduce(
      (sum, element) =>
        sum +
        Math.max(0, (Number.parseFloat(element.style.width) || element.offsetWidth) + (Number.parseFloat(element.style.marginRight) || 0) + gap),
      0,
    );
    const style = getComputedStyle(primary);
    const links = primary.querySelectorAll('.desktop-dock-item').length;
    const inset = (['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'] as const).reduce(
      (sum, property) => sum + (Number.parseFloat(style[property]) || 0),
      0,
    );
    const mainWidth =
      dock.dataset.minimizedCompact === 'true'
        ? links * (Number.parseFloat(getComputedStyle(dock).getPropertyValue('--orbis-dock-icon-width')) || 52) +
          (links - 1) * (Number.parseFloat(style.columnGap) || 0) +
          inset
        : primary.getBoundingClientRect().width;
    const dockBox = dock.getBoundingClientRect();
    return new DOMRect(
      dockFlightTargetLeft({
        center: dockBox.x + dockBox.width / 2,
        mainWidth,
        leftSpace,
        trayWidth: Number.parseFloat(wrapper.style.width) || inner.getBoundingClientRect().width,
        gap,
        offset: Math.max(
          0,
          Math.min(
            box.x - inner.getBoundingClientRect().x,
            (Number.parseFloat(wrapper.style.width) || inner.getBoundingClientRect().width) - box.width,
          ),
        ),
      }),
      box.y,
      box.width,
      box.height,
    );
  };
  const minimizedApps = useMemo(
    () => (
      <DockCompanion visible={desktop && minimized.length > 0} side="right" retainOnExit>
        <fieldset ref={setTray} className="orbis-app-tray" aria-label="Minimized apps" title="Minimized apps — scroll horizontally for more">
          <ul className="app-tray-list">
            {minimized.map(({ request, status }) => (
              <li key={request.urn} className="app-tray-item">
                <Button
                  className="app-tray-restore"
                  data-minimized-app={request.urn}
                  data-flying={status === 'minimizing' || undefined}
                  aria-label={
                    preferences.appLaunch.mode === 'tab' || preferences.appLaunch.apps[request.urn]?.mode === 'tab'
                      ? `Open ${request.name} in new tab`
                      : `Restore ${request.name}`
                  }
                  title={request.name}
                  onClick={() => {
                    openApp(request);
                    if (preferences.appLaunch.mode === 'tab' || preferences.appLaunch.apps[request.urn]?.mode === 'tab')
                      dockFocusTarget()?.focus({ preventScroll: true });
                  }}
                  onFocus={(event) => event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })}
                >
                  <AppLogo urn={request.urn} url={request.logoUrl} size={28} />
                </Button>
                <Button
                  className="app-tray-close"
                  size="icon"
                  aria-label={`Close ${request.name}`}
                  onClick={() => {
                    const index = minimized.findIndex((item) => item.request.urn === request.urn);
                    const next = minimized[index + 1] ?? minimized[index - 1];
                    const target = next ? trayButton(next.request.urn) : dockFocusTarget();
                    dispatch({ type: 'remove', urn: request.urn });
                    origins.current.delete(request.urn);
                    openers.current.delete(request.urn);
                    target?.focus({ preventScroll: true });
                  }}
                >
                  <IconX size={16} aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        </fieldset>
      </DockCompanion>
    ),
    [desktop, minimized, trayButton, openApp, preferences.appLaunch],
  );
  return (
    <AppEmbeddingProvider>
      <OpenedAppsContext.Provider value={opened}>
        <AppLauncherContext.Provider value={openApp}>
          <AppTrayContext.Provider value={minimizedApps}>
            {children}
            {state.windows.length > 0 && typeof document !== 'undefined'
              ? createPortal(
                  <>
                    {state.windows.map((item) => (
                      <AppWindow
                        key={item.request.urn}
                        item={item}
                        active={workspace.active === item.request.urn}
                        desktop={windowsEnabled}
                        area={area}
                        ratio={ratio}
                        serverName={preferences.serverName}
                        saved={preferences.appLaunch.apps[item.request.urn]?.bounds}
                        origin={origins.current.get(item.request.urn)?.bounds}
                        originOpacity={origins.current.get(item.request.urn)?.opacity}
                        trayReady={Boolean(tray)}
                        trayTarget={() => flightTarget(item.request.urn)}
                        trayElement={() => trayButton(item.request.urn)}
                        onPlace={(mode) => {
                          const partner = [...state.windows]
                            .reverse()
                            .find(
                              (candidate) =>
                                candidate.request.urn !== item.request.urn &&
                                candidate.section === item.section &&
                                candidate.status === 'visible' &&
                                candidate.request.launchUrl &&
                                appOpeningMode(
                                  preferences.appLaunch,
                                  candidate.request.urn,
                                  candidate.request.launchUrl,
                                  window.location.origin,
                                  desktop,
                                ) === 'window',
                            );
                          dispatch({ type: 'place', urn: item.request.urn, mode, partner: partner?.request.urn });
                        }}
                        onFocus={() => dispatch({ type: 'focus', urn: item.request.urn })}
                        onMinimize={() => dispatch({ type: 'minimize', urn: item.request.urn })}
                        onMinimized={() => {
                          dispatch({ type: 'minimized', urn: item.request.urn });
                          if (!item.automatic) restoreFocus(item.request.urn, true);
                        }}
                        onClose={() => dispatch({ type: 'close', urn: item.request.urn })}
                        onRemoved={() => remove(item.request.urn, true)}
                        onTab={() => {
                          window.open(item.request.launchUrl, '_blank', 'noopener,noreferrer');
                          remove(item.request.urn);
                        }}
                        onSave={(bounds) => saveBounds(item.request.urn, bounds)}
                      />
                    ))}
                    {windowsEnabled && split && !split.partner && !workspace.pickerDismissed ? (
                      <AppSplitPicker
                        anchor={split.anchor}
                        side={split.side === 'left' ? 'right' : 'left'}
                        area={area}
                        ratio={ratio}
                        opened={state.windows.map(({ request }) => request)}
                        onChoose={(request) => {
                          remember(request);
                          dispatch({ type: 'pair', request });
                        }}
                        onClose={() => {
                          dispatch({ type: 'dismiss-picker' });
                          restoreFocus(split?.anchor ?? '');
                        }}
                      />
                    ) : null}
                    {windowsEnabled && split?.partner ? (
                      <AppSplitDivider area={area} ratio={ratio} onChange={(value) => dispatch({ type: 'ratio', value })} />
                    ) : null}
                  </>,
                  document.body,
                )
              : null}
          </AppTrayContext.Provider>
        </AppLauncherContext.Provider>
      </OpenedAppsContext.Provider>
    </AppEmbeddingProvider>
  );
}
