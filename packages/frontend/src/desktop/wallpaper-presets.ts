import type { WallpaperColours } from './wallpaper-palette';

export const themePresets = ['frost', 'graphite', 'forest', 'stone', 'ocean', 'blush', 'burgundy', 'amber', 'rose', 'orange'] as const;
export type ThemePreset = (typeof themePresets)[number];
export const visibleThemePresets = themePresets.filter((preset) => preset !== 'rose');
export type WallpaperPresentationColours = WallpaperColours & { preset?: ThemePreset };

export function taggedWallpaperColours(source: string): WallpaperPresentationColours | null {
  const preset = themePresets.find((name) => presetWallpaperSources[name] === source);
  return preset ? { ...presetWallpaperColours[preset], preset } : null;
}
export function wallpaperColourOverrides(colours: WallpaperPresentationColours | null) {
  if (!colours) return null;
  return colours.preset ? { themeColour: null, accent: null } : { themeColour: colours.themeColour, accent: colours.accent };
}

export type LegacyWallpaper = 'sandstone' | 'tidal' | 'canopy';
export type WallpaperKey = LegacyWallpaper | `theme-${ThemePreset}`;
export type WallpaperChoice = {
  preset: ThemePreset;
  wallpaper: LegacyWallpaper;
  wallpaperMode?: 'theme' | 'custom';
  wallpaperPreset?: ThemePreset | null;
  appearance?: { wallpaperImage?: string | null };
};
export const presetLabels: Record<ThemePreset, string> = {
  frost: 'Frost',
  graphite: 'Graphite',
  forest: 'Forest',
  stone: 'Stone',
  ocean: 'Ocean',
  blush: 'Blush',
  burgundy: 'Burgundy',
  amber: 'Amber',
  rose: 'Saved wallpaper',
  orange: 'Orange',
};
export const presetWallpaperColours: Record<ThemePreset, WallpaperColours> = {
  frost: { themeColour: '#6c9b88', accent: '#087867' },
  graphite: { themeColour: '#777a82', accent: '#42474f' },
  forest: { themeColour: '#54765e', accent: '#1c7540' },
  stone: { themeColour: '#b89263', accent: '#965013' },
  ocean: { themeColour: '#527a9e', accent: '#1464bc' },
  blush: { themeColour: '#ec62a2', accent: '#a5216d' },
  burgundy: { themeColour: '#b43852', accent: '#94213d' },
  amber: { themeColour: '#e2bc25', accent: '#765800' },
  rose: { themeColour: '#e988b3', accent: '#a23b70' },
  orange: { themeColour: '#f97329', accent: '#b44206' },
};
export const presetWallpaperSources: Record<ThemePreset, string> = {
  frost: '/wallpapers/frost-v2.webp',
  graphite: '/wallpapers/graphite-v2.webp',
  forest: '/wallpapers/forest-v3.webp',
  stone: '/wallpapers/stone-v2.webp',
  ocean: '/wallpapers/ocean-v4.webp',
  blush: '/wallpapers/blush-v4.webp',
  burgundy: '/wallpapers/burgundy-v1.webp',
  amber: '/wallpapers/amber-v1.webp',
  rose: '/wallpapers/rose-v1.webp',
  orange: '/wallpapers/orange-v1.webp',
};
export const presetWallpaperPreviews = Object.fromEntries(
  themePresets.map((preset) => [preset, presetWallpaperSources[preset].replace('.webp', '-preview.webp')]),
) as Record<ThemePreset, string>;
export const wallpaperSources: Record<WallpaperKey, string> = {
  sandstone: presetWallpaperSources.stone,
  tidal: presetWallpaperSources.ocean,
  canopy: presetWallpaperSources.forest,
  ...Object.fromEntries(themePresets.map((preset) => [`theme-${preset}`, presetWallpaperSources[preset]])),
} as Record<WallpaperKey, string>;

// Kept self-contained because the same resolver runs before the client bundle loads.
export function resolveWallpaperKey(value: WallpaperChoice): WallpaperKey {
  const presets = ['frost', 'graphite', 'forest', 'stone', 'ocean', 'blush', 'burgundy', 'amber', 'rose', 'orange'];
  const mode = value.wallpaperMode ?? (value.wallpaperPreset || value.appearance?.wallpaperImage ? 'custom' : 'theme');
  if (mode === 'theme') return `theme-${value.preset}`;
  return value.wallpaperPreset && presets.includes(value.wallpaperPreset) ? `theme-${value.wallpaperPreset}` : value.wallpaper;
}
