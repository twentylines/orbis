import * as Dialog from '@radix-ui/react-dialog';
import { IconExternalLink, IconSettings, IconX } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { Link } from 'react-router';
import { getAppOptions } from '@/api-client/@tanstack/react-query.gen';
import { AppLogo } from '@/components/app-logo/app-logo';
import { Button } from '@/components/ui/Button';
import { useAppContext } from '@/context/app-context';
import { useDesktopWindows } from './window-viewport';
import { appDestinations } from './app-destinations';
import './app-launcher.css';

type LaunchRequest = { urn: string; name: string; preferredUrl?: string };
const AppLauncherContext = createContext<(request: LaunchRequest) => boolean>(() => false);
export const useAppLauncher = () => useContext(AppLauncherContext);

export function AppLauncherProvider({ children }: PropsWithChildren) {
  const desktop = useDesktopWindows();
  const { userSettings } = useAppContext();
  const [selected, setSelected] = useState<LaunchRequest | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const openApp = useCallback(
    (request: LaunchRequest) => {
      if (!desktop) return false;
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setSelected(request);
      return true;
    },
    [desktop],
  );
  const details = useQuery({
    ...getAppOptions({ path: { urn: selected?.urn ?? '' } }),
    enabled: selected !== null && desktop,
    refetchInterval: selected && desktop ? 15000 : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
  useEffect(() => {
    if (!desktop) setSelected(null);
  }, [desktop]);

  const data = details.data;
  const destinations = data ? appDestinations(data, userSettings, window.location.hostname) : [];
  const primary = destinations.find((destination) => destination.url === normalizeAddress(selected?.preferredUrl)) ?? destinations[0];
  const [appId, storeId] = selected?.urn.split(':') ?? [];
  const managePath = `/apps/${encodeURIComponent(storeId ?? '')}/${encodeURIComponent(appId ?? '')}`;
  const status = data?.app?.status;

  return (
    <AppLauncherContext.Provider value={openApp}>
      {children}
      <Dialog.Root
        open={selected !== null && desktop}
        modal={false}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Content
            className="orbis-app-launcher"
            onInteractOutside={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const target = opener.current?.isConnected
                ? opener.current
                : document.querySelector<HTMLElement>('.desktop-dock-item[aria-current="page"]');
              target?.focus({ preventScroll: true });
            }}
          >
            <header className="app-launcher-bar">
              <span title={userSettings.internalIp || window.location.hostname}>{userSettings.internalIp || window.location.hostname}</span>
              <Dialog.Close asChild>
                <Button className="app-launcher-close" size="icon" aria-label="Close app launcher">
                  <IconX size={19} aria-hidden="true" />
                </Button>
              </Dialog.Close>
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
