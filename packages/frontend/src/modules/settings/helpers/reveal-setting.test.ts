import { expect, test } from 'bun:test';
import { revealSetting } from './reveal-setting';
import { settingsCatalogue } from './settings-catalogue';

test('a dark-mode result focuses its actual control inside the exact setting section without changing it', () => {
  const entry = settingsCatalogue.find((item) => item.id === 'dark-mode');
  if (!entry) throw new Error('Missing catalogue entry.');
  const calls: unknown[] = [];
  const section = {
    querySelector: (selector: string) => {
      calls.push(selector);
      return { closest: () => null, scrollIntoView: (options: unknown) => calls.push(options), focus: (options: unknown) => calls.push(options) };
    },
    scrollIntoView: (options: unknown) => calls.push(options),
  };
  const target = { closest: (selector: string) => (selector === '[hidden]' ? null : section), matches: () => true };
  const root = {
    querySelector: (selector: string) => {
      calls.push(selector);
      return target;
    },
  } as unknown as HTMLElement;
  expect(revealSetting(root, entry, true)).toBe(true);
  expect(calls).toEqual(['[id="appearance-mode"]', '[data-setting-value="dark"]', { block: 'start', behavior: 'instant' }, { preventScroll: true }]);
});
test('missing and hidden targets never redirect focus to unrelated controls', () => {
  const entry = settingsCatalogue[0];
  if (!entry) throw new Error('Missing catalogue entry.');
  expect(revealSetting({ querySelector: () => null } as unknown as HTMLElement, entry, false)).toBe(false);
  expect(revealSetting({ querySelector: () => ({ closest: () => ({}) }) } as unknown as HTMLElement, entry, false)).toBe(false);
});

test('a labelled range result reveals that control group instead of the first wallpaper control', () => {
  const entry = settingsCatalogue.find((item) => item.id === 'wallpaper-dim');
  if (!entry) throw new Error('Missing dim setting.');
  const actions: string[] = [];
  const range = { scrollIntoView: () => actions.push('reveal-range') };
  const input = { closest: () => range, focus: () => actions.push('focus-dim') };
  const section = {
    querySelectorAll: () => [
      { textContent: 'Horizontal position', control: null },
      { textContent: 'Dim wallpaper 25%', control: input },
    ],
  };
  const target = { matches: () => true, closest: (selector: string) => (selector === '[hidden]' ? null : section) };
  expect(revealSetting({ querySelector: () => target } as unknown as HTMLElement, entry, true)).toBe(true);
  expect(actions).toEqual(['reveal-range', 'focus-dim']);
});
