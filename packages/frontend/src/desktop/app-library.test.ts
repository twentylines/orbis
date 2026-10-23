import { expect, test } from 'bun:test';
import { readOpenedApps, rememberOpenedApp, selectLibraryApps } from './app-library';

const apps = [
  { key: 'z', name: 'Zebra', categories: ['media'], installedAt: 30 },
  { key: 'a', name: 'Alpha 10', categories: ['utilities'], installedAt: 10 },
  { key: 'b', name: 'Alpha 2', categories: [], installedAt: 20 },
];
test('sorts names naturally in either direction without changing inventory order', () => {
  const f = { search: '', category: '', sort: 'az' as const };
  expect(selectLibraryApps(apps, f, {}).map((app) => app.key)).toEqual(['b', 'a', 'z']);
  expect(selectLibraryApps(apps, { ...f, sort: 'za' }, {}).map((app) => app.key)).toEqual(['z', 'a', 'b']);
  expect(apps.map((app) => app.key)).toEqual(['z', 'a', 'b']);
});
test('uses actual installation and open times, with alphabetical ties for unopened apps', () => {
  const f = { search: '', category: '', sort: 'installed' as const };
  expect(selectLibraryApps(apps, f, {}).map((app) => app.key)).toEqual(['z', 'b', 'a']);
  expect(selectLibraryApps([...apps, { key: 'old-peer', name: 'A legacy app', installedAt: Number.NaN }], f, {}).map((app) => app.key)).toEqual([
    'z',
    'b',
    'a',
    'old-peer',
  ]);
  expect(selectLibraryApps(apps, { ...f, sort: 'opened' }, { a: 500 }).map((app) => app.key)).toEqual(['a', 'b', 'z']);
});
test('combines search and categories and includes apps without category metadata', () => {
  expect(selectLibraryApps(apps, { search: 'zEB', category: 'media', sort: 'az' }, {}).map((app) => app.key)).toEqual(['z']);
  expect(selectLibraryApps(apps, { search: '', category: 'uncategorized', sort: 'az' }, {}).map((app) => app.key)).toEqual(['b']);
  expect(selectLibraryApps(apps, { search: 'alpha', category: 'media', sort: 'az' }, {})).toEqual([]);
});
test('rejects corrupt recent history and bounds retained entries to 200', () => {
  for (const value of ['null', '[]', 'broken', '{"app":null,"other":"12"}']) expect(readOpenedApps(value)).toEqual({});
  const opened = Object.fromEntries(Array.from({ length: 205 }, (_, i) => [`app-${i}`, i + 1]));
  expect(Object.keys(readOpenedApps(JSON.stringify(opened)))).toHaveLength(200);
  const next = rememberOpenedApp(readOpenedApps(JSON.stringify(opened)), 'new', 1000);
  expect(next.new).toBe(1000);
  expect(Object.keys(next)).toHaveLength(200);
  expect(next['app-5']).toBeUndefined();
});
