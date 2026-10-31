import { describe, expect, test } from 'bun:test';
import type { AppInfoSimple } from '@/types/app.types';
import { defaultDesktopPreferences, isPreferences, normalisePreferences } from '@/desktop/preferences';
import {
  recommendStoreApps,
  recommendationCategories,
  storeRecommendationCategoryIds,
  validHiddenRecommendationCategories,
} from './store-recommendations';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { createAppQueryClient } from '@/lib/query-client';
import { getInstalledAppsOptions, searchAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { disableStoreRecommendations, StoreCollectionArt, StoreDiscover, suggestionItemMotion, suggestionSurfaceMotion } from './store-discover';
import { StoreCatalogue, storeCataloguePositionMotion } from '@/modules/app/pages/store-catalogue';
import { mediaApps } from './store-curation';
import { StoreRecommendationSettings } from '@/modules/settings/containers/store-recommendation-settings';
import { StorePreviewContext, type StorePreview } from '../../pages/store-preview-context';

const app = (id: string, category: AppInfoSimple['categories'][number], overrides: Partial<AppInfoSimple> = {}): AppInfoSimple => ({
  id,
  urn: `${id}:enabled`,
  name: id,
  available: true,
  deprecated: false,
  categories: [category],
  created_at: 0,
  short_desc: '',
  supported_architectures: ['amd64'],
  ...overrides,
});

describe('catalogue-aware recommendations', () => {
  test('only available enabled catalogue identities are recommended, with installed IDs excluded across repositories', () => {
    const result = recommendStoreApps(
      [
        app('crafty', 'gaming'),
        app('valheim', 'gaming'),
        app('removed', 'ai', { available: false }),
        app('old', 'finance', { deprecated: true }),
        app('valheim', 'gaming', { urn: 'valheim:other' }),
      ],
      [app('crafty', 'gaming', { urn: 'crafty:other' })],
      'view',
      'enabled',
    );
    expect(result.flatMap((entry) => entry.apps.map((app) => app.urn))).toEqual(['valheim:enabled']);
  });
  test('gaming apps are not all game hosts and an installed unrelated game app does not suppress hosting choices', () => {
    const result = recommendStoreApps(
      [app('romm', 'gaming'), app('crafty', 'gaming'), app('pufferpanel', 'gaming')],
      [app('romm', 'gaming')],
      'view',
    );
    expect(result[0]?.choiceCount).toBe(2);
    expect(result[0]?.apps).toHaveLength(2);
    expect(result[0]?.apps.map((app) => app.id).sort()).toEqual(['crafty', 'pufferpanel']);
    expect(recommendStoreApps([app('romm', 'gaming'), app('crafty-lookalike', 'gaming')], [], 'view')).toEqual([]);
  });
  test('an installed panel can expose another real hosting option without creating a dependency or install plan', () => {
    const result = recommendStoreApps([app('crafty', 'gaming'), app('valheim', 'gaming')], [app('crafty', 'gaming')], 'view');
    expect(result[0]?.apps.map((app) => app.id)).toEqual(['valheim']);
    expect(Object.keys(result[0] ?? {}).sort()).toEqual(['apps', 'category', 'choiceCount', 'title']);
  });
  test('selection and order remain stable across rerenders and catalogue ordering; rotation is explicit', () => {
    const catalogue = [app('valheim', 'gaming'), app('crafty', 'gaming'), app('ollama', 'ai'), app('actual-budget', 'finance')];
    expect(recommendStoreApps(catalogue, [], 'same')).toEqual(recommendStoreApps([...catalogue].reverse(), [], 'same'));
    const one = recommendStoreApps(catalogue.slice(0, 2), [], 'same');
    const two = recommendStoreApps(catalogue.slice(0, 2), [], 'same', undefined, 1);
    expect(one[0]?.apps[0]?.id).not.toBe(two[0]?.apps[0]?.id);
    expect(recommendStoreApps(catalogue, [], 'same', undefined, Number.NaN)).toEqual(recommendStoreApps(catalogue, [], 'same'));
  });
  test('AI and development complements rank ahead of unrelated choices without reinstalling their existing half', () => {
    const result = recommendStoreApps(
      [app('ollama', 'ai'), app('open-webui', 'ai'), app('other-ai', 'ai'), app('actual-budget', 'finance')],
      [app('open-webui', 'ai')],
      'view',
    );
    expect(result[0]?.category).toBe('ai');
    expect(result[0]?.apps[0]?.id).toBe('ollama');
  });
  test('multi-category entries and duplicate repositories never repeat an identity in the same set', () => {
    const result = recommendStoreApps(
      [app('both', 'ai', { categories: ['ai', 'development'] }), app('both', 'ai', { urn: 'both:other' })],
      [],
      'view',
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.choiceCount).toBe(1);
    expect(result[0]?.apps).toHaveLength(1);
  });
  test('each category offers several available uninstalled apps with stable unique identities', () => {
    const result = recommendStoreApps(
      [
        app('crafty', 'gaming'),
        app('valheim', 'gaming'),
        app('pufferpanel', 'gaming'),
        app('amp', 'gaming'),
        app('crafty', 'gaming', { urn: 'crafty:other' }),
      ],
      [],
      'view',
      'enabled',
    );
    const games = result.find((entry) => entry.category === 'gaming');
    expect(games?.choiceCount).toBe(4);
    expect(games?.apps).toHaveLength(3);
    expect(new Set(games?.apps.map((app) => app.id)).size).toBe(3);
    expect(games?.apps.every((app) => app.urn.endsWith(':enabled'))).toBe(true);
    const next = recommendStoreApps(
      [app('crafty', 'gaming'), app('valheim', 'gaming'), app('pufferpanel', 'gaming'), app('amp', 'gaming')],
      [],
      'view',
      'enabled',
      1,
    ).find((entry) => entry.category === 'gaming');
    expect(next?.apps.map((app) => app.id)).not.toEqual(games?.apps.map((app) => app.id));
    expect(recommendStoreApps([app('crafty', 'gaming'), app('valheim', 'gaming')], [app('crafty', 'gaming')], 'view')[0]?.apps).toEqual([
      app('valheim', 'gaming'),
    ]);
  });
  test('hidden categories are excluded before identity allocation and missing categories never create placeholders', () => {
    const catalogue = [app('both', 'ai', { categories: ['ai', 'development'] })];
    expect(recommendStoreApps(catalogue, [], 'view', undefined, 0, ['ai'])[0]?.category).toBe('development');
    expect(recommendStoreApps(catalogue, [], 'view', undefined, 0, storeRecommendationCategoryIds)).toEqual([]);
    expect(recommendStoreApps([], [], 'view')).toEqual([]);
  });
});

describe('recommendation transitions', () => {
  test('content changes use bounded opacity and translation without scaling text', () => {
    const motion = suggestionItemMotion(false, true);
    expect(motion.initial).toEqual({ opacity: 0, y: 4 });
    expect(motion.animate).toEqual({ opacity: 1, y: 0 });
    expect(motion.exit).toEqual({ opacity: 0, y: -4 });
    expect(motion.transition.duration).toBeGreaterThan(0);
    expect(motion).not.toHaveProperty('scale');
  });

  test('reduced motion and hidden documents settle new and exiting content immediately', () => {
    for (const motion of [suggestionItemMotion(true, true), suggestionItemMotion(false, false)]) {
      expect(motion.transition.duration).toBe(0);
      expect(motion.initial).toEqual({ opacity: 1, y: 0 });
      expect(motion.exit).toEqual({ opacity: 0, y: 0 });
    }
  });

  test('editorial entry and exit use position-only layout while page presentation collapses its padding', () => {
    const editorial = suggestionSurfaceMotion('editorial', false, true);
    expect(editorial.layout).toBe('position');
    expect(editorial.initial).toEqual({ opacity: 0, y: 4 });
    expect(editorial.animate).toEqual({ opacity: 1, y: 0 });
    expect(editorial.exit).toEqual({ opacity: 0, y: -4 });
    expect(editorial.exit).not.toHaveProperty('height');
    expect(suggestionSurfaceMotion('editorial', false, true, false).initial).toBe(false);

    const page = suggestionSurfaceMotion('page', false, true);
    expect(page.initial).toMatchObject({ height: 0, paddingTop: 0, paddingBottom: 0 });
    expect(page.animate).toMatchObject({ height: 'auto', paddingTop: 12, paddingBottom: 12 });
    expect(page.exit).toMatchObject({ height: 0, paddingTop: 0, paddingBottom: 0 });
  });

  test('catalogue reflow uses bounded position-only motion and disables it when hidden or reduced', () => {
    expect(storeCataloguePositionMotion(false, true)).toMatchObject({
      layout: 'position',
      transition: { duration: expect.any(Number), ease: [0.32, 0.08, 0.24, 1] },
    });
    expect(storeCataloguePositionMotion(true, true).transition.duration).toBe(0);
    expect(storeCataloguePositionMotion(false, false).transition.duration).toBe(0);

    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(StoreCatalogue, {
          apps: [app('one', 'ai'), app('two', 'ai')],
          collections: createElement('div', { className: 'orbis-store-editorial' }, 'suggestions'),
          collectionsAfter: 1,
          lastElementRef: () => {},
        }),
      ),
    );
    expect(html.match(/class="orbis-store-grid-item"/g)).toHaveLength(2);
    expect(html.indexOf('orbis-store-editorial')).toBeGreaterThan(html.indexOf('orbis-store-grid-item'));
    expect(html.lastIndexOf('orbis-store-grid-item')).toBeGreaterThan(html.indexOf('orbis-store-editorial'));
  });
});

