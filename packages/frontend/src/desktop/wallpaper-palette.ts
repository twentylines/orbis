export type WallpaperColours = { themeColour: string; accent: string };

type Colour = { red: number; green: number; blue: number; count: number };
const hsl = (red: number, green: number, blue: number) => {
  const values = [red, green, blue].map((value) => value / 255);
  const [r = 0, g = 0, b = 0] = values;
  const high = Math.max(...values);
  const low = Math.min(...values);
  const difference = high - low;
  const light = (high + low) / 2;
  const saturation = difference === 0 ? 0 : difference / (1 - Math.abs(2 * light - 1));
  const hue =
    difference === 0 ? 0 : ((high === r ? (g - b) / difference : high === g ? (b - r) / difference + 2 : (r - g) / difference + 4) * 60 + 360) % 360;
  return { hue, saturation, light };
};
const hex = (hue: number, saturation: number, light: number) => {
  const chroma = (1 - Math.abs(2 * light - 1)) * saturation;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const offset = light - chroma / 2;
  const segments = [
    [chroma, x, 0],
    [x, chroma, 0],
    [0, chroma, x],
    [0, x, chroma],
    [x, 0, chroma],
    [chroma, 0, x],
  ];
  return `#${(segments[Math.floor(hue / 60)] ?? segments[0] ?? [])
    .map((channel) =>
      Math.round((channel + offset) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
};
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

// Population is measured before saturation: a tiny colourful highlight must not
// recolour a mostly neutral image. The runtime derives readable Light/Dark inks.
export function selectWallpaperColours(pixels: ArrayLike<number>): WallpaperColours {
  if (!pixels.length || pixels.length % 4 !== 0 || pixels.length > 96 * 96 * 4) throw new Error('Invalid wallpaper sample.');
  const buckets = new Map<number, Colour>();
  let included = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const channels = [pixels[index], pixels[index + 1], pixels[index + 2], pixels[index + 3]];
    if (!channels.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 255))
      throw new Error('Invalid wallpaper sample.');
    const [red = 0, green = 0, blue = 0, alpha = 0] = channels;
    if (alpha < 224) continue;
    const colour = hsl(red, green, blue);
    if (colour.light < 0.07 || colour.light > 0.93) continue;
    const neutral = colour.saturation < 0.12;
    // Group shades of the same hue so a broad colour is not outvoted by grey.
    const key = neutral ? 24 : Math.floor(((colour.hue + 7.5) % 360) / 15);
    const bucket = buckets.get(key) ?? { red: 0, green: 0, blue: 0, count: 0 };
    bucket.red += red;
    bucket.green += green;
    bucket.blue += blue;
    bucket.count++;
    included++;
    buckets.set(key, bucket);
  }
  if (!included) return { themeColour: '#737780', accent: '#626b80' };
  const candidates = [...buckets.values()]
    .map((bucket) => ({
      ...hsl(bucket.red / bucket.count, bucket.green / bucket.count, bucket.blue / bucket.count),
      population: bucket.count / included,
    }))
    .sort((a, b) => b.population - a.population || a.hue - b.hue);
  const dominant = candidates.find((candidate) => candidate.saturation >= 0.12 && candidate.population >= 0.12) ?? candidates[0];
  if (!dominant) return { themeColour: '#737780', accent: '#626b80' };
  const chromatic = dominant.saturation >= 0.12;
  const theme = hex(dominant.hue, clamp(dominant.saturation * 1.16, chromatic ? 0.42 : 0, 0.9), clamp(dominant.light, 0.4, 0.62));
  const accents = candidates
    .filter((candidate) => {
      const distance = Math.abs(candidate.hue - dominant.hue);
      const hueDistance = Math.min(distance, 360 - distance);
      return (
        chromatic &&
        candidate.population >= Math.max(0.08, dominant.population * 0.25) &&
        candidate.saturation >= 0.18 &&
        hueDistance >= 18 &&
        hueDistance <= 95
      );
    })
    .sort((a, b) => b.population * (0.5 + b.saturation) - a.population * (0.5 + a.saturation));
  const accent = accents[0] ?? dominant;
  return {
    themeColour: theme,
    accent: hex(accent.hue, clamp(accent.saturation * 1.25, chromatic ? 0.56 : 0, 0.95), clamp(accent.light, 0.36, 0.55)),
  };
}

export async function extractWallpaperColours(source: string, signal: AbortSignal): Promise<WallpaperColours> {
  signal.throwIfAborted();
  const image = new Image();
  image.crossOrigin = 'anonymous';
  const aborted = () => {
    image.src = '';
  };
  signal.addEventListener('abort', aborted, { once: true });
  try {
    image.src = source;
    await image.decode();
    signal.throwIfAborted();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 96;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context || !image.naturalWidth || !image.naturalHeight) throw new Error('Wallpaper colours are unavailable.');
    context.drawImage(image, 0, 0, 96, 96);
    return selectWallpaperColours(context.getImageData(0, 0, 96, 96).data);
  } finally {
    signal.removeEventListener('abort', aborted);
    image.src = '';
  }
}
