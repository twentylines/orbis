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
import { StoreDiscover } from './store-discover';
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
    expect(result.map((entry) => entry.app.urn)).toEqual(['valheim:enabled']);
  });
  test('gaming apps are not all game hosts and an installed unrelated game app does not suppress hosting choices', () => {
    const result = recommendStoreApps(
      [app('romm', 'gaming'), app('crafty', 'gaming'), app('pufferpanel', 'gaming')],
      [app('romm', 'gaming')],
      'view',
    );
    expect(result[0]?.choiceCount).toBe(2);
    expect(['crafty', 'pufferpanel']).toContain(result[0]?.app.id ?? '');
    expect(recommendStoreApps([app('romm', 'gaming'), app('crafty-lookalike', 'gaming')], [], 'view')).toEqual([]);
  });
  test('an installed panel can expose another real hosting option without creating a dependency or install plan', () => {
    const result = recommendStoreApps([app('crafty', 'gaming'), app('valheim', 'gaming')], [app('crafty', 'gaming')], 'view');
    expect(result[0]?.app.id).toBe('valheim');
    expect(Object.keys(result[0] ?? {}).sort()).toEqual(['app', 'category', 'choiceCount', 'title']);
  });
  test('selection and order remain stable across rerenders and catalogue ordering; rotation is explicit', () => {
    const catalogue = [app('valheim', 'gaming'), app('crafty', 'gaming'), app('ollama', 'ai'), app('actual-budget', 'finance')];
    expect(recommendStoreApps(catalogue, [], 'same')).toEqual(recommendStoreApps([...catalogue].reverse(), [], 'same'));
    const one = recommendStoreApps(catalogue.slice(0, 2), [], 'same');
    const two = recommendStoreApps(catalogue.slice(0, 2), [], 'same', undefined, 1);
    expect(one[0]?.app.id).not.toBe(two[0]?.app.id);
    expect(recommendStoreApps(catalogue, [], 'same', undefined, Number.NaN)).toEqual(recommendStoreApps(catalogue, [], 'same'));
  });
  test('AI and development complements rank ahead of unrelated choices without reinstalling their existing half', () => {
    const result = recommendStoreApps(
      [app('ollama', 'ai'), app('open-webui', 'ai'), app('other-ai', 'ai'), app('actual-budget', 'finance')],
      [app('open-webui', 'ai')],
      'view',
    );
    expect(result[0]?.category).toBe('ai');
    expect(result[0]?.app.id).toBe('ollama');
  });
  test('multi-category entries and duplicate repositories never repeat an identity in the same set', () => {
    const result = recommendStoreApps(
      [app('both', 'ai', { categories: ['ai', 'development'] }), app('both', 'ai', { urn: 'both:other' })],
      [],
      'view',
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.choiceCount).toBe(1);
  });
  test('hidden categories are excluded before identity allocation and missing categories never create placeholders', () => {
    const catalogue = [app('both', 'ai', { categories: ['ai', 'development'] })];
    expect(recommendStoreApps(catalogue, [], 'view', undefined, 0, ['ai'])[0]?.category).toBe('development');
    expect(recommendStoreApps(catalogue, [], 'view', undefined, 0, storeRecommendationCategoryIds)).toEqual([]);
    expect(recommendStoreApps([], [], 'view')).toEqual([]);
  });
});

describe('recommendation preferences', () => {
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
    expect(html).toContain('Show Store recommendations');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('Restore hidden categories');
    expect(html).not.toContain('href=');
  });
});

function renderSuggestions({
  catalogue = [],
  installedApps = [],
  hidden = [],
  enabled = true,
  preview = null,
}: {
  catalogue?: AppInfoSimple[];
  installedApps?: AppInfoSimple[];
  hidden?: (typeof storeRecommendationCategoryIds)[number][];
  enabled?: boolean;
  preview?: StorePreview | null;
} = {}) {
  const client = createAppQueryClient();
  client.setQueryData([...getInstalledAppsOptions().queryKey], { installed: installedApps.map((info) => ({ app: { status: 'running' }, info })) });
  for (const entry of mediaApps)
    client.setQueryData([...searchAppsOptions({ query: { search: entry.name, pageSize: 24 } }).queryKey], { data: [], total: 0 });
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
  const html = renderSuggestions({ catalogue: [app('valheim', 'gaming')] });
  expect(html).toContain('Game hosting');
  expect(html).toContain('/app-store/enabled/valheim');
  expect(html).toContain('Don&#x27;t show again');
  expect(html).toContain('Dismiss Game hosting suggestions for this visit');
  expect(html).not.toContain('Install');
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
