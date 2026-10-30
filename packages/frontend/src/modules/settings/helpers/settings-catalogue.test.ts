import { expect, test } from 'bun:test';
import {
  retainSettingsSections,
  resolveSettingsSection,
  searchSettings,
  settingAvailable,
  settingsLocation,
  settingsCatalogue,
  settingsPath,
  type SettingsSection,
} from './settings-catalogue';
const operator = { operator: true, advanced: true };

test('individual settings rank exact words, joined words and transposed/omitted letters deterministically', () => {
  for (const [query, id] of [
    ['dark', 'dark-mode'],
    ['drak', 'dark-mode'],
    ['light', 'light-mode'],
    ['servername', 'server-name'],
    ['sever name', 'server-name'],
    ['wallpaper', 'wallpaper'],
    ['autoupdates', 'automatic-updates'],
    ['backup', 'server-backups'],
  ])
    expect(searchSettings(query ?? '', operator)[0]?.id).toBe(id);
  expect(searchSettings('wallpaper', operator)).toEqual(searchSettings('wallpaper', operator));
  expect(searchSettings('nonexistent unicorn reactor', operator)).toEqual([]);
  expect(searchSettings('   ', operator)).toEqual([]);
});
test('settings search is bounded and preserves permission and advanced-setting boundaries', () => {
  const basic = { operator: false };
  for (const query of ['backup', 'cluster', 'autoupdates', 'sources', 'port', 'local domain'])
    expect(searchSettings(query, basic).some((entry) => entry.operator)).toBe(false);
  expect(searchSettings('password', basic)[0]?.id).toBe('password');
  expect(searchSettings('http port', { operator: true }).some((entry) => entry.id === 'http-port')).toBe(false);
  expect(searchSettings('http port', operator).some((entry) => entry.id === 'http-port')).toBe(true);
  expect(searchSettings('a'.repeat(100000), operator)).toEqual([]);
  expect(searchSettings('theme', operator, 1000).length).toBeLessThanOrEqual(20);
  expect(searchSettings('theme', operator, -1)).toEqual([]);
});
test('catalogue entries have unique identities and precise stable destinations instead of generic category links', () => {
  expect(new Set(settingsCatalogue.map((entry) => entry.id)).size).toBe(settingsCatalogue.length);
  for (const entry of settingsCatalogue) {
    const destination = new URL(settingsPath(entry), 'https://fixture.invalid');
    expect(destination.pathname).toBe('/settings');
    expect(destination.searchParams.get('setting')).toBe(entry.id);
    expect(destination.searchParams.get('tab')).toBe(entry.section);
    expect(entry.anchor.length).toBeGreaterThan(0);
  }
  const dark = settingsCatalogue.find((entry) => entry.id === 'dark-mode');
  const light = settingsCatalogue.find((entry) => entry.id === 'light-mode');
  expect(dark?.focus).not.toBe(light?.focus);
  const backups = settingsCatalogue.find((entry) => entry.id === 'server-backups');
  if (!backups) throw new Error('Missing backup setting.');
  expect(settingAvailable(backups, { operator: false })).toBe(false);
});
test('legacy settings links resolve without losing the new category', () => {
  expect(resolveSettingsSection('appearance')).toBe('customise');
  expect(resolveSettingsSection('settings')).toBe('general');
  expect(resolveSettingsSection('appstores')).toBe('store');
  expect(resolveSettingsSection('security')).toBe('security');
  expect(resolveSettingsSection('invalid')).toBe('general');
  expect(resolveSettingsSection('__proto__')).toBe('general');
  expect(resolveSettingsSection('constructor')).toBe('general');
});
test('visited panels retain their stable identity across category and responsive navigation switches', () => {
  const original: ReadonlySet<SettingsSection> = new Set(['general']);
  const custom = retainSettingsSections(original, 'customise');
  const backup = retainSettingsSections(custom, 'backups');
  expect([...original]).toEqual(['general']);
  expect([...backup]).toEqual(['general', 'customise', 'backups']);
  expect(retainSettingsSections(backup, 'general')).toBe(backup);
});

test('category navigation explicitly clears old hash and setting without dropping unrelated query state', () => {
  const destination = settingsLocation('/settings', '?tab=appearance&setting=wallpaper&keep=draft', 'updates');
  expect(destination.hash).toBe('');
  const params = new URLSearchParams(destination.search);
  expect(params.get('setting')).toBeNull();
  expect(params.get('tab')).toBe('updates');
  expect(params.get('keep')).toBe('draft');
});

test('HTTPS setup appears only for HTTP access and keeps its real dedicated anchor', () => {
  const http = searchSettings('https setup', { operator: true, http: true });
  expect(http.some((entry) => entry.id === 'https-setup' && entry.section === 'https' && entry.anchor === 'setting-https-setup')).toBe(true);
  expect(searchSettings('https setup', { operator: true, http: false }).some((entry) => entry.id === 'https-setup')).toBe(false);
});
