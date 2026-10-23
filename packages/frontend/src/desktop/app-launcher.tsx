import { prefersReducedMotion } from '@/desktop/motion-setting';
import * as Dialog from '@radix-ui/react-dialog';
import { IconExternalLink, IconMinus, IconSettings, IconX } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type PropsWithChildren, type ReactNode } from 'react';
import { Link } from 'react-router';
import { getAppOptions } from '@/api-client/@tanstack/react-query.gen';
import { AppLogo } from '@/components/app-logo/app-logo';
import { Button } from '@/components/ui/Button';
import { useAppContext } from '@/context/app-context';
import { useDesktopWindows } from './window-viewport';
import { appDestinations } from './app-destinations';
import { DockCompanion } from './dock-companion';
import { dockFlightTargetLeft } from './dock-motion-geometry';
import './app-launcher.css';

type LaunchRequest = {
  urn: string;
  name: string;
  preferredUrl?: string;
  serverName?: string;
  logoUrl?: string;
  launchUrl?: string;
  manageUrl?: string;
  status?: string;
};
const dockFocusTarget = () =>
  document.querySelector<HTMLElement>('.desktop-dock-item[aria-current="page"]') ?? document.querySelector<HTMLElement>('.desktop-dock-item');
const AppLauncherContext = createContext<(request: LaunchRequest) => boolean>(() => false);
const AppTrayContext = createContext<ReactNode>(null);
export const useAppLauncher = () => useContext(AppLauncherContext);
export const MinimizedApps = () => useContext(AppTrayContext);

