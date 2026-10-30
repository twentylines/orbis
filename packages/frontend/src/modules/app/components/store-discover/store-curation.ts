import type { AppInfoSimple } from '@/types/app.types';

export const mediaPlayers = ['jellyfin', 'plex', 'emby'] as const;
export type MediaPlayer = (typeof mediaPlayers)[number];
export type MediaApp = MediaPlayer | 'sonarr' | 'radarr' | 'prowlarr' | 'bazarr' | 'lidarr' | 'jackett' | 'qbittorrent' | 'transmission';
export function isMediaPlayer(id: MediaApp): id is MediaPlayer {
  return mediaPlayers.includes(id as MediaPlayer);
}
export const mediaApps: { id: MediaApp; name: string; purpose: string }[] = [
  { id: 'jellyfin', name: 'Jellyfin', purpose: 'Stream your personal media library.' },
  { id: 'plex', name: 'Plex', purpose: 'Stream your personal media library.' },
  { id: 'emby', name: 'Emby', purpose: 'Stream your personal media library.' },
  { id: 'prowlarr', name: 'Prowlarr', purpose: 'Manage indexers for your media tools.' },
  { id: 'jackett', name: 'Jackett', purpose: 'Connect indexers to compatible media tools.' },
  { id: 'sonarr', name: 'Sonarr', purpose: 'Organise and monitor your TV library.' },
  { id: 'radarr', name: 'Radarr', purpose: 'Organise and monitor your film library.' },
  { id: 'bazarr', name: 'Bazarr', purpose: 'Find subtitles for your media library.' },
  { id: 'lidarr', name: 'Lidarr', purpose: 'Organise and monitor your music library.' },
  { id: 'qbittorrent', name: 'qBittorrent', purpose: 'A download client to connect to your library tools.' },
  { id: 'transmission', name: 'Transmission', purpose: 'A download client to connect to your library tools.' },
];

const mediaStackRoles: { role: string; ids: readonly MediaApp[] }[] = [
  { role: 'player', ids: mediaPlayers },
  { role: 'indexer', ids: ['prowlarr', 'jackett'] },
  { role: 'download-client', ids: ['qbittorrent', 'transmission'] },
  { role: 'tv', ids: ['sonarr'] },
  { role: 'movies', ids: ['radarr'] },
  { role: 'subtitles', ids: ['bazarr'] },
  { role: 'music', ids: ['lidarr'] },
];

export function mediaStackCoverage(catalogue: Partial<Record<MediaApp, AppInfoSimple>>, installed: readonly { id: string; status?: string }[]) {
  const installedIds = new Set(installed.filter((app) => installationState(app.status) === 'ready').map((app) => app.id));
  const availableRoles = mediaStackRoles.filter(({ ids }) =>
    ids.some((id) => {
      const app = catalogue[id];
      return app?.available && !app.deprecated;
    }),
  );
  const installedRoles = availableRoles.filter(({ ids }) => ids.some((id) => installedIds.has(id)));
  return {
    availableRoleCount: availableRoles.length,
    installedRoleCount: installedRoles.length,
    majorityInstalled: availableRoles.length > 0 && installedRoles.length * 2 > availableRoles.length,
  };
}

export function resolveCuratedApp(apps: AppInfoSimple[], ids: readonly string[], storeId?: string): AppInfoSimple | undefined {
  return ids.flatMap((id) =>
    apps.filter((app) => app.id === id && app.available && !app.deprecated && (!storeId || app.urn.split(':')[1] === storeId)),
  )[0];
}

export function mediaPlan(
  player: MediaPlayer | null,
  companions: readonly MediaApp[],
  resolved: Partial<Record<MediaApp, AppInfoSimple>>,
  downloadClient: 'qbittorrent' | 'transmission' | null = null,
) {
  return [
    ...(player ? [player] : []),
    ...(downloadClient ? [downloadClient] : []),
    ...mediaApps
      .map((entry) => entry.id)
      .filter((id) => !isMediaPlayer(id) && !['qbittorrent', 'transmission'].includes(id) && companions.includes(id)),
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
  const existingPlayer = installed.find((app) => app.id === 'jellyfin' || app.id === 'plex' || app.id === 'emby');
  const existingClient = installed.find((app) => app.id === 'qbittorrent' || app.id === 'transmission');
  const resolved: Partial<Record<MediaApp, AppInfoSimple>> = {};
  for (const entry of mediaApps) {
    const app = catalogue[entry.id];
    if (existingPlayer && isMediaPlayer(entry.id)) continue;
    if (existingClient && (entry.id === 'qbittorrent' || entry.id === 'transmission')) continue;
    if (app && missingRecommendations([app], installed).length) resolved[entry.id] = app;
  }
  return { resolved, existingPlayer, existingClient };
}

export function installationState(status?: string | null): 'ready' | 'busy' | 'missing' {
  if (status === 'running' || status === 'stopped') return 'ready';
  return !status || status === 'missing' ? 'missing' : 'busy';
}

export function storeView(value: string | null | undefined): 'apps' | 'discover' | 'themes' {
  return value === 'themes' ? 'themes' : value === 'discover' || value === 'collections' ? 'discover' : 'apps';
}

export function storeEditorialFits(width: number, height: number, rootFontSize: number) {
  return (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    Number.isFinite(rootFontSize) &&
    rootFontSize > 0 &&
    width >= 68 * rootFontSize &&
    height >= 40 * rootFontSize
  );
}
