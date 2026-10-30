import type { DesktopAppearance } from '@runtipi/common/schemas/desktop-appearance';
import type { InterfaceThemeDescriptor, InterfaceThemeSettingsEntry } from '@runtipi/common/schemas/interface-theme';
import { interfaceThemeSettingAllows } from '@runtipi/common/schemas/interface-theme';
import type { ResolvedInterfaceThemeSettings } from '@runtipi/common/schemas/interface-theme-resolution';

export type InterfaceThemeEnvironment = {
  reducedMotion: boolean;
  reducedTransparency: boolean;
  forcedColours: boolean;
  resourceLimited?: boolean;
};

// Also embedded before hydration. Keep the projection self-contained and free of DOM/storage access.
export function projectInterfaceThemePreferences<T extends { preset: string; appearance: DesktopAppearance }>(
  base: T,
  theme: ResolvedInterfaceThemeSettings | null,
  host: InterfaceThemeEnvironment,
): T {
  const appearance = { ...base.appearance };
  let preset = base.preset;
  if (theme) {
    const values = new Map(theme.values.map((item) => [item.key, item.value]));
    const colour = values.get('accent');
    appearance.accent = typeof colour === 'string' && /^#[a-f0-9]{6}$/i.test(colour) ? colour : null;
    const number = (key: string, min: number, max: number) => {
      const value = values.get(key);
      return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
    };
    appearance.surfaceOpacity = number('panel-opacity', 90, 100);
    appearance.chromeOpacity = number('chrome-opacity', 80, 100);
    appearance.glassBlur = number('panel-blur', 0, 40);
    appearance.chromeBlur = number('chrome-blur', 0, 64);
    appearance.glassTint = number('panel-tint', 0, 30);
    const transparency = values.get('transparency');
    appearance.transparency = transparency === 'glass' || transparency === 'solid' ? transparency : 'system';
    appearance.motion = values.get('motion') === 'reduced' ? 'reduced' : 'system';
    appearance.lowEffects = values.get('low-effects') === true;
    const palette = values.get('palette');
    if (
      theme.descriptor.kind === 'builtin' &&
      typeof palette === 'string' &&
      ['frost', 'graphite', 'forest', 'stone', 'ocean', 'blush'].includes(palette)
    )
      preset = palette;
  }
  if (host.reducedMotion) appearance.motion = 'reduced';
  if (host.reducedTransparency || host.forcedColours) appearance.transparency = 'solid';
  if (host.forcedColours) appearance.accent = null;
  if (host.resourceLimited) appearance.lowEffects = true;
  return { ...base, preset, appearance };
}

export function readInterfaceThemeEnvironment(): InterfaceThemeEnvironment {
  const media = (query: string) => {
    try {
      return typeof matchMedia === 'function' && matchMedia(query).matches;
    } catch {
      return false;
    }
  };
  return {
    reducedMotion: media('(prefers-reduced-motion: reduce)'),
    reducedTransparency: media('(prefers-reduced-transparency: reduce)'),
    forcedColours: media('(forced-colors: active)'),
  };
}

export function interfaceThemeValuesFromLegacy(
  base: { preset: string; appearance: DesktopAppearance },
  descriptor: InterfaceThemeDescriptor,
): InterfaceThemeSettingsEntry['values'] {
  const mapping = {
    accent: base.appearance.accent,
    'panel-opacity': base.appearance.surfaceOpacity,
    'chrome-opacity': base.appearance.chromeOpacity,
    'panel-blur': base.appearance.glassBlur,
    'chrome-blur': base.appearance.chromeBlur,
    'panel-tint': base.appearance.glassTint,
    transparency: base.appearance.transparency,
    motion: base.appearance.motion,
    'low-effects': base.appearance.lowEffects,
    palette: base.preset,
  };
  return descriptor.settings.flatMap((setting) => {
    if (!Object.hasOwn(mapping, setting.key)) return [];
    const value = mapping[setting.key as keyof typeof mapping];
    return interfaceThemeSettingAllows(setting, value) ? [{ key: setting.key, value }] : [];
  });
}
