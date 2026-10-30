/// <reference types="bun" />
import { afterEach, describe, expect, mock, test, spyOn } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { bundledThemePacks } from '../../../../backend/src/modules/theme-packs/theme-pack-catalogue';
import { appearanceBootstrap, preferenceStorageKey } from '@/desktop/appearance-cache';
import { applyAppearanceRuntime } from '@/desktop/appearance-runtime';
import { applyThemePackRuntime, themePackAppearance } from './theme-pack-runtime';
import {
  decodeThemePackCache,
  isThemePackAppearance,
  publicThemePackWallpapers,
  publicThemePackWallpaper,
  readThemePackCache,
  rememberThemePackCache,
  themePackCacheAge,
  themePackCacheKey,
  themePackCacheLimit,
  themePackCacheEvent,
  subscribeThemePackAppearance,
  themePackAppearanceSnapshot,
} from './theme-pack-cache';
import { cacheThemePackSelection, useThemePack } from './use-theme-pack';
import { normaliseDesktopAppearance } from '@runtipi/common/schemas/desktop-appearance';
import { WallpaperLayer } from '@/desktop/wallpaper-layer';
import { wallpaperSources } from '@/desktop/wallpaper-presets';

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalComputedStyle = globalThis.getComputedStyle;
const originalMatchMedia = globalThis.matchMedia;
const originalFetch = globalThis.fetch;
afterEach(() => {
  rememberThemePackCache(null);
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
  globalThis.getComputedStyle = originalComputedStyle;
  globalThis.matchMedia = originalMatchMedia;
  globalThis.fetch = originalFetch;
});
const pack = bundledThemePacks.find((value) => value.id === 'tideline' && value.version === '1.1.0');
if (!pack) throw new Error('Missing bundled theme');
function storage() {
  const values = new Map<string, string>();
  globalThis.window = Object.assign(new EventTarget(), {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  }) as unknown as Window & typeof globalThis;
  return values;
}

