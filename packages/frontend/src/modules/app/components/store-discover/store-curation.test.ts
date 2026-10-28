import { describe, expect, test } from 'bun:test';
import type { AppInfoSimple } from '@/types/app.types';
import { installationState, mediaPlan, mediaRecommendations, missingRecommendations, resolveCuratedApp } from './store-curation';

const app = (id: string, store = 'official', overrides: Partial<AppInfoSimple> = {}): AppInfoSimple => ({
  id,
  urn: `${id}:${store}`,
  name: id,
  available: true,
  deprecated: false,
  categories: ['media'],
  created_at: 0,
  short_desc: '',
  supported_architectures: ['amd64'],
  ...overrides,
});

describe('Store collection resolution', () => {
  test('uses exact app identity from the selected repository, never a similarly named app', () => {
    const apps = [app('jellyfin-plus'), app('jellyfin', 'other'), app('jellyfin')];
    expect(resolveCuratedApp(apps, ['jellyfin'], 'official')?.urn).toBe('jellyfin:official');
    expect(resolveCuratedApp(apps, ['plex'], 'official')).toBeUndefined();
  });
  test('does not recommend unavailable or deprecated catalogue entries', () => {
    expect(resolveCuratedApp([app('plex', 'official', { available: false }), app('plex', 'other', { deprecated: true })], ['plex'])).toBeUndefined();
  });
  test('all-repository resolution retains the actual returned slug instead of inventing an official slug', () => {
    expect(resolveCuratedApp([app('plex', 'my-personal-repository')], ['plex'])?.urn).toBe('plex:my-personal-repository');
    expect(resolveCuratedApp([app('plex', 'my-personal-repository')], ['plex'], 'other')).toBeUndefined();
  });
  test('an installed player suppresses both player recommendations, including a competing player from another repository', () => {
    const result = mediaRecommendations({ jellyfin: app('jellyfin'), plex: app('plex'), sonarr: app('sonarr') }, [app('plex', 'custom-store')]);
    expect(result.existingPlayer?.urn).toBe('plex:custom-store');
    expect(Object.keys(result.resolved)).toEqual(['sonarr']);
    expect(mediaPlan(null, ['sonarr'], result.resolved).map((item) => item.id)).toEqual(['sonarr']);
  });
  test('completed media setups yield no further recommendations and partial setups expose only missing tools', () => {
    const catalogue = { jellyfin: app('jellyfin'), plex: app('plex'), sonarr: app('sonarr'), radarr: app('radarr'), prowlarr: app('prowlarr') };
    const installed = [app('jellyfin'), app('sonarr'), app('radarr'), app('prowlarr')];
    expect(Object.keys(mediaRecommendations(catalogue, installed).resolved)).toEqual([]);
    expect(Object.keys(mediaRecommendations(catalogue, installed.slice(0, 3)).resolved)).toEqual(['prowlarr']);
  });
  test('installed identity matching hides an exact URN and the same app ID from a different repository', () => {
    const apps = [app('sonarr'), app('sonarr', 'community'), app('radarr')];
    expect(missingRecommendations(apps, [app('sonarr')]).map((item) => item.urn)).toEqual(['radarr:official']);
  });
  test('a media plan includes one player and only explicitly selected, resolved companions', () => {
    const resolved = { jellyfin: app('jellyfin'), plex: app('plex'), sonarr: app('sonarr'), radarr: app('radarr') };
    expect(mediaPlan('plex', ['sonarr', 'prowlarr', 'jellyfin'], resolved).map((item) => item.id)).toEqual(['plex', 'sonarr']);
    expect(mediaPlan('jellyfin', [], resolved).map((item) => item.id)).toEqual(['jellyfin']);
  });
  test('download clients are opt-in alternatives and cannot both enter a plan through the companion selections', () => {
    const resolved = { jellyfin: app('jellyfin'), sonarr: app('sonarr'), qbittorrent: app('qbittorrent'), transmission: app('transmission') };
    expect(mediaPlan('jellyfin', ['sonarr'], resolved).map((item) => item.id)).toEqual(['jellyfin', 'sonarr']);
    expect(mediaPlan('jellyfin', ['sonarr', 'qbittorrent', 'transmission'], resolved, 'transmission').map((item) => item.id)).toEqual([
      'jellyfin',
      'transmission',
      'sonarr',
    ]);
    expect(mediaPlan('jellyfin', [], { jellyfin: app('jellyfin') }, 'qbittorrent').map((item) => item.id)).toEqual(['jellyfin']);
  });
  test('an installed download client keeps its actual repository identity and suppresses both competing client recommendations', () => {
    const result = mediaRecommendations(
      { jellyfin: app('jellyfin'), qbittorrent: app('qbittorrent'), transmission: app('transmission'), radarr: app('radarr') },
      [app('jellyfin'), app('transmission', 'private-catalogue')],
    );
    expect(result.existingClient?.urn).toBe('transmission:private-catalogue');
    expect(Object.keys(result.resolved)).toEqual(['radarr']);
  });
  test('a complete media and download setup has no competing recommendations; a partial setup exposes only missing tools', () => {
    const catalogue = {
      jellyfin: app('jellyfin'),
      plex: app('plex'),
      prowlarr: app('prowlarr'),
      sonarr: app('sonarr'),
      radarr: app('radarr'),
      qbittorrent: app('qbittorrent'),
      transmission: app('transmission'),
    };
    const installed = [app('plex'), app('prowlarr'), app('sonarr'), app('radarr'), app('qbittorrent')];
    expect(Object.keys(mediaRecommendations(catalogue, installed).resolved)).toEqual([]);
    expect(
      Object.keys(
        mediaRecommendations(
          catalogue,
          installed.filter((item) => item.id !== 'radarr'),
        ).resolved,
      ),
    ).toEqual(['radarr']);
  });
  test('queued or transitional states never count as an installed, ready app', () => {
    for (const status of ['installing', 'starting', 'updating', 'restoring', 'uninstalling', 'restarting'])
      expect(installationState(status)).toBe('busy');
    expect(installationState('running')).toBe('ready');
    expect(installationState('stopped')).toBe('ready');
    expect(installationState(null)).toBe('missing');
    expect(installationState('missing')).toBe('missing');
  });
});