describe('recommendation preferences', () => {
  test('the Store hide button writes the global preference used by Settings', () => {
    let update: { showStoreRecommendations: boolean } | undefined;
    disableStoreRecommendations((next) => {
      update = next;
    });
    const saved = normalisePreferences({ ...defaultDesktopPreferences, ...update });
    expect(saved.showStoreRecommendations).toBe(false);

    const settings = renderToStaticMarkup(
      createElement(StoreRecommendationSettings, { shown: saved.showStoreRecommendations, hidden: [], onChange: () => {}, onRestore: () => {} }),
    );
    expect(settings).toContain('aria-checked="false"');
  });

  test('legacy preferences default to shown and unhidden; account import/export preserves independent choices', () => {
    const { showStoreRecommendations: _shown, hiddenStoreRecommendationCategories: _hidden, ...legacy } = defaultDesktopPreferences;
    expect(isPreferences(legacy)).toBe(true);
    expect(normalisePreferences(legacy).showStoreRecommendations).toBe(true);
    expect(normalisePreferences(legacy).hiddenStoreRecommendationCategories).toEqual([]);
    const saved = JSON.parse(
      JSON.stringify({ ...defaultDesktopPreferences, showStoreRecommendations: false, hiddenStoreRecommendationCategories: ['gaming', 'finance'] }),
    );
    expect(isPreferences(saved)).toBe(true);
    const restored = normalisePreferences(saved);
    expect(restored.showStoreRecommendations).toBe(false);
    expect(restored.hiddenStoreRecommendationCategories).toEqual(['gaming', 'finance']);
  });
  test('malformed saved hide lists or switch values cannot enter the preference cache', () => {
    for (const value of [null, 'gaming', ['unknown'], ['gaming', 'gaming'], [false]]) expect(validHiddenRecommendationCategories(value)).toBe(false);
    expect(validHiddenRecommendationCategories(['gaming', 'media'])).toBe(true);
    expect(isPreferences({ ...defaultDesktopPreferences, showStoreRecommendations: 'false' })).toBe(false);
    expect(isPreferences({ ...defaultDesktopPreferences, hiddenStoreRecommendationCategories: ['invalid'] })).toBe(false);
  });
  test('Settings exposes a labelled switch and a separate restore action', () => {
    const html = renderToStaticMarkup(
      createElement(StoreRecommendationSettings, { shown: false, hidden: ['gaming'], onChange: () => {}, onRestore: () => {} }),
    );
    expect(html).toContain('Show suggestions');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('Restore hidden categories');
    expect(html).not.toContain('href=');
  });
});

