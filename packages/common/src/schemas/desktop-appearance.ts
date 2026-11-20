import { type } from 'arktype';

export const desktopColourPresets = ['frost', 'graphite', 'forest', 'stone', 'ocean', 'blush', 'burgundy', 'amber', 'rose', 'orange'] as const;
export const desktopColourPresetSchema = type.enumerated(...desktopColourPresets);
export const desktopWallpaperPresetSchema = type.enumerated(...desktopColourPresets, null);
export type DesktopColourPreset = (typeof desktopColourPresets)[number];

const colour = type('string | null').narrow((value) => value === null || /^#[0-9a-f]{6}$/i.test(value));
const image = type('string | null').narrow((value) => value === null || /^[a-f0-9]{64}$/.test(value));
export const wallpaperUnsplashIdSchema = type('string').narrow((value) => /^[A-Za-z0-9_-]{1,48}$/.test(value));
const materialOpacity = type('0 <= number.integer <= 100 | null');
const appPins = type('string > 2 & string <= 180')
  .array()
  .narrow((items) => items.length <= 6 && new Set(items).size === items.length && items.every((item) => /^[^:]+:[^:]+$/.test(item)));

const materialFields = {
  'surfaceOpacity?': materialOpacity,
  'chromeOpacity?': materialOpacity,
  'glassBlur?': '0 <= number.integer <= 40 | null',
  'chromeBlur?': '0 <= number.integer <= 64 | null',
  'glassTint?': '0 <= number.integer <= 30 | null',
  'materialMode?': type.enumerated('default', 'custom'),
  'transparency?': type.enumerated('system', 'glass', 'solid'),
} as const;
const desktopMaterialSchema = type(materialFields).onUndeclaredKey('reject');
export type DesktopMaterial = typeof desktopMaterialSchema.infer;
export const desktopModeMaterialKeys = ['lightMaterial', 'darkMaterial'] as const;

export const desktopAppearanceSchema = type({
  'accent?': colour,
  'themeColour?': colour,
  'wallpaperImage?': image,
  'wallpaperUnsplash?': wallpaperUnsplashIdSchema.or('null'),
  'wallpaperFit?': type.enumerated('cover', 'contain'),
  'wallpaperColours?': 'boolean',
  'wallpaperX?': '0 <= number.integer <= 100',
  'wallpaperY?': '0 <= number.integer <= 100',
  'wallpaperDim?': '0 <= number.integer <= 70',
  'wallpaperBlur?': '0 <= number.integer <= 24',
  ...materialFields,
  'lightMaterial?': desktopMaterialSchema.or('null'),
  'darkMaterial?': desktopMaterialSchema.or('null'),
  'textScale?': '85 <= number.integer <= 150',
  'timeFormat?': type.enumerated('12h', '24h'),
  'motion?': type.enumerated('system', 'reduced'),
  'lowEffects?': 'boolean',
  'oledDark?': 'boolean',
  'dockPlacement?': type.enumerated('bottom', 'left', 'right'),
  'dockSize?': type.enumerated('compact', 'comfortable', 'large'),
  'dockAutoHide?': 'boolean',
  'dockPins?': appPins,
}).onUndeclaredKey('reject');

export type DesktopAppearance = Required<typeof desktopAppearanceSchema.infer>;

export const defaultDesktopAppearance: DesktopAppearance = {
  accent: null,
  themeColour: null,
  wallpaperImage: null,
  wallpaperUnsplash: null,
  wallpaperFit: 'cover',
  wallpaperColours: false,
  wallpaperX: 50,
  wallpaperY: 0,
  wallpaperDim: 0,
  wallpaperBlur: 0,
  surfaceOpacity: null,
  chromeOpacity: null,
  glassBlur: null,
  chromeBlur: null,
  glassTint: null,
  materialMode: 'default',
  lightMaterial: null,
  darkMaterial: null,
  textScale: 100,
  timeFormat: '12h',
  motion: 'system',
  transparency: 'system',
  lowEffects: false,
  oledDark: false,
  dockPlacement: 'bottom',
  dockSize: 'comfortable',
  dockAutoHide: false,
  dockPins: [],
};

export const desktopMaterialFields = ['surfaceOpacity', 'chromeOpacity', 'glassBlur', 'chromeBlur', 'glassTint'] as const;

export function hasDesktopMaterialOverrides(appearance: Partial<DesktopAppearance>): boolean {
  return desktopMaterialFields.some((key) => typeof appearance[key] === 'number');
}

export function normaliseDesktopAppearance(value?: unknown): DesktopAppearance {
  const parsed = desktopAppearanceSchema(value ?? {});
  return parsed instanceof type.errors
    ? { ...defaultDesktopAppearance, dockPins: [] }
    : {
        ...defaultDesktopAppearance,
        ...parsed,
        materialMode: parsed.materialMode ?? (hasDesktopMaterialOverrides(parsed) ? 'custom' : 'default'),
        dockPins: parsed.dockPins ?? [],
      };
}
