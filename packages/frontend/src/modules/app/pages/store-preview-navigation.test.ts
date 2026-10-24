/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  appsPreviewDepth,
  appsReturnPath,
  nextAppsPreviewHistory,
  nextStorePreviewHistory,
  storePreviewDepth,
  storeReturnPath,
} from './store-preview-navigation';

describe('Store preview history', () => {
  test('a direct app link returns to its selected store without retaining detail tabs', () => {
    expect(storeReturnPath(null, '?store=official&tab=description')).toBe('/app-store?store=official');
  });
  test('a catalogue selection preserves the original list URL', () => {
    expect(nextStorePreviewHistory({ storeReturnPath: '/app-store?store=community' }, '?tab=description')).toEqual({
      storeReturnPath: '/app-store?store=community',
      storePreviewDepth: 1,
    });
  });
  test('selecting another app records how many entries close must go back', () => {
    const first = nextStorePreviewHistory(null, '?store=official');
    expect(nextStorePreviewHistory(first, '?store=official')).toEqual({ storeReturnPath: '/app-store?store=official', storePreviewDepth: 2 });
  });
  test.each(['https://example.invalid/', '//example.invalid/', '/apps', '/app-store/source/app'])(
    'never uses an unrelated saved close destination: %s',
    (path) => {
      expect(storeReturnPath({ storeReturnPath: path }, '')).toBe('/app-store');
    },
  );
  test('direct URLs never navigate backward into an unrelated page', () => {
    expect(storePreviewDepth(null)).toBe(0);
    expect(storePreviewDepth({ storePreviewDepth: -2 })).toBe(0);
    expect(storePreviewDepth({ storePreviewDepth: 1.5 })).toBe(0);
  });
  test('tabs and selections after a direct deep link keep the safe catalogue close destination', () => {
    const tab = nextStorePreviewHistory(null, '?store=official', true);
    expect(tab).toEqual({ storeReturnPath: '/app-store?store=official', storePreviewDepth: 0 });
    expect(nextStorePreviewHistory(tab, '?tab=info', true)).toEqual(tab);
  });
  test('an excessive history chain closes to the catalogue instead of an earlier preview', () => {
    expect(nextStorePreviewHistory({ storePreviewDepth: 50 }, '', true).storePreviewDepth).toBe(0);
  });
});

describe('Installed app preview history', () => {
  test('preserves library filters and excludes detail tabs from the return URL', () => {
    expect(appsReturnPath(null, '?q=home%20assistant&sort=za&category=utilities&tab=logs')).toBe('/apps?q=home+assistant&category=utilities&sort=za');
    expect(appsReturnPath({ appsReturnPath: '/apps?q=Jellyfin&sort=installed' }, '?tab=info')).toBe('/apps?q=Jellyfin&sort=installed');
  });
  test('closing after app selections and detail tabs returns to the retained list entry', () => {
    const first = nextAppsPreviewHistory(null, '?sort=opened');
    const tab = nextAppsPreviewHistory(first, '?sort=opened&tab=info', true);
    const second = nextAppsPreviewHistory(tab, '?sort=opened&tab=info', true);
    expect(first).toEqual({ appsReturnPath: '/apps?sort=opened', appsPreviewDepth: 1 });
    expect(second).toEqual({ appsReturnPath: '/apps?sort=opened', appsPreviewDepth: 3 });
  });
  test('deep links and excessive chains never navigate back to an unrelated page', () => {
    expect(nextAppsPreviewHistory(null, '?tab=info', true)).toEqual({ appsReturnPath: '/apps', appsPreviewDepth: 0 });
    expect(nextAppsPreviewHistory({ appsPreviewDepth: 50 }, '', true).appsPreviewDepth).toBe(0);
    for (const value of [-1, 1.5, Number.POSITIVE_INFINITY, '1']) expect(appsPreviewDepth({ appsPreviewDepth: value as number })).toBe(0);
  });
  test.each(['https://example.invalid/', '//example.invalid/', '/apps/source/app', '/app-store', '/apps#section'])(
    'ignores unrelated saved close destinations: %s',
    (path) => {
      expect(appsReturnPath({ appsReturnPath: path }, '?sort=za')).toBe('/apps?sort=za');
    },
  );
});
