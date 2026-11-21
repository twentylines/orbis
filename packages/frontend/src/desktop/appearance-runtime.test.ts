/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { themePresets, wallpaperColourOverrides } from './wallpaper-presets';
import { applyAppearanceRuntime } from './appearance-runtime';
import { appearanceBootstrap, preferenceStorageKey } from './appearance-cache';

const palette = {
  surface: 'rgba(248, 250, 246, 0.92)',
  chrome: 'rgba(17, 38, 36, 0.82)',
  muted: '#536b65',
  accent: '#914725',
  action: '#27584a',
  'action-ink': '#fff8ee',
  positive: '#236c4d',
  negative: '#aa4235',
  warning: '#82551e',
  info: '#366780',
  focus: '#b75c3e',
  'panel-dark': 'rgba(14, 35, 34, 0.92)',
};
const darkPalette = {
  ...palette,
  surface: 'rgba(20, 36, 35, 0.95)',
  chrome: 'rgba(9, 23, 23, 0.92)',
  muted: '#b5c8bf',
  accent: '#e2b28d',
  positive: '#8fd1af',
  negative: '#efa99a',
  warning: '#e8c180',
  info: '#9cc3d3',
};
const themeCss = readFileSync(new URL('./theme.css', import.meta.url), 'utf8');
const declarations = (selector: string): Record<string, string> => {
  const start = themeCss.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Missing palette: ${selector}`);
  const block = themeCss.slice(start, themeCss.indexOf('}', start));
  return Object.fromEntries([...block.matchAll(/(--[a-z-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2]?.trim() ?? '']));
};
const actualPalette = (preset: string, dark: boolean) => {
  const tokens: Record<string, string> = {
    ...declarations(':root'),
    ...declarations(`html[data-desktop-preset="${preset}"]`),
    ...(dark ? declarations('html[data-desktop-mode="dark"]') : {}),
    ...(dark ? declarations(`html[data-desktop-preset="${preset}"][data-desktop-mode="dark"]`) : {}),
  };
  for (const [name, value] of Object.entries(tokens)) {
    const reference = value.match(/^var\((--[a-z-]+)(?:,\s*var\((--[a-z-]+)\))?\)$/);
    if (reference) tokens[name] = tokens[reference[1] ?? ''] ?? tokens[reference[2] ?? ''] ?? '';
  }
  return tokens;
};
function apply(
  options: unknown,
  {
    dark = false,
    solidSystem = false,
    motionSystem = false,
    blockedMedia = false,
    paletteReady = true,
    tokens = {} as Record<string, string>,
    firstPaint = false,
    legacy = false,
  } = {},
) {
  const properties = new Map<string, string>([['--orbis-accent', 'stale']]);
  const root = {
    dataset: {} as Record<string, string>,
    style: { setProperty: (key: string, value: string) => properties.set(key, value), removeProperty: (key: string) => properties.delete(key) },
  };
  const environment = {
    document: { documentElement: root, querySelector: () => root },
    getComputedStyle: () => ({
      getPropertyValue: (name: string) =>
        tokens[name] ??
        (name === '--desktop-chrome-ink'
          ? '#f5f8f2'
          : name === '--desktop-preset-tint'
            ? '#597b73'
            : paletteReady
              ? ((dark ? darkPalette : palette)[name.replace('--desktop-base-', '') as keyof typeof palette] ?? '')
              : ''),
    }),
    matchMedia: (query: string) => {
      if (blockedMedia) throw new Error('Unavailable');
      return { matches: query.includes('transparency') ? solidSystem : motionSystem };
    },
  };
  // Existing unit cases exercise an explicitly chosen material in each mode.
  const cached = legacy || !options || typeof options !== 'object' ? options : { ...options, [dark ? 'darkMaterial' : 'lightMaterial']: options };
  if (firstPaint)
    runInNewContext(appearanceBootstrap, {
      ...environment,
      requestAnimationFrame: (callback: () => void) => {
        callback();
        return 1;
      },
      localStorage: {
        getItem: (key: string) => (key === preferenceStorageKey ? JSON.stringify({ appearance: cached, mode: dark ? 'dark' : 'light' }) : null),
      },
    });
  else runInNewContext(`(${applyAppearanceRuntime.toString()})(options,mode)`, { ...environment, options, mode: dark ? 'dark' : 'light' });
  return { properties, dataset: root.dataset };
}
const rgb = (value: string) =>
  value.startsWith('#')
    ? [1, 3, 5].map((start) => Number.parseInt(value.slice(start, start + 2), 16)).concat(1)
    : (value.match(/[\d.]+/g) ?? []).map(Number);
const composite = (value: number[], backdrop: number) =>
  value.slice(0, 3).map((channel) => channel * (value[3] ?? 1) + backdrop * (1 - (value[3] ?? 1)));
const luminance = (value: number[]) =>
  value
    .slice(0, 3)
    .map((channel) => channel / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((total, channel, index) => total + channel * ([0.2126, 0.7152, 0.0722][index] ?? 0), 0);
const contrast = (first: number[], second: number[]) =>
  (Math.max(luminance(first), luminance(second)) + 0.05) / (Math.min(luminance(first), luminance(second)) + 0.05);

const chromeBackdrop = (properties: Map<string, string>, wallpaper: number) =>
  wallpaper * (rgb(properties.get('--orbis-chrome-backdrop-brightness') ?? 'brightness(1)')[0] ?? 1);

describe('saved appearance applied before hydration and to live materials', () => {
  test('keeps menu blur independent from panels and disables both for solid surfaces', () => {
    const result = apply({ glassBlur: 12, chromeBlur: 48 });
    expect(result.properties.get('--orbis-glass-filter')).toBe('blur(12px) saturate(1.2)');
    expect(result.properties.get('--orbis-chrome-filter')).toBe('blur(48px) saturate(1.2)');
    expect(apply({ chromeBlur: 65 }).properties.has('--orbis-chrome-filter')).toBe(false);
    expect(apply({ chromeBlur: 0 }).properties.get('--orbis-chrome-filter')).toBe('none');
    const solid = apply({ glassBlur: 12, chromeBlur: 48, transparency: 'solid' });
    expect(solid.properties.get('--orbis-chrome-filter')).toBe('none');
    expect(solid.properties.get('--orbis-glass-filter')).toBe('none');
  });
  test('keeps dense controls and preset colours while applying the default frosted pane', () => {
    const result = apply({});
    expect([...result.properties.keys()].sort()).toEqual([
      '--orbis-accent',
      '--orbis-chrome',
      '--orbis-chrome-focus',
      '--orbis-chrome-muted',
      '--orbis-control-transition-duration',
      '--orbis-focus',
      '--orbis-home-surface',
      '--orbis-info',
      '--orbis-menu-filter',
      '--orbis-menu-muted',
      '--orbis-menu-surface',
      '--orbis-muted',
      '--orbis-negative',
      '--orbis-pane-surface',
      '--orbis-positive',
      '--orbis-warning',
    ]);
    expect(result.dataset).toEqual({
      orbisMotion: 'full',
      orbisTransparency: 'glass',
      orbisEffects: 'full',
      orbisColourCustom: 'false',
      orbisOled: 'false',
    });
  });
  test('ignores invalid or CSS-shaped values instead of writing them into styles', () => {
    const result = apply({
      accent: 'url(https://invalid.example)',
      surfaceOpacity: -1,
      chromeOpacity: 101,
      glassBlur: 1000,
      glassTint: -1,
      lowEffects: 'yes',
    });
    expect([...result.properties.entries()]).toEqual([...apply({}).properties.entries()]);
  });
  test('applies saved text sizing before stylesheet readiness and clears it at the default', () => {
    for (const textScale of [85, 125, 150]) {
      const result = apply({ textScale }, { paletteReady: false });
      expect(result.properties.get('--orbis-text-scale')).toBe(String(textScale / 100));
      expect(result.dataset.orbisEffects).toBeUndefined();
    }
    expect(apply({ textScale: 100 }).properties.has('--orbis-text-scale')).toBe(false);
  });
  test.each([84, 151, 100.5, '150', 'calc(2)', null])('ignores invalid cached text size: %p', (textScale) => {
    expect(apply({ textScale }).properties.has('--orbis-text-scale')).toBe(false);
  });
  test('keeps primary glyphs, links and small labels readable at 128 colour/material extremes', () => {
    let combinations = 0;
    for (const dark of [false, true])
      for (const accent of ['#ffffff', '#000000', '#ffff00', '#00ffff', '#ff0000', '#00ff00', '#0000ff', '#808080'])
        for (const surfaceOpacity of [90, 100])
          for (const glassTint of [0, 30])
            for (const chromeOpacity of [80, 100]) {
              const { properties: p } = apply({ accent, surfaceOpacity, chromeOpacity, glassTint }, { dark });
              const surface = rgb(p.get('--orbis-surface') ?? '');
              for (const key of ['accent', 'muted', 'positive', 'negative', 'warning', 'info']) {
                const foreground = rgb(p.get(`--orbis-${key}`) ?? '');
                for (const backdrop of [0, 255]) expect(contrast(foreground, composite(surface, backdrop))).toBeGreaterThanOrEqual(4.5);
              }
              const action = rgb(p.get('--orbis-action') ?? '');
              expect(contrast(action, [255, 255, 255])).toBeGreaterThanOrEqual(4.5);
              expect(
                contrast(
                  action.slice(0, 3).map((channel) => channel * 0.88),
                  [255, 255, 255],
                ),
              ).toBeGreaterThanOrEqual(4.5);
              for (const backdrop of [0, 255])
                expect(
                  contrast(rgb(p.get('--orbis-chrome-focus') ?? ''), composite(rgb(p.get('--orbis-chrome') ?? ''), chromeBackdrop(p, backdrop))),
                ).toBeGreaterThanOrEqual(3);
              for (const backdrop of [0, 255]) {
                const paint = composite(rgb(p.get('--orbis-chrome') ?? ''), chromeBackdrop(p, backdrop));
                const selected = paint.map((channel) => channel * 0.8 + 255 * 0.2);
                expect(contrast(rgb(p.get('--orbis-chrome-muted') ?? ''), selected)).toBeGreaterThanOrEqual(4.5);
                expect(contrast(rgb('#f5f8f2'), selected)).toBeGreaterThanOrEqual(4.5);
              }
              combinations += 1;
            }
    expect(combinations).toBe(128);
  });
  test('all 20 shipped palettes retain readable default controls and status labels', () => {
    for (const preset of themePresets) {
      for (const dark of [false, true]) {
        const tokens = actualPalette(preset, dark);
        const surface = rgb(tokens['--desktop-base-surface'] ?? '');
        const tint = rgb(tokens['--desktop-preset-tint'] ?? '');
        for (const backdrop of [0, 255]) {
          for (const amount of [0, 0.08, 0.2]) {
            const behind = composite(surface, backdrop).map((channel, index) => channel * (1 - amount) + (tint[index] ?? 0) * amount);
            for (const name of ['--desktop-ink', '--desktop-base-muted', '--desktop-base-accent']) {
              expect(
                contrast(rgb(tokens[name] ?? ''), behind),
                `${preset} ${dark ? 'dark' : 'light'} ${name} over ${backdrop} at ${amount}`,
              ).toBeGreaterThanOrEqual(4.5);
            }
          }
        }
        expect(
          contrast(rgb(tokens['--desktop-base-action'] ?? ''), rgb(tokens['--desktop-base-action-ink'] ?? '')),
          `${preset} ${dark ? 'dark' : 'light'} action`,
        ).toBeGreaterThanOrEqual(4.5);
        const custom = apply({ accent: '#00ffff', surfaceOpacity: 90, glassTint: 30 }, { dark, tokens });
        for (const backdrop of [0, 255]) {
          for (const name of ['accent', 'muted', 'positive', 'negative', 'warning', 'info']) {
            expect(
              contrast(rgb(custom.properties.get(`--orbis-${name}`) ?? ''), composite(rgb(custom.properties.get('--orbis-surface') ?? ''), backdrop)),
            ).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
    }
  });
  test('keeps the sampled palette on accents and dense surfaces in both modes', () => {
    for (const dark of [false, true]) {
      const custom = apply({ themeColour: '#ed6929', accent: '#df4e09' }, { dark, tokens: actualPalette('ocean', dark) });
      const [red = 0, green = 0, blue = 0] = rgb(custom.properties.get('--orbis-accent') ?? '');
      expect(red).toBeGreaterThan(green);
      expect(green).toBeGreaterThan(blue);
      expect(red - blue).toBeGreaterThan(24);
      const [actionRed = 0, , actionBlue = 0] = rgb(custom.properties.get('--orbis-action') ?? '');
      expect(actionRed - actionBlue).toBeGreaterThan(100);
      expect(custom.properties.get('--orbis-accent')).toBe(custom.properties.get('--orbis-focus'));
      expect(custom.properties.get('--orbis-chrome-rgb')).toBe(dark ? '8, 8, 8' : '66, 29, 11');
      expect(custom.properties.get('--orbis-theme-tint')).toBe('rgba(237, 105, 41, 1)');
    }
  });
  test('Graphite remains neutral white in Light and neutral charcoal in Dark', () => {
    for (const dark of [false, true]) {
      const tokens = actualPalette('graphite', dark);
      const surface = rgb(tokens['--desktop-base-surface'] ?? '').slice(0, 3);
      expect(Math.max(...surface) - Math.min(...surface)).toBeLessThanOrEqual(5);
      if (dark) expect(Math.max(...surface)).toBeLessThanOrEqual(30);
      else expect(Math.min(...surface)).toBeGreaterThanOrEqual(250);
    }
  });
  test('main panes use 90% while Home stays more translucent and text retains contrast', () => {
    for (const preset of themePresets) {
      for (const dark of [false, true]) {
        const tokens = actualPalette(preset, dark);
        for (const firstPaint of [false, true]) {
          const { properties, dataset } = apply({}, { dark, tokens, firstPaint });
          const pane = rgb(properties.get('--orbis-pane-surface') ?? '');
          const home = rgb(properties.get('--orbis-home-surface') ?? '');
          expect(pane[3]).toBe(0.9);
          expect(home[3]).toBeGreaterThanOrEqual(dark ? 0.82 : 0.76);
          expect(home[3]).toBeLessThanOrEqual(dark ? 0.9 : 0.88);
          if (!dark) expect(pane.slice(0, 3).every((channel, index) => channel >= (home[index] ?? 0))).toBe(true);
          expect(properties.has('--orbis-surface')).toBe(false);
          expect(dataset.orbisColourCustom).toBe('false');
          for (const wallpaper of [0, 255]) {
            for (const amount of [0, 0.08, 0.2]) {
              const tint = rgb(tokens['--desktop-preset-tint'] ?? '');
              const paint = composite(pane, wallpaper).map((channel, index) => channel * (1 - amount) + (tint[index] ?? 0) * amount);
              expect(contrast(rgb(tokens['--desktop-ink'] ?? ''), paint)).toBeGreaterThanOrEqual(4.5);
              for (const name of ['accent', 'muted', 'positive', 'negative', 'warning', 'info'])
                expect(contrast(rgb(properties.get(`--orbis-${name}`) ?? ''), paint)).toBeGreaterThanOrEqual(4.5);
            }
          }
        }
      }
    }
  });
  test('pane opacity respects custom fill, solid, OLED and device accessibility choices', () => {
    expect(rgb(apply({ surfaceOpacity: 95 }).properties.get('--orbis-pane-surface') ?? '')[3]).toBe(0.95);
    for (const preset of themePresets) {
      for (const dark of [false, true]) {
        const { properties } = apply({ surfaceOpacity: 95 }, { dark, tokens: actualPalette(preset, dark) });
        const home = rgb(properties.get('--orbis-home-surface') ?? '');
        expect(home[3]).toBeLessThan(0.95);
        for (const wallpaper of [0, 255])
          expect(contrast(rgb(properties.get('--orbis-muted') ?? ''), composite(home, wallpaper))).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(rgb(apply({ surfaceOpacity: 40 }).properties.get('--orbis-home-surface') ?? '')[3]).toBe(0.4);
    for (const options of [{ transparency: 'solid' }, { lowEffects: true }, { oledDark: true }]) {
      const result = apply(options, { dark: true });
      expect(rgb(result.properties.get('--orbis-pane-surface') ?? '')[3]).toBe(1);
      expect(rgb(result.properties.get('--orbis-home-surface') ?? '')[3]).toBe(1);
      expect(result.properties.get('--orbis-glass-filter')).toBe('none');
    }
    expect(rgb(apply({}, { solidSystem: true }).properties.get('--orbis-pane-surface') ?? '')[3]).toBe(1);
    expect(rgb(apply({ transparency: 'glass' }, { solidSystem: true }).properties.get('--orbis-pane-surface') ?? '')[3]).toBe(0.9);
  });
  test('floating glass remains translucent and readable across every preset and wallpaper extreme', () => {
    for (const preset of themePresets) {
      for (const dark of [false, true]) {
        const tokens = actualPalette(preset, dark);
        const { properties } = apply({}, { dark, tokens });
        const menu = rgb(properties.get('--orbis-menu-surface') ?? '');
        const chrome = rgb(properties.get('--orbis-chrome') ?? tokens['--desktop-base-chrome'] ?? '');
        expect(menu[3]).toBe(0.78);
        expect(chrome[3]).toBeLessThanOrEqual(dark ? 0.28 : 0.8);
        if (!dark) expect(properties.has('--orbis-chrome-backdrop-brightness')).toBe(false);
        for (const wallpaper of [0, 255]) {
          const behind = composite(menu, wallpaper);
          expect(contrast(rgb(tokens['--desktop-ink'] ?? ''), behind)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(rgb(properties.get('--orbis-menu-muted') ?? ''), behind)).toBeGreaterThanOrEqual(4.5);
          const selected = composite(chrome, chromeBackdrop(properties, wallpaper)).map((channel) => channel * 0.8 + 255 * 0.2);
          expect(contrast(rgb(tokens['--desktop-chrome-ink'] ?? ''), selected)).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
  test('dark Stone defaults use translucent chrome and the requested 90% pane', () => {
    const options = { dark: true, tokens: actualPalette('stone', true) };
    const defaults = apply({}, options).properties;
    const reference = apply(
      { materialMode: 'custom', transparency: 'glass', surfaceOpacity: 90, chromeOpacity: 28, chromeBlur: 24, glassTint: 0 },
      options,
    ).properties;
    for (const token of ['pane-surface', 'chrome', 'chrome-backdrop-brightness', 'chrome-muted', 'chrome-focus']) {
      expect(defaults.get(`--orbis-${token}`)).toBe(reference.get(`--orbis-${token}`));
    }
    expect(defaults.get('--orbis-chrome-filter')).toBe(reference.get('--orbis-chrome-filter'));
    expect(rgb(defaults.get('--orbis-chrome') ?? '').slice(0, 3)).toEqual([8, 8, 8]);
  });
  test('the entire opacity sweep retains the same chrome tint and readable controls in every palette', () => {
    for (const dark of [false, true]) {
      for (const preset of themePresets) {
        const tokens = actualPalette(preset, dark);
        const automatic = wallpaperColourOverrides({ themeColour: '#a8432c', accent: '#2fe3ba' });
        for (const colours of [{}, automatic, { themeColour: '#ffffff', accent: '#692344' }]) {
          const opacities = [100, 90, 89, 80, 76, 70, 50, 0];
          const paints = opacities.map(
            (chromeOpacity) =>
              apply({ materialMode: 'custom', glassTint: 30, chromeBlur: 0, chromeOpacity, ...colours }, { dark, tokens }).properties,
          );
          const baseline = rgb(paints[0]?.get('--orbis-chrome') ?? '').slice(0, 3);
          for (const [index, paint] of paints.entries()) {
            const chrome = rgb(paint.get('--orbis-chrome') ?? '');
            expect(chrome.slice(0, 3)).toEqual(baseline);
            expect(chrome[3]).toBe((opacities[index] ?? 0) / 100);
            for (const role of ['theme-tint', 'action', 'accent']) {
              expect(paint.get(`--orbis-${role}`)).toBe(paints[0]?.get(`--orbis-${role}`));
            }
            expect(paint.get('--orbis-chrome-filter')).toBe('none');
            if (paint.has('--orbis-chrome-backdrop-brightness')) expect(paint.get('--orbis-glass-chrome-blur')).toBe('blur(0px)');
            for (const backdrop of [0, 255]) {
              const resting = composite(chrome, chromeBackdrop(paint, backdrop));
              const highlighted = resting.map((channel) => channel * 0.76 + 255 * 0.24);
              for (const background of [resting, highlighted]) {
                for (const ink of [tokens['--desktop-chrome-ink'] ?? '', '#fff7ec', paint.get('--orbis-chrome-muted') ?? '']) {
                  expect(contrast(rgb(ink), background)).toBeGreaterThanOrEqual(4.5);
                }
                expect(contrast(rgb(paint.get('--orbis-chrome-focus') ?? ''), background)).toBeGreaterThanOrEqual(3);
              }
            }
          }
        }
      }
    }
  });
  test('dark chrome stays neutral across presets and custom colours while actions retain their accent', () => {
    for (const preset of themePresets) {
      const options = { dark: true, tokens: actualPalette(preset, true) };
      const normal = apply({}, options).properties;
      expect(rgb(normal.get('--orbis-chrome') ?? '')).toEqual([8, 8, 8, 0.28]);
      expect(normal.get('--orbis-chrome-filter')).toBe('blur(24px) saturate(1.2)');
      for (const chromeOpacity of [10, 28, 76, 100]) {
        const custom = apply({ materialMode: 'custom', chromeOpacity, glassTint: 30, themeColour: '#ed6929', accent: '#df4e09' }, options).properties;
        expect(rgb(custom.get('--orbis-chrome') ?? '')).toEqual([8, 8, 8, chromeOpacity / 100]);
        expect(custom.get('--orbis-theme-tint')).toBe('rgba(237, 105, 41, 1)');
        expect(custom.get('--orbis-action-rgb')).not.toBe('8, 8, 8');
      }
    }
  });
  test('explicit solid and accessibility materials remain opaque, while explicit chrome opacity is preserved', () => {
    for (const options of [{ transparency: 'solid' }, { lowEffects: true }, { oledDark: true }]) {
      const { properties } = apply(options, { dark: true });
      expect(rgb(properties.get('--orbis-menu-surface') ?? '')[3]).toBe(1);
      expect(properties.get('--orbis-chrome-filter')).toBe('none');
      expect(properties.get('--orbis-menu-filter')).toBe('none');
    }
    expect(rgb(apply({ chromeOpacity: 100 }).properties.get('--orbis-chrome') ?? '')[3]).toBe(1);
  });
  test('dropdown blur and translucency are independent of Bar and Dock opacity and blur', () => {
    for (const dark of [false, true])
      for (const chromeOpacity of [0, 28, 100])
        for (const chromeBlur of [0, 64]) {
          const { properties } = apply({ chromeOpacity, chromeBlur }, { dark });
          expect(properties.get('--orbis-menu-filter')).toBe('blur(24px) saturate(1.2)');
          expect(rgb(properties.get('--orbis-menu-surface') ?? '')[3]).toBe(0.78);
        }
  });
  test.each([
    ['#fdf7faf7', [253, 247, 250]],
    ['#FDF7FAF7', [253, 247, 250]],
    ['#abc8', [170, 187, 204]],
    ['#abc', [170, 187, 204]],
  ] as const)('compiled palette %s preserves its colour in solid mode and startup', (surface, expected) => {
    for (const firstPaint of [false, true]) {
      const result = apply({ lowEffects: true }, { tokens: { '--desktop-base-surface': surface }, firstPaint });
      const actual = rgb(result.properties.get('--orbis-surface') ?? '');
      expect(actual).toEqual([...expected, 1]);
      expect(contrast(actual, [0, 0, 0])).toBeGreaterThan(4.5);
    }
  });
  test('OLED blackens cards and panels while preserving preset chrome and controls in dark mode', () => {
    const oled = apply({ oledDark: true, glassTint: 30, surfaceOpacity: 90 }, { dark: true });
    expect(rgb(oled.properties.get('--orbis-surface') ?? '')).toEqual([0, 0, 0, 1]);
    expect(rgb(oled.properties.get('--orbis-chrome') ?? '')).toEqual([8, 8, 8, 1]);
    expect(rgb(oled.properties.get('--orbis-panel-dark') ?? '')).toEqual([0, 0, 0, 1]);
    expect(rgb(oled.properties.get('--orbis-oled-panel') ?? '')).toEqual([0, 0, 0, 1]);
    expect(oled.properties.has('--orbis-action')).toBe(false);
    expect(oled.dataset.orbisEffects).toBe('full');
    expect(oled.dataset.orbisMotion).toBe('full');
    expect(oled.dataset.orbisOled).toBe('true');
    expect(themeCss).toContain(':root[data-orbis-oled="true"] body:has(.orbis-theme) :is(.alert, .workspace-message)');
    for (const preset of themePresets) {
      const ink = actualPalette(preset, true)['--desktop-ink'] ?? '';
      expect(contrast(rgb(ink), [0, 0, 0])).toBeGreaterThan(4.5);
    }
    const light = apply({ oledDark: true });
    expect(light.properties.has('--orbis-surface')).toBe(false);
    expect(light.properties.has('--orbis-oled-panel')).toBe(false);
    expect(light.dataset.orbisOled).toBe('false');
    const cached = apply({ oledDark: true }, { dark: true, firstPaint: true });
    expect(rgb(cached.properties.get('--orbis-surface') ?? '')).toEqual([0, 0, 0, 1]);
    expect(rgb(cached.properties.get('--orbis-oled-panel') ?? '')).toEqual([0, 0, 0, 1]);
  });
  test('low effects forces opaque materials and disables the blur filter', () => {
    const result = apply({ lowEffects: true, glassBlur: 40, surfaceOpacity: 90, chromeOpacity: 80 });
    expect(result.dataset.orbisMotion).toBe('reduced');
    expect(result.dataset.orbisTransparency).toBe('solid');
    expect(result.dataset.orbisEffects).toBe('low');
    expect(result.properties.get('--orbis-glass-filter')).toBe('none');
    for (const name of ['surface', 'chrome', 'panel-dark']) expect(rgb(result.properties.get(`--orbis-${name}`) ?? '')[3]).toBe(1);
  });
  test('respects system preferences with an explicit glass override', () => {
    expect(apply({}, { solidSystem: true, motionSystem: true }).dataset).toMatchObject({ orbisTransparency: 'solid', orbisMotion: 'reduced' });
    expect(apply({ transparency: 'glass' }, { solidSystem: true }).dataset.orbisTransparency).toBe('glass');
    expect(apply({ motion: 'reduced' }).dataset.orbisMotion).toBe('reduced');
  });
  test('works when browser media preferences are unavailable', () => {
    expect(apply({ glassBlur: 0 }, { blockedMedia: true }).properties.get('--orbis-glass-filter')).toBe('none');
  });
});

test('low-effects switches keep cheap transitions while explicit and system reduced motion remain immediate, including first paint', () => {
  for (const firstPaint of [false, true]) {
    for (const lowEffects of [false, true]) {
      expect(apply({ lowEffects }, { firstPaint }).properties.get('--orbis-control-transition-duration')).toBe('180ms');
      expect(apply({ lowEffects, motion: 'reduced' }, { firstPaint }).properties.get('--orbis-control-transition-duration')).toBe('0.01ms');
      expect(apply({ lowEffects }, { firstPaint, motionSystem: true }).properties.get('--orbis-control-transition-duration')).toBe('0.01ms');
    }
  }
  expect(apply({ lowEffects: true }).dataset.orbisMotion).toBe('reduced');
  expect(apply({ lowEffects: true }).properties.get('--orbis-glass-filter')).toBe('none');
});

test('menu labels stay readable on tinted cards and selected menu items across every preset and wallpaper extreme', () => {
  for (const preset of themePresets)
    for (const dark of [false, true]) {
      const tokens = actualPalette(preset, dark);
      const { properties } = apply({}, { dark, tokens });
      const menu = rgb(properties.get('--orbis-menu-surface') ?? '');
      const muted = rgb(properties.get('--orbis-menu-muted') ?? '');
      const tint = rgb(tokens['--desktop-preset-tint'] ?? '');
      for (const wallpaper of [0, 255])
        for (const amount of [0, 0.07, 0.16, 0.2]) {
          const background = composite(menu, wallpaper).map((value, index) => value * (1 - amount) + (tint[index] ?? 0) * amount);
          expect(contrast(muted, background)).toBeGreaterThanOrEqual(4.5);
        }
    }
});

test('explicit default keeps the accepted material and retains inactive custom values', () => {
  for (const firstPaint of [false, true]) {
    for (const dark of [false, true]) {
      const previous = apply({}, { firstPaint, dark });
      const retained = apply(
        { materialMode: 'default', surfaceOpacity: 0, chromeOpacity: 0, glassBlur: 0, chromeBlur: 0, glassTint: 30 },
        { firstPaint, dark },
      );
      expect([...retained.properties]).toEqual([...previous.properties]);
      expect(retained.dataset).toEqual(previous.dataset);
    }
  }
});

test('all integer custom opacity values including zero survive startup without a hidden opacity floor', () => {
  for (const firstPaint of [false, true]) {
    for (const dark of [false, true]) {
      for (const opacity of [0, 1, 25, 50, 68, 76, 89, 90, 100]) {
        const { properties } = apply({ materialMode: 'custom', surfaceOpacity: opacity, chromeOpacity: opacity }, { firstPaint, dark });
        expect(rgb(properties.get('--orbis-pane-surface') ?? '')[3]).toBe(opacity / 100);
        expect(rgb(properties.get('--orbis-chrome') ?? '')[3]).toBe(opacity / 100);
        expect([...properties.values()].every((value) => !/NaN|Infinity|undefined/.test(value))).toBe(true);
      }
    }
  }
  expect(apply({ surfaceOpacity: 25 }).properties.get('--orbis-pane-surface')).toBe(
    apply({ materialMode: 'custom', surfaceOpacity: 25 }).properties.get('--orbis-pane-surface'),
  );
});

test('custom theme seeds and independent accents are readable at default glass across modes and first paint', () => {
  for (const themeColour of ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#f8da35', '#ad2756', '#ef9dc5']) {
    for (const dark of [false, true]) {
      for (const firstPaint of [false, true]) {
        const { properties } = apply({ themeColour, accent: '#d33f91' }, { dark, firstPaint });
        const ink = rgb(properties.get('--orbis-theme-ink') ?? '');
        const pane = rgb(properties.get('--orbis-pane-surface') ?? '');
        const tint = rgb(themeColour);
        for (const wallpaper of [0, 255]) {
          for (const amount of [0, 0.08, 0.2]) {
            const paint = composite(pane, wallpaper).map((value, index) => value * (1 - amount) + (tint[index] ?? 0) * amount);
            expect(contrast(ink, paint)).toBeGreaterThanOrEqual(4.5);
          }
        }
        expect(contrast(rgb(properties.get('--orbis-action') ?? ''), [255, 255, 255])).toBeGreaterThanOrEqual(4.5);
        expect(properties.get('--orbis-theme-tint')).toBeTruthy();
      }
    }
  }
});

test('legacy chrome stays in Dark on first paint and explicit mode profiles retain independent blur and alpha', () => {
  const legacy = { chromeOpacity: 10, glassBlur: 40, chromeBlur: 7, themeColour: '#917965', textScale: 125 };
  const firstPaint = (appearance: unknown, dark: boolean) => apply(appearance, { firstPaint: true, legacy: true, dark }).properties;
  const light = firstPaint(legacy, false);
  const dark = firstPaint(legacy, true);
  expect(rgb(light.get('--orbis-pane-surface') ?? '')[3]).toBe(0.9);
  expect(rgb(light.get('--orbis-chrome') ?? '')[3]).not.toBe(0.1);
  expect(light.has('--orbis-chrome-filter')).toBe(false);
  expect(rgb(dark.get('--orbis-chrome') ?? '')[3]).toBe(0.1);
  expect(rgb(dark.get('--orbis-menu-surface') ?? '')[3]).toBe(0.78);
  expect(dark.get('--orbis-chrome-filter')).toBe('blur(7px) saturate(1.2)');
  expect(dark.get('--orbis-glass-filter')).toBe('blur(40px) saturate(1.2)');
  expect(chromeBackdrop(dark, 1)).toBeGreaterThan(0.22);
  expect(light.get('--orbis-theme-tint')).toBe(dark.get('--orbis-theme-tint'));
  expect(light.get('--orbis-text-scale')).toBe('1.25');

  const split = {
    ...legacy,
    lightMaterial: { chromeOpacity: 85, chromeBlur: 18, glassBlur: 12 },
    darkMaterial: { chromeOpacity: 0, chromeBlur: 0, glassBlur: 36 },
  };
  expect(rgb(firstPaint(split, false).get('--orbis-chrome') ?? '')[3]).toBe(0.85);
  expect(firstPaint(split, false).get('--orbis-chrome-filter')).toBe('blur(18px) saturate(1.2)');
  const zero = firstPaint(split, true);
  expect(rgb(zero.get('--orbis-chrome') ?? '')[3]).toBe(0);
  expect(rgb(zero.get('--orbis-menu-surface') ?? '')[3]).toBe(0.78);
  expect(zero.get('--orbis-menu-filter')).toBe('blur(24px) saturate(1.2)');
  expect(zero.get('--orbis-chrome-filter')).toBe('none');
  expect(zero.get('--orbis-glass-chrome-blur')).toBe('blur(0px)');
  expect(zero.get('--orbis-glass-filter')).toBe('blur(36px) saturate(1.2)');
});

test('dark floating panels keep a restrained near-black preset tint', () => {
  for (const preset of themePresets) {
    const tokens = actualPalette(preset, true);
    const { properties } = apply({}, { dark: true, tokens });
    const menu = rgb(properties.get('--orbis-menu-surface') ?? '');
    expect(Math.max(...menu.slice(0, 3))).toBeLessThan(30);
    expect(menu[3]).toBe(0.78);
    expect(properties.get('--orbis-menu-filter')).toBe('blur(24px) saturate(1.2)');
  }
});