function renderSuggestions({
  catalogue = [],
  mediaCatalogue = [],
  installedApps = [],
  installedStatus = 'running',
  hidden = [],
  enabled = true,
  preview = null,
}: {
  catalogue?: AppInfoSimple[];
  mediaCatalogue?: AppInfoSimple[];
  installedApps?: AppInfoSimple[];
  installedStatus?: string;
  hidden?: (typeof storeRecommendationCategoryIds)[number][];
  enabled?: boolean;
  preview?: StorePreview | null;
} = {}) {
  const client = createAppQueryClient();
  client.setQueryData([...getInstalledAppsOptions().queryKey], {
    installed: installedApps.map((info) => ({ app: { status: installedStatus }, info })),
  });
  for (const entry of mediaApps)
    client.setQueryData([...searchAppsOptions({ query: { search: entry.name, pageSize: 24 } }).queryKey], {
      data: mediaCatalogue.filter((app) => app.id === entry.id),
      total: mediaCatalogue.length,
    });
  for (const { category } of recommendationCategories)
    client.setQueryData([...searchAppsOptions({ query: { category, pageSize: 60 } }).queryKey], {
      data: catalogue.filter((entry) => entry.categories.includes(category)),
      total: catalogue.length,
    });
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: ['/app-store'] },
        createElement(
          StorePreviewContext.Provider,
          { value: preview },
          createElement(StoreDiscover, {
            onBrowse: () => {},
            onDisableSuggestions: () => {},
            enabled,
            hiddenCategories: hidden,
            onHideCategory: () => {},
            presentation: 'editorial',
            seed: 'fixture',
          }),
        ),
      ),
    ),
  );
  client.clear();
  return html;
}

