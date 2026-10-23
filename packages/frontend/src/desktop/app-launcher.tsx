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
  const panelMotion = useRef<Animation | null>(null);
  const trayMotion = useRef<Animation | null>(null);
  const motionId = useRef(0);
  const trayWidth = useRef(0);
  const restoreOrigin = useRef<DOMRect | null>(null);
  const focusMinimized = useRef<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const captureTray = useCallback((element: HTMLElement | null) => {
    if (!element && tray.current?.contains(document.activeElement)) {
      document.querySelector<HTMLElement>('.desktop-dock-item[aria-current="page"]')?.focus({ preventScroll: true });
    }
    tray.current = element;
  }, []);
  const cancelMotion = useCallback(() => {
    motionId.current++;
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
      trayMotion.current?.cancel();
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
        spacing(element, 'padding-left', 'padding-right', 'border-left-width', 'border-right-width') + spacing(list, 'padding-left', 'padding-right');
      const links = [...primary.querySelectorAll<HTMLElement>('.desktop-dock-item')];
      const iconWidth = Number.parseFloat(getComputedStyle(dock).getPropertyValue('--orbis-dock-icon-width')) || 52;
      const contractedWidth =
        links.length * iconWidth +
        spacing(primary, 'column-gap') * (links.length - 1) +
        spacing(primary, 'padding-left', 'padding-right', 'border-left-width', 'border-right-width');
      const navigation = (minimized.length > 3 ? contractedWidth : primary.offsetWidth) + spacing(dock, 'column-gap');
      const available =
        document.documentElement.clientWidth -
        inset * 2 -
        navigation -
        spacing(dock, 'padding-left', 'padding-right', 'border-left-width', 'border-right-width') -
        padding -
        spacing(element, 'margin-left');
      const slots = Math.max(1, Math.floor((available + gap) / (item.offsetWidth + gap)));
      element.style.maxWidth = `${Math.min(slots, minimized.length) * (item.offsetWidth + gap) - gap + padding}px`;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(primary);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [desktop, trayVisible, minimized.length]);

  useLayoutEffect(() => {
    if (!minimizing || !selected || !panel || !trayVisible || !desktop) return;
    const target = trayButton(selected.urn);
    if (!target) return;
    target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    target.focus({ preventScroll: true });
    const from = panel.getBoundingClientRect();
    const to = target.getBoundingClientRect();
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
    const animation = panel.animate(
      [
        { transform: 'none', opacity: 1, borderRadius: '22px' },
        {
          transform: `translate(${to.x - from.x}px, ${to.y - from.y}px) scale(${to.width / from.width}, ${to.height / from.height})`,
          opacity: 0,
          borderRadius: '40px',
        },
      ],
      { duration: 420, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'forwards' },
    );
    panelMotion.current = animation;
    void animation.finished.then(finish, () => undefined);
    return () => animation.cancel();
  }, [minimizing, selected, panel, trayVisible, desktop, trayButton]);

  useLayoutEffect(() => {
    const origin = restoreOrigin.current;
    if (!origin || !selected || !panel || !desktop || minimizing) return;
    restoreOrigin.current = null;
    if (reducedMotion()) return;
    const target = panel.getBoundingClientRect();
    panel.style.animation = 'none';
    const animation = panel.animate(
      [
        {
          transform: `translate(${origin.x - target.x}px, ${origin.y - target.y}px) scale(${origin.width / target.width}, ${origin.height / target.height})`,
          opacity: 0,
        },
        { transform: 'translateY(-3px) scale(1.015)', opacity: 1, offset: 0.76 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: 520, easing: 'cubic-bezier(.22, 1, .36, 1)' },
    );
    panelMotion.current = animation;
    return () => animation.cancel();
  }, [selected, panel, desktop, minimizing]);

  useLayoutEffect(() => {
    if (desktop && minimized.length && !trayVisible) {
      setTrayVisible(true);
      return;
    }
    const element = tray.current;
    if (!desktop || !element || !trayVisible) return;
    const dock = element.closest<HTMLElement>('.desktop-dock');
    const previous = trayMotion.current?.playState === 'running' ? element.getBoundingClientRect().width : trayWidth.current;
    trayMotion.current?.cancel();
    const width = Number.parseFloat(element.style.maxWidth) || element.getBoundingClientRect().width;
    if (!minimized.length) {
      if (reducedMotion()) {
        setTrayVisible(false);
        trayWidth.current = 0;
        return;
      }
      const animation = element.animate(
        [
          { width: `${previous || width}px`, paddingInline: '7px', borderWidth: '1px', marginLeft: '0px', opacity: 1, transform: 'none' },
          { width: '0px', paddingInline: '0px', borderWidth: '0px', marginLeft: '-12px', opacity: 0, transform: 'scaleY(.84)' },
        ],
        { duration: 460, easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'forwards' },
      );
      if (dock) dock.dataset.trayMotion = 'joining';
      trayMotion.current = animation;
      void animation.finished.then(
        () => {
          setTrayVisible(false);
          trayWidth.current = 0;
          if (dock) delete dock.dataset.trayMotion;
        },
        () => undefined,
      );
      return () => {
        animation.cancel();
        if (dock) delete dock.dataset.trayMotion;
      };
    }
    trayWidth.current = width;
    if (reducedMotion()) return;
    const animation = element.animate(
      [
        {
          width: `${previous || 0}px`,
          paddingInline: previous ? '7px' : '0px',
          borderWidth: previous ? '1px' : '0px',
          marginLeft: previous ? '0px' : '-12px',
          opacity: previous ? 1 : 0,
          transform: 'scaleY(.9)',
        },
        { width: `${width}px`, paddingInline: '7px', borderWidth: '1px', marginLeft: '0px', opacity: 1, transform: 'scaleY(1.035)', offset: 0.72 },
        { width: `${width}px`, paddingInline: '7px', borderWidth: '1px', marginLeft: '0px', opacity: 1, transform: 'none' },
      ],
      { duration: 620, easing: 'cubic-bezier(.22, 1, .36, 1)' },
    );
    if (dock && !previous) dock.dataset.trayMotion = 'splitting';
    trayMotion.current = animation;
    void animation.finished.then(
      () => {
        if (dock) delete dock.dataset.trayMotion;
      },
      () => undefined,
    );
    return () => {
      animation.cancel();
      if (dock) delete dock.dataset.trayMotion;
    };
  }, [desktop, minimized, trayVisible]);

  const minimize = () => {
    if (!selected || minimizing) return;
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
    const start = { transform: style.transform, opacity: style.opacity };
    cancelMotion();
    setClosing(true);
    const id = ++motionId.current;
    const animation = panel.animate([start, { transform: 'translateY(12px) scale(.96)', opacity: 0 }], {
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

  const minimizedApps = desktop ? (
    <fieldset
      ref={captureTray}
      className="orbis-app-tray"
      hidden={!trayVisible}
      aria-label="Minimized apps"
      title="Minimized apps — scroll horizontally for more"
      aria-hidden={minimized.length === 0}
    >
      <ul className="app-tray-list">
        {minimized.map((request) => (
          <li key={request.urn} className="app-tray-item">
            <Button
              className="app-tray-restore"
              data-minimized-app={request.urn}
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
                const target = next ? trayButton(next.urn) : document.querySelector<HTMLElement>('.desktop-dock-item[aria-current="page"]');
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
  ) : null;

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
              ref={setPanel}
              className="orbis-app-launcher"
              data-minimizing={minimizing}
              data-closing={closing}
              inert={minimizing || closing || undefined}
              onInteractOutside={(event) => event.preventDefault()}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                const minimizedTarget = focusMinimized.current ? trayButton(focusMinimized.current) : null;
                const target =
                  minimizedTarget ??
                  (opener.current?.isConnected ? opener.current : document.querySelector<HTMLElement>('.desktop-dock-item[aria-current="page"]'));
                target?.focus({ preventScroll: true });
                focusMinimized.current = null;
              }}
            >
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
                    <Link to={managePath} viewTransition onClick={() => setSelected(null)}>
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
