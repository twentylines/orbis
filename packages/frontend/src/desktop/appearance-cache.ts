import { applyAppearanceRuntime } from './appearance-runtime';
import { resolveColourMode } from './colour-mode';
import { resolveWallpaperKey, type ThemePreset } from './wallpaper-presets';

const appearanceOptions = {
  presets: ['frost', 'graphite', 'forest', 'stone', 'ocean', 'blush'],
  modes: ['light', 'dark', 'system'],
  wallpapers: ['sandstone', 'tidal', 'canopy'],
} as const;

export type CachedAppearance = {
  preset: (typeof appearanceOptions.presets)[number];
  mode: (typeof appearanceOptions.modes)[number];
  wallpaper: (typeof appearanceOptions.wallpapers)[number];
  wallpaperMode: 'theme' | 'custom';
  wallpaperPreset: ThemePreset | null;
};

export const preferenceStorageKey = 'server-desktop-preferences-v1';
export const preferenceChangeEvent = 'orbis-desktop-preferences-changed';
export const preferenceCacheLimit = 256 * 1024;

export function appearanceFromStored(value: unknown, options = appearanceOptions): CachedAppearance {
  const stored = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const preset = options.presets.includes(stored.preset as CachedAppearance['preset']) ? (stored.preset as CachedAppearance['preset']) : 'frost';
  const wallpaper = options.wallpapers.includes(stored.wallpaper as CachedAppearance['wallpaper'])
    ? (stored.wallpaper as CachedAppearance['wallpaper'])
    : 'sandstone';
  const image =
    stored.appearance && typeof stored.appearance === 'object' && 'wallpaperImage' in stored.appearance && stored.appearance.wallpaperImage;
  return {
    preset,
    mode: options.modes.includes(stored.mode as CachedAppearance['mode'])
      ? (stored.mode as CachedAppearance['mode'])
      : preset === 'graphite'
        ? 'dark'
        : 'light',
    wallpaper,
    wallpaperMode:
      stored.wallpaperMode === 'theme' || stored.wallpaperMode === 'custom'
        ? stored.wallpaperMode
        : wallpaper !== 'sandstone' || (typeof image === 'string' && /^[a-f0-9]{64}$/.test(image))
          ? 'custom'
          : 'theme',
    wallpaperPreset: options.presets.includes(stored.wallpaperPreset as ThemePreset) ? (stored.wallpaperPreset as ThemePreset) : null,
  };
}

export function readCachedAppearance(): CachedAppearance {
  try {
    const raw = window.localStorage.getItem(preferenceStorageKey);
    return appearanceFromStored(raw && raw.length <= preferenceCacheLimit ? JSON.parse(raw) : null);
  } catch {
    return appearanceFromStored(null);
  }
}

// Static code and a shared allowlist keep the first paint independent of the app bundle.
export const appearanceBootstrap = `(()=>{
  const appearanceOptions=${JSON.stringify(appearanceOptions)};
  const options=appearanceOptions;
  let stored={};
  try {
    const raw=localStorage.getItem(${JSON.stringify(preferenceStorageKey)});
    const value=raw&&raw.length<=${preferenceCacheLimit}?JSON.parse(raw):null;
    if(value&&typeof value==='object'&&!Array.isArray(value))stored=value;
  } catch {}
  const preset=options.presets.includes(stored.preset)?stored.preset:'frost';
  const requested=options.modes.includes(stored.mode)?stored.mode:preset==='graphite'?'dark':'light';
  let systemDark=false;
  if(requested==='system') {
    try { systemDark=matchMedia('(prefers-color-scheme: dark)').matches; } catch {}
  }
  const mode=(${resolveColourMode.toString()})(requested,systemDark);
  const root=document.documentElement;
  root.dataset.desktopPreset=preset;
  root.dataset.desktopMode=mode;
  const cached=(${appearanceFromStored.toString()})(stored,options);
  root.dataset.desktopWallpaper=(${resolveWallpaperKey.toString()})(cached);
  const apply=()=>{
    if(root.dataset.orbisAppearanceReady==='true'){
      if(typeof document.removeEventListener==='function')document.removeEventListener('load',apply,true);
      return;
    }
    if(typeof getComputedStyle!=='function')return;
    (${applyAppearanceRuntime.toString()})(stored.appearance,mode);
    if(root.dataset.orbisEffects&&typeof document.removeEventListener==='function')document.removeEventListener('load',apply,true);
  };
  if(typeof requestAnimationFrame==='function')requestAnimationFrame(apply);
  if(typeof document.addEventListener==='function')document.addEventListener('load',apply,true);
  if(typeof document.addEventListener==='function')document.addEventListener('DOMContentLoaded',apply,{once:true});
})();`;
