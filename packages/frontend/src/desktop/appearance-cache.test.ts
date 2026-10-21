/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { appearanceBootstrap, appearanceFromStored, preferenceStorageKey } from './appearance-cache';

function firstPaint(raw: string | null, { dark = false, blockedStorage = false, blockedMedia = false } = {}) {
  const dataset: Record<string, string> = {};
  runInNewContext(appearanceBootstrap, {
    document: { documentElement: { dataset } },
    localStorage: {
      getItem(key: string) {
        expect(key).toBe(preferenceStorageKey);
        if (blockedStorage) throw new Error('Storage denied');
        return raw;
      },
    },
    matchMedia(query: string) {
      expect(query).toBe('(prefers-color-scheme: dark)');
      if (blockedMedia) throw new Error('Media query unavailable');
      return { matches: dark };
    },
  });
  return dataset;
}

describe('appearance before hydration', () => {
  test.each(['frost', 'graphite', 'forest', 'stone', 'ocean', 'blush'] as const)('retains the saved %s palette while loading', (preset) => {
    const saved = { preset, mode: 'dark', wallpaper: 'canopy' } as const;
    expect(appearanceFromStored(saved)).toEqual(saved);
    expect(firstPaint(JSON.stringify(saved))).toEqual({ desktopPreset: preset, desktopMode: 'dark', desktopWallpaper: 'canopy' });
  });

  test('honours saved Light over an OS Dark preference', () => {
    expect(firstPaint(JSON.stringify({ preset: 'stone', mode: 'light', wallpaper: 'tidal' }), { dark: true })).toEqual({
      desktopPreset: 'stone',
      desktopMode: 'light',
      desktopWallpaper: 'tidal',
    });
  });

  test.each([false, true])('resolves System using the OS preference: dark=%s', (dark) => {
    expect(firstPaint(JSON.stringify({ mode: 'system' }), { dark }).desktopMode).toBe(dark ? 'dark' : 'light');
  });

  test('uses Light when the OS preference is unavailable', () => {
    expect(firstPaint(JSON.stringify({ mode: 'system' }), { blockedMedia: true }).desktopMode).toBe('light');
  });

  test('preserves the legacy Graphite default without a saved mode', () => {
    expect(appearanceFromStored({ preset: 'graphite' }).mode).toBe('dark');
    expect(firstPaint(JSON.stringify({ preset: 'graphite' })).desktopMode).toBe('dark');
  });

  test.each([
    null,
    'broken JSON',
    '[]',
    'null',
    JSON.stringify({ preset: '</script><script>throw 1</script>', mode: 'inherit', wallpaper: 'url(unsafe)' }),
    ' '.repeat(16385),
  ])('ignores absent, corrupt, untrusted or oversized appearance data: case %#', (raw) => {
    expect(firstPaint(raw)).toEqual({ desktopPreset: 'frost', desktopMode: 'light', desktopWallpaper: 'sandstone' });
  });

  test('remains usable when local storage is denied', () => {
    expect(firstPaint(null, { blockedStorage: true })).toEqual({ desktopPreset: 'frost', desktopMode: 'light', desktopWallpaper: 'sandstone' });
  });

  test('keeps valid appearance fields when an unrelated cached preference is invalid', () => {
    const saved = { preset: 'ocean', mode: 'dark', wallpaper: 'tidal', serverName: 42, pinnedApps: null };
    expect(appearanceFromStored(saved)).toEqual({ preset: 'ocean', mode: 'dark', wallpaper: 'tidal' });
    expect(firstPaint(JSON.stringify(saved))).toEqual({ desktopPreset: 'ocean', desktopMode: 'dark', desktopWallpaper: 'tidal' });
  });
});
