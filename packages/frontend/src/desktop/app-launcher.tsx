import { prefersReducedMotion } from '@/desktop/motion-setting';
import * as Dialog from '@radix-ui/react-dialog';
import {
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconArrowsMove,
  IconExternalLink,
  IconMinus,
  IconResize,
  IconSettings,
  IconX,
} from '@tabler/icons-react';
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PropsWithChildren,
  type ReactNode,
} from 'react';
import { Link } from 'react-router';
import { AppLogo } from '@/components/app-logo/app-logo';
import { Button } from '@/components/ui/Button';
import { useAppContext } from '@/context/app-context';
import { useDesktopWindows } from './window-viewport';
import { DockCompanion } from './dock-companion';
import { sectionMotionTiming } from './section-motion-geometry';
import { dockFlightTargetLeft } from './dock-motion-geometry';
import './app-launcher.css';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/DropdownMenu';
import { useDesktopPreferences } from './preferences';
import { appAddress, appOpeningMode } from './app-opening';
import { useAppWindowGeometry } from './app-window-geometry';
import { readOpenedApps, rememberOpenedApp, type OpenedApps } from './app-library';

type LaunchRequest = {
  urn: string;
  name: string;
  preferredUrl?: string;
  serverName?: string;
  logoUrl?: string;
  launchUrl?: string;
  manageUrl?: string;
  status?: string;
  recentKey?: string;
  categories?: string[];
};
const dockFocusTarget = () =>
  document.querySelector<HTMLElement>('.desktop-dock-item[aria-current="page"]') ?? document.querySelector<HTMLElement>('.desktop-dock-item');
const AppLauncherContext = createContext<(request: LaunchRequest) => boolean>(() => false);
const AppTrayContext = createContext<ReactNode>(null);
const OpenedAppsContext = createContext<OpenedApps>({});
export const useOpenedApps = () => useContext(OpenedAppsContext);
export const useAppLauncher = () => useContext(AppLauncherContext);
export const MinimizedApps = () => useContext(AppTrayContext);

