import type { AppInfoSimple } from '@/types/app.types';

export type MediaApp = 'jellyfin' | 'plex' | 'sonarr' | 'radarr' | 'prowlarr' | 'qbittorrent' | 'transmission';
export const mediaApps: { id: MediaApp; name: string; purpose: string }[] = [
  { id: 'jellyfin', name: 'Jellyfin', purpose: 'Stream your personal media library.' },
  { id: 'plex', name: 'Plex', purpose: 'Stream your personal media library.' },
  { id: 'prowlarr', name: 'Prowlarr', purpose: 'Manage indexers for your media tools.' },
  { id: 'sonarr', name: 'Sonarr', purpose: 'Organise and monitor your TV library.' },
  { id: 'radarr', name: 'Radarr', purpose: 'Organise and monitor your film library.' },
  { id: 'qbittorrent', name: 'qBittorrent', purpose: 'A download client to connect to your library tools.' },
  { id: 'transmission', name: 'Transmission', purpose: 'A download client to connect to your library tools.' },
];

export function resolveCuratedApp(apps: AppInfoSimple[], ids: readonly string[], storeId?: string): AppInfoSimple | undefined {
  return ids.flatMap((id) =>
    apps.filter((app) => app.id === id && app.available && !app.deprecated && (!storeId || app.urn.split(':')[1] === storeId)),
  )[0];
}

export function mediaPlan(
  player: 'jellyfin' | 'plex' | null,
  companions: readonly MediaApp[],
  resolved: Partial<Record<MediaApp, AppInfoSimple>>,
  downloadClient: 'qbittorrent' | 'transmission' | null = null,
) {
  return [
    ...(player ? [player] : []),
    ...(downloadClient ? [downloadClient] : []),
    ...mediaApps
      .map((entry) => entry.id)
      .filter((id) => !['jellyfin', 'plex', 'qbittorrent', 'transmission'].includes(id) && companions.includes(id)),
  ].flatMap((id) => (resolved[id] ? [resolved[id] as AppInfoSimple] : []));
}

export function missingRecommendations(apps: AppInfoSimple[], installed: readonly { urn: string; id: string }[]) {
  const urns = new Set(installed.map((app) => app.urn));
  const ids = new Set(installed.map((app) => app.id));
  return apps.filter((app) => app.available && !app.deprecated && !urns.has(app.urn) && !ids.has(app.id));
}

export function mediaRecommendations(
  catalogue: Partial<Record<MediaApp, AppInfoSimple>>,
  installed: readonly { urn: string; id: string; name: string }[],
) {
  const existingPlayer = installed.find((app) => app.id === 'jellyfin' || app.id === 'plex');
  const existingClient = installed.find((app) => app.id === 'qbittorrent' || app.id === 'transmission');
  const resolved: Partial<Record<MediaApp, AppInfoSimple>> = {};
  for (const entry of mediaApps) {
    const app = catalogue[entry.id];
    if (existingPlayer && (entry.id === 'jellyfin' || entry.id === 'plex')) continue;
    if (existingClient && (entry.id === 'qbittorrent' || entry.id === 'transmission')) continue;
    if (app && missingRecommendations([app], installed).length) resolved[entry.id] = app;
  }
  return { resolved, existingPlayer, existingClient };
}

export function installationState(status?: string | null): 'ready' | 'busy' | 'missing' {
  if (status === 'running' || status === 'stopped') return 'ready';
  return !status || status === 'missing' ? 'missing' : 'busy';
}
