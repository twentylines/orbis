import { expect, it, vi } from 'vitest';
import { acquireBackupDisk, backupDiskActive } from '@/common/backup-disk';
import { AutomaticUpdatesService } from '../host-updates/automatic-updates.service';

it('defers scheduled work while a full backup transfer owns disk access', async () => {
  const host = { status: vi.fn(), plan: vi.fn(), apply: vi.fn() };
  const actor = new AutomaticUpdatesService(
    ...([{ get: () => ({ timeZone: 'UTC' }) }, host, {}, {}, {}, {}, {}, { warn: vi.fn() }] as unknown as ConstructorParameters<
      typeof AutomaticUpdatesService
    >),
  );
  const release = acquireBackupDisk();
  try {
    expect(backupDiskActive()).toBe(true);
    await actor.tick();
    expect(host.status).not.toHaveBeenCalled();
    expect(host.plan).not.toHaveBeenCalled();
    expect(host.apply).not.toHaveBeenCalled();
  } finally {
    release();
  }
  expect(backupDiskActive()).toBe(false);
});

it('keeps transfer admission exclusive and makes release idempotent', () => {
  const release = acquireBackupDisk();
  expect(() => acquireBackupDisk()).toThrow('Another backup transfer');
  release();
  release();
  const next = acquireBackupDisk();
  expect(backupDiskActive()).toBe(true);
  next();
  expect(backupDiskActive()).toBe(false);
});
