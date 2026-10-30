import { describe, expect, test } from 'bun:test';
import type { AppInfo, AppInfoSimple } from '@/types/app.types';
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
import { createElement, type ComponentType, type ReactNode } from 'react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { createAppQueryClient } from '@/lib/query-client';
import { appContextOptions, getInstalledAppsOptions, searchAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { AppContextProvider } from '@/context/app-context';
import { InstallForm } from '../install-form/install-form';
import { StoreCollectionArt, StoreDiscover } from './store-discover';
import { StoreTile } from '../store-tile/store-tile';
import { StoreCatalogue } from '../../pages/store-catalogue';
import { recommendationCategories } from './store-recommendations';
import {
  canPersistStackInstallFence,
  canRetryStackInstall,
  hasPendingStackOperation,
  reconcileStackInstall,
  stackFormRemainsMounted,
  stackInstallFenceKey,
} from './store-stack-review';
import type { TaskRecord } from '@runtipi/common/schemas';

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
  test('Emby is recognised as an installed player and suppresses Jellyfin and Plex alternatives', () => {
    const result = mediaRecommendations({ jellyfin: app('jellyfin'), plex: app('plex'), emby: app('emby'), sonarr: app('sonarr') }, [
      app('emby', 'custom-store'),
    ]);
    expect(result.existingPlayer?.urn).toBe('emby:custom-store');
    expect(Object.keys(result.resolved)).toEqual(['sonarr']);
    expect(mediaPlan(null, ['emby', 'sonarr'], result.resolved).map((item) => item.id)).toEqual(['sonarr']);
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
    const resolved = { jellyfin: app('jellyfin'), plex: app('plex'), emby: app('emby'), sonarr: app('sonarr'), radarr: app('radarr') };
    expect(mediaPlan('plex', ['sonarr', 'prowlarr', 'jellyfin'], resolved).map((item) => item.id)).toEqual(['plex', 'sonarr']);
    expect(mediaPlan('emby', ['emby', 'sonarr'], resolved).map((item) => item.id)).toEqual(['emby', 'sonarr']);
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
  test('Arr tools and Jackett appear only when their exact catalogue entries are available and not deprecated', () => {
    const catalogue = {
      sonarr: app('sonarr'),
      radarr: app('radarr'),
      prowlarr: app('prowlarr'),
      bazarr: app('bazarr'),
      lidarr: app('lidarr'),
      jackett: app('jackett'),
    };
    const result = mediaRecommendations(catalogue, []);
    expect(Object.keys(result.resolved)).toEqual(['prowlarr', 'jackett', 'sonarr', 'radarr', 'bazarr', 'lidarr']);
    expect(mediaApps.map((entry) => entry.id)).not.toContain('overseerr');
    expect(mediaPlan(null, ['sonarr', 'radarr', 'prowlarr', 'bazarr', 'lidarr', 'jackett'], result.resolved).map((item) => item.id)).toEqual([
      'prowlarr',
      'jackett',
      'sonarr',
      'radarr',
      'bazarr',
      'lidarr',
    ]);
    const filtered = mediaRecommendations(
      {
        sonarr: app('sonarr', 'official', { available: false }),
        radarr: app('radarr', 'official', { deprecated: true }),
        bazarr: app('bazarr'),
      },
      [],
    );
    expect(Object.keys(filtered.resolved)).toEqual(['bazarr']);
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

test('mounted app forms give repeated field names distinct controls and matching labels', () => {
  const client = createAppQueryClient();
  client.setQueryData<unknown>(appContextOptions().queryKey, {
    userSettings: { guestDashboard: false, localDomain: 'home.arpa', internalIp: '127.0.0.1', domain: 'example.test', maxBackups: 2 },
  });
  const i18n = createInstance();
  void i18n.init({ lng: 'en', initImmediate: false, resources: { en: { translation: {} } } });
  const forms = ['first', 'second'].map((id) =>
    createElement(InstallForm, {
      key: id,
      formId: `install-${id}`,
      onSubmit: () => undefined,
      info: { ...app(id), dynamic_config: true, exposable: true, force_expose: false, port: 8096 } as AppInfo,
      initialValues: { exposedLocal: true, exposed: true, domain: 'app.example.test', localSubdomain: 'app', port: '8096' },
      formFields: [
        { type: 'text', env_variable: 'SHARED_VALUE', label: 'Shared setting', required: false },
        { type: 'password', env_variable: 'SHARED_PASSWORD', label: 'Shared password', required: false },
      ],
    }),
  );
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(I18nextProvider, { i18n }, createElement(AppContextProvider as ComponentType<{ children?: ReactNode }>, null, forms)),
    ),
  );
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  expect(new Set(ids).size).toBe(ids.length);
  for (const label of html.matchAll(/\sfor="([^"]+)"/g)) expect(ids.filter((id) => id === label[1])).toHaveLength(1);
  for (const name of ['port', 'maxBackups', 'SHARED_VALUE', 'SHARED_PASSWORD']) {
    const fields = [...html.matchAll(/<input\b[^>]+>/g)].filter(([tag]) => tag.includes(`name="${name}"`));
    expect(fields).toHaveLength(2);
    expect(new Set(fields.map(([tag]) => tag.match(/\sid="([^"]+)"/)?.[1])).size).toBe(2);
  }
  client.clear();
});

describe('media stack install reconciliation', () => {
  const urn = 'sonarr:community';
  const requestId = 'f92e8862-38b5-4e81-bc84-f9131944872d';
  const task = (status: TaskRecord['status'], overrides: Partial<TaskRecord> = {}): TaskRecord => ({
    id: requestId,
    appUrn: urn as TaskRecord['appUrn'],
    action: 'install',
    status,
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    ...overrides,
  });

  test('unknown or timed-out POST stays fenced when a fresh app read still says missing', () => {
    const fence = { state: 'uncertain' } as const;
    expect(reconcileStackInstall(urn, fence, undefined, 'missing').status).toBe('uncertain');
    expect(canRetryStackInstall(urn, fence, undefined, 'missing', true, [])).toBe(false);
    expect(reconcileStackInstall(urn, undefined, undefined, 'missing').retryAllowed).toBeUndefined();
  });

  test('install fences are isolated by account and server and fail closed when session storage is unavailable', () => {
    expect(stackInstallFenceKey(7, 'https://server-a.example')).not.toBe(stackInstallFenceKey(8, 'https://server-a.example'));
    expect(stackInstallFenceKey(7, 'https://server-a.example')).not.toBe(stackInstallFenceKey(7, 'https://server-b.example'));
    expect(canPersistStackInstallFence(undefined)).toBe(false);
    expect(
      canPersistStackInstallFence({
        setItem: () => {
          throw new Error('blocked');
        },
        removeItem: () => undefined,
      }),
    ).toBe(false);
    const stored = new Map<string, string>();
    expect(
      canPersistStackInstallFence({
        setItem: (key, value) => void stored.set(key, value),
        removeItem: (key) => void stored.delete(key),
      }),
    ).toBe(true);
    expect(stored.size).toBe(0);
  });

  test('an acknowledged request follows only its exact queued or running task', () => {
    const fence = { state: 'accepted', requestId } as const;
    for (const status of ['queued', 'running'] as const) {
      const current = reconcileStackInstall(urn, fence, task(status), 'missing');
      expect(current.status).toBe('accepted');
      expect(current.retryAllowed).toBeUndefined();
    }
    expect(reconcileStackInstall(urn, fence, task('running', { id: 'another-request' }), 'missing').status).toBe('accepted');
    expect(reconcileStackInstall(urn, fence, task('failed', { appUrn: 'radarr:community' as TaskRecord['appUrn'] }), 'missing').status).toBe(
      'accepted',
    );
    const busy = reconcileStackInstall(urn, fence, task('running'), 'busy');
    expect(busy.status).toBe('busy');
    expect(stackFormRemainsMounted('busy', busy.status)).toBe(true);
  });

  test('only exact definitive failure plus fresh missing state unlocks one retry', () => {
    const accepted = { state: 'accepted', requestId } as const;
    const failed = task('failed');
    const outcome = reconcileStackInstall(urn, accepted, failed, 'missing');
    expect(outcome).toMatchObject({ status: 'needs-check', taskStatus: 'failed', retryAllowed: true });
    expect(stackFormRemainsMounted('missing', outcome.status)).toBe(true);
    expect(canRetryStackInstall(urn, accepted, failed, 'missing', true, [failed])).toBe(true);
    expect(canRetryStackInstall(urn, accepted, failed, 'busy', true, [failed])).toBe(false);
    expect(canRetryStackInstall(urn, accepted, failed, 'ready', true, [failed])).toBe(false);
    expect(canRetryStackInstall(urn, accepted, failed, 'missing', false, [failed])).toBe(false);
    expect(canRetryStackInstall(urn, accepted, task('failed', { id: 'another-request' }), 'missing', true, [failed])).toBe(false);
    expect(
      canRetryStackInstall(urn, accepted, task('failed', { appUrn: 'radarr:community' as TaskRecord['appUrn'] }), 'missing', true, [failed]),
    ).toBe(false);
    expect(canRetryStackInstall(urn, accepted, task('interrupted'), 'missing', true, [failed])).toBe(false);
    expect(canRetryStackInstall(urn, { state: 'uncertain' }, failed, 'missing', true, [failed])).toBe(false);
    // Once the retry replaces the accepted fence with an uncertain submission, the old failed task cannot unlock another retry.
    expect(canRetryStackInstall(urn, { state: 'uncertain' }, failed, 'missing', true, [failed])).toBe(false);
  });

  test('a different live or unresolved operation on the same app blocks retry even after an exact failure', () => {
    const accepted = { state: 'accepted', requestId } as const;
    const failed = task('failed');
    for (const status of ['queued', 'running', 'unconfirmed', 'interrupted'] as const) {
      const other = task(status, { id: 'different-operation', action: 'update' });
      expect(hasPendingStackOperation(urn, [other])).toBe(true);
      expect(canRetryStackInstall(urn, accepted, failed, 'missing', true, [failed, other])).toBe(false);
      expect(
        canRetryStackInstall(urn, accepted, failed, 'missing', true, [failed, { ...other, appUrn: 'radarr:community' as TaskRecord['appUrn'] }]),
      ).toBe(true);
    }
  });

  test('successful and fresh-busy app reads remain non-retryable while submitted forms stay mounted through failure recovery', () => {
    const accepted = { state: 'accepted', requestId } as const;
    expect(reconcileStackInstall(urn, accepted, task('failed'), 'ready').status).toBe('ready');
    expect(reconcileStackInstall(urn, accepted, task('failed'), 'busy').status).toBe('busy');
    expect(stackFormRemainsMounted('busy', 'accepted')).toBe(true);
    expect(stackFormRemainsMounted('missing', 'needs-check')).toBe(true);
    expect(stackFormRemainsMounted('ready', 'accepted')).toBe(false);
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
    expect(storeEditorialFits(1088, 640, 16)).toBe(true);
    expect(storeEditorialFits(1087, 640, 16)).toBe(false);
    expect(storeEditorialFits(1500, 960, 24)).toBe(false);
    expect(storeEditorialFits(1632, 960, 24)).toBe(true);
    for (const width of [320, 390, 768]) expect(storeEditorialFits(width, 960, 16)).toBe(false);
    for (const [width, font] of [
      [Number.POSITIVE_INFINITY, 16],
      [1200, Number.NaN],
      [1200, 0],
    ])
      expect(storeEditorialFits(width ?? 0, 960, font ?? 0)).toBe(false);
  });

  test('wide but short catalogue panes retain browsing space, including when text is enlarged', () => {
    expect(storeEditorialFits(1800, 400, 16)).toBe(false);
    expect(storeEditorialFits(1800, 639, 16)).toBe(false);
    expect(storeEditorialFits(1800, 640, 16)).toBe(true);
    expect(storeEditorialFits(1800, 711, 24)).toBe(false);
    expect(storeEditorialFits(1800, 960, 24)).toBe(true);
    for (const height of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(storeEditorialFits(1800, height, 16)).toBe(false);
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
    for (const { category } of recommendationCategories) {
      client.setQueryData([...searchAppsOptions({ query: { category, pageSize: 60, storeId: 'community' } }).queryKey], {
        data: category === 'gaming' ? [app('crafty', 'community', { name: 'Crafty', categories: ['gaming'] })] : [],
        total: category === 'gaming' ? 1 : 0,
        nextCursor: null,
      });
    }
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
            seed: 'fixture',
            onBrowse: () => undefined,
            onCollections: () => undefined,
          }),
        ),
      ),
    );
    expect(html).toContain('Plex is installed.');
    expect(html).toContain('>Continue <svg');
    expect(html).toContain('/api/marketplace/apps/radarr%3Acommunity/image');
    expect(html).not.toContain('/api/marketplace/apps/jellyfin');
    expect(html).not.toContain('/api/marketplace/apps/qbittorrent');
    expect(html).toContain('/app-store/community/crafty?view=apps&amp;store=community');
    expect(html).not.toContain('Browse all apps');
    client.clear();
  });
});
