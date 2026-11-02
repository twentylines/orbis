import { expect, test } from 'bun:test';
import { firstSetupAfterSignIn, showSetupSpace } from './sign-in-onboarding';

test('classifies only an authenticated, valid onboarding response', async () => {
  const fetcher =
    (body: unknown, status = 200) =>
    async (url: RequestInfo | URL, options?: RequestInit) => {
      expect(url).toBe('/api/desktop-preferences/onboarding');
      expect(options?.credentials).toBe('include');
      return Response.json(body, { status });
    };
  expect(await firstSetupAfterSignIn(fetcher({ complete: false }))).toBe(true);
  expect(await firstSetupAfterSignIn(fetcher({ complete: true }))).toBe(false);
  expect(await firstSetupAfterSignIn(fetcher({ complete: 'false' }))).toBeUndefined();
  expect(await firstSetupAfterSignIn(fetcher({}, 401))).toBeUndefined();
  expect(
    await firstSetupAfterSignIn(async () => {
      throw new Error('offline');
    }),
  ).toBeUndefined();
});

test('uses setup space until workspace preparation while preserving other transitions', () => {
  expect(showSetupSpace(true, 'signing-in', null, false)).toBe(true);
  expect(showSetupSpace(true, null, null, false)).toBe(true);
  expect(showSetupSpace(true, 'preparing-orbis', null, false)).toBe(false);
  expect(showSetupSpace(false, 'signing-in', null, false)).toBe(false);
  expect(showSetupSpace(true, 'logging-out', null, false)).toBe(false);
  expect(showSetupSpace(true, null, 'restore', false)).toBe(false);
  expect(showSetupSpace(true, null, 'update', false)).toBe(false);
  expect(showSetupSpace(true, null, null, true)).toBe(false);
});