export function AppLauncherProvider({ children }: PropsWithChildren) {
  const desktop = useDesktopWindows();
  const { userSettings } = useAppContext();
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
      if (!desktop) return false;
      cancelMotion();
      restoreOrigin.current = null;
      focusMinimized.current = null;
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setMinimized((current) => current.filter((item) => item.urn !== request.urn));
      setSelected(request);
      return true;
    },
    [desktop, cancelMotion],
  );
  const details = useQuery({
    ...getAppOptions({ path: { urn: selected?.urn ?? '' } }),
    enabled: selected !== null && !selected.manageUrl && desktop,
    refetchInterval: selected && !selected.manageUrl && desktop ? 15000 : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
  useEffect(() => {
    if (!desktop) {
      cancelMotion();
      restoreOrigin.current = null;
      setSelected(null);
    }
  }, [desktop, cancelMotion]);
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
      element.style.width = width;
      element.style.maxWidth = width;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(primary);
    for (const child of dock.children) if (child !== element) observer.observe(child);
    const changes = new MutationObserver(() => {
      for (const child of dock.children) if (child !== element) observer.observe(child);
      measure();
    });
    changes.observe(dock, { childList: true });
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      changes.disconnect();
      window.removeEventListener('resize', measure);
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
    const deadline = performance.now() + 580;
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
    const naturalHeight =
      (panel.querySelector<HTMLElement>('.app-launcher-bar')?.offsetHeight ?? 0) +
      (panel.querySelector<HTMLElement>('.app-launcher-body')?.scrollHeight ?? target.height);
    panel.dataset.launchMotion = 'restoring';
    const deadline = performance.now() + 580;
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
        const style = getComputedStyle(panel);
        const right = Number.parseFloat(style.right) || 24;
        const barBottom = Number.parseFloat(document.documentElement.style.getPropertyValue('--orbis-bar-bottom')) || 88;
        const dockHeight = Number.parseFloat(document.documentElement.style.getPropertyValue('--orbis-dock-height')) || 78;
        const height = Math.min(naturalHeight, window.innerHeight - barBottom - dockHeight - 64);
        travel(panel.getBoundingClientRect(), new DOMRect(window.innerWidth - right - target.width, barBottom + 20, target.width, height));
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
        panelMotion.current = null;
        setClosing(false);
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
    setMinimized((current) => current.filter((item) => item.urn !== request.urn));
    setSelected(request);
  };

  const data = selected?.manageUrl ? undefined : details.data;
  const destinations = selected?.manageUrl
    ? selected.launchUrl
      ? [{ label: selected.serverName || 'Server address', url: selected.launchUrl }]
      : []
    : data
      ? appDestinations(data, userSettings, window.location.hostname)
      : [];
  const primary = destinations.find((destination) => destination.url === normalizeAddress(selected?.preferredUrl)) ?? destinations[0];
  const [appId, storeId] = selected?.urn.split(':') ?? [];
  const managePath = `/apps/${encodeURIComponent(storeId ?? '')}/${encodeURIComponent(appId ?? '')}`;
  const status = selected?.manageUrl ? selected.status : data?.app?.status;

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
                aria-label={`Close ${request.name} launcher`}
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
                  setMinimized((current) => current.filter((item) => item.urn !== request.urn));
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
          <Dialog.Portal>
            <Dialog.Content
              ref={capturePanel}
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
              <header className="app-launcher-bar">
                <span title={selected?.serverName || userSettings.internalIp || window.location.hostname}>
                  {selected?.serverName || userSettings.internalIp || window.location.hostname}
                </span>
                <div className="app-launcher-controls">
                  <Button
                    className="app-launcher-close"
                    size="icon"
                    aria-label="Minimize app launcher"
                    disabled={minimizing || closing}
                    onClick={minimize}
                  >
                    <IconMinus size={19} aria-hidden="true" />
                  </Button>
                  <Dialog.Close asChild>
                    <Button className="app-launcher-close" size="icon" aria-label="Close app launcher" disabled={minimizing || closing}>
                      <IconX size={19} aria-hidden="true" />
                    </Button>
                  </Dialog.Close>
                </div>
              </header>
              <div className="app-launcher-body">
                <div className="app-launcher-identity">
                  <AppLogo urn={selected?.urn} url={selected?.logoUrl} size={64} />
                  <div>
                    <Dialog.Title>{data?.info.name ?? selected?.name}</Dialog.Title>
                    <span className="app-launcher-status">
                      {status ? status.replaceAll('_', ' ') : details.isError ? 'Unavailable' : 'Loading app…'}
                    </span>
                  </div>
                </div>
                <Dialog.Description className="app-launcher-description">
                  {!selected?.manageUrl && details.isError
                    ? 'App details could not be loaded. Try again or open its settings.'
                    : data?.info.no_gui
                      ? 'This app runs without a web interface.'
                      : status && status !== 'running'
                        ? 'Open app settings to start or manage this app.'
                        : 'Open the app on its server.'}
                </Dialog.Description>
                {primary ? (
                  <Button asChild intent="primary">
                    <a href={primary.url} target="_blank" rel="noopener noreferrer">
                      <IconExternalLink size={18} aria-hidden="true" />
                      Open app
                    </a>
                  </Button>
                ) : null}
                {destinations.length > 0 ? (
                  <ul className="app-launcher-addresses" aria-label="App addresses">
                    {destinations.map(({ label, url }) => (
                      <li key={url}>
                        <a href={url} target="_blank" rel="noopener noreferrer">
                          <span>{label}</span>
                          <span title={url}>{url}</span>
                          <IconExternalLink size={16} aria-hidden="true" />
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {!selected?.manageUrl && details.isError ? <Button onClick={() => void details.refetch()}>Retry</Button> : null}
                <Button asChild variant="outline">
                  {selected?.manageUrl ? (
                    <a href={selected.manageUrl} target="_blank" rel="noopener noreferrer">
                      <IconSettings size={18} aria-hidden="true" /> App settings
                    </a>
                  ) : (
                    <Link to={managePath} onClick={() => setSelected(null)}>
                      <IconSettings size={18} aria-hidden="true" />
                      App settings
                    </Link>
                  )}
                </Button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </AppTrayContext.Provider>
    </AppLauncherContext.Provider>
  );
}

function normalizeAddress(value?: string) {
  try {
    return value ? new URL(value).href : undefined;
  } catch {
    return undefined;
  }
}

function reducedMotion() {
  return prefersReducedMotion();
}
