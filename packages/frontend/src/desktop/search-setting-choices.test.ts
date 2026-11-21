import { expect, test } from 'bun:test';
import { defaultDesktopPreferences } from './preferences';
import { searchSettingChoices } from './search-setting-choices';

test('direct search choices preserve per-app overrides and unrelated appearance settings', () => {
  const preferences = structuredClone(defaultDesktopPreferences);
  preferences.appLaunch.apps = { 'example:store': { mode: 'tab' } };
  preferences.appearance.surfaceOpacity = 90;
  const tabs = searchSettingChoices('opening-apps', preferences).find(({ value }) => value === 'tab');
  expect(tabs?.patch.appLaunch?.apps).toEqual(preferences.appLaunch.apps);
  expect(tabs?.patch.appLaunch?.mode).toBe('tab');
  expect(searchSettingChoices('text-size', preferences).find(({ value }) => value === '150')?.patch.appearance).toEqual({
    ...preferences.appearance,
    textScale: 150,
  });
  expect(searchSettingChoices('motion', preferences).find(({ value }) => value === 'reduced')?.patch.appearance).toEqual({
    ...preferences.appearance,
    motion: 'reduced',
  });
  expect(searchSettingChoices('system-reset', preferences)).toEqual([]);
  expect(searchSettingChoices('density', preferences).filter(({ selected }) => selected)).toHaveLength(1);
});
