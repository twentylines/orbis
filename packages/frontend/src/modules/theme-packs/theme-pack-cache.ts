import { themePackManifestSchema, type ThemePackManifest } from '@runtipi/common/schemas/theme-pack';

export type ThemePackAppearance = Pick<ThemePackManifest, 'id' | 'version' | 'name' | 'light' | 'dark' | 'wallpaper' | 'treatment'>;
export const themePackCacheKey = 'orbis-public-theme-appearance-v1';
export const themePackCacheLimit = 8192;
export const themePackCacheAge = 30 * 24 * 60 * 60_000;
export const themePackCacheEvent = 'orbis-public-theme-appearance-changed';
let liveAppearance: ThemePackAppearance | null = null;
let liveRaw: string | null | undefined;
let liveUntil = 0;
let volatileAppearance = false;
export const publicThemePackWallpapers = {
  alpine: {
    name: 'Alpine',
    hash: '6dbaac76b6a77df63379af3ddf8b311e75af57c389a69a921d36eec805398efe',
    path: '/wallpapers/theme-pack-alpine-v1.webp',
    bytes: 303372,
  },
  tideline: {
    name: 'Tideline',
    hash: '209416fb881a62165ab4fb3bb939f95af6b9fe40d42f7b926c6bb76cb450221f',
    path: '/wallpapers/theme-pack-tideline-v1.webp',
    bytes: 176806,
  },
  woodland: {
    name: 'Woodland',
    hash: '5ad60fb90e61215096b4e9315f750f039b83e050bc1a95c94c3c39fdfd689031',
    path: '/wallpapers/theme-pack-woodland-v1.webp',
    bytes: 205358,
  },
} as const;

// These validators also run in the static first-paint script, without a schema library.
export function isThemePackAppearance(
  value: unknown,
  assets: typeof publicThemePackWallpapers = publicThemePackWallpapers,
): value is ThemePackAppearance {
  const object = (input: unknown): input is Record<string, unknown> => Boolean(input && typeof input === 'object' && !Array.isArray(input));
  const keys = (input: Record<string, unknown>, expected: string[]) =>
    Object.keys(input).length === expected.length && expected.every((key) => Object.hasOwn(input, key));
  if (!object(value) || !keys(value, ['id', 'version', 'name', 'light', 'dark', 'wallpaper', 'treatment'])) return false;
  if (typeof value.id !== 'string' || !Object.hasOwn(assets, value.id)) return false;
  const asset = assets[value.id as keyof typeof assets];
  if (
    !asset ||
    value.name !== asset.name ||
    value.wallpaper !== asset.hash ||
    typeof value.version !== 'string' ||
    !/^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/.test(value.version)
  )
    return false;
  const colours = ['ink', 'muted', 'surface', 'chrome', 'chromeInk', 'panel', 'accent', 'action', 'positive', 'negative', 'warning', 'info', 'tint'];
  for (const palette of [value.light, value.dark]) {
    if (
      !object(palette) ||
      !keys(palette, colours) ||
      !Object.values(palette).every((colour) => typeof colour === 'string' && /^#[a-f0-9]{6}$/i.test(colour))
    )
      return false;
  }
  const choices = {
    typography: ['source-sans', 'system'],
    corners: ['soft', 'crisp'],
    material: ['mist', 'clear'],
    icons: ['fine', 'regular'],
    controls: ['quiet', 'defined'],
    charts: ['soft', 'defined'],
    menus: ['flat', 'raised'],
    motion: ['calm', 'quick'],
  };
  if (!object(value.treatment) || !keys(value.treatment, Object.keys(choices))) return false;
  const treatment = value.treatment;
  return Object.entries(choices).every(([key, options]) => typeof treatment[key] === 'string' && options.includes(treatment[key]));
}

export function publicThemePackWallpaper(pack: ThemePackAppearance, assets: typeof publicThemePackWallpapers = publicThemePackWallpapers) {
  const asset = assets[pack.id as keyof typeof assets];
  return asset?.hash === pack.wallpaper ? `${asset.path}?version=${asset.hash}` : null;
}

export function decodeThemePackCache(
  raw: string | null,
  now = Date.now(),
  rules = { limit: themePackCacheLimit, age: themePackCacheAge },
  validate: (value: unknown) => value is ThemePackAppearance = isThemePackAppearance,
): ThemePackAppearance | null {
  if (!raw || raw.length > rules.limit) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',') !== 'pack,savedAt,version' ||
      record.version !== 1 ||
      typeof record.savedAt !== 'number' ||
      !Number.isSafeInteger(record.savedAt) ||
      record.savedAt > now ||
      now - record.savedAt >= rules.age ||
      !validate(record.pack)
    )
      return null;
    return record.pack;
  } catch {
    return null;
  }
}

