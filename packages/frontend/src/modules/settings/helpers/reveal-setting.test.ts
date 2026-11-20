import { expect, test } from 'bun:test';
import { openSettingReview, revealSetting } from './reveal-setting';
import { settingsCatalogue } from './settings-catalogue';

test('review actions activate only their registered, visible enabled review opener', () => {
  const entry = settingsCatalogue.find((item) => item.id === 'system-reset');
  if (!entry) throw new Error('Missing reset entry.');
  const calls: string[] = [];
  const button = { disabled: false, closest: () => null, click: () => calls.push('open-review') };
  const target = {
    closest: () => null,
    matches: () => false,
    querySelector: (selector: string) => {
      calls.push(selector);
      return button;
    },
  };
  const root = { querySelector: () => target } as unknown as HTMLElement;
  expect(openSettingReview(root, entry, 'create-backup')).toBe(false);
  expect(openSettingReview(root, entry, 'reset-orbis"] button[type="submit"]')).toBe(false);
  expect(calls).toEqual([]);
  button.disabled = true;
  expect(openSettingReview(root, entry, 'reset-orbis')).toBe(false);
  expect(calls).toEqual(['button[data-setting-review="reset-orbis"]']);
  calls.length = 0;
  button.disabled = false;
  expect(openSettingReview(root, entry, 'reset-orbis')).toBe(true);
  expect(calls).toEqual(['button[data-setting-review="reset-orbis"]', 'open-review']);
  const hidden = { querySelector: () => ({ closest: () => ({}), matches: () => false }) } as unknown as HTMLElement;
  expect(openSettingReview(hidden, entry, 'reset-orbis')).toBe(false);
});

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

test('a hidden wallpaper layout result focuses the match switch without changing the preference', () => {
  const entry = settingsCatalogue.find((item) => item.id === 'wallpaper-blur');
  if (!entry) throw new Error('Missing blur setting.');
  const actions: string[] = [];
  const toggle = {
    closest: () => null,
    scrollIntoView: () => actions.push('reveal-match'),
    focus: () => actions.push('focus-match'),
  };
  const section = {
    querySelectorAll: () => [{ textContent: 'Match wallpaper to colour preset', control: toggle }],
  };
  const target = { matches: () => true, closest: (selector: string) => (selector === '[hidden]' ? null : section) };
  expect(revealSetting({ querySelector: () => target } as unknown as HTMLElement, entry, true)).toBe(true);
  expect(actions).toEqual(['reveal-match', 'focus-match']);
});

test('manual colour search opens the native disclosure and focuses its matched control', () => {
  const entry = settingsCatalogue.find((item) => item.id === 'accent-colour');
  if (!entry) throw new Error('Missing accent setting.');
  const actions: string[] = [];
  const disclosure = {
    tagName: 'DETAILS',
    parentElement: null,
    open: false,
    matches: () => false,
    closest: () => null,
    contains: (element: unknown) => element === disclosure,
    querySelector: () => input,
  };
  const input = {
    parentElement: disclosure,
    closest: () => null,
    scrollIntoView: () => actions.push('reveal-accent'),
    focus: () => actions.push('focus-accent'),
  };
  expect(revealSetting({ querySelector: () => disclosure } as unknown as HTMLElement, entry, true)).toBe(true);
  expect(disclosure.open).toBe(true);
  expect(actions).toEqual(['reveal-accent', 'focus-accent']);
});
