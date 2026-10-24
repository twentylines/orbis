import { getInstalledAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { AppLogo } from '@/components/app-logo/app-logo';
import { Button } from '@/components/ui/Button';
import { useAppContext } from '@/context/app-context';
import { IconSearch, IconX } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { appDestinations } from './app-destinations';
import { appAddress, canEmbedApp, primaryAppAddress } from './app-opening';
import { splitAppBounds } from './app-window-layout';
import type { AppLaunchRequest } from './app-window-state';
import type { WindowArea } from './window-geometry';

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
  const apps = useQuery(getInstalledAppsOptions());
  const [search, setSearch] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const heading = useId();
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
    input.current?.focus({ preventScroll: true });
  }, []);
  return (
    <dialog
      open
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
          aria-label="Search split screen apps"
          placeholder="Search apps"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      {apps.isError ? (
        <p role="alert">
          Installed apps could not be loaded.{' '}
          <button type="button" onClick={() => void apps.refetch()}>
            Retry
          </button>
        </p>
      ) : null}
      {apps.isPending ? <output>Loading installed apps…</output> : null}
      <ul>
        {choices.map((request) => {
          const url = appAddress(request.preferredUrl ?? request.launchUrl);
          const enabled = url && canEmbedApp(url, window.location.origin, true);
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
    </dialog>
  );
}
