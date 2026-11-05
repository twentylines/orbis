import { desktopAppearanceSchema } from '@runtipi/common/schemas';
import { desktopPreferencesSchema } from '../desktop-preferences/desktop-preferences.dto';
import type { DesktopPreferences } from '../desktop-preferences/desktop-preferences.service';

export type SettingsPreferenceSection = 'settings' | 'dashboard' | 'wallpapers' | 'themes';
const fields = {
  settings: ['serverName', 'showStoreRecommendations', 'hiddenStoreRecommendationCategories'],
  dashboard: ['density', 'workspace', 'windows', 'appLaunch'],
  wallpapers: ['wallpaper', 'wallpaperMode', 'wallpaperPreset'],
  themes: ['preset', 'mode'],
} as const;
const appearance = {
  settings: ['textScale', 'timeFormat', 'motion', 'transparency', 'lowEffects', 'oledDark'],
  dashboard: ['dockPlacement', 'dockSize', 'dockAutoHide', 'dockPins'],
  wallpapers: ['wallpaperImage', 'wallpaperFit', 'wallpaperX', 'wallpaperY', 'wallpaperDim', 'wallpaperBlur'],
  themes: ['accent', 'surfaceOpacity', 'chromeOpacity', 'glassBlur', 'chromeBlur', 'glassTint'],
} as const;
const sections = ['settings', 'dashboard', 'wallpapers', 'themes'] as const;
const fail = () => new Error('The desktop backup contains unsupported preferences. No settings were restored.');
const full = desktopPreferencesSchema.onDeepUndeclaredKey('reject');
const partial = full.partial();

export function validateSettingsPreferencePatch(section: SettingsPreferenceSection, value: unknown): Partial<DesktopPreferences> {
  if (!sections.includes(section)) throw fail();
  const patch = partial.assert(structuredClone(value));
  const allowed = new Set<string>(fields[section]);
  const allowedAppearance = new Set<string>(appearance[section]);
  if (
    Object.keys(patch).some((key) => key !== 'appearance' && !allowed.has(key)) ||
    (patch.appearance && Object.keys(patch.appearance).some((key) => !allowedAppearance.has(key)))
  )
    throw fail();
  return patch;
}

export function splitSettingsPreferences(value: unknown): Record<SettingsPreferenceSection, Partial<DesktopPreferences>> {
  const preferences = full.assert(structuredClone(value));
  const known = new Set<string>(Object.values(fields).flat());
  const knownAppearance = new Set<string>(Object.values(appearance).flat());
  if (
    Object.keys(preferences).some((key) => key !== 'appearance' && !known.has(key)) ||
    Object.keys(preferences.appearance ?? {}).some((key) => !knownAppearance.has(key))
  )
    throw fail();
  return Object.fromEntries(
    sections.map((section) => {
      const patch = Object.fromEntries(fields[section].filter((key) => preferences[key] !== undefined).map((key) => [key, preferences[key]]));
      if (preferences.appearance)
        patch.appearance = Object.fromEntries(
          appearance[section].filter((key) => preferences.appearance?.[key] !== undefined).map((key) => [key, preferences.appearance?.[key]]),
        );
      return [section, validateSettingsPreferencePatch(section, patch)];
    }),
  ) as Record<SettingsPreferenceSection, Partial<DesktopPreferences>>;
}

/** Only patches belonging to the selected sections are merged; omitted sections retain their current values. */
export function mergeSettingsPreferences(
  current: DesktopPreferences,
  patches: Partial<Record<SettingsPreferenceSection, unknown>>,
): DesktopPreferences {
  let next = full.assert(structuredClone(current));
  if (Object.keys(patches).some((key) => !sections.includes(key as SettingsPreferenceSection))) throw fail();
  for (const section of sections) {
    if (!Object.hasOwn(patches, section)) continue;
    const patch = validateSettingsPreferencePatch(section, patches[section]);
    next = full.assert({ ...next, ...patch, ...(patch.appearance ? { appearance: { ...next.appearance, ...patch.appearance } } : {}) });
  }
  if (next.appearance) desktopAppearanceSchema.onUndeclaredKey('reject').assert(next.appearance);
  return next;
}
