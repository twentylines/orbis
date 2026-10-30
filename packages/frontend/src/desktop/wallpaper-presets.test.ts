/// <reference types="bun" />
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'bun:test';
import { WallpaperLayer } from './wallpaper-layer';
import { presetWallpaperPreviews, presetWallpaperSources, resolveWallpaperKey, themePresets, wallpaperSources } from './wallpaper-presets';

describe('versioned wallpaper photographs', () => {
  test('every preset points to its new full image and preview', () => {
    for (const preset of themePresets) {
      const version = preset === 'blush' || preset === 'ocean' ? 'v3' : 'v2';
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
