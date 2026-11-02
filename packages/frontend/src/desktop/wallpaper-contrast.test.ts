import { describe, expect, test } from 'bun:test';
import { wallpaperTextColour, type WallpaperSample } from './wallpaper-contrast';

function sample(pixel: (x: number, y: number) => [number, number, number, number]): WallpaperSample {
  const data = new Uint8ClampedArray(16 * 16 * 4);
  for (let y = 0; y < 16; y += 1) for (let x = 0; x < 16; x += 1) data.set(pixel(x, y), (y * 16 + x) * 4);
  return { pixels: { width: 16, height: 16, sourceWidth: 1600, sourceHeight: 1600, data }, fit: 'cover', x: 50, y: 0, dim: 0 };
}
const viewport = { width: 800, height: 800 };
const region = { left: 40, top: 80, width: 240, height: 100 };
const base = [0, 0, 0] as const;

describe('wallpaper text contrast', () => {
  test('uses light text on a dark image and dark text on a bright image regardless of interface mode', () => {
    expect(
      wallpaperTextColour(
        sample(() => [25, 39, 42, 255]),
        viewport,
        region,
        base,
      ),
    ).toBe('#ffffff');
    expect(
      wallpaperTextColour(
        sample(() => [235, 225, 205, 255]),
        viewport,
        region,
        base,
      ),
    ).toBe('#10181b');
  });
  test('samples the text region, so headings on different parts of one image can use different colours', () => {
    const image = sample((x) => (x < 8 ? [15, 20, 25, 255] : [235, 235, 235, 255]));
    expect(wallpaperTextColour(image, viewport, region, base)).toBe('#ffffff');
    expect(wallpaperTextColour(image, viewport, { ...region, left: 480 }, base)).toBe('#10181b');
  });
  test('honours cover cropping and the saved horizontal position', () => {
    const image = sample((x) => (x < 8 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const narrow = { width: 200, height: 800 };
    const heading = { left: 10, top: 30, width: 180, height: 80 };
    expect(wallpaperTextColour({ ...image, x: 0 }, narrow, heading, base)).toBe('#ffffff');
    expect(wallpaperTextColour({ ...image, x: 100 }, narrow, heading, base)).toBe('#10181b');
  });
  test('honours vertical positioning and dimming', () => {
    const image = sample((_, y) => (y < 8 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const wide = { width: 800, height: 200 };
    expect(wallpaperTextColour({ ...image, y: 0 }, wide, region, base)).toBe('#ffffff');
    expect(wallpaperTextColour({ ...image, y: 100 }, wide, region, base)).toBe('#10181b');
    expect(wallpaperTextColour({ ...image, y: 100, dim: 0.8 }, wide, region, base)).toBe('#ffffff');
  });
  test('includes contained gutters and transparent custom artwork', () => {
    const image = sample(() => [0, 0, 0, 0]);
    expect(wallpaperTextColour(image, viewport, region, [250, 250, 250])).toBe('#10181b');
    const contained = { ...image, fit: 'contain' as const, pixels: { ...image.pixels, sourceWidth: 3200 } };
    expect(wallpaperTextColour(contained, viewport, { ...region, top: 10 }, base)).toBe('#ffffff');
  });
  test('does not replace a hidden or offscreen heading fallback', () => {
    const image = sample(() => [0, 0, 0, 255]);
    expect(wallpaperTextColour(image, viewport, { ...region, height: 0 }, base)).toBeNull();
    expect(wallpaperTextColour(image, viewport, { ...region, top: 1000 }, base)).toBeNull();
  });
});
