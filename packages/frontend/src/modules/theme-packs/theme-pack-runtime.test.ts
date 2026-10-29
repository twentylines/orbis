/// <reference types="bun" />
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { normaliseDesktopAppearance } from '@runtipi/common/schemas/desktop-appearance';
import { themePackSnapshotSchema } from '@runtipi/common/schemas/theme-pack';
import { bundledThemePacks } from '../../../../backend/src/modules/theme-packs/theme-pack-catalogue';
import { applyThemePackRuntime, themePackAppearance } from './theme-pack-runtime';
import { applyAppearanceRuntime } from '@/desktop/appearance-runtime';
import { themePacksRequest } from './theme-packs-api';
import { publicThemePackWallpaper } from './theme-pack-cache';

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.document = originalDocument;
  globalThis.window = originalWindow;
  globalThis.fetch = originalFetch;
});
function root() {
  const properties = new Map<string, string>();
  const dataset: Record<string, string> = {};
  globalThis.document = {
    documentElement: {
      dataset,
      style: {
        setProperty: (name: string, value: string) => properties.set(name, value),
        removeProperty: (name: string) => properties.delete(name),
      },
    },
  } as unknown as Document;
  return { properties, dataset };
}
const alpine = bundledThemePacks.find((item) => item.id === 'alpine' && item.version === '1.1.0');
const tideline = bundledThemePacks.find((item) => item.id === 'tideline' && item.version === '1.1.0');
if (!alpine || !tideline) throw new Error('Missing theme fixture');

