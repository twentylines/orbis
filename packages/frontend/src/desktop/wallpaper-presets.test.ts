/// <reference types="bun" />
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'bun:test';
import { WallpaperLayer } from './wallpaper-layer';
import {
  presetWallpaperColours,
  presetWallpaperPreviews,
  presetWallpaperSources,
  resolveWallpaperKey,
  taggedWallpaperColours,
  themePresets,
  visibleThemePresets,
  wallpaperColourOverrides,
  wallpaperSources,
} from './wallpaper-presets';

describe('versioned wallpaper photographs', () => {
  test('every preset points to its new full image and preview', () => {
    for (const preset of themePresets) {
      const version = ['amber', 'rose'].includes(preset) ? 'v1' : preset === 'blush' || preset === 'ocean' || preset === 'forest' ? 'v4' : 'v2';
      expect(presetWallpaperSources[preset]).toBe(`/wallpapers/${preset}-${version}.webp`);
      expect(presetWallpaperPreviews[preset]).toBe(`/wallpapers/${preset}-${version}-preview.webp`);
      expect(Bun.file(new URL(`../../public${presetWallpaperSources[preset]}`, import.meta.url)).size).toBeGreaterThan(0);
      expect(Bun.file(new URL(`../../public${presetWallpaperPreviews[preset]}`, import.meta.url)).size).toBeGreaterThan(0);
      expect(wallpaperSources[`theme-${preset}`]).toBe(presetWallpaperSources[preset]);
    }
  });

  test('legacy aliases and custom wallpaper selections keep resolving', () => {
    expect(wallpaperSources.sandstone).toBe(presetWallpaperSources.stone);
    expect(wallpaperSources.tidal).toBe(presetWallpaperSources.ocean);
    expect(wallpaperSources.canopy).toBe(presetWallpaperSources.forest);

    expect(resolveWallpaperKey({ preset: 'frost', wallpaper: 'sandstone', wallpaperMode: 'theme' })).toBe('theme-frost');
    expect(resolveWallpaperKey({ preset: 'frost', wallpaper: 'sandstone', wallpaperMode: 'custom', wallpaperPreset: null })).toBe('sandstone');
    expect(resolveWallpaperKey({ preset: 'frost', wallpaper: 'tidal', wallpaperMode: 'custom', wallpaperPreset: 'ocean' })).toBe('theme-ocean');
  });

  test('tags built-ins and legacy aliases but leaves uploaded and online photos to sampling', () => {
    for (const preset of themePresets) {
      expect(taggedWallpaperColours(presetWallpaperSources[preset])).toEqual({ ...presetWallpaperColours[preset], preset });
    }
    expect(taggedWallpaperColours(wallpaperSources.tidal)?.preset).toBe('ocean');
    expect(taggedWallpaperColours(wallpaperSources.sandstone)?.preset).toBe('stone');
    expect(taggedWallpaperColours(wallpaperSources.canopy)?.preset).toBe('forest');
    expect(taggedWallpaperColours('blob:custom')).toBeNull();
    expect(taggedWallpaperColours('https://images.unsplash.com/photo-example')).toBeNull();
  });

  test('selects the named palette for a tagged photo and uses overrides only for an extracted pair', () => {
    expect(wallpaperColourOverrides(taggedWallpaperColours(presetWallpaperSources.orange))).toEqual({ themeColour: null, accent: null });
    const custom = { themeColour: '#f97329', accent: '#b44206' };
    expect(wallpaperColourOverrides(custom)).toEqual(custom);
    expect(wallpaperColourOverrides(null)).toBeNull();
  });

  test('hides the pink preset from selection while keeping stored wallpaper and theme identifiers valid', () => {
    expect(visibleThemePresets).toEqual(themePresets.filter((preset) => preset !== 'rose'));
    expect(resolveWallpaperKey({ preset: 'rose', wallpaper: 'tidal' })).toBe('theme-rose');
    expect(resolveWallpaperKey({ preset: 'frost', wallpaper: 'tidal', wallpaperPreset: 'rose' })).toBe('theme-rose');
  });

  test('keeps Home headings unframed for built-in presets and custom photos', () => {
    for (const preset of themePresets) {
      const markup = renderToStaticMarkup(createElement(WallpaperLayer, { choice: { preset, wallpaper: 'sandstone', wallpaperMode: 'theme' } }));
      expect(markup).not.toContain('data-heading-protect');
    }
    const customMarkup = renderToStaticMarkup(
      createElement(WallpaperLayer, {
        choice: {
          preset: 'ocean',
          wallpaper: 'tidal',
          wallpaperMode: 'custom',
          appearance: { wallpaperImage: 'a'.repeat(64) },
        },
      }),
    );
    expect(customMarkup).not.toContain('data-heading-protect');
  });
});
