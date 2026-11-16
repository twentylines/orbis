import { acquireBackupMaintenance, backupMaintenanceLeaseHeld } from './backup-maintenance';

declare const leaseBrand: unique symbol;
export type BackupMaintenanceLease = Readonly<{ [leaseBrand]: true }>;
const leases = new WeakMap<BackupMaintenanceLease, AbortSignal>();

/** Validates a borrowed lease without admitting a second mutation or making maintenance reentrant. */
export function assertBackupMaintenanceLease(lease: BackupMaintenanceLease): void {
  const signal = leases.get(lease);
  if (!signal || !backupMaintenanceLeaseHeld()) throw new Error('The backup maintenance lease is not active.');
  signal.throwIfAborted();
}

/** A borrowed token expires when the awaited operation settles, including cancellation or failure. */
export async function withBackupMaintenanceLease<T>(signal: AbortSignal, work: (lease: BackupMaintenanceLease) => Promise<T>): Promise<T> {
  const release = await acquireBackupMaintenance(signal);
  const lease = Object.freeze({}) as BackupMaintenanceLease;
  leases.set(lease, signal);
  try {
    assertBackupMaintenanceLease(lease);
    const result = await work(lease);
    assertBackupMaintenanceLease(lease);
    return result;
  } finally {
    leases.delete(lease);
    release();
  }
}
