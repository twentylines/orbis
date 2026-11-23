import { expect, it, vi } from 'vitest';
import { createMockApp } from '@/tests/helpers/app-mocks';
import type { App } from '@/core/database/drizzle/types';
import type { Database } from '@/core/database/database.module';
import { AppsRepository } from './apps.repository';

function fixture() {
  const initial = createMockApp({ config: { VALUE: 'original' }, updatedAt: 10 });
  let row: App | undefined = structuredClone(initial);
  const lockingRead = vi.fn(async () => (row ? [structuredClone(row)] : []));
  const update = vi.fn((patch: Partial<App>) => ({
    where: () => ({
      returning: async () => {
        if (!row) return [];
        row = { ...row, ...patch };
        return [structuredClone(row)];
      },
    }),
  }));
  const transaction = vi.fn(async (work: (connection: unknown) => Promise<unknown>, _options: unknown) =>
    work({
      select: () => ({ from: () => ({ where: () => ({ for: lockingRead }) }) }),
      update: () => ({ set: update }),
    }),
  );
  const repository = new AppsRepository({ transaction } as unknown as Database);
  return {
    repository,
    initial,
    transaction,
    lockingRead,
    update,
    read: () => structuredClone(row),
    replace: (value: App | undefined) => {
      row = value;
    },
  };
}

it('locks and compares the current SQL row before atomically recording settings', async () => {
  const f = fixture();
  const saved = await f.repository.updateSettingsIfCurrent(f.initial, { config: { VALUE: 'new' }, pendingRestart: true });
  expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'serializable' });
  expect(f.lockingRead).toHaveBeenCalledWith('update');
  expect(saved).toMatchObject({ id: f.initial.id, config: { VALUE: 'new' }, pendingRestart: true });
});

it.each(['version', 'createdAt', 'config', 'status', 'pendingRestart'] as const)(
  'refuses a SQL commit after the current %s changes',
  async (field) => {
    const f = fixture();
    const changed =
      field === 'config'
        ? { ...f.initial, config: { VALUE: 'newer writer' } }
        : field === 'status'
          ? { ...f.initial, status: 'updating' as const }
          : field === 'pendingRestart'
            ? { ...f.initial, pendingRestart: true }
            : { ...f.initial, [field]: Number(f.initial[field]) + 1 };
    f.replace(changed);
    await expect(f.repository.updateSettingsIfCurrent(f.initial, { config: { VALUE: 'stale' } })).rejects.toThrow('application changed');
    expect(f.update).not.toHaveBeenCalled();
    expect(f.read()).toEqual(changed);
  },
);

it('does not recreate a deleted application from a delayed settings completion', async () => {
  const f = fixture();
  f.replace(undefined);
  await expect(f.repository.updateSettingsIfCurrent(f.initial, { config: { VALUE: 'stale' } })).rejects.toThrow('application changed');
  expect(f.update).not.toHaveBeenCalled();
  expect(f.read()).toBeUndefined();
});
