import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  acquireBackupMaintenance,
  backupMaintenanceActive,
  enterBackupMutation,
  setBackupRecoveryRequired,
  setResetRecoveryRequired,
  setRestoreRecoveryRequired,
  waitForBackupMutation,
} from '@/common/backup-maintenance';
import { assertBackupMaintenanceLease, withBackupMaintenanceLease, type BackupMaintenanceLease } from '@/common/backup-maintenance-lease';

const signal = () => AbortSignal.timeout(1000);
beforeEach(() => {
  setBackupRecoveryRequired(false);
  setResetRecoveryRequired(false);
  setRestoreRecoveryRequired(false);
});
afterEach(() => expect(backupMaintenanceActive()).toBe(false));

it('holds one exclusive lease for awaited work and expires its borrowed identity afterward', async () => {
  let saved: BackupMaintenanceLease | undefined;
  const value = await withBackupMaintenanceLease(signal(), async (lease) => {
    saved = lease;
    assertBackupMaintenanceLease(lease);
    expect(backupMaintenanceActive()).toBe(true);
    expect(enterBackupMutation()).toBeNull();
    await Promise.resolve();
    assertBackupMaintenanceLease(lease);
    return 7;
  });
  expect(value).toBe(7);
  expect(() => assertBackupMaintenanceLease(saved as BackupMaintenanceLease)).toThrow('not active');
  const release = enterBackupMutation();
  expect(release).not.toBeNull();
  release?.();
});

it('rejects forged, copied and expired tokens even while another valid lease is held', async () => {
  let expired: BackupMaintenanceLease | undefined;
  await withBackupMaintenanceLease(signal(), async (lease) => {
    expired = lease;
    for (const forged of [{}, { ...lease }, structuredClone(lease), Object.create(lease)])
      expect(() => assertBackupMaintenanceLease(forged as BackupMaintenanceLease)).toThrow('not active');
  });
  await withBackupMaintenanceLease(signal(), async (lease) => {
    assertBackupMaintenanceLease(lease);
    expect(() => assertBackupMaintenanceLease(expired as BackupMaintenanceLease)).toThrow('not active');
  });
});

it('preserves non-reentrancy for both legacy and borrowed-lease callers', async () => {
  await withBackupMaintenanceLease(signal(), async (lease) => {
    await expect(acquireBackupMaintenance(signal())).rejects.toThrow('in progress');
    await expect(withBackupMaintenanceLease(signal(), async () => undefined)).rejects.toThrow('in progress');
    assertBackupMaintenanceLease(lease);
  });
  const release = await acquireBackupMaintenance(signal());
  try {
    await expect(withBackupMaintenanceLease(signal(), async () => undefined)).rejects.toThrow('in progress');
  } finally {
    release();
  }
});

it('blocks new mutations as soon as a backup starts draining existing operations', async () => {
  const release = enterBackupMutation();
  expect(release).not.toBeNull();
  let entered = false;
  const work = withBackupMaintenanceLease(signal(), async (lease) => {
    entered = true;
    assertBackupMaintenanceLease(lease);
  });
  try {
    expect(entered).toBe(false);
    expect(backupMaintenanceActive()).toBe(true);
    expect(enterBackupMutation()).toBeNull();
  } finally {
    release?.();
    await work;
  }
  expect(entered).toBe(true);
});

it('wakes blocked mutation admissions when a draining backup is cancelled', async () => {
  const release = enterBackupMutation();
  const controller = new AbortController();
  const work = withBackupMaintenanceLease(controller.signal, async () => {
    throw new Error('A cancelled acquisition must not enter its callback');
  });
  const waiting = waitForBackupMutation();
  controller.abort();
  try {
    await expect(work).rejects.toThrow('cancelled');
    const admitted = await waiting;
    admitted();
    expect(backupMaintenanceActive()).toBe(false);
  } finally {
    release?.();
  }
});

it('releases the owned lease and invalidates its token after callback failure', async () => {
  let saved: BackupMaintenanceLease | undefined;
  await expect(
    withBackupMaintenanceLease(signal(), async (lease) => {
      saved = lease;
      throw new Error('Export verification failed');
    }),
  ).rejects.toThrow('Export verification failed');
  expect(() => assertBackupMaintenanceLease(saved as BackupMaintenanceLease)).toThrow('not active');
});

it('rejects an already cancelled request without running or retaining work', async () => {
  const controller = new AbortController();
  controller.abort();
  let entered = false;
  await expect(
    withBackupMaintenanceLease(controller.signal, async () => {
      entered = true;
    }),
  ).rejects.toThrow();
  expect(entered).toBe(false);
});

it('rejects continued work or successful settlement after cancellation inside the callback', async () => {
  const controller = new AbortController();
  let saved: BackupMaintenanceLease | undefined;
  await expect(
    withBackupMaintenanceLease(controller.signal, async (lease) => {
      saved = lease;
      controller.abort();
      expect(() => assertBackupMaintenanceLease(lease)).toThrow();
      return 'must not report successful export';
    }),
  ).rejects.toThrow();
  expect(() => assertBackupMaintenanceLease(saved as BackupMaintenanceLease)).toThrow('not active');
});