describe('public theme continuity cache', () => {
  test('stores only bounded public appearance and clears explicitly selected null without retaining registry or account data', () => {
    const values = storage();
    const selected = rememberThemePackCache(pack);
    expect(isThemePackAppearance(selected)).toBe(true);
    const raw = values.get(themePackCacheKey) ?? '';
    expect(raw.length).toBeLessThan(themePackCacheLimit);
    expect(Object.keys(JSON.parse(raw).pack).sort()).toEqual(['dark', 'id', 'light', 'name', 'treatment', 'version', 'wallpaper']);
    for (const forbidden of ['https:', '/api/', '"source":', 'license', 'assets', 'author', 'account', 'token', 'installed', 'wallpaperImage'])
      expect(raw).not.toContain(forbidden);
    expect(readThemePackCache()).toEqual(selected);
    expect(rememberThemePackCache(null)).toBeNull();
    expect(readThemePackCache()).toBeNull();
    expect(values.has(themePackCacheKey)).toBe(false);
  });

  test('rejects expired, future, malformed, oversized and injected cache entries, removing invalid device state', () => {
    const values = storage();
    const selected = rememberThemePackCache(pack);
    const now = Date.now();
    const valid = { version: 1, savedAt: now, pack: selected };
    expect(decodeThemePackCache(JSON.stringify(valid), now)).toEqual(selected);
    for (const value of [
      null,
      [],
      { ...valid, token: 'never-retain' },
      { ...valid, version: 2 },
      { ...valid, savedAt: now + 1 },
      { ...valid, savedAt: now - themePackCacheAge },
      { ...valid, pack: { ...selected, privateUrl: '/api/private' } },
      { ...valid, pack: { ...selected, wallpaper: 'https://tracker.invalid' } },
      { ...valid, pack: { ...selected, id: '__proto__' } },
      { ...valid, pack: { ...selected, light: { ...selected?.light, ink: 'url(unsafe)' } } },
      { ...valid, pack: { ...selected, treatment: { ...selected?.treatment, script: 'unsafe' } } },
    ])
      expect(decodeThemePackCache(JSON.stringify(value), now)).toBeNull();
    for (const raw of ['broken JSON', 'x'.repeat(themePackCacheLimit + 1)]) expect(decodeThemePackCache(raw)).toBeNull();
    values.set(themePackCacheKey, JSON.stringify({ ...valid, token: 'never-retain' }));
    expect(readThemePackCache()).toBeNull();
    expect(values.has(themePackCacheKey)).toBe(false);
  });

  test('works without storage access and never accepts arbitrary manifest fields or wallpaper URLs', () => {
    rememberThemePackCache(null);
    globalThis.window = {
      localStorage: {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        },
        removeItem: () => {
          throw new Error('denied');
        },
      },
    } as unknown as Window & typeof globalThis;
    expect(readThemePackCache()).toBeNull();
    expect(rememberThemePackCache(pack)?.id).toBe(pack.id);
    expect(rememberThemePackCache({ ...pack, css: 'unsafe' } as typeof pack)).toBeNull();
  });

  test('the live production snapshot purges invalid and rejected persisted cache without applying it', () => {
    const values = storage();
    const selected = rememberThemePackCache(pack);
    const now = Date.now();
    for (const raw of [
      '',
      'broken JSON',
      'x'.repeat(themePackCacheLimit + 1),
      JSON.stringify({ version: 1, savedAt: now - themePackCacheAge, pack: selected }),
      JSON.stringify({ version: 1, savedAt: now + 60_000, pack: selected }),
      JSON.stringify({ version: 1, savedAt: now, pack: selected, accountId: 'must-not-retain' }),
      JSON.stringify({ version: 1, savedAt: now, pack: { ...selected, wallpaper: '/api/private' } }),
    ]) {
      values.set(themePackCacheKey, raw);
      expect(themePackAppearanceSnapshot()).toBeNull();
      expect(values.has(themePackCacheKey)).toBe(false);
      expect(themePackAppearanceSnapshot()).toBeNull();
    }
  });

  test('the live snapshot purges an unchanged cached entry at expiry and after a backward clock change', () => {
    const values = storage();
    const clock = spyOn(Date, 'now');
    const now = Date.now();
    try {
      clock.mockReturnValue(now);
      rememberThemePackCache(pack);
      const first = themePackAppearanceSnapshot();
      expect(first?.id).toBe(pack.id);
      const raw = values.get(themePackCacheKey);
      clock.mockReturnValue(now + themePackCacheAge - 1);
      expect(themePackAppearanceSnapshot()).toBe(first);
      expect(values.get(themePackCacheKey)).toBe(raw);
      clock.mockReturnValue(now + themePackCacheAge);
      expect(themePackAppearanceSnapshot()).toBeNull();
      expect(values.has(themePackCacheKey)).toBe(false);
      clock.mockReturnValue(now);
      rememberThemePackCache(pack);
      clock.mockReturnValue(now - 1);
      expect(themePackAppearanceSnapshot()).toBeNull();
      expect(values.has(themePackCacheKey)).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  test('the production snapshot stays cleared when this browser denies removal and recovers on a valid replacement', () => {
    const values = storage();
    rememberThemePackCache(pack);
    values.set(themePackCacheKey, 'broken JSON');
    const remove = spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('denied');
    });
    try {
      expect(themePackAppearanceSnapshot()).toBeNull();
      expect(themePackAppearanceSnapshot()).toBeNull();
      expect(values.get(themePackCacheKey)).toBe('broken JSON');
      expect(remove).toHaveBeenCalledTimes(2);
    } finally {
      remove.mockRestore();
    }
    expect(themePackAppearanceSnapshot()).toBeNull();
    expect(values.has(themePackCacheKey)).toBe(false);
    rememberThemePackCache(pack);
    expect(themePackAppearanceSnapshot()?.id).toBe(pack.id);
  });

  test('every bundled immutable photograph matches the exact public bytes and length; paths never come from cache', () => {
    for (const manifest of bundledThemePacks) {
      const selected = rememberThemePackCache(manifest);
      if (!selected) throw new Error('Bundled projection was rejected');
      const asset = publicThemePackWallpapers[manifest.id as keyof typeof publicThemePackWallpapers];
      const data = readFileSync(new URL(`../../../public${asset.path}`, import.meta.url));
      expect(createHash('sha256').update(data).digest('hex')).toBe(manifest.wallpaper);
      expect(data.length).toBe(manifest.assets[0]?.bytes ?? -1);
      expect(data.length).toBe(asset.bytes);
      expect(publicThemePackWallpaper(selected)).toBe(`${asset.path}?version=${manifest.wallpaper}`);
    }
  });

  test('signed-out and authenticated loading renders retain the last verified public selection without requesting private assets', () => {
    storage();
    rememberThemePackCache(pack);
    const fetch = mock(() => Promise.reject(new Error('No request before effects')));
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    function Read({ enabled }: { enabled: boolean }) {
      return createElement('span', null, useThemePack(enabled)?.name ?? 'default');
    }
    for (const enabled of [false, true, false]) expect(renderToStaticMarkup(createElement(Read, { enabled }))).toContain('Tideline');
    expect(fetch).not.toHaveBeenCalled();
    rememberThemePackCache(null);
    expect(renderToStaticMarkup(createElement(Read, { enabled: false }))).toContain('default');
  });

  test('a successful new account with no selected pack and explicit removal clear the prior device selection', () => {
    const values = storage();
    rememberThemePackCache(pack);
    expect(cacheThemePackSelection({ formatVersion: 1, selected: null, installed: [] })).toBeNull();
    expect(values.has(themePackCacheKey)).toBe(false);
    const installation = {
      manifest: pack,
      digest: 'a'.repeat(64),
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      previous: null,
    };
    expect(cacheThemePackSelection({ formatVersion: 1, selected: { id: pack.id, version: pack.version }, installed: [installation] })?.id).toBe(
      pack.id,
    );
    expect(cacheThemePackSelection({ formatVersion: 1, selected: null, installed: [installation] })).toBeNull();
    expect(readThemePackCache()).toBeNull();
  });

  test('updates subscribers only from appearance/storage changes, keeps snapshots stable and removes both listeners on unmount', () => {
    const values = storage();
    const changed = mock();
    const unsubscribe = subscribeThemePackAppearance(changed);
    rememberThemePackCache(pack);
    expect(changed).toHaveBeenCalledTimes(1);
    const first = themePackAppearanceSnapshot();
    expect(themePackAppearanceSnapshot()).toBe(first);
    const event = (key: string) => Object.assign(new Event('storage'), { key });
    window.dispatchEvent(event('unrelated'));
    expect(changed).toHaveBeenCalledTimes(1);
    values.delete(themePackCacheKey);
    window.dispatchEvent(event(themePackCacheKey));
    expect(changed).toHaveBeenCalledTimes(2);
    expect(themePackAppearanceSnapshot()).toBeNull();
    unsubscribe();
    window.dispatchEvent(new Event(themePackCacheEvent));
    window.dispatchEvent(event(themePackCacheKey));
    expect(changed).toHaveBeenCalledTimes(2);
  });

  test('the actual image layer uses pack photographs only in theme mode, preserving fixed and custom-upload precedence', () => {
    storage();
    rememberThemePackCache(pack);
    const choice = { preset: 'frost' as const, wallpaper: 'canopy' as const, wallpaperMode: 'theme' as const };
    expect(renderToStaticMarkup(createElement(WallpaperLayer, { choice }))).toContain(
      `/wallpapers/theme-pack-tideline-v1.webp?version=${pack.wallpaper}`,
    );
    const fixed = renderToStaticMarkup(createElement(WallpaperLayer, { choice: { ...choice, wallpaperMode: 'custom' } }));
    expect(fixed).toContain(wallpaperSources.canopy);
    expect(fixed).not.toContain('/wallpapers/theme-pack-tideline-v1.webp');
    const uploaded = renderToStaticMarkup(
      createElement(WallpaperLayer, {
        choice: { ...choice, wallpaperMode: 'custom', appearance: { wallpaperImage: 'a'.repeat(64), wallpaperX: 70, wallpaperFit: 'contain' } },
      }),
    );
    expect(uploaded).toContain('data-custom="true"');
    expect(uploaded).toContain('data-wallpaper-state="loading"');
    expect(uploaded).not.toContain('/wallpapers/');
    rememberThemePackCache(null);
    expect(renderToStaticMarkup(createElement(WallpaperLayer, { choice }))).toContain('/wallpapers/frost-v2.webp');
  });
});

