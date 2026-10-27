import { describe, expect, test } from 'bun:test';
import { appLaunchSchema, defaultAppLaunch } from '@runtipi/common/schemas/app-launch';
import {
  appAddress,
  appEmbeddingBoundary,
  appEmbeddingWarning,
  appOpeningMode,
  initialAppBounds,
  primaryAppAddress,
  restoreAppBounds,
} from './app-opening';

describe('actual app opening', () => {
  test('rejects executable addresses and embedded credentials', () => {
    for (const value of ['javascript:alert(1)', 'data:text/html,test', 'file:///tmp/app', 'https://user:secret@app.local', '/apps/app'])
      expect(appAddress(value)).toBeUndefined();
    expect(appAddress('http://192.168.0.10:8080')).toBe('http://192.168.0.10:8080/');
  });
  test('resolves account and per-app choices while enforcing browser boundaries', () => {
    const preferences = { ...defaultAppLaunch, mode: 'tab' as const, apps: { 'notes:store': { mode: 'window' as const } } };
    expect(appOpeningMode(preferences, 'notes:store', 'https://notes.local', 'https://orbis.local', true)).toBe('tab');
    expect(appOpeningMode({ ...preferences, mode: 'window' }, 'notes:store', 'https://notes.local', 'https://orbis.local', true)).toBe('window');
    expect(
      appOpeningMode(
        { ...preferences, mode: 'window', apps: { 'notes:store': { mode: 'tab' } } },
        'notes:store',
        'https://notes.local',
        'https://orbis.local',
        true,
      ),
    ).toBe('tab');
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
    const initial = initialAppBounds(area);
    expect(initial.width).toBeGreaterThan(area.width * 0.9);
    expect(initial.height).toBeGreaterThan(area.height * 0.9);
    expect(Math.abs(initial.x - area.x - (area.width - initial.width) / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(initial.y - area.y - (area.height - initial.height) / 2)).toBeLessThanOrEqual(1);
    expect(initialAppBounds(area, { x: 1900, y: 1000, width: 1300, height: 800 })).toEqual(area);
    const large = { ...area, width: 1800, height: 1000 };
    expect(initialAppBounds(large, undefined, ['utilities']).width).toBe(940);
    expect(initialAppBounds(large).width).toBe(1280);
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
  test('fullscreen saved geometry restores to a smaller floating frame and ordinary geometry is retained', () => {
    const area = { x: 24, y: 100, width: 1392, height: 750 };
    const restored = restoreAppBounds(area, area, ['utilities']);
    expect(restored.width).toBe(940);
    expect(restored.height).toBeLessThan(area.height);
    expect(restored.x).toBeGreaterThan(area.x);
    expect(restoreAppBounds(area, restored)).toEqual(restored);
  });
});

describe('general app window compatibility warnings', () => {
  test('distinguishes a server probe failure from the browser app connection', () => {
    const warning = appEmbeddingWarning({ status: 'unknown', reason: 'unreachable' });
    expect(warning?.blocked).toBe(false);
    expect(warning?.title).toBe('Check unavailable');
    expect(warning?.description).toContain('Your browser may still connect');
  });
  test('allows ordinary redirects, sign-in, unsupported HEAD and failed checks to open normally', () => {
    for (const reason of [
      'redirect',
      'authentication-required',
      'head-unsupported',
      'policy-unknown',
      'unverified-destination',
      'check-unavailable',
      'busy',
    ])
      expect(appEmbeddingWarning({ status: 'unknown', reason })).toBeUndefined();
    expect(appEmbeddingWarning({ status: 'not-blocked-by-headers', reason: 'no-blocking-header' })).toBeUndefined();
    expect(appEmbeddingWarning()).toBeUndefined();
  });
  test('treats anonymous server header restrictions as advisory for the signed-in browser', () => {
    for (const reason of ['x-frame-options-deny', 'x-frame-options-sameorigin', 'csp-frame-ancestors'])
      expect(appEmbeddingWarning({ status: 'blocked', reason })).toMatchObject({ blocked: false, title: 'Server restriction' });
  });
  test('enforces browser-local safety independently of anonymous or stale probe results', () => {
    expect(appEmbeddingBoundary('http://app.local', 'https://orbis.local')).toEqual({ status: 'blocked', reason: 'mixed-content' });
    expect(appEmbeddingBoundary('https://orbis.local/app', 'https://orbis.local')).toEqual({ status: 'blocked', reason: 'same-origin' });
    for (const url of [undefined, 'javascript:alert(1)', 'https://user:secret@app.local'])
      expect(appEmbeddingBoundary(url, 'https://orbis.local')).toEqual({ status: 'blocked', reason: 'invalid-address' });
    expect(appEmbeddingBoundary('https://app.local', 'https://orbis.local')).toBeUndefined();
    expect(appEmbeddingWarning({ status: 'blocked', reason: 'mixed-content' })?.description).toContain('HTTP');
    expect(appEmbeddingWarning({ status: 'blocked', reason: 'same-origin' })?.description).toContain('same address');
    expect(appEmbeddingWarning({ status: 'blocked', reason: 'invalid-address' })?.blocked).toBe(true);
    for (const reason of ['unreachable', 'check-unavailable', 'redirect', 'authentication-required']) {
      expect(appEmbeddingWarning({ status: 'unknown', reason })?.blocked ?? false).toBe(false);
      expect(appEmbeddingBoundary('https://app.local', 'https://orbis.local')).toBeUndefined();
    }
  });
});
