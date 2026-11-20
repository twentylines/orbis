import { describe, expect, test } from 'bun:test';
import { selectWallpaperColours } from './wallpaper-palette';

const sample = (...colours: { rgb: number[]; count: number }[]) =>
  new Uint8ClampedArray(colours.flatMap(({ rgb, count }) => Array.from({ length: count }, () => [...rgb, 255]).flat()));

describe('population-aware wallpaper colours', () => {
  test('uses the broad landscape colour rather than a tiny neon highlight', () => {
    const base = sample({ rgb: [74, 112, 82], count: 900 }, { rgb: [240, 15, 230], count: 9 });
    expect(selectWallpaperColours(base)).toEqual(selectWallpaperColours(sample({ rgb: [74, 112, 82], count: 900 })));
  });
  test('a substantial secondary tone can supply the accent', () => {
    const pair = selectWallpaperColours(sample({ rgb: [80, 120, 145], count: 600 }, { rgb: [160, 90, 150], count: 400 }));
    expect(pair.themeColour).not.toBe(pair.accent);
    expect(pair).toEqual(selectWallpaperColours(sample({ rgb: [160, 90, 150], count: 400 }, { rgb: [80, 120, 145], count: 600 })));
  });
  test('does not invent a saturated colour in a monochrome image', () => {
    const pair = selectWallpaperColours(
      sample({ rgb: [110, 110, 110], count: 800 }, { rgb: [160, 160, 160], count: 200 }, { rgb: [255, 0, 0], count: 1 }),
    );
    for (const value of Object.values(pair)) expect(value.slice(1, 3)).toBe(value.slice(3, 5));
  });
  test('keeps a substantial orange subject colourful across different shades and a neutral background', () => {
    const pair = selectWallpaperColours(
      sample({ rgb: [125, 125, 125], count: 720 }, { rgb: [197, 118, 75], count: 100 }, { rgb: [227, 133, 84], count: 100 }),
    );
    for (const colour of Object.values(pair)) {
      const [red = 0, green = 0, blue = 0] = (colour.match(/[a-f0-9]{2}/g) ?? []).map((channel) => Number.parseInt(channel, 16));
      expect(red).toBeGreaterThan(green);
      expect(green).toBeGreaterThan(blue);
      expect(red - blue).toBeGreaterThan(100);
    }
    expect(pair.themeColour).not.toEqual(pair.accent);
  });

  test('black, white and transparent images have a stable neutral fallback', () => {
    const fallback = { themeColour: '#737780', accent: '#626b80' };
    for (const rgb of [
      [0, 0, 0],
      [255, 255, 255],
    ])
      expect(selectWallpaperColours(sample({ rgb, count: 50 }))).toEqual(fallback);
    expect(selectWallpaperColours(new Uint8ClampedArray(400))).toEqual(fallback);
  });
  test('rejects malformed and oversized samples before doing colour work', () => {
    for (const pixels of [[], [1, 2, 3], [1, 2, 3, Number.NaN], [1, 2, 3, 256], new Uint8ClampedArray(96 * 96 * 4 + 4)])
      expect(() => selectWallpaperColours(pixels)).toThrow('Invalid wallpaper sample.');
  });
});
