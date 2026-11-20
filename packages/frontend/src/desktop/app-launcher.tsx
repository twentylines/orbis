import { endDesktopSessionEvent } from '@/components/startup/auth-session-navigation';
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
import { AnimatePresence } from 'framer-motion';
import { useLocation } from 'react-router';
import { IconX } from '@tabler/icons-react';
import { AppLogo } from '@/components/app-logo/app-logo';
import { Button } from '@/components/ui/Button';
import { useAppContext } from '@/context/app-context';
import type { DesktopWindowBounds } from '@runtipi/common/schemas';
import { useDesktopWindows } from './window-viewport';
import { DockCompanion } from './dock-companion';
import { dockNavigationFocusTarget } from './dock-scroll-reveal';
import { useDesktopPreferences } from './preferences';
import { appOpeningMode, appRestorePlan } from './app-opening';
import { readOpenedApps, rememberOpenedApp, type OpenedApps } from './app-library';
import { appWindowReducer, appWindowRatio, appWorkspace, minimizedAppGroups, parkedAppLayout, type AppLaunchRequest } from './app-window-state';
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

const trayMemberSelector = (urn: string) => `[data-tray-member="${CSS.escape(urn)}"]`;

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
  useEffect(() => {
    const clear = () => dispatch({ type: 'reset-session' });
    window.addEventListener(endDesktopSessionEvent, clear);
    return () => window.removeEventListener(endDesktopSessionEvent, clear);
  }, []);
  const latestState = useRef(state);
  latestState.current = state;
  const workspace = appWorkspace(state);
  const split =
    workspace.split && state.windows.some(({ request, status }) => request.urn === workspace.split?.anchor && status === 'visible')
      ? workspace.split
      : undefined;
  const [tray, setTray] = useState<HTMLElement | null>(null);
  const [detachedWindow, setDetachedWindow] = useState<string | null>(null);
  const ratio = workspace.ratio ?? 0.5;
  const area = useAppWindowArea();
  const origins = useRef(new Map<string, { bounds: DOMRect; opacity?: number }>());
  const openers = useRef(new Map<string, HTMLElement>());
  const minimized = useMemo(() => minimizedAppGroups(state), [state]);
  useAppTrayLayout(desktop, minimized.length, tray);
  const trayButton = useCallback(
    (urn: string) =>
      [...(tray?.querySelectorAll<HTMLButtonElement>('[data-minimized-app]') ?? [])].find(
        (button) => button.dataset.minimizedApp === urn || Boolean(button.querySelector(trayMemberSelector(urn))),
      ),
    [tray],
  );
  const remember = useCallback(
    (request: AppLaunchRequest) => setOpened((previous) => rememberOpenedApp(previous, request.recentKey ?? request.urn, Date.now())),
    [],
  );
  const captureOpener = useCallback((urn: string) => {
    if (document.activeElement instanceof HTMLElement) openers.current.set(urn, document.activeElement);
  }, []);
  const planRestore = useCallback(
    (request: AppLaunchRequest, members: readonly AppLaunchRequest[]) =>
      appRestorePlan(preferences.appLaunch, request, members, window.location.origin, desktop),
    [desktop, preferences.appLaunch],
  );
  const openApp = useCallback(
    (request: AppLaunchRequest) => {
      const group = minimizedAppGroups(latestState.current).find((members) => members.some((item) => item.request.urn === request.urn));
      const plan = planRestore(request, group?.map((item) => item.request) ?? []);
      if (!plan) return false;

      remember(request);
      if (plan.mode === 'tab') {
        window.open(plan.url, '_blank', 'noopener,noreferrer');
        if (document.activeElement?.closest('.orbis-app-tray')) dockNavigationFocusTarget()?.focus({ preventScroll: true });
        dispatch({ type: 'remove', urn: request.urn });
        origins.current.delete(request.urn);
        openers.current.delete(request.urn);
      } else {
        for (const member of plan.requests) {
          if (member.urn !== request.urn) remember(member);
          captureOpener(member.urn);
          const origin = trayButton(member.urn)?.getBoundingClientRect();
          if (origin) origins.current.set(member.urn, { bounds: origin });
          else origins.current.delete(member.urn);
        }
        dispatch({ type: 'open', request: { ...request, launchUrl: plan.url }, restorePair: group?.length === 2 ? plan.restorePair : undefined });
      }
      return true;
    },
    [planRestore, remember, trayButton, captureOpener],
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
      const surviving = document.querySelector<HTMLElement>('.orbis-app-launcher:not([hidden]):not([inert]) .app-launcher-bar');
      const target =
        document.querySelector<HTMLElement>('.app-split-picker:not([inert]) input') ??
        (preferTray ? trayButton(urn) : null) ??
        surviving ??
        (opener?.isConnected && !opener.closest('[hidden],[inert]') ? opener : null) ??
        dockNavigationFocusTarget();
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
      dockNavigationFocusTarget()?.focus({ preventScroll: true });
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
    if (dock.hasAttribute('data-scroll-folding')) return box;
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
      <DockCompanion visible={desktop && minimized.length > 0} side="right" retainOnExit expandedWidth="var(--orbis-app-tray-width, max-content)">
        <fieldset ref={setTray} className="orbis-app-tray" aria-label="Minimized apps" title="Minimized apps — scroll horizontally for more">
          <ul className="app-tray-list">
            {minimized.map((members, index) => {
              const { request, status } = members[0];
              const grouped = members.length > 1;
              const requests = members.map((item) => item.request);
              const names = requests.map((member) => member.name).join(' and ');
              const plan = planRestore(request, requests);
              const restoreLabel =
                plan?.mode === 'tab'
                  ? `Open ${request.name} in new tab`
                  : plan?.restorePair
                    ? `Restore ${names} in split screen`
                    : `Restore ${request.name}`;
              return (
                <li key={request.urn} className="app-tray-item">
                  <Button
                    className="app-tray-restore"
                    data-minimized-app={request.urn}
                    data-flying={(!grouped && status === 'minimizing') || undefined}
                    aria-label={restoreLabel}
                    title={restoreLabel}
                    onClick={() => openApp(request)}
                    onFocus={(event) => event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })}
                  >
                    {grouped ? (
                      <span className="app-tray-pair" aria-hidden="true">
                        {members.map(({ request: member, status: memberStatus }) => (
                          <span key={member.urn} data-tray-member={member.urn} data-flying={memberStatus === 'minimizing' || undefined}>
                            <AppLogo urn={member.urn} url={member.logoUrl} size={17} />
                          </span>
                        ))}
                      </span>
                    ) : (
                      <AppLogo urn={request.urn} url={request.logoUrl} size={28} />
                    )}
                  </Button>
                  <Button
                    className="app-tray-close"
                    size="icon"
                    aria-label={`Close ${names}`}
                    onClick={() => {
                      const next = minimized[index + 1] ?? minimized[index - 1];
                      const target = next ? trayButton(next[0].request.urn) : dockNavigationFocusTarget();
                      const urns = members.map((item) => item.request.urn);
                      dispatch({ type: 'remove-group', urns });
                      for (const urn of urns) {
                        origins.current.delete(urn);
                        openers.current.delete(urn);
                      }
                      target?.focus({ preventScroll: true });
                    }}
                  >
                    <IconX size={16} aria-hidden="true" />
                  </Button>
                </li>
              );
            })}
          </ul>
        </fieldset>
      </DockCompanion>
    ),
    [desktop, minimized, trayButton, openApp, planRestore],
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
                        ratio={appWindowRatio(state, item)}
                        serverName={preferences.serverName}
                        saved={preferences.appLaunch.apps[item.request.urn]?.bounds}
                        origin={origins.current.get(item.request.urn)?.bounds}
                        originOpacity={origins.current.get(item.request.urn)?.opacity}
                        trayReady={Boolean(tray)}
                        trayTarget={() => flightTarget(item.request.urn)}
                        trayElement={() => {
                          const button = trayButton(item.request.urn);
                          return button?.querySelector<HTMLElement>(trayMemberSelector(item.request.urn)) ?? button;
                        }}
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
                        onDetachChange={(detached) =>
                          setDetachedWindow((current) => (detached ? item.request.urn : current === item.request.urn ? null : current))
                        }
                        onMinimize={() => dispatch({ type: 'minimize', urn: item.request.urn })}
                        onMinimized={() => {
                          dispatch({ type: 'minimized', urn: item.request.urn });
                          if (!item.automatic && !parkedAppLayout(state, item.request.urn)) restoreFocus(item.request.urn, true);
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
                    <AnimatePresence>
                      {windowsEnabled && split && !split.partner && !workspace.pickerDismissed && detachedWindow !== split.anchor ? (
                        <AppSplitPicker
                          key={`${section}:${split.anchor}:${split.side}`}
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
                    </AnimatePresence>
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
