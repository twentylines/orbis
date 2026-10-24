import { describe, expect, test } from 'bun:test';
import { appLaunchSchema, defaultAppLaunch } from '@runtipi/common/schemas';
import { appAddress, appOpeningMode, initialAppBounds, primaryAppAddress } from './app-opening';

describe('actual app opening', () => {
  test('rejects executable addresses and embedded credentials', () => {
    for (const value of ['javascript:alert(1)', 'data:text/html,test', 'file:///tmp/app', 'https://user:secret@app.local', '/apps/app'])
      expect(appAddress(value)).toBeUndefined();
    expect(appAddress('http://192.168.0.10:8080')).toBe('http://192.168.0.10:8080/');
  });
  test('resolves account and per-app choices while enforcing browser boundaries', () => {
    const preferences = { ...defaultAppLaunch, mode: 'tab' as const, apps: { 'notes:store': { mode: 'window' as const } } };
    expect(appOpeningMode(preferences, 'notes:store', 'https://notes.local', 'https://orbis.local', true)).toBe('window');
    expect(appOpeningMode(preferences, 'other:store', 'https://other.local', 'https://orbis.local', true)).toBe('tab');
    expect(appOpeningMode(preferences, 'notes:store', 'http://notes.local', 'https://orbis.local', true)).toBe('tab');
    expect(appOpeningMode(preferences, 'notes:store', 'https://orbis.local/apps', 'https://orbis.local', true)).toBe('tab');
    expect(appOpeningMode(preferences, 'notes:store', 'https://notes.local', 'https://orbis.local', false)).toBe('tab');
  });
  test('prefers an available secure address on secure Orbis pages', () => {
    const destinations = [{ url: 'http://server.local:8080/' }, { url: 'https://notes.local/' }];
    expect(primaryAppAddress(destinations, 'https://orbis.local')).toBe('https://notes.local/');
    expect(primaryAppAddress(destinations, 'http://server.local')).toBe('http://server.local:8080/');
  });
  test('keeps initial and restored app bounds inside the usable workspace', () => {
    const area = { x: 24, y: 120, width: 1052, height: 380 };
    expect(initialAppBounds(area)).toEqual(area);
    expect(initialAppBounds(area, { x: 1900, y: 1000, width: 1300, height: 800 })).toEqual(area);
    const large = { ...area, width: 1800, height: 1000 };
    expect(initialAppBounds(large, undefined, ['utilities']).width).toBe(820);
    expect(initialAppBounds(large).width).toBe(1200);
  });
  test('stores only bounded app identities, opening preferences and geometry', () => {
    expect(
      appLaunchSchema.allows({
        mode: 'window',
        apps: { 'server-id/notes:store': { mode: 'tab', bounds: { x: 24, y: 120, width: 800, height: 600 } } },
      }),
    ).toBe(true);
    for (const apps of [
      { constructor: {} },
      { 'notes:store': { url: 'https://secret.local/token' } },
      { 'notes:store': { mode: 'popup' } },
      { 'notes:store': { bounds: { x: -1, y: 0, width: 800, height: 600 } } },
      Object.fromEntries(Array.from({ length: 513 }, (_, index) => [`app${index}:store`, {}])),
    ])
      expect(appLaunchSchema.allows({ mode: 'window', apps })).toBe(false);
  });
});
