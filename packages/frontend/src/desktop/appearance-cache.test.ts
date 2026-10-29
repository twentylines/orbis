/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { appearanceBootstrap, appearanceFromStored, preferenceStorageKey, preferenceCacheLimit } from './appearance-cache';

function firstPaint(raw: string | null, { dark = false, blockedStorage = false, blockedMedia = false } = {}) {
  const dataset: Record<string, string> = {};
  runInNewContext(appearanceBootstrap, {
    document: { documentElement: { dataset } },
    localStorage: {
      getItem(key: string) {
        if (key === 'orbis-public-theme-appearance-v1') return null;
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
    expect(appearanceFromStored(saved)).toEqual({ ...saved, wallpaperMode: 'theme', wallpaperPreset: null });
    expect(firstPaint(JSON.stringify(saved))).toEqual({ desktopPreset: preset, desktopMode: 'dark', desktopWallpaper: `theme-${preset}` });
  });

  test.each(['frost', 'graphite', 'forest', 'stone', 'ocean', 'blush'] as const)('uses the %s landscape before hydration', (preset) => {
    expect(firstPaint(JSON.stringify({ preset, wallpaper: 'sandstone' })).desktopWallpaper).toBe(`theme-${preset}`);
    expect(firstPaint(JSON.stringify({ preset, wallpaper: 'sandstone', wallpaperMode: 'custom', wallpaperPreset: 'ocean' })).desktopWallpaper).toBe(
      'theme-ocean',
    );
  });

  test('keeps an explicitly selected legacy landscape and uploaded image fallback', () => {
    expect(firstPaint(JSON.stringify({ preset: 'blush', wallpaper: 'sandstone', wallpaperMode: 'custom' })).desktopWallpaper).toBe('sandstone');
    expect(firstPaint(JSON.stringify({ preset: 'blush', wallpaper: 'tidal', wallpaperMode: 'custom' })).desktopWallpaper).toBe('tidal');
    expect(
      firstPaint(JSON.stringify({ preset: 'blush', wallpaper: 'sandstone', appearance: { wallpaperImage: 'a'.repeat(64) } })).desktopWallpaper,
    ).toBe('sandstone');
  });

  test('remembers only bounded image identity and layout for this browser’s local wallpaper', () => {
    const saved = {
      preset: 'blush',
      wallpaper: 'sandstone',
      wallpaperMode: 'custom',
      appearance: {
        wallpaperImage: 'a'.repeat(64),
        wallpaperFit: 'contain' as const,
        wallpaperX: 37,
        wallpaperY: 42,
        wallpaperDim: 12,
        wallpaperBlur: 4,
      },
    };
    expect(appearanceFromStored(saved).appearance).toEqual(saved.appearance);
    expect(firstPaint(JSON.stringify(saved))).toEqual({
      desktopPreset: 'blush',
      desktopMode: 'light',
      desktopWallpaper: 'sandstone',
      desktopLocalWallpaper: 'true',
    });
    expect(
      appearanceFromStored({
        appearance: {
          wallpaperImage: 'https://example.test/private',
          wallpaperFit: 'unsafe',
          wallpaperX: -1,
          wallpaperY: 101,
          wallpaperDim: 100,
          wallpaperBlur: 25,
        },
      }).appearance,
    ).toBeUndefined();
    expect(appearanceBootstrap).not.toContain('/api/desktop-preferences/wallpaper');
  });

  test('honours saved Light over an OS Dark preference', () => {
    expect(firstPaint(JSON.stringify({ preset: 'stone', mode: 'light', wallpaper: 'tidal' }), { dark: true })).toEqual({
      desktopPreset: 'stone',
      desktopMode: 'light',
      desktopWallpaper: 'theme-stone',
    });
  });

  test.each([false, true])('resolves System using the OS preference: dark=%s', (dark) => {
    expect(firstPaint(JSON.stringify({ mode: 'system' }), { dark }).desktopMode).toBe(dark ? 'dark' : 'light');
  });

  test.each(['frost', 'graphite', 'forest', 'stone', 'ocean', 'blush'] as const)('System and manual modes resolve the same %s palette', (preset) => {
    for (const dark of [false, true]) {
      const shared = { preset, wallpaper: 'canopy' };
      expect(firstPaint(JSON.stringify({ ...shared, mode: 'system' }), { dark })).toEqual(
        firstPaint(JSON.stringify({ ...shared, mode: dark ? 'dark' : 'light' }), { dark: !dark }),
      );
    }
  });

  test('keeps first-paint appearance when a large pinned order is cached', () => {
    const saved = {
      preset: 'ocean',
      mode: 'system',
      wallpaper: 'tidal',
      workspace: { pinnedApps: Array.from({ length: 512 }, (_, index) => `app-${index}-${'a'.repeat(150)}:store`) },
      appearance: { textScale: 150 },
    };
    const raw = JSON.stringify(saved);
    expect(raw.length).toBeGreaterThan(16 * 1024);
    expect(raw.length).toBeLessThan(preferenceCacheLimit);
    expect(firstPaint(raw, { dark: true })).toEqual({ desktopPreset: 'ocean', desktopMode: 'dark', desktopWallpaper: 'theme-ocean' });
  });

  test('applies enlarged text before hydration with a large pinned order', () => {
    const properties = new Map<string, string>();
    const dataset: Record<string, string> = {};
    const raw = JSON.stringify({
      preset: 'graphite',
      mode: 'system',
      appearance: { textScale: 150 },
      workspace: { pinnedApps: Array.from({ length: 512 }, (_, index) => `app-${index}-${'a'.repeat(150)}:store`) },
    });
    runInNewContext(appearanceBootstrap, {
      document: {
        documentElement: {
          dataset,
          style: {
            setProperty: (name: string, value: string) => properties.set(name, value),
            removeProperty: (name: string) => properties.delete(name),
          },
        },
      },
      localStorage: { getItem: () => raw },
      matchMedia: () => ({ matches: true }),
      getComputedStyle: () => ({ getPropertyValue: () => '' }),
      requestAnimationFrame: (callback: () => void) => callback(),
    });
    expect(dataset.desktopMode).toBe('dark');
    expect(properties.get('--orbis-text-scale')).toBe('1.5');
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
    ' '.repeat(preferenceCacheLimit + 1),
  ])('ignores absent, corrupt, untrusted or oversized appearance data: case %#', (raw) => {
    expect(firstPaint(raw)).toEqual({ desktopPreset: 'frost', desktopMode: 'light', desktopWallpaper: 'theme-frost' });
  });

  test('remains usable when local storage is denied', () => {
    expect(firstPaint(null, { blockedStorage: true })).toEqual({ desktopPreset: 'frost', desktopMode: 'light', desktopWallpaper: 'theme-frost' });
  });

  test('keeps valid appearance fields when an unrelated cached preference is invalid', () => {
    const saved = { preset: 'ocean', mode: 'dark', wallpaper: 'tidal', serverName: 42, pinnedApps: null };
    expect(appearanceFromStored(saved)).toEqual({
      preset: 'ocean',
      mode: 'dark',
      wallpaper: 'tidal',
      wallpaperMode: 'theme',
      wallpaperPreset: null,
    });
    expect(firstPaint(JSON.stringify(saved))).toEqual({ desktopPreset: 'ocean', desktopMode: 'dark', desktopWallpaper: 'theme-ocean' });
  });
});