test('empty, installed-only, hidden-all and globally disabled suggestions create no heading or container', () => {
  expect(renderSuggestions()).toBe('');
  expect(renderSuggestions({ catalogue: [app('crafty', 'gaming')], installedApps: [app('crafty', 'gaming')] })).toBe('');
  expect(renderSuggestions({ catalogue: [app('romm', 'gaming')] })).toBe('');
  expect(renderSuggestions({ catalogue: [app('crafty', 'gaming')], hidden: ['gaming'] })).toBe('');
  expect(renderSuggestions({ catalogue: [app('crafty', 'gaming')], enabled: false })).toBe('');
});

test('real recommendation cards contain full category actions, real preview links and no install action', () => {
  const html = renderSuggestions({
    catalogue: [app('crafty', 'gaming'), app('valheim', 'gaming'), app('pufferpanel', 'gaming'), app('amp', 'gaming')],
  });
  expect(html).toContain('Game hosting');
  expect(html).toContain('/app-store/enabled/valheim');
  expect(html).toContain('/app-store/enabled/crafty');
  expect(html.match(/orbis-store-recommendation-preview/g)).toHaveLength(3);
  expect(html).toContain('Browse Game hosting');
  expect(html).toContain('Refresh');
  expect(html).toContain('Do not show suggestions');
  expect(html.match(/data-recommendation-key=/g)).toHaveLength(3);
  expect(html).toContain('data-recommendation-key="valheim:enabled"');
  expect(html).not.toContain('Other suggestions');
  expect(html).toContain('Don&#x27;t show again');
  expect(html).toContain('Dismiss Game hosting suggestions for this visit');
  expect(html).not.toContain('Install');
});

test('media art shows up to six real stack icons and the media section hides after a strict installed-role majority', () => {
  const mediaCatalogue = mediaApps.map(({ id }) => app(id, 'media', { urn: `${id}:community`, categories: ['media'] }));
  const allRoles = [
    app('jellyfin', 'media', { urn: 'jellyfin:community' }),
    app('sonarr', 'media', { urn: 'sonarr:community' }),
    app('radarr', 'media', { urn: 'radarr:community' }),
    app('prowlarr', 'media', { urn: 'prowlarr:community' }),
  ];
  const exactThreeOfSeven = allRoles.slice(0, 3);
  const art = renderSuggestions({ mediaCatalogue });
  expect(art).toContain('data-stack-grid=""');
  expect(art.match(/class="orbis-store-artwork-app"/g)).toHaveLength(6);
  expect(renderSuggestions({ mediaCatalogue, installedApps: exactThreeOfSeven })).toContain('Media library');
  expect(renderSuggestions({ mediaCatalogue, installedApps: allRoles })).not.toContain('Media library');
  expect(
    renderSuggestions({
      mediaCatalogue,
      installedApps: [app('jellyfin', 'media', { urn: 'jellyfin:community' })],
      installedStatus: 'installing',
    }),
  ).not.toContain('Media library');
});

test('game artwork uses centered single-icon positioning and a non-overlapping grid for multiple choices', () => {
  const single = renderToStaticMarkup(createElement(StoreCollectionArt, { apps: [app('crafty', 'gaming')], kind: 'gaming' }));
  expect(single).toContain('data-collection-kind="gaming" data-art-count="1"');
  expect(single).not.toContain('data-stack-grid');
  expect(single).toContain('class="orbis-store-artwork-app" data-art-position="0"');

  const three = renderToStaticMarkup(
    createElement(StoreCollectionArt, {
      apps: [app('crafty', 'gaming'), app('valheim', 'gaming'), app('pufferpanel', 'gaming')],
      kind: 'gaming',
    }),
  );
  expect(three).toContain('data-collection-kind="gaming" data-art-count="3" data-stack-grid=""');
  expect(three.match(/class="orbis-store-artwork-app" data-art-position=/g)).toHaveLength(3);
  expect(three).toContain('class="orbis-store-artwork-app" data-art-position="0"');
  expect(three).toContain('class="orbis-store-artwork-app" data-art-position="1"');
  expect(three).toContain('class="orbis-store-artwork-app" data-art-position="2"');
});

test('an open split preview hides the entire recommendation section', () => {
  const html = renderSuggestions({
    catalogue: [app('crafty', 'gaming')],
    preview: {
      closePath: '/app-store',
      split: true,
      selectedUrn: 'crafty:enabled',
      onCardMount: () => {},
      onDetailsMount: () => {},
      previewId: 'fixture',
      close: () => {},
      nextHistory: () => ({}),
    },
  });
  expect(html).toBe('');
});
