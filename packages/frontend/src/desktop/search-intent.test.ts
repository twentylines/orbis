import { expect, test } from 'bun:test';
import { createSearchMatcher } from '@runtipi/common/search';
import { appSearchIntent, availableAppCommands, searchPalettePresets } from './search-intent';
import { desktopSearchSections } from './navigation';

test('app intent separates the command from the app name without inventing a command for ordinary names', () => {
  expect(appSearchIntent('restart ArchiveBox')).toEqual({ action: 'restart', query: 'ArchiveBox' });
  expect(appSearchIntent('turn off app Home Assistant')).toEqual({ action: 'stop', query: 'Home Assistant' });
  expect(appSearchIntent('settings for Jellyfin')).toEqual({ action: 'manage', query: 'Jellyfin' });
  expect(appSearchIntent('launch Notes')).toEqual({ action: 'open', query: 'Notes' });
  expect(appSearchIntent('performance')).toBeNull();
  expect(appSearchIntent('Home Assistant')).toBeNull();
});

test('only actions supported by the current app state are offered', () => {
  expect(availableAppCommands('running')).toEqual(['restart', 'stop']);
  expect(availableAppCommands('stopped')).toEqual(['start']);
  for (const state of ['starting', 'stopping', 'updating', 'installing', 'unknown']) expect(availableAppCommands(state)).toEqual([]);
});

test('theme intent offers direct palettes, including named and colour aliases', () => {
  expect(searchPalettePresets('themes')).toHaveLength(9);
  expect(searchPalettePresets('colour palettes')).toHaveLength(9);
  expect(searchPalettePresets('apply sage green theme')).toEqual(['forest']);
  expect(searchPalettePresets('burgundy')).toEqual(['burgundy']);
  expect(searchPalettePresets('yellow')).toEqual(['amber']);
  expect(searchPalettePresets('performance')).toEqual([]);
  expect(searchPalettePresets('')).toEqual([]);
  expect(searchPalettePresets('themes')).not.toContain('rose');
});

test('performance and resource searches resolve to actual Monitor sections', () => {
  for (const [query, path] of [
    ['performance', '/monitor?section=performance'],
    ['CPU', '/monitor?section=performance&metric=cpu#telemetry-cpu-title'],
    ['Memory', '/monitor?section=performance&metric=memory#telemetry-memory-title'],
    ['Devices', '/monitor?section=devices'],
    ['GPU', '/monitor?section=sensors#host-gpus-title'],
  ] as const) {
    const match = createSearchMatcher(query);
    const ranked = desktopSearchSections
      .filter((s) => match(s.label, s.keywords) > 0)
      .sort((a, b) => match(b.label, b.keywords) - match(a.label, a.keywords));
    expect(ranked[0]?.path).toBe(path);
  }
});
