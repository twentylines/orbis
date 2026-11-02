import { expect, test } from 'bun:test';
import { appearanceFromStored } from './appearance-cache';
import { publishServerAppearance, readServerAppearance, restoredPreferencesState, subscribeServerAppearance } from './restore-readiness';

test('restored Home cannot use a browser fallback after failed or retrying backend preference reads', () => {
  expect(restoredPreferencesState(true, true, false, false)).toBe('waiting');
  expect(restoredPreferencesState(true, true, false, true)).toBe('error');
  expect(restoredPreferencesState(true, true, true, false)).toBe('normal');
  expect(restoredPreferencesState(true, false, false, false)).toBe('normal');
  expect(restoredPreferencesState(false, true, false, true)).toBe('normal');
});
test('actual appearance proof is ephemeral, not browser cache, and is cleared between provider/session lifetimes', () => {
  let changes = 0;
  const stop = subscribeServerAppearance(() => changes++);
  const actual = appearanceFromStored({ preset: 'forest', mode: 'dark', wallpaper: 'canopy' });
  publishServerAppearance(actual);
  expect(readServerAppearance()).toBe(actual);
  publishServerAppearance(null);
  expect(readServerAppearance()).toBeNull();
  expect(changes).toBe(2);
  stop();
});
