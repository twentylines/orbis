import { getInstalledAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { AppLogo } from '@/components/app-logo/app-logo';
import { Button } from '@/components/ui/Button';
import { useAppContext } from '@/context/app-context';
import { IconSearch, IconX } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { motion, useIsPresent } from 'framer-motion';
import { appDestinations } from './app-destinations';
import { appAddress, canEmbedApp, primaryAppAddress } from './app-opening';
import { splitAppBounds } from './app-window-layout';
import type { AppLaunchRequest } from './app-window-state';
import type { WindowArea } from './window-geometry';
import { useDesktopPreferences } from './preferences';
import { useBlockedAppEmbeds } from './app-embedding';
import { useReducedMotion } from './motion-preferences';

export function AppSplitPicker({
  anchor,
  side,
  area,
  ratio,
  opened,
  onChoose,
  onClose,
}: {
  anchor: string;
  side: 'left' | 'right';
  area: WindowArea;
  ratio: number;
  opened: AppLaunchRequest[];
  onChoose: (request: AppLaunchRequest) => void;
  onClose: () => void;
}) {
  const { userSettings } = useAppContext();
  const { preferences } = useDesktopPreferences();
  const blocked = useBlockedAppEmbeds();
  const apps = useQuery(getInstalledAppsOptions());
  const [search, setSearch] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const heading = useId();
  const present = useIsPresent();
  const reducedMotion = Boolean(useReducedMotion());
  const bounds = splitAppBounds(side, area, ratio);
  const requests = new Map<string, AppLaunchRequest>();
  for (const request of opened) requests.set(request.urn, request);
  for (const entry of apps.data?.installed ?? []) {
    if (entry.info.no_gui) continue;
    requests.set(entry.info.urn, {
      ...entry.info,
      status: entry.app.status,
      launchUrl: primaryAppAddress(appDestinations(entry, userSettings, window.location.hostname), window.location.origin),
    });
  }
  const choices = [...requests.values()]
    .filter((item) => item.urn !== anchor && item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
  useLayoutEffect(() => {
    if (present) input.current?.focus({ preventScroll: true });
  }, [present]);
  return (
    <motion.dialog
      open
      inert={!present}
      aria-hidden={!present || undefined}
      data-leaving={!present || undefined}
      initial={reducedMotion ? false : { opacity: 0.7, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6, transition: { duration: reducedMotion ? 0 : 0.24, ease: [0.2, 0.76, 0.22, 1] } }}
      transition={{ duration: reducedMotion ? 0 : 0.36, ease: [0.2, 0.76, 0.22, 1] }}
      aria-labelledby={heading}
      className="app-split-picker"
      style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header>
        <div>
          <h2 id={heading}>Open beside this app</h2>
          <p>Choose an app for the other half of the screen.</p>
        </div>
        <Button size="icon" aria-label="Close split screen app picker" onClick={onClose}>
          <IconX size={19} aria-hidden="true" />
        </Button>
      </header>
      <label className="app-split-search">
        <IconSearch size={19} aria-hidden="true" />
        <input
          ref={input}
          className="form-control"
          aria-label="Search split screen apps"
          placeholder="Search apps"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      {apps.isError ? (
        <p role="alert">
          Installed apps could not be loaded.{' '}
          <Button type="button" variant="outline" onClick={() => void apps.refetch()}>
            Retry
          </Button>
        </p>
      ) : null}
      {apps.isPending ? <output>Loading installed apps…</output> : null}
      <ul>
        {choices.map((request) => {
          const url = appAddress(request.preferredUrl ?? request.launchUrl);
          const enabled =
            url &&
            canEmbedApp(url, window.location.origin, true) &&
            preferences.appLaunch.mode !== 'tab' &&
            preferences.appLaunch.apps[request.urn]?.mode !== 'tab' &&
            blocked[request.urn]?.url !== url;
          return (
            <li key={request.urn}>
              <button
                type="button"
                disabled={!enabled}
                onClick={() => {
                  if (url) onChoose({ ...request, launchUrl: url });
                }}
              >
                <AppLogo urn={request.urn} url={request.logoUrl} size={40} />
                <span>
                  <strong>{request.name}</strong>
                  <small>
                    {enabled
                      ? request.serverName || 'Open in split screen'
                      : request.status && request.status !== 'running'
                        ? 'App is not running'
                        : 'Requires a browser tab'}
                  </small>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {!apps.isPending && choices.length === 0 ? <p>No matching apps.</p> : null}
    </motion.dialog>
  );
}
