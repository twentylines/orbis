import { expect, it } from 'vitest';
import { defaultDesktopAppearance } from '@runtipi/common/schemas';
import { DEFAULT_DESKTOP_PREFERENCES } from '../desktop-preferences/desktop-preferences.service';
import { mergeSettingsPreferences, splitSettingsPreferences, validateSettingsPreferencePatch } from './settings-backup-preferences';

const source = () => ({
  ...structuredClone(DEFAULT_DESKTOP_PREFERENCES),
  preset: 'forest' as const,
  density: 'compact' as const,
  appearance: { ...defaultDesktopAppearance, accent: '#aabbcc', wallpaperX: 42, dockSize: 'large' as const, textScale: 125 },
});

it('preserves every supported preference when all four categories are restored', () => {
  const value = source();
  expect(mergeSettingsPreferences(structuredClone(DEFAULT_DESKTOP_PREFERENCES), splitSettingsPreferences(value))).toEqual(value);
});

it('restores dashboard layout without changing omitted theming, wallpaper or general preferences', () => {
  const value = source();
  const destination = {
    ...source(),
    preset: 'graphite' as const,
    serverName: 'Keep destination',
    appearance: { ...source().appearance, accent: '#112233', wallpaperX: 5, textScale: 90 },
  };
  const result = mergeSettingsPreferences(destination, { dashboard: splitSettingsPreferences(value).dashboard });
  expect(result.preset).toBe(destination.preset);
  expect(result.serverName).toBe(destination.serverName);
  expect(result.appearance).toMatchObject({ accent: '#112233', wallpaperX: 5, textScale: 90, dockSize: 'large' });
  expect(result.density).toBe(value.density);
  expect(destination.appearance.wallpaperX).toBe(5);
});

it('rejects cross-section preference injection, unknown future data and malformed values', () => {
  for (const patch of [
    { preset: 'forest' },
    { appearance: { wallpaperImage: 'a'.repeat(64) } },
    { appearance: { textScale: 125 } },
    { appearance: { dockSize: 'invalid' } },
    { script: 'run' },
  ])
    expect(() => validateSettingsPreferencePatch('dashboard', patch)).toThrow();
  expect(() => splitSettingsPreferences({ ...source(), futurePreference: true })).toThrow();
  expect(() => mergeSettingsPreferences(source(), { docker: {} } as never)).toThrow();
});

it('keeps independently returned selections detached from the current profile', () => {
  const value = source();
  const patches = splitSettingsPreferences(value);
  const appearance = patches.themes.appearance;
  if (!appearance) throw new Error('Missing theme fixture');
  appearance.accent = '#000000';
  expect(value.appearance.accent).toBe('#aabbcc');
});