describe('bounded theme runtime and personal override preservation', () => {
  test('two packs change full surfaces, wallpaper, typography and controls in both modes', () => {
    const { properties, dataset } = root();
    for (const mode of ['light', 'dark'] as const) {
      applyThemePackRuntime(alpine, mode, true);
      const first = new Map(properties);
      applyThemePackRuntime(tideline, mode, true);
      expect(properties.get('--desktop-base-surface')).not.toBe(first.get('--desktop-base-surface'));
      expect(properties.get('--desktop-base-chrome')).not.toBe(first.get('--desktop-base-chrome'));
      expect(properties.get('--orbis-pack-font')).not.toBe(first.get('--orbis-pack-font'));
      expect(properties.get('--orbis-pack-radius')).not.toBe(first.get('--orbis-pack-radius'));
      expect(properties.get('--orbis-pack-control-border')).not.toBe(first.get('--orbis-pack-control-border'));
      expect(properties.get('--orbis-pack-wallpaper')).toContain(publicThemePackWallpaper(tideline) ?? 'missing verified public photograph');
      expect(dataset.orbisThemePack).toBe('tideline@1.1.0');
    }
  });
  test('keeps every authored setting and upload while nullable material values inherit pack treatment', () => {
    const personal = normaliseDesktopAppearance({
      accent: '#915221',
      surfaceOpacity: 100,
      chromeOpacity: 100,
      glassBlur: 0,
      chromeBlur: 0,
      glassTint: 17,
      textScale: 150,
      motion: 'reduced',
      transparency: 'solid',
      lowEffects: true,
      wallpaperImage: 'a'.repeat(64),
      wallpaperX: 87,
      wallpaperY: 21,
      wallpaperBlur: 4,
      wallpaperDim: 38,
      wallpaperFit: 'contain',
      dockPlacement: 'right',
      dockSize: 'large',
      dockAutoHide: true,
      dockPins: ['one:one'],
    });
    const original = JSON.stringify(personal);
    expect(themePackAppearance(alpine, personal)).toEqual(personal);
    expect(themePackAppearance(tideline, personal)).toEqual(personal);
    expect(JSON.stringify(personal)).toBe(original);
    const defaults = normaliseDesktopAppearance();
    expect(themePackAppearance(alpine, defaults).glassBlur).toBe(12);
    expect(themePackAppearance(tideline, defaults).glassBlur).toBe(28);
    expect(defaults.glassBlur).toBeNull();
    const { dataset } = root();
    applyThemePackRuntime(tideline, 'light', false);
    expect(dataset.orbisPackWallpaper).toBe('false');
  });
  test('removing selection clears all pack-owned tokens without changing user/runtime properties', () => {
    const { properties, dataset } = root();
    properties.set('--orbis-accent', '#123456');
    properties.set('--orbis-text-scale', '1.5');
    applyThemePackRuntime(alpine, 'dark', true);
    expect(properties.has('--orbis-pack-radius')).toBe(true);
    applyThemePackRuntime(null, 'dark', false);
    expect([...properties]).toEqual([
      ['--orbis-accent', '#123456'],
      ['--orbis-text-scale', '1.5'],
    ]);
    expect(dataset.orbisThemePack).toBeUndefined();
  });
  test('pack and authored accent colors pass the existing contrast derivation in both modes', () => {
    const oldComputedStyle = globalThis.getComputedStyle;
    const oldMatchMedia = globalThis.matchMedia;
    try {
      const { properties } = root();
      globalThis.getComputedStyle = (() => ({
        getPropertyValue: (name: string) => properties.get(name) ?? '',
      })) as unknown as typeof getComputedStyle;
      globalThis.matchMedia = (() => ({ matches: false })) as unknown as typeof matchMedia;
      const rgb = (value: string) =>
        value.startsWith('#')
          ? [1, 3, 5].map((start) => Number.parseInt(value.slice(start, start + 2), 16)).concat(1)
          : (value.match(/[\d.]+/g) ?? []).map(Number);
      const luminance = (channels: number[]) =>
        channels.slice(0, 3).reduce((sum, channel, index) => {
          const unit = channel / 255;
          return sum + (unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4) * ([0.2126, 0.7152, 0.0722][index] ?? 0);
        }, 0);
      const contrast = (a: number[], b: number[]) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
      for (const pack of bundledThemePacks.filter((item) => item.version === '1.1.0')) {
        for (const mode of ['light', 'dark'] as const) {
          for (const accent of [null, '#ffff00', '#000000', '#ffffff']) {
            applyThemePackRuntime(pack, mode, true);
            const personal = normaliseDesktopAppearance({ accent });
            applyAppearanceRuntime(themePackAppearance(pack, personal), mode);
            const surface = rgb(properties.get('--orbis-surface') ?? pack[mode].surface);
            const backgrounds = [0, 255].map((backdrop) =>
              surface.slice(0, 3).map((channel) => channel * (surface[3] ?? 1) + backdrop * (1 - (surface[3] ?? 1))),
            );
            for (const token of ['muted', 'accent', 'positive', 'negative', 'warning', 'info']) {
              const foreground = rgb(properties.get(`--orbis-${token}`) ?? pack[mode][token as 'muted']);
              for (const background of backgrounds) expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
            }
          }
        }
      }
    } finally {
      globalThis.getComputedStyle = oldComputedStyle;
      globalThis.matchMedia = oldMatchMedia;
    }
  });

  test('invalid runtime manifests cannot set CSS or request remote content', () => {
    const { properties } = root();
    applyThemePackRuntime({ ...alpine, css: 'body{display:none}' }, 'light', true);
    expect(properties.size).toBe(0);
    applyThemePackRuntime({ ...alpine, wallpaper: 'https://tracker.invalid/image' }, 'light', true);
    expect(properties.size).toBe(0);
  });
});

describe('same-origin validated theme API', () => {
  const snapshot = { catalogue: bundledThemePacks, state: { formatVersion: 1, selected: null, installed: [] } };
  test('rejects unsupported response data and never announces failed changes', async () => {
    const dispatch = mock();
    globalThis.window = { dispatchEvent: dispatch } as unknown as Window & typeof globalThis;
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ ...snapshot, script: 'unsafe' }), { status: 200 })) as unknown as typeof fetch;
    await expect(themePacksRequest('/install', 'POST', { id: 'alpine' })).rejects.toThrow('unsupported');
    expect(dispatch).not.toHaveBeenCalled();
  });
  test('requests only the theme API with account credentials and validates before notifying', async () => {
    const dispatch = mock();
    const fetch = mock(async (_input: string | URL | Request, _options?: RequestInit) => new Response(JSON.stringify(snapshot), { status: 200 }));
    globalThis.window = { dispatchEvent: dispatch } as unknown as Window & typeof globalThis;
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    expect(themePackSnapshotSchema.allows(await themePacksRequest('/selection', 'PUT', { selected: null }))).toBe(true);
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/theme-packs/selection');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    await expect(themePacksRequest('/../app-stores', 'POST')).rejects.toThrow('Invalid');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
