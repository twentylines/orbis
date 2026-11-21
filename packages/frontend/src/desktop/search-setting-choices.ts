import type { DesktopPreferences } from './preferences';

export type SearchSettingChoice = { value: string; label: string; selected: boolean; patch: Partial<DesktopPreferences> };

export function searchSettingChoices(id: string, preferences: DesktopPreferences): SearchSettingChoice[] {
  if (id === 'opening-apps')
    return (['window', 'tab'] as const).map((mode) => ({
      value: mode,
      label: mode === 'window' ? 'Window layout' : 'New tabs',
      selected: preferences.appLaunch.mode === mode,
      patch: { appLaunch: { ...preferences.appLaunch, mode } },
    }));
  if (id === 'colour-mode')
    return (['light', 'dark', 'system'] as const).map((mode) => ({
      value: mode,
      label: mode === 'system' ? 'Follow system' : mode === 'light' ? 'Light' : 'Dark',
      selected: preferences.mode === mode,
      patch: { mode },
    }));
  if (id === 'text-size')
    return [85, 100, 115, 125, 150].map((textScale) => ({
      value: String(textScale),
      label: `${textScale}%`,
      selected: preferences.appearance.textScale === textScale,
      patch: { appearance: { ...preferences.appearance, textScale } },
    }));
  if (id === 'density')
    return (['comfortable', 'compact'] as const).map((density) => ({
      value: density,
      label: density === 'comfortable' ? 'Comfortable' : 'Compact',
      selected: preferences.density === density,
      patch: { density },
    }));
  if (id === 'motion')
    return (['system', 'reduced'] as const).map((motion) => ({
      value: motion,
      label: motion === 'system' ? 'Follow system' : 'Reduce motion',
      selected: preferences.appearance.motion === motion,
      patch: { appearance: { ...preferences.appearance, motion } },
    }));
  return [];
}
