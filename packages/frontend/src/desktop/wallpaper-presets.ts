export const themePresets = ['frost', 'graphite', 'forest', 'stone', 'ocean', 'blush'] as const;
export type ThemePreset = (typeof themePresets)[number];
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
};
export const presetWallpaperSources: Record<ThemePreset, string> = {
  frost: '/wallpapers/frost.webp',
  graphite: '/wallpapers/graphite.webp',
  forest: '/wallpapers/forest.webp',
  stone: '/wallpapers/orbis-horizon.webp',
  ocean: '/wallpapers/ocean.webp',
  blush: '/wallpapers/blush.webp',
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
  const presets = ['frost', 'graphite', 'forest', 'stone', 'ocean', 'blush'];
  const mode = value.wallpaperMode ?? (value.wallpaper !== 'sandstone' || value.appearance?.wallpaperImage ? 'custom' : 'theme');
  if (mode === 'theme') return `theme-${value.preset}`;
  return value.wallpaperPreset && presets.includes(value.wallpaperPreset) ? `theme-${value.wallpaperPreset}` : value.wallpaper;
}