export function readThemePackCache(): ThemePackAppearance | null {
  if (volatileAppearance) return Date.now() < liveUntil ? liveAppearance : null;
  try {
    const raw = window.localStorage.getItem(themePackCacheKey);
    const pack = decodeThemePackCache(raw);
    if (raw && !pack) window.localStorage.removeItem(themePackCacheKey);
    return pack;
  } catch {
    return null;
  }
}

export function themePackAppearanceSnapshot(): ThemePackAppearance | null {
  if (volatileAppearance) return Date.now() < liveUntil ? liveAppearance : null;
  try {
    const raw = window.localStorage.getItem(themePackCacheKey);
    if (raw !== liveRaw) {
      liveRaw = raw;
      liveAppearance = decodeThemePackCache(raw);
      liveUntil = liveAppearance && raw ? (JSON.parse(raw) as { savedAt: number }).savedAt + themePackCacheAge : 0;
    }
    const now = Date.now();
    if (liveAppearance && now >= liveUntil - themePackCacheAge && now < liveUntil) return liveAppearance;
    liveAppearance = null;
    liveUntil = 0;
    if (raw !== null) {
      window.localStorage.removeItem(themePackCacheKey);
      liveRaw = null;
    }
    return null;
  } catch {
    return null;
  }
}

export function subscribeThemePackAppearance(changed: () => void) {
  const storageChanged = (event: StorageEvent) => {
    if (event.key !== null && event.key !== themePackCacheKey) return;
    volatileAppearance = false;
    liveRaw = undefined;
    changed();
  };
  window.addEventListener(themePackCacheEvent, changed);
  window.addEventListener('storage', storageChanged);
  return () => {
    window.removeEventListener(themePackCacheEvent, changed);
    window.removeEventListener('storage', storageChanged);
  };
}

export function rememberThemePackCache(pack: ThemePackManifest | null): ThemePackAppearance | null {
  let appearance: ThemePackAppearance | null = null;
  if (pack && themePackManifestSchema.allows(pack)) {
    const { id, version, name, light, dark, wallpaper, treatment } = pack;
    const projection = { id, version, name, light, dark, wallpaper, treatment };
    if (isThemePackAppearance(projection)) appearance = projection;
  }
  const now = Date.now();
  liveAppearance = appearance;
  liveUntil = appearance ? now + themePackCacheAge : 0;
  liveRaw = appearance ? JSON.stringify({ version: 1, savedAt: now, pack: appearance }) : null;
  volatileAppearance = true;
  try {
    if (liveRaw) window.localStorage.setItem(themePackCacheKey, liveRaw);
    else window.localStorage.removeItem(themePackCacheKey);
    volatileAppearance = false;
  } catch {
    /* Device storage can be unavailable while the active selection remains usable. */
  }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') window.dispatchEvent(new Event(themePackCacheEvent));
  return appearance;
}

export const themePackCacheBootstrap = `
const publicThemePackWallpapers=${JSON.stringify(publicThemePackWallpapers)};
const themePackCacheLimit=${themePackCacheLimit},themePackCacheAge=${themePackCacheAge};
const isThemePackAppearance=${isThemePackAppearance.toString()};
const publicThemePackWallpaper=${publicThemePackWallpaper.toString()};
const decodeThemePackCache=${decodeThemePackCache.toString()};
let cachedThemePack=null;
try{cachedThemePack=decodeThemePackCache(localStorage.getItem(${JSON.stringify(themePackCacheKey)}),Date.now(),{limit:themePackCacheLimit,age:themePackCacheAge},value=>isThemePackAppearance(value,publicThemePackWallpapers));}catch{}
`;
