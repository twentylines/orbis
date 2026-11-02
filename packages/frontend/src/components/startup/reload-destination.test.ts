import { expect, test } from 'bun:test';
import { reloadDestination } from './reload-destination';
const base = { navigationType: 'reload', pathname: '/settings', authenticated: true, restorationIdle: true };
test('an authenticated normal-route reload returns to Dashboard only after authoritative idle', () => {
  for (const pathname of ['/monitor', '/updates', '/tasks', '/time-machine', '/settings', '/apps/a', '/app-store/a'])
    expect(reloadDestination({ ...base, pathname })).toBe('/dashboard');
  expect(reloadDestination({ ...base, restorationIdle: false })).toBeNull();
  expect(reloadDestination({ ...base, authenticated: false })).toBeNull();
});
test('direct visits, history navigation, auth/onboarding and explicit authentication handoffs retain their destinations', () => {
  for (const navigationType of ['navigate', 'back_forward', undefined]) expect(reloadDestination({ ...base, navigationType })).toBeNull();
  for (const pathname of ['/', '/dashboard', '/login', '/register', '/reset-password', '/not-found'])
    expect(reloadDestination({ ...base, pathname })).toBeNull();
  expect(reloadDestination({ ...base, authHandoff: true })).toBeNull();
});
