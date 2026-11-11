export type WallpaperPixels = {
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  data: Uint8ClampedArray;
};

export type WallpaperSample = {
  pixels: WallpaperPixels;
  fit: 'cover' | 'contain';
  x: number;
  y: number;
  dim: number;
};

type Rect = { left: number; top: number; width: number; height: number };
type Colour = readonly [number, number, number];

export const wallpaperTextColours = { light: '#ffffff', dark: '#10181b' } as const;
const colours: Record<keyof typeof wallpaperTextColours, Colour> = { light: [255, 255, 255], dark: [16, 24, 27] };
const luminance = (rgb: Colour) => {
  const linear = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
};
const contrast = (first: number, second: number) => (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);

export function wallpaperTextColour(sample: WallpaperSample, viewport: { width: number; height: number }, rect: Rect, base: Colour) {
  const { pixels } = sample;
  if (Math.min(viewport.width, viewport.height, pixels.sourceWidth, pixels.sourceHeight, rect.width, rect.height) <= 0) return null;
  const scale = Math[sample.fit === 'contain' ? 'min' : 'max'](viewport.width / pixels.sourceWidth, viewport.height / pixels.sourceHeight);
  const width = pixels.sourceWidth * scale;
  const height = pixels.sourceHeight * scale;
  const left = (viewport.width - width) * (sample.x / 100);
  const top = (viewport.height - height) * (sample.y / 100);
  const dim = 1 - Math.max(0, Math.min(1, sample.dim));
  const readings: number[] = [];
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 12; column += 1) {
      const x = rect.left + ((column + 0.5) * rect.width) / 12;
      const y = rect.top + ((row + 0.5) * rect.height) / 4;
      if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) continue;
      const imageX = (x - left) / width;
      const imageY = (y - top) / height;
      let rgb = base;
      if (imageX >= 0 && imageX < 1 && imageY >= 0 && imageY < 1) {
        const offset = (Math.floor(imageY * pixels.height) * pixels.width + Math.floor(imageX * pixels.width)) * 4;
        const alpha = (pixels.data[offset + 3] ?? 0) / 255;
        rgb = [0, 1, 2].map((channel) => (pixels.data[offset + channel] ?? 0) * alpha + (base[channel] ?? 0) * (1 - alpha)) as [
          number,
          number,
          number,
        ];
      }
      readings.push(luminance(rgb.map((channel) => channel * dim) as [number, number, number]));
    }
  }
  if (!readings.length) return null;
  const score = (colour: Colour) => {
    const value = luminance(colour);
    // A heading can cross sky and dark foreground; protect its weakest sampled region.
    return Math.min(...readings.map((reading) => contrast(value, reading)));
  };
  const lightScore = score(colours.light);
  const darkScore = score(colours.dark);
  // Mixed photographs need light ink so its dark, diffuse shadow can support the bright areas.
  if (Math.max(lightScore, darkScore) < 4.5) return wallpaperTextColours.light;
  return lightScore > darkScore ? wallpaperTextColours.light : wallpaperTextColours.dark;
}
