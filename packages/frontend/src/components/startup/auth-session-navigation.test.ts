import { expect, test } from 'bun:test';
import { authenticatedSessionId, forgetAuthenticatedSession, rememberAuthenticatedSession, signInDestination } from './auth-session-navigation';

const first = 'f934dc04-2412-47b0-a931-e7ec9346a51f';
const second = 'e934dc04-2412-47b0-a931-e7ec9346a51f';
const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
};

test('ordinary sign-in ignores a return target; incidental expiry retains a matching same-tab destination', () => {
  const store = storage();
  rememberAuthenticatedSession(store, () => first);
  const recovery = { orbisSessionRecovery: '/settings?tab=general', orbisSessionId: first };
  expect(signInDestination('/settings?tab=general', null, authenticatedSessionId(store))).toBe('/dashboard');
  expect(signInDestination('/settings?tab=general', recovery, authenticatedSessionId(store))).toBe('/settings?tab=general');
  expect(signInDestination('/settings?tab=other', recovery, authenticatedSessionId(store))).toBe('/dashboard');
  expect(signInDestination('//example.com', recovery, authenticatedSessionId(store))).toBe('/dashboard');
  forgetAuthenticatedSession(store);
  expect(signInDestination('/settings?tab=general', recovery, authenticatedSessionId(store))).toBe('/dashboard');
  rememberAuthenticatedSession(store, () => second);
  expect(signInDestination('/settings?tab=general', recovery, authenticatedSessionId(store))).toBe('/dashboard');
});
