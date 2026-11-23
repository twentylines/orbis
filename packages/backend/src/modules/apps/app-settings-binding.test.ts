import { expect, it } from 'vitest';
import { createMockApp } from '@/tests/helpers/app-mocks';
import { appSettingsBinding } from './app-settings-binding';

it('keeps a settings binding stable across SQL JSON key order and catalogue refresh', () => {
  const app = createMockApp({ config: { A: 'one', B: { x: 1, y: 2 } } });
  const refreshed = { ...app, config: { B: { y: 2, x: 1 }, A: 'one' }, appStore: { ...app.appStore, hash: 'new-catalogue-hash' } };
  expect(appSettingsBinding(refreshed)).toBe(appSettingsBinding(app));
});
it.each(['id', 'createdAt', 'version', 'status', 'updatedAt', 'config', 'pendingRestart'] as const)(
  'binds the app %s to prevent a stale settings write',
  (field) => {
    const app = createMockApp();
    const replacement =
      field === 'config'
        ? { ...app, config: { A: 'changed' } }
        : field === 'status'
          ? { ...app, status: 'updating' as const }
          : field === 'pendingRestart'
            ? { ...app, pendingRestart: true }
            : { ...app, [field]: Number(app[field]) + 1 };
    expect(appSettingsBinding(replacement)).not.toBe(appSettingsBinding(app));
  },
);
