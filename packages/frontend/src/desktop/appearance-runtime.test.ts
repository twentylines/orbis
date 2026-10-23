/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { applyAppearanceRuntime } from './appearance-runtime';

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
function apply(options: unknown, { dark = false, solidSystem = false, motionSystem = false, blockedMedia = false, paletteReady = true } = {}) {
  const properties = new Map<string, string>([['--orbis-accent', 'stale']]);
  const root = {
    dataset: {} as Record<string, string>,
    style: { setProperty: (key: string, value: string) => properties.set(key, value), removeProperty: (key: string) => properties.delete(key) },
  };
  const environment = {
    document: { documentElement: root, querySelector: () => root },
    getComputedStyle: () => ({
      getPropertyValue: (name: string) =>
        name === '--desktop-chrome-ink'
          ? '#f5f8f2'
          : name === '--desktop-preset-tint'
            ? '#597b73'
            : paletteReady
              ? ((dark ? darkPalette : palette)[name.replace('--desktop-base-', '') as keyof typeof palette] ?? '')
              : '',
    }),
    matchMedia: (query: string) => {
      if (blockedMedia) throw new Error('Unavailable');
      return { matches: query.includes('transparency') ? solidSystem : motionSystem };
    },
  };
  runInNewContext(`(${applyAppearanceRuntime.toString()})(options,mode)`, { ...environment, options, mode: dark ? 'dark' : 'light' });
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

describe('saved appearance applied before hydration and to live materials', () => {
  test('keeps the theme defaults exact and removes stale overrides on reset', () => {
    const result = apply({});
    expect([...result.properties.keys()].sort()).toEqual(['--orbis-chrome-focus', '--orbis-chrome-muted']);
    expect(result.dataset).toEqual({ orbisMotion: 'full', orbisTransparency: 'glass', orbisEffects: 'full', orbisColourCustom: 'false' });
  });
  test('ignores invalid or CSS-shaped values instead of writing them into styles', () => {
    const result = apply({
      accent: 'url(https://invalid.example)',
      surfaceOpacity: 0,
      chromeOpacity: 79,
      glassBlur: 1000,
      glassTint: -1,
      lowEffects: 'yes',
    });
    expect([...result.properties.keys()].sort()).toEqual(['--orbis-chrome-focus', '--orbis-chrome-muted']);
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
                  contrast(rgb(p.get('--orbis-chrome-focus') ?? ''), composite(rgb(p.get('--orbis-chrome') ?? ''), backdrop)),
                ).toBeGreaterThanOrEqual(3);
              for (const backdrop of [0, 255]) {
                const paint = composite(rgb(p.get('--orbis-chrome') ?? ''), backdrop);
                const selected = paint.map((channel) => channel * 0.8 + 255 * 0.2);
                expect(contrast(rgb(p.get('--orbis-chrome-muted') ?? ''), selected)).toBeGreaterThanOrEqual(4.5);
                expect(contrast(rgb('#f5f8f2'), selected)).toBeGreaterThanOrEqual(4.5);
              }
              combinations += 1;
            }
    expect(combinations).toBe(128);
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