function firstPaint(script: string, saved: unknown, rawPack: string | null, systemDark: boolean) {
  const properties = new Map<string, string>();
  const dataset: Record<string, string> = {};
  const document = {
    documentElement: {
      dataset,
      style: { setProperty: (key: string, value: string) => properties.set(key, value), removeProperty: (key: string) => properties.delete(key) },
    },
  };
  const getComputedStyle = () => ({ getPropertyValue: (key: string) => properties.get(key) ?? '' });
  runInNewContext(script, {
    document,
    localStorage: { getItem: (key: string) => (key === preferenceStorageKey ? JSON.stringify(saved) : key === themePackCacheKey ? rawPack : null) },
    matchMedia: (query: string) => ({ matches: query === '(prefers-color-scheme: dark)' && systemDark }),
    getComputedStyle,
    requestAnimationFrame: (callback: () => void) => callback(),
  });
  return { properties, dataset, document, getComputedStyle };
}

describe('pack first paint and hydration use identical appearance', () => {
  test('preserves palette, materials, typography, wallpaper, authored accent and enlarged size in both modes before hydration', () => {
    const values = storage();
    for (const manifest of bundledThemePacks) {
      const selected = rememberThemePackCache(manifest);
      for (const dark of [false, true]) {
        const personal = normaliseDesktopAppearance({
          textScale: 150,
          accent: '#915221',
          surfaceOpacity: 100,
          chromeOpacity: 100,
          glassBlur: 0,
          chromeBlur: 0,
        });
        const initial = firstPaint(
          appearanceBootstrap,
          { mode: 'system', appearance: personal, wallpaperMode: 'theme' },
          values.get(themePackCacheKey) ?? null,
          dark,
        );
        expect(initial.dataset.orbisThemePack).toBe(`${manifest.id}@${manifest.version}`);
        expect(initial.dataset.desktopMode).toBe(dark ? 'dark' : 'light');
        expect(initial.properties.get('--orbis-text-scale')).toBe('1.5');
        expect(initial.properties.get('--orbis-pack-wallpaper')).toContain('/wallpapers/');
        expect(initial.properties.get('--orbis-pack-wallpaper')).not.toContain('/api/');
        const before = new Map(initial.properties);
        globalThis.document = initial.document as unknown as Document;
        globalThis.getComputedStyle = initial.getComputedStyle as unknown as typeof getComputedStyle;
        globalThis.matchMedia = (() => ({ matches: false })) as unknown as typeof matchMedia;
        applyThemePackRuntime(selected, dark ? 'dark' : 'light', true);
        applyAppearanceRuntime(themePackAppearance(selected, personal), dark ? 'dark' : 'light');
        expect(initial.properties).toEqual(before);
      }
    }
  });

  test('custom wallpaper keeps its own layout while pack fonts and palette persist; invalid cache never applies pack tokens', () => {
    const values = storage();
    rememberThemePackCache(pack);
    const saved = { mode: 'light', appearance: { wallpaperImage: 'a'.repeat(64), wallpaperX: 70, textScale: 125 } };
    const initial = firstPaint(appearanceBootstrap, saved, values.get(themePackCacheKey) ?? null, true);
    expect(initial.dataset.desktopMode).toBe('light');
    expect(initial.dataset.orbisPackWallpaper).toBe('false');
    expect(initial.dataset.desktopLocalWallpaper).toBe('true');
    expect(initial.properties.get('--orbis-text-scale')).toBe('1.25');
    expect(firstPaint(appearanceBootstrap, saved, '{"pack":{"css":"unsafe"}}', false).dataset.orbisThemePack).toBeUndefined();
  });

  test('minified production bootstrap preserves helper references and the exact cached first paint', async () => {
    const values = storage();
    rememberThemePackCache(pack);
    const entry = 'orbis-first-paint-test';
    const result = await Bun.build({
      entrypoints: [entry],
      target: 'browser',
      format: 'iife',
      minify: true,
      plugins: [
        {
          name: 'first-paint-entry',
          setup(build) {
            build.onResolve({ filter: /^orbis-first-paint-test$/ }, () => ({ path: entry, namespace: 'first-paint' }));
            build.onLoad({ filter: /.*/, namespace: 'first-paint' }, () => ({
              contents: `import {appearanceBootstrap} from ${JSON.stringify(new URL('../../desktop/appearance-cache.ts', import.meta.url).pathname)};globalThis.__orbisTestBootstrap=appearanceBootstrap;`,
              loader: 'ts',
            }));
          },
        },
      ],
    });
    expect(result.success).toBe(true);
    const context: Record<string, unknown> = {
      Blob,
      File,
      Headers,
      Request,
      Response,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      FormData,
      AbortController,
      AbortSignal,
      DOMException,
      console,
      crypto,
    };
    runInNewContext((await result.outputs[0]?.text()) ?? '', context);
    const script = context.__orbisTestBootstrap;
    if (typeof script !== 'string') throw new Error('Missing minified first-paint script');
    const raw = values.get(themePackCacheKey) ?? null;
    const saved = { mode: 'system', appearance: { textScale: 150 } };
    expect(firstPaint(script, saved, raw, true).properties).toEqual(firstPaint(appearanceBootstrap, saved, raw, true).properties);
  });
});
