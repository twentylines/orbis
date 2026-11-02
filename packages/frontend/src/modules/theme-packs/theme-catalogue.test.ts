/// <reference types="bun" />
import { expect, test } from 'bun:test';
import type { ThemePackManifest, ThemePackSnapshot } from '@runtipi/common/schemas/theme-pack';
import {
  compareThemeVersions,
  themeCatalogue,
  themeVersions,
  themeStoreVersions,
  themeStoreCatalogue,
  themeStoreEmptyMessage,
} from './theme-catalogue';

const pack = (id: string, version: string, name: string, description = '', author = 'Photographer') =>
  ({ id, version, name, description, author }) as ThemePackManifest;
test('Store groups versioned packs by identity and chooses the latest numeric version regardless of API order', () => {
  const catalogue = [pack('alpine', '1.10.0', 'Alpine'), pack('woodland', '1.0.0', 'Woodland'), pack('alpine', '1.2.0', 'Alpine')];
  expect(themeCatalogue(catalogue).map((item) => `${item.id}@${item.version}`)).toEqual(['alpine@1.10.0', 'woodland@1.0.0']);
  expect(themeVersions(catalogue, 'alpine').map((item) => item.version)).toEqual(['1.2.0', '1.10.0']);
  expect(catalogue.map((item) => item.version)).toEqual(['1.10.0', '1.0.0', '1.2.0']);
  expect(compareThemeVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
});
test('Theme search is local, case-insensitive and matches name, treatment description or photographer', () => {
  const catalogue = [
    pack('alpine', '1.1.0', 'Alpine', 'Pale stone surfaces', 'Willian'),
    pack('tideline', '1.1.0', 'Tideline', 'Quiet blue controls', 'Annie'),
  ];
  expect(themeCatalogue(catalogue, '  ALPINE stone ').map((item) => item.id)).toEqual(['alpine']);
  expect(themeCatalogue(catalogue, 'annie').map((item) => item.id)).toEqual(['tideline']);
  expect(themeCatalogue(catalogue, 'remote import')).toEqual([]);
  expect(themeCatalogue([], 'anything')).toEqual([]);
});

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { bundledThemePacks } from '../../../../backend/src/modules/theme-packs/theme-pack-catalogue';
import { ThemePacksEmpty } from './theme-packs-catalogue';
const fresh = (): ThemePackSnapshot => ({ catalogue: [], state: { formatVersion: 1, installed: [], selected: null } });
function historical(): ThemePackSnapshot {
  const current = bundledThemePacks.find((item) => item.id === 'alpine' && item.version === '1.0.0');
  if (!current) throw new Error('Missing preserved compatibility metadata');
  return {
    catalogue: [],
    state: {
      formatVersion: 1,
      selected: { id: current.id, version: current.version },
      installed: [
        { manifest: current, digest: 'a'.repeat(64), installedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', previous: null },
      ],
    },
  };
}
test('fresh Store is honestly empty and Default-only even with stale legacy discovery metadata', () => {
  const snapshot = fresh();
  snapshot.catalogue = bundledThemePacks;
  expect(themeStoreCatalogue(snapshot)).toEqual([]);
  expect(themeStoreVersions(snapshot)).toEqual([]);
  const markup = renderToStaticMarkup(createElement(ThemePacksEmpty, { snapshot }));
  expect(markup).toContain('No themes are available. Default is active.');
  for (const forbidden of ['Install', 'Alpine', 'Tideline', 'Woodland', '<a', '<button', 'github', 'remote catalogue'])
    expect(markup).not.toContain(forbidden);
});
test('installed legacy themes remain visible without discovery data and retain available update metadata', () => {
  const snapshot = historical();
  const before = structuredClone(snapshot);
  expect(themeStoreCatalogue(snapshot).map((item) => `${item.id}@${item.version}`)).toEqual(['alpine@1.0.0']);
  expect(renderToStaticMarkup(createElement(ThemePacksEmpty, { snapshot }))).toBe('');
  expect(snapshot).toEqual(before);
  snapshot.catalogue = bundledThemePacks;
  expect(themeStoreCatalogue(snapshot).map((item) => `${item.id}@${item.version}`)).toEqual(['alpine@1.1.0']);
  expect(themeStoreCatalogue(snapshot, 'alpine')).toHaveLength(1);
  expect(themeStoreCatalogue(snapshot, 'woodland')).toEqual([]);
});
test('previous and current installed versions survive empty discovery and removal cannot offer stale reinstall', () => {
  const snapshot = historical();
  const previous = bundledThemePacks.find((item) => item.id === 'alpine' && item.version === '1.1.0');
  if (!previous || !snapshot.state.installed[0]) throw new Error('Missing preserved compatibility version');
  snapshot.state.installed[0].previous = { manifest: previous, digest: 'b'.repeat(64) };
  expect(themeStoreVersions(snapshot).map((item) => item.version)).toEqual(['1.1.0', '1.0.0']);
  snapshot.state.installed = [];
  snapshot.state.selected = null;
  snapshot.catalogue = bundledThemePacks;
  expect(themeStoreCatalogue(snapshot)).toEqual([]);
  expect(themeStoreEmptyMessage(snapshot)).toContain('Default is active');
});
test('search and loading empty states never incorrectly claim an applied legacy theme is Default', () => {
  const snapshot = historical();
  expect(renderToStaticMarkup(createElement(ThemePacksEmpty, { snapshot, search: 'missing' }))).toContain('No themes match your search.');
  expect(themeStoreEmptyMessage(snapshot, 'missing')).not.toContain('Default');
  expect(renderToStaticMarkup(createElement(ThemePacksEmpty, { snapshot: null }))).toBe('');
});

test('installed theme search preserves punctuation, incomplete terms, typos and relevance ranking', () => {
  const snapshot = historical();
  snapshot.catalogue = bundledThemePacks;
  for (const query of ['alpi', 'alpnie', 'pale_stone', 'pale stne'])
    expect(themeStoreCatalogue(snapshot, query).map((item) => item.id)).toEqual(['alpine']);
  const record = snapshot.state.installed[0];
  if (!record) throw new Error('Missing installed legacy fixture');
  snapshot.catalogue = [];
  snapshot.state.installed.push({
    ...record,
    manifest: { ...record.manifest, id: 'tideline', name: 'Tideline', description: 'Alpine-inspired materials' },
  });
  expect(themeStoreCatalogue(snapshot, 'alpine').map((item) => item.id)).toEqual(['alpine', 'tideline']);
});
