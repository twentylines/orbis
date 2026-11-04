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

test('LAN HTTP retains a valid authenticated session without randomUUID', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const original = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { getRandomValues: original.getRandomValues.bind(original) },
  });
  try {
    const store = storage();
    rememberAuthenticatedSession(store);
    const id = authenticatedSessionId(store);
    expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    rememberAuthenticatedSession(store);
    expect(authenticatedSessionId(store)).toBe(id);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else Reflect.deleteProperty(globalThis, 'crypto');
  }
});

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
