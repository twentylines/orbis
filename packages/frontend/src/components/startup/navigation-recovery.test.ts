import { expect, test } from 'bun:test';
import { clearNavigation, recoverNavigation, rememberNavigation } from './navigation-recovery';

const cache = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
};

test('a missing route module reload recovers the requested page once', () => {
  const storage = cache();
  rememberNavigation(storage, '/apps', '/settings?tab=appearance', 100_000);
  expect(recoverNavigation(storage, '/apps', 101_000, true)).toBe('/settings?tab=appearance');
  expect(recoverNavigation(storage, '/apps', 101_001, true)).toBeNull();
});

test('a later click replaces an abandoned destination; successful navigation clears it', () => {
  const storage = cache();
  rememberNavigation(storage, '/apps', '/settings', 100_000);
  rememberNavigation(storage, '/apps', '/monitor', 100_100);
  expect(recoverNavigation(storage, '/apps', 100_200, true)).toBe('/monitor');
  rememberNavigation(storage, '/apps', '/settings', 100_300);
  clearNavigation(storage);
  expect(recoverNavigation(storage, '/apps', 100_400, true)).toBeNull();
});

test('normal visits, other pages, expired and future-dated intents never redirect', () => {
  for (const [current, now, reload] of [
    ['/apps', 101_000, false],
    ['/monitor', 101_000, true],
    ['/apps', 131_000, true],
    ['/apps', 99_999, true],
  ] as const) {
    const storage = cache();
    rememberNavigation(storage, '/apps', '/settings', 100_000);
    expect(recoverNavigation(storage, current, now, reload)).toBeNull();
  }
});

test('unsafe destinations and malformed or blocked storage cannot redirect', () => {
  for (const to of ['https://example.com', '//example.com', '/\\example.com', '/apps\n', '/apps path', `/${'x'.repeat(2048)}`]) {
    const storage = cache();
    rememberNavigation(storage, '/apps', to, 100_000);
    expect(recoverNavigation(storage, '/apps', 101_000, true)).toBeNull();
  }
  const storage = cache();
  storage.setItem('orbis-navigation-intent-v1', '{broken');
  expect(recoverNavigation(storage, '/apps', 101_000, true)).toBeNull();
  const blocked = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  };
  expect(() => rememberNavigation(blocked, '/apps', '/settings', 100_000)).not.toThrow();
  expect(() => clearNavigation(blocked)).not.toThrow();
  expect(recoverNavigation(blocked, '/apps', 101_000, true)).toBeNull();
});