export function AppLauncherProvider({ children }: PropsWithChildren) {
  const desktop = useDesktopWindows();
  const { preferences, update } = useDesktopPreferences();
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
      /* Opening apps still works when storage is blocked. */
    }
  }, [opened, recentStorageKey]);
  const [windows, setWindows] = useState<LaunchRequest[]>([]);
  const [selected, setSelected] = useState<LaunchRequest | null>(null);
  const [minimized, setMinimized] = useState<LaunchRequest[]>([]);
  const [minimizing, setMinimizing] = useState(false);
  const [closing, setClosing] = useState(false);
  const [trayVisible, setTrayVisible] = useState(false);
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const tray = useRef<HTMLElement>(null);
  const panelElement = useRef<HTMLDivElement | null>(null);
  const capturePanel = useCallback((element: HTMLDivElement | null) => {
    panelElement.current = element;
    setPanel(element);
  }, []);
  const panelMotion = useRef<Animation | null>(null);
  const motionId = useRef(0);
  const restoreOrigin = useRef<DOMRect | null>(null);
  const minimizeOrigin = useRef<DOMRect | null>(null);
  const focusMinimized = useRef<string | null>(null);
  const keyboardWindow = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const captureTray = useCallback((element: HTMLElement | null) => {
    if (!element && tray.current?.contains(document.activeElement)) {
      dockFocusTarget()?.focus({ preventScroll: true });
    }
    tray.current = element;
    setTrayVisible(Boolean(element));
  }, []);
  const cancelMotion = useCallback(() => {
    motionId.current++;
    if (panelElement.current) delete panelElement.current.dataset.launchMotion;
    panelMotion.current?.cancel();
    panelMotion.current = null;
    setMinimizing(false);
    setClosing(false);
  }, []);
  const openApp = useCallback(
    (request: LaunchRequest) => {
      const url = appAddress(request.preferredUrl ?? request.launchUrl);
      if (!url) return false;
      setOpened((previous) => rememberOpenedApp(previous, request.recentKey ?? request.urn, Date.now()));
      if (appOpeningMode(preferences.appLaunch, request.urn, url, window.location.origin, desktop) === 'tab') {
        window.open(url, '_blank', 'noopener,noreferrer');
        setWindows((current) => current.filter((item) => item.urn !== request.urn));
        setMinimized((current) => current.filter((item) => item.urn !== request.urn));
        if (selected?.urn === request.urn) {
          cancelMotion();
          setSelected(null);
        }
        return true;
      }
      cancelMotion();
      restoreOrigin.current = null;
      focusMinimized.current = null;
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const existing = windows.find((item) => item.urn === request.urn);
      const next = existing ?? { ...request, launchUrl: url };
      setMinimized((current) => {
        const remaining = current.filter((item) => item.urn !== request.urn);
        return selected && selected.urn !== request.urn && !remaining.some((item) => item.urn === selected.urn)
          ? [...remaining, selected]
          : remaining;
      });
      setWindows((current) => (current.some((item) => item.urn === request.urn) ? current : [...current, next]));
      setSelected(next);
      return true;
    },
    [desktop, cancelMotion, preferences.appLaunch, windows, selected],
  );
  const geometry = useAppWindowGeometry(
    selected?.urn,
    selected ? preferences.appLaunch.apps[selected.urn]?.bounds : undefined,
    selected?.categories,
    (bounds) => {
      if (!selected) return;
      update({
        appLaunch: {
          ...preferences.appLaunch,
          apps: { ...preferences.appLaunch.apps, [selected.urn]: { ...preferences.appLaunch.apps[selected.urn], bounds } },
        },
      });
    },
  );
  const windowBounds = useRef(geometry.bounds);
  useLayoutEffect(() => {
    windowBounds.current = geometry.bounds;
  }, [geometry.bounds]);
  const removeWindow = (urn: string) => {
    setWindows((current) => current.filter((item) => item.urn !== urn));
    setMinimized((current) => current.filter((item) => item.urn !== urn));
    if (selected?.urn === urn)
      requestAnimationFrame(() => {
        const target = opener.current?.isConnected ? opener.current : dockFocusTarget();
        target?.focus({ preventScroll: true });
      });
  };
  useEffect(() => {
    if (!desktop) {
      if (panelElement.current?.contains(document.activeElement) || tray.current?.contains(document.activeElement))
        dockFocusTarget()?.focus({ preventScroll: true });
      cancelMotion();
      restoreOrigin.current = null;
      if (selected) setMinimized((current) => (current.some((item) => item.urn === selected.urn) ? current : [...current, selected]));
      setSelected(null);
    }
  }, [desktop, cancelMotion, selected]);
  useEffect(
    () => () => {
      panelMotion.current?.cancel();
    },
    [],
  );

  const trayButton = useCallback(
    (urn: string) =>
      [...(tray.current?.querySelectorAll<HTMLButtonElement>('[data-minimized-app]') ?? [])].find((button) => button.dataset.minimizedApp === urn),
    [],
  );

  useLayoutEffect(() => {
    const element = tray.current;
    const dock = element?.closest<HTMLElement>('.desktop-dock') ?? document.querySelector<HTMLElement>('.desktop-dock');
    if (!desktop || !trayVisible || !element || !dock || !minimized.length) {
      if (dock) delete dock.dataset.minimizedCompact;
      return;
    }
    const primary = dock.querySelector<HTMLElement>('.desktop-dock-main');
    if (!primary) return;
    dock.dataset.minimizedCompact = String(minimized.length > 3);
    const measure = () => {
      const item = element.querySelector<HTMLElement>('.app-tray-item');
      const list = element.querySelector<HTMLElement>('.app-tray-list');
      if (!item || !list) return;
      const spacing = (target: Element, ...properties: string[]) => {
        const style = getComputedStyle(target);
        return properties.reduce((total, property) => total + (Number.parseFloat(style.getPropertyValue(property)) || 0), 0);
      };
      const inset = Number.parseFloat(getComputedStyle(dock).getPropertyValue('--desktop-inset')) || 24;
      const gap = spacing(list, 'column-gap');
      const padding =
        2 * (Number.parseFloat(getComputedStyle(element).getPropertyValue('--app-tray-inset')) || 7) +
        2 +
        spacing(list, 'padding-left', 'padding-right');
      const links = [...primary.querySelectorAll<HTMLElement>('.desktop-dock-item')];
      const iconWidth = Number.parseFloat(getComputedStyle(dock).getPropertyValue('--orbis-dock-icon-width')) || 52;
      const contractedWidth =
        links.length * iconWidth +
        spacing(primary, 'column-gap') * (links.length - 1) +
        spacing(primary, 'padding-left', 'padding-right', 'border-left-width', 'border-right-width');
      const wrapper = element.closest('.desktop-dock-companion');
      const companions = [...dock.children].filter(
        (child) => child !== wrapper && child.matches('.desktop-dock-companion') && getComputedStyle(child).display !== 'none',
      );
      const companionWidth = companions.reduce((total, child) => total + child.getBoundingClientRect().width, 0);
      const navigation =
        (minimized.length > 3 ? contractedWidth : primary.offsetWidth) + companionWidth + spacing(dock, 'column-gap') * (1 + companions.length);
      const available =
        document.documentElement.clientWidth -
        inset * 2 -
        navigation -
        spacing(dock, 'padding-left', 'padding-right', 'border-left-width', 'border-right-width') -
        padding -
        spacing(element, 'margin-left');
      const slots = Math.max(1, Math.floor((available + gap) / (item.offsetWidth + gap)));
      const width = `${Math.min(slots, minimized.length) * (item.offsetWidth + gap) - gap + padding}px`;
      if (element.style.width !== width) element.style.width = width;
      if (element.style.maxWidth !== width) element.style.maxWidth = width;
    };
    let layoutFrame = 0;
    const schedule = () => {
      if (!layoutFrame)
        layoutFrame = requestAnimationFrame(() => {
          layoutFrame = 0;
          measure();
        });
    };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(primary);
    for (const child of dock.children) if (child !== element) observer.observe(child);
    const changes = new MutationObserver(() => {
      for (const child of dock.children) if (child !== element) observer.observe(child);
      schedule();
    });
    changes.observe(dock, { childList: true });
    window.addEventListener('resize', schedule);
    return () => {
      observer.disconnect();
      changes.disconnect();
      window.removeEventListener('resize', schedule);
      cancelAnimationFrame(layoutFrame);
    };
  }, [desktop, trayVisible, minimized.length]);

  useLayoutEffect(() => {
    if (!minimizing || !selected || !panel || !trayVisible || !desktop) return;
    const target = trayButton(selected.urn);
    if (!target) return;
    target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    target.focus({ preventScroll: true });
    const from = minimizeOrigin.current ?? panel.getBoundingClientRect();
    minimizeOrigin.current = null;
    const dock = tray.current?.closest<HTMLElement>('.desktop-dock');
    const primary = dock?.querySelector<HTMLElement>('.desktop-dock-main');
    const wrapper = tray.current?.closest<HTMLElement>('.desktop-dock-companion');
    const destination = (button: HTMLElement) => {
      const box = button.getBoundingClientRect();
      const inner = wrapper?.firstElementChild;
      if (!dock || !primary || !wrapper || !inner) return box;
      const gap = Number.parseFloat(getComputedStyle(dock).columnGap) || 12;
      const leftSpace = [...dock.querySelectorAll<HTMLElement>(':scope > .desktop-dock-companion[data-side="left"]')].reduce((sum, element) => {
        const declared = Number.parseFloat(element.style.width);
        return (
          sum + Math.max(0, (Number.isFinite(declared) ? declared : element.offsetWidth) + (Number.parseFloat(element.style.marginRight) || 0) + gap)
        );
      }, 0);
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
          offset: box.x - inner.getBoundingClientRect().x,
        }),
        box.y,
        box.width,
        box.height,
      );
    };
    const to = destination(target);
    const id = ++motionId.current;
    const finish = () => {
      if (id !== motionId.current) return;
      panelMotion.current = null;
      setSelected(null);
      setMinimizing(false);
    };
    if (reducedMotion()) {
      finish();
      return;
    }
    const deadline = performance.now() + sectionMotionTiming.surface;
    let animation: Animation | null = null;
    let lastEnd: DOMRect | null = null;
    let resizeFrame = 0;
    const travel = (start: DOMRect, end: DOMRect) => {
      animation?.cancel();
      lastEnd = end;
      animation = panel.animate(
        [
          {
            left: `${start.x}px`,
            top: `${start.y}px`,
            width: `${start.width}px`,
            height: `${start.height}px`,
            borderRadius: '22px',
            transform: 'none',
          },
          {
            left: `${end.x - 3}px`,
            top: `${end.y - 3}px`,
            width: `${end.width + 6}px`,
            height: `${end.height + 6}px`,
            borderRadius: '18px',
            offset: 0.78,
          },
          { left: `${end.x}px`, top: `${end.y}px`, width: `${end.width}px`, height: `${end.height}px`, borderRadius: '14px', transform: 'none' },
        ],
        { duration: Math.max(100, deadline - performance.now()), easing: 'cubic-bezier(.32, .08, .16, 1)', fill: 'forwards' },
      );
      animation.id = 'orbis-app-minimize';
      panelMotion.current = animation;
      void animation.finished.then(finish, () => undefined);
    };
    const retarget = () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        const button = trayButton(selected.urn);
        if (!panel.isConnected || !button) return;
        const end = destination(button);
        if (
          lastEnd &&
          Math.abs(end.x - lastEnd.x) + Math.abs(end.y - lastEnd.y) + Math.abs(end.width - lastEnd.width) + Math.abs(end.height - lastEnd.height) <
            0.75
        )
          return;
        travel(panel.getBoundingClientRect(), end);
      });
    };
    travel(from, to);
    const observer = new ResizeObserver(retarget);
    for (const element of [dock, primary, wrapper, tray.current]) if (element) observer.observe(element);
    window.addEventListener('resize', retarget);
    return () => {
      cancelAnimationFrame(resizeFrame);
      window.removeEventListener('resize', retarget);
      observer.disconnect();
      animation?.cancel();
    };
  }, [minimizing, selected, panel, trayVisible, desktop, trayButton]);

  useLayoutEffect(() => {
    const origin = restoreOrigin.current;
    if (!origin || !selected || !panel || !desktop || minimizing) return;
    restoreOrigin.current = null;
    if (reducedMotion()) return;
    panel.style.animation = 'none';
    const target = panel.getBoundingClientRect();
    panel.dataset.launchMotion = 'restoring';
    const deadline = performance.now() + sectionMotionTiming.surface;
    let animation: Animation | null = null;
    let resizeFrame = 0;
    const travel = (start: DOMRect, end: DOMRect) => {
      animation?.cancel();
      animation = panel.animate(
        [
          {
            left: `${start.x}px`,
            top: `${start.y}px`,
            width: `${start.width}px`,
            height: `${start.height}px`,
            borderRadius: '14px',
            transform: 'none',
          },
          { left: `${end.x}px`, top: `${end.y - 3}px`, width: `${end.width}px`, height: `${end.height + 3}px`, borderRadius: '22px', offset: 0.82 },
          { left: `${end.x}px`, top: `${end.y}px`, width: `${end.width}px`, height: `${end.height}px`, borderRadius: '22px', transform: 'none' },
        ],
        { duration: Math.max(180, deadline - performance.now()), easing: 'cubic-bezier(.2, .76, .22, 1)' },
      );
      panelMotion.current = animation;
      void animation.finished.then(
        () => {
          if (panel.isConnected) delete panel.dataset.launchMotion;
        },
        () => undefined,
      );
    };
    const retarget = () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (!panel.isConnected) return;
        const bounds = windowBounds.current;
        travel(panel.getBoundingClientRect(), new DOMRect(bounds.x, bounds.y, bounds.width, bounds.height));
      });
    };
    travel(origin, target);
    window.addEventListener('resize', retarget);
    return () => {
      cancelAnimationFrame(resizeFrame);
      window.removeEventListener('resize', retarget);
      animation?.cancel();
      delete panel.dataset.launchMotion;
    };
  }, [selected, panel, desktop, minimizing]);

  useLayoutEffect(() => {
    if (!selected || !panel || !desktop) return;
    panel.querySelector<HTMLElement>('[aria-label="App window options"]')?.focus({ preventScroll: true });
    if (panel.dataset.launchMotion === 'restoring' || reducedMotion()) return;
    const animation = panel.animate(
      [
        { opacity: 0.75, transform: 'translateY(12px)' },
        { opacity: 1, transform: 'none' },
      ],
      {
        duration: 460,
        easing: 'cubic-bezier(.16, 1, .3, 1)',
      },
    );
    animation.id = 'orbis-app-open';
    panelMotion.current = animation;
    void animation.finished.then(
      () => {
        if (panelMotion.current === animation) panelMotion.current = null;
        animation.cancel();
      },
      () => undefined,
    );
    return () => animation.cancel();
  }, [selected, panel, desktop]);

  const minimize = () => {
    if (!selected || minimizing) return;
    minimizeOrigin.current = panel?.getBoundingClientRect() ?? null;
    cancelMotion();
    focusMinimized.current = selected.urn;
    setMinimized((current) => (current.some((item) => item.urn === selected.urn) ? current : [...current, selected]));
    setMinimizing(true);
  };
  const closeLauncher = () => {
    if (!selected || minimizing || closing) return;
    if (!panel || reducedMotion()) {
      cancelMotion();
      removeWindow(selected.urn);
      setSelected(null);
      return;
    }
    const style = getComputedStyle(panel);
    const box = panel.getBoundingClientRect();
    const start = {
      left: `${box.x}px`,
      top: `${box.y}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
      transform: 'none',
      opacity: style.opacity,
    };
    panel.style.animation = 'none';
    cancelMotion();
    setClosing(true);
    const id = ++motionId.current;
    const animation = panel.animate([start, { ...start, top: `${box.y + 12}px`, opacity: 0 }], {
      duration: 240,
      easing: 'cubic-bezier(.4, 0, .8, 1)',
      fill: 'forwards',
    });
    panelMotion.current = animation;
    void animation.finished.then(
      () => {
        if (motionId.current !== id) return;
        panel.hidden = true;
        animation.cancel();
        panelMotion.current = null;
        setClosing(false);
        removeWindow(selected.urn);
        setSelected(null);
      },
      () => undefined,
    );
  };
  const restore = (request: LaunchRequest) => {
    cancelMotion();
    restoreOrigin.current = trayButton(request.urn)?.getBoundingClientRect() ?? null;
    focusMinimized.current = null;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMinimized((current) => {
      const remaining = current.filter((item) => item.urn !== request.urn);
      return selected && selected.urn !== request.urn && !remaining.some((item) => item.urn === selected.urn) ? [...remaining, selected] : remaining;
    });
    setSelected(request);
  };

  const [appId, storeId] = selected?.urn.split(':') ?? [];
  const managePath = selected?.manageUrl ?? `/apps/${encodeURIComponent(storeId ?? '')}/${encodeURIComponent(appId ?? '')}`;
  const openInTab = () => {
    if (!selected?.launchUrl) return;
    window.open(selected.launchUrl, '_blank', 'noopener,noreferrer');
    cancelMotion();
    removeWindow(selected.urn);
    setSelected(null);
  };
  const changeOpening = (mode?: 'window' | 'tab') => {
    if (!selected) return;
    const apps = { ...preferences.appLaunch.apps };
    const next = { ...apps[selected.urn], mode };
    if (!mode) delete next.mode;
    apps[selected.urn] = next;
    update({ appLaunch: { ...preferences.appLaunch, apps } });
  };

  const minimizedApps = (
    <DockCompanion visible={desktop && minimized.length > 0} side="right" retainOnExit>
      <fieldset ref={captureTray} className="orbis-app-tray" aria-label="Minimized apps" title="Minimized apps — scroll horizontally for more">
        <ul className="app-tray-list">
          {minimized.map((request) => (
            <li key={request.urn} className="app-tray-item">
              <Button
                className="app-tray-restore"
                data-minimized-app={request.urn}
                data-flying={(minimizing && selected?.urn === request.urn) || undefined}
                aria-label={`Restore ${request.name}`}
                title={request.name}
                onClick={() => restore(request)}
                onFocus={(event) => event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })}
              >
                <AppLogo urn={request.urn} url={request.logoUrl} size={28} />
              </Button>
              <Button
                className="app-tray-close"
                size="icon"
                aria-label={`Close ${request.name}`}
                onClick={() => {
                  const index = minimized.findIndex((item) => item.urn === request.urn);
                  const next = minimized[index + 1] ?? minimized[index - 1];
                  const target = next ? trayButton(next.urn) : dockFocusTarget();
                  if (selected?.urn === request.urn && minimizing) {
                    cancelMotion();
                    focusMinimized.current = null;
                    opener.current = target ?? null;
                    setSelected(null);
                  }
                  removeWindow(request.urn);
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
  );

  return (
    <OpenedAppsContext.Provider value={opened}>
      <AppLauncherContext.Provider value={openApp}>
        <AppTrayContext.Provider value={minimizedApps}>
          {children}
          <Dialog.Root
            open={selected !== null && desktop}
            modal={false}
            onOpenChange={(open) => {
              if (!open) closeLauncher();
            }}
          >
            {windows.length > 0 ? (
              <Dialog.Portal forceMount>
                <Dialog.Content
                  forceMount
                  ref={capturePanel}
                  hidden={!selected || !desktop}
                  aria-describedby="app-window-embedding-help"
                  style={{ left: geometry.bounds.x, top: geometry.bounds.y, width: geometry.bounds.width, height: geometry.bounds.height }}
                  data-gesturing={geometry.gestureKind || undefined}
                  className="orbis-app-launcher"
                  data-minimizing={minimizing}
                  data-closing={closing}
                  inert={minimizing || closing || undefined}
                  onInteractOutside={(event) => event.preventDefault()}
                  onCloseAutoFocus={(event) => {
                    event.preventDefault();
                    const minimizedTarget = focusMinimized.current ? trayButton(focusMinimized.current) : null;
                    const target = minimizedTarget ?? (opener.current?.isConnected ? opener.current : dockFocusTarget());
                    target?.focus({ preventScroll: true });
                    focusMinimized.current = null;
                  }}
                >
                  <span className="app-launcher-flight-mark" aria-hidden="true">
                    <AppLogo urn={selected?.urn} url={selected?.logoUrl} size={28} />
                  </span>
                  <div
                    role="toolbar"
                    aria-label="App window controls"
                    className="app-launcher-bar"
                    tabIndex={-1}
                    onKeyDown={geometry.keyboard}
                    onDoubleClick={(event) => {
                      if (!(event.target as HTMLElement).closest('button,a,select')) geometry.maximize();
                    }}
                    {...geometry.move}
                    onPointerDown={(event) => {
                      cancelMotion();
                      geometry.move.onPointerDown(event);
                    }}
                  >
                    <div className="app-launcher-heading">
                      <AppLogo urn={selected?.urn} url={selected?.logoUrl} size={28} />
                      <div>
                        <Dialog.Title title={selected?.name}>{selected?.name ?? 'App window'}</Dialog.Title>
                        <span title={selected?.serverName || preferences.serverName}>{selected?.serverName || preferences.serverName}</span>
                      </div>
                    </div>
                    <div className="app-launcher-controls">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button className="app-launcher-close" size="icon" aria-label="App window options">
                            <IconSettings size={18} aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          onCloseAutoFocus={(event) => {
                            if (!keyboardWindow.current) return;
                            event.preventDefault();
                            keyboardWindow.current = false;
                            panel?.querySelector<HTMLElement>('.app-launcher-bar')?.focus({ preventScroll: true });
                          }}
                        >
                          <DropdownMenuLabel>Open this app</DropdownMenuLabel>
                          <DropdownMenuItem onSelect={() => changeOpening()} aria-label="Use default opening preference">
                            Use account default{preferences.appLaunch.apps[selected?.urn ?? '']?.mode ? '' : ' ✓'}
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => changeOpening('window')}>
                            In Orbis{preferences.appLaunch.apps[selected?.urn ?? '']?.mode === 'window' ? ' ✓' : ''}
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => changeOpening('tab')}>
                            In a new tab{preferences.appLaunch.apps[selected?.urn ?? '']?.mode === 'tab' ? ' ✓' : ''}
                          </DropdownMenuItem>
                          <DropdownMenuLabel>Window</DropdownMenuLabel>
                          <DropdownMenuItem
                            onSelect={() => {
                              keyboardWindow.current = true;
                              geometry.beginKeyboard('move');
                            }}
                          >
                            <IconArrowsMove size={18} aria-hidden="true" />
                            Move with keyboard
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => {
                              keyboardWindow.current = true;
                              geometry.beginKeyboard('resize');
                            }}
                          >
                            <IconResize size={18} aria-hidden="true" />
                            Resize with keyboard
                          </DropdownMenuItem>
                          <DropdownMenuItem asChild>
                            {selected?.manageUrl ? (
                              <a href={managePath} target="_blank" rel="noopener noreferrer">
                                Manage app
                              </a>
                            ) : (
                              <Link to={managePath} onClick={minimize}>
                                Manage app
                              </Link>
                            )}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <Button
                        className="app-launcher-close"
                        size="icon"
                        aria-label="Open app in new tab"
                        title="Open in new tab and close this window"
                        onClick={openInTab}
                      >
                        <IconExternalLink size={19} aria-hidden="true" />
                      </Button>
                      <Button
                        className="app-launcher-close"
                        size="icon"
                        aria-label={geometry.maximized ? 'Restore app window size' : 'Maximize app window'}
                        onClick={geometry.maximize}
                      >
                        {geometry.maximized ? (
                          <IconArrowsMinimize size={19} aria-hidden="true" />
                        ) : (
                          <IconArrowsMaximize size={19} aria-hidden="true" />
                        )}
                      </Button>
                      <Button
                        className="app-launcher-close"
                        size="icon"
                        aria-label="Minimize app window"
                        disabled={minimizing || closing}
                        onClick={minimize}
                      >
                        <IconMinus size={19} aria-hidden="true" />
                      </Button>
                      <Dialog.Close asChild>
                        <Button className="app-launcher-close" size="icon" aria-label="Close app window" disabled={minimizing || closing}>
                          <IconX size={19} aria-hidden="true" />
                        </Button>
                      </Dialog.Close>
                    </div>
                  </div>
                  <div className="app-launcher-body">
                    {windows.map((request) => (
                      <AppFrame key={request.urn} request={request} hidden={request.urn !== selected?.urn} />
                    ))}
                  </div>
                  <footer className="app-launcher-footer">
                    <Dialog.Description id="app-window-embedding-help">Apps that block embedding or sign-in need a new tab.</Dialog.Description>
                    {geometry.gestureKind ? <output>Arrow keys adjust · Enter saves · Escape cancels</output> : null}
                    <button type="button" onClick={openInTab}>
                      Open in new tab <IconExternalLink size={15} aria-hidden="true" />
                    </button>
                  </footer>
                  <button
                    type="button"
                    className="app-window-resize"
                    aria-label="Resize app window"
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !geometry.gestureKind) {
                        event.preventDefault();
                        geometry.beginKeyboard('resize');
                      } else geometry.keyboard(event);
                    }}
                    {...geometry.resize}
                  >
                    <IconResize size={17} aria-hidden="true" />
                  </button>
                </Dialog.Content>
              </Dialog.Portal>
            ) : null}
          </Dialog.Root>
        </AppTrayContext.Provider>
      </AppLauncherContext.Provider>
    </OpenedAppsContext.Provider>
  );
}

const AppFrame = memo(function AppFrame({ request, hidden }: { request: LaunchRequest; hidden: boolean }) {
  return (
    <iframe
      className="app-window-frame"
      title={`${request.name} app`}
      src={request.launchUrl}
      hidden={hidden}
      referrerPolicy="no-referrer"
      allow="fullscreen; clipboard-read; clipboard-write; camera; microphone; geolocation; display-capture"
      sandbox="allow-forms allow-scripts allow-same-origin allow-downloads allow-popups allow-popups-to-escape-sandbox allow-modals allow-presentation"
    />
  );
});

function reducedMotion() {
  return prefersReducedMotion();
}
