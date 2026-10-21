import * as Dialog from '@radix-ui/react-dialog';
import { IconExternalLink, IconMinus, IconSettings, IconX } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type PropsWithChildren } from 'react';
import { Link } from 'react-router';
import { getAppOptions } from '@/api-client/@tanstack/react-query.gen';
import { AppLogo } from '@/components/app-logo/app-logo';
import { Button } from '@/components/ui/Button';
import { useAppContext } from '@/context/app-context';
import { revealPageFocus, useDesktopWindows } from './window-viewport';
import { appDestinations } from './app-destinations';
import './app-launcher.css';

type LaunchRequest = { urn: string; name: string; preferredUrl?: string };
const AppLauncherContext = createContext<(request: LaunchRequest) => boolean>(() => false);
export const useAppLauncher = () => useContext(AppLauncherContext);

export function AppLauncherProvider({ children }: PropsWithChildren) {
  const desktop = useDesktopWindows();
  const { userSettings } = useAppContext();
  const [selected, setSelected] = useState<LaunchRequest | null>(null);
  const [minimized, setMinimized] = useState<LaunchRequest[]>([]);
  const [minimizing, setMinimizing] = useState(false);
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
  }, []);
  const openApp = useCallback(
    (request: LaunchRequest) => {
      if (!desktop) return false;
      cancelMotion();
      restoreOrigin.current = null;
      focusMinimized.current = null;
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setMinimized((current) => {
        const remaining = current.filter((item) => item.urn !== request.urn);
        return selected && selected.urn !== request.urn && !remaining.some((item) => item.urn === selected.urn)
          ? [...remaining, selected]
          : remaining;
      });
      setSelected(request);
      return true;
    },
    [desktop, selected, cancelMotion],
  );
  const details = useQuery({
    ...getAppOptions({ path: { urn: selected?.urn ?? '' } }),
    enabled: selected !== null && desktop,
    refetchInterval: selected && desktop ? 15000 : false,
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
    const previous = trayMotion.current?.playState === 'running' ? element.getBoundingClientRect().width : trayWidth.current;
    trayMotion.current?.cancel();
    const width = element.getBoundingClientRect().width;
    if (!minimized.length) {
      if (reducedMotion()) {
        setTrayVisible(false);
        trayWidth.current = 0;
        return;
      }
      const animation = element.animate(
        [
          { width: `${previous || width}px`, opacity: 1, transform: 'translateX(-50%)' },
          { width: '56px', opacity: 0, transform: 'translateX(-50%) translateY(8px) scale(.92)' },
        ],
        { duration: 220, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'forwards' },
      );
      trayMotion.current = animation;
      void animation.finished.then(
        () => {
          setTrayVisible(false);
          trayWidth.current = 0;
        },
        () => undefined,
      );
      return () => animation.cancel();
    }
    trayWidth.current = width;
    if (reducedMotion()) return;
    const animation = element.animate(
      [
        { width: `${previous || 56}px`, opacity: previous ? 1 : 0, transform: 'translateX(-50%) translateY(6px) scale(.96)' },
        { width: `${width}px`, opacity: 1, transform: 'translateX(-50%) translateY(-2px) scale(1.025)', offset: 0.7 },
        { width: `${width}px`, opacity: 1, transform: 'translateX(-50%)' },
      ],
      { duration: 560, easing: 'cubic-bezier(.22, 1, .36, 1)' },
    );
    trayMotion.current = animation;
    return () => animation.cancel();
  }, [desktop, minimized, trayVisible]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const previous = root.style.getPropertyValue('--orbis-app-tray-height');
    const element = tray.current;
    let measuredHeight = -1;
    const measure = () => {
      const height = desktop && trayVisible && element ? element.offsetHeight + 12 : 0;
      if (height === measuredHeight) return;
      measuredHeight = height;
      root.style.setProperty('--orbis-app-tray-height', `${height}px`);
      if (document.activeElement instanceof HTMLElement) revealPageFocus(document.activeElement);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (element) observer.observe(element);
    return () => {
      observer.disconnect();
      if (previous) root.style.setProperty('--orbis-app-tray-height', previous);
      else root.style.removeProperty('--orbis-app-tray-height');
    };
  }, [desktop, trayVisible]);

  const minimize = () => {
    if (!selected || minimizing) return;
    cancelMotion();
    focusMinimized.current = selected.urn;
    setMinimized((current) => (current.some((item) => item.urn === selected.urn) ? current : [...current, selected]));
    setMinimizing(true);
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

  const data = details.data;
  const destinations = data ? appDestinations(data, userSettings, window.location.hostname) : [];
  const primary = destinations.find((destination) => destination.url === normalizeAddress(selected?.preferredUrl)) ?? destinations[0];
  const [appId, storeId] = selected?.urn.split(':') ?? [];
  const managePath = `/apps/${encodeURIComponent(storeId ?? '')}/${encodeURIComponent(appId ?? '')}`;
  const status = data?.app?.status;

  return (
    <AppLauncherContext.Provider value={openApp}>
      {children}
      {desktop ? (
        <nav ref={captureTray} className="orbis-app-tray" hidden={!trayVisible} aria-label="Minimized apps" aria-hidden={minimized.length === 0}>
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
                  <AppLogo urn={request.urn} size={28} />
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
        </nav>
      ) : null}
      <Dialog.Root
        open={selected !== null && desktop}
        modal={false}
        onOpenChange={(open) => {
          if (!open) {
            cancelMotion();
            setSelected(null);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Content
            ref={setPanel}
            className="orbis-app-launcher"
            data-minimizing={minimizing}
            inert={minimizing || undefined}
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
              <span title={userSettings.internalIp || window.location.hostname}>{userSettings.internalIp || window.location.hostname}</span>
              <div className="app-launcher-controls">
                <Button className="app-launcher-close" size="icon" aria-label="Minimize app launcher" disabled={minimizing} onClick={minimize}>
                  <IconMinus size={19} aria-hidden="true" />
                </Button>
                <Dialog.Close asChild>
                  <Button className="app-launcher-close" size="icon" aria-label="Close app launcher" disabled={minimizing}>
                    <IconX size={19} aria-hidden="true" />
                  </Button>
                </Dialog.Close>
              </div>
            </header>
            <div className="app-launcher-body">
              <div className="app-launcher-identity">
                <AppLogo urn={selected?.urn} size={64} />
                <div>
                  <Dialog.Title>{data?.info.name ?? selected?.name}</Dialog.Title>
                  <span className="app-launcher-status">
                    {status ? status.replaceAll('_', ' ') : details.isError ? 'Unavailable' : 'Loading app…'}
                  </span>
                </div>
              </div>
              <Dialog.Description className="app-launcher-description">
                {details.isError
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
              {details.isError ? <Button onClick={() => void details.refetch()}>Retry</Button> : null}
              <Button asChild variant="outline">
                <Link to={managePath} viewTransition onClick={() => setSelected(null)}>
                  <IconSettings size={18} aria-hidden="true" />
                  App settings
                </Link>
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
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
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
