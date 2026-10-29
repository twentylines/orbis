import { describe, expect, test } from 'bun:test';
import type { AppInfoSimple } from '@/types/app.types';
import {
  installationState,
  mediaApps,
  mediaPlan,
  mediaRecommendations,
  missingRecommendations,
  resolveCuratedApp,
  storeView,
  storeEditorialFits,
} from './store-curation';
import { createElement } from 'react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { createAppQueryClient } from '@/lib/query-client';
import { getInstalledAppsOptions, searchAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { StoreCollectionArt, StoreDiscover } from './store-discover';
import { StoreTile } from '../store-tile/store-tile';
import { StoreCatalogue } from '../../pages/store-catalogue';

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

describe('catalogue-first Store presentation', () => {
  test('collection shelves follow eight real catalogue links and do not replace or duplicate any app', () => {
    const items = Array.from({ length: 12 }, (_, index) => app(`product-${index}`));
    const i18n = createInstance();
    void i18n.init({ lng: 'en', initImmediate: false, resources: { en: { translation: { APP_CATEGORY_MEDIA: 'Media' } } } });
    const html = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(
          MemoryRouter,
          {},
          createElement(StoreCatalogue, {
            apps: items,
            lastElementRef: () => undefined,
            collections: createElement('aside', { 'data-collection-shelf': true }, 'Collections'),
          }),
        ),
      ),
    );
    const shelf = html.indexOf('data-collection-shelf');
    expect(shelf).toBeGreaterThan(html.indexOf('href="/app-store/official/product-7"'));
    expect(shelf).toBeLessThan(html.indexOf('href="/app-store/official/product-8"'));
    expect(html.match(/href="\/app-store\/official\/product-/g)?.length).toBe(12);
    for (const item of items) expect(html.split(`href="/app-store/official/${item.id}"`).length).toBe(2);
    const short = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(
          MemoryRouter,
          {},
          createElement(StoreCatalogue, {
            apps: items.slice(0, 3),
            lastElementRef: () => undefined,
            collections: createElement('aside', { 'data-collection-shelf': true }, 'Collections'),
          }),
        ),
      ),
    );
    expect(short).not.toContain('data-collection-shelf');
    expect(short.match(/href="\/app-store\/official\/product-/g)?.length).toBe(3);
  });

  test('the root, explicit apps and unsupported views open the catalogue, while saved discovery URLs remain collections', () => {
    for (const value of [undefined, null, '', 'apps', 'unknown']) expect(storeView(value)).toBe('apps');
    expect(storeView('discover')).toBe('discover');
    expect(storeView('collections')).toBe('discover');
    expect(storeView('themes')).toBe('themes');
  });

  test('editorial content disappears before it crowds enlarged text and never treats invalid measurements as wide', () => {
    expect(storeEditorialFits(1088, 16)).toBe(true);
    expect(storeEditorialFits(1087, 16)).toBe(false);
    expect(storeEditorialFits(1500, 24)).toBe(false);
    expect(storeEditorialFits(1632, 24)).toBe(true);
    for (const width of [320, 390, 768]) expect(storeEditorialFits(width, 16)).toBe(false);
    for (const [width, font] of [
      [Number.POSITIVE_INFINITY, 16],
      [1200, Number.NaN],
      [1200, 0],
    ])
      expect(storeEditorialFits(width ?? 0, font ?? 0)).toBe(false);
  });

  test('product cards keep exact repository and preview history, real descriptions and availability without nested install buttons', () => {
    const item = app('jellyfin', 'community', { name: 'Jellyfin', short_desc: 'A personal media server.', available: false });
    const i18n = createInstance();
    void i18n.init({ lng: 'en', initImmediate: false, resources: { en: { translation: { APP_CATEGORY_MEDIA: 'Media' } } } });
    const html = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(
          MemoryRouter,
          { initialEntries: ['/app-store?view=apps&store=community'] },
          createElement(StoreTile, { app: item, isLoading: false }),
        ),
      ),
    );
    expect(html).toContain('/app-store/community/jellyfin?view=apps&amp;store=community');
    expect(html).toContain('/api/marketplace/apps/jellyfin%3Acommunity/image');
    expect(html).toContain('width="72"');
    expect(html.match(/loading="lazy"/g)?.length).toBe(1);
    expect([...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((match) => match[1])).toEqual([
      '/api/marketplace/apps/jellyfin%3Acommunity/image',
      '/api/marketplace/apps/jellyfin%3Acommunity/image',
    ]);
    expect(html).toContain('Unavailable');
    expect(html).toContain('Preview');
    expect(html).toContain('A personal media server.');
    expect(html).toContain('aria-describedby=');
    expect(html).not.toContain('<button');
  });

  test('collection art uses at most four actual app icons and never creates art for an empty catalogue', () => {
    const items = ['jellyfin', 'sonarr', 'radarr', 'prowlarr', 'qbittorrent'].map((id) => app(id, 'community'));
    const html = renderToStaticMarkup(createElement(StoreCollectionArt, { apps: items, kind: 'media' }));
    expect(html.match(/<img /g)?.length).toBe(4);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('/api/marketplace/apps/radarr%3Acommunity/image');
    expect(html).not.toContain('qbittorrent');
    expect(renderToStaticMarkup(createElement(StoreCollectionArt, { apps: [], kind: 'media' }))).toBe('');
  });

  test('the rendered editorial panel respects installed alternatives and opens real app previews without an app-browsing gate', () => {
    const client = createAppQueryClient();
    const installed = [app('plex', 'custom', { name: 'Plex' }), app('sonarr'), app('qbittorrent')];
    client.setQueryData([...getInstalledAppsOptions().queryKey], { installed: installed.map((info) => ({ app: { status: 'running' }, info })) });
    for (const entry of mediaApps)
      client.setQueryData([...searchAppsOptions({ query: { search: entry.name, pageSize: 24, storeId: 'community' } }).queryKey], {
        data: [app(entry.id, 'community', { name: entry.name })],
        total: 1,
        nextCursor: null,
      });
    client.setQueryData([...searchAppsOptions({ query: { search: 'Crafty', pageSize: 24, storeId: 'community' } }).queryKey], {
      data: [app('crafty', 'community', { name: 'Crafty', categories: ['gaming'] })],
      total: 1,
      nextCursor: null,
    });
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          { initialEntries: ['/app-store?view=apps&store=community'] },
          createElement(StoreDiscover, {
            presentation: 'editorial',
            storeId: 'community',
            onBrowse: () => undefined,
            onCollections: () => undefined,
          }),
        ),
      ),
    );
    expect(html).toContain('Plex is installed.');
    expect(html).toContain('Review setup');
    expect(html).toContain('/api/marketplace/apps/radarr%3Acommunity/image');
    expect(html).not.toContain('/api/marketplace/apps/jellyfin');
    expect(html).not.toContain('/api/marketplace/apps/qbittorrent');
    expect(html).toContain('/app-store/community/crafty?view=apps&amp;store=community');
    expect(html).not.toContain('Browse all apps');
    client.clear();
  });
});
