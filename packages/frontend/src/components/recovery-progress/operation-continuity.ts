import type { RestoreJob } from '@/modules/system-backups/contracts';

export const operationContinuityStorageName = 'orbis-operation-continuity-v1';
export const operationDepartureMs = 1100;
export type MaintenanceOperation = 'restore' | 'update' | 'downgrade';
export type OperationJob = { id: string; operation: MaintenanceOperation; status: string; needsRecovery: boolean };
export type OperationContinuity = {
  operation: MaintenanceOperation;
  version: 1;
  jobId: string;
  savedAt: number;
  phase: 'running' | 'departing' | 'reload' | 'booting';
};
type ContinuityStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export function operationContinuityStorage(): ContinuityStorage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function decodeOperationContinuity(raw: string | null, now = Date.now()): OperationContinuity | null {
  if (!raw || raw.length > 256) return null;
  try {
    const value = JSON.parse(raw);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'jobId,operation,phase,savedAt,version'
    )
      return null;
    if (!['restore', 'update', 'downgrade'].includes(value.operation)) return null;
    if (
      value.version !== 1 ||
      typeof value.jobId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.jobId)
    )
      return null;
    if (
      !['running', 'departing', 'reload', 'booting'].includes(value.phase) ||
      !Number.isSafeInteger(value.savedAt) ||
      value.savedAt <= 0 ||
      value.savedAt > now
    )
      return null;
    if (now - value.savedAt >= (value.phase === 'running' ? 1800000 : 120000)) return null;
    return value;
  } catch {
    return null;
  }
}
export function readOperationContinuity(storage: ContinuityStorage, now = Date.now()) {
  try {
    const raw = storage.getItem(operationContinuityStorageName);
    const value = decodeOperationContinuity(raw, now);
    if (raw && !value) storage.removeItem(operationContinuityStorageName);
    return value;
  } catch {
    return null;
  }
}
export function writeOperationContinuity(value: OperationContinuity, storage: ContinuityStorage, now = Date.now()) {
  const raw = JSON.stringify(value);
  if (!decodeOperationContinuity(raw, now)) return false;
  try {
    storage.setItem(operationContinuityStorageName, raw);
    return storage.getItem(operationContinuityStorageName) === raw;
  } catch {
    return false;
  }
}
export function clearOperationContinuity(storage: Pick<Storage, 'removeItem'>) {
  try {
    storage.removeItem(operationContinuityStorageName);
  } catch {
    /* Browser storage is optional; the marker never authorizes an operation. */
  }
}
export function clearMatchingRestoreContinuity(jobId: string, storage: ContinuityStorage) {
  try {
    const marker = decodeOperationContinuity(storage.getItem(operationContinuityStorageName));
    if (!marker || marker.operation !== 'restore' || marker.jobId !== jobId) return false;
    storage.removeItem(operationContinuityStorageName);
    return storage.getItem(operationContinuityStorageName) === null;
  } catch {
    return false;
  }
}
export function advanceOperationContinuity(
  previous: OperationContinuity | null,
  job: OperationJob,
  reconnecting: boolean,
  now: number,
): OperationContinuity | null {
  if (reconnecting || (job.operation === 'restore' && job.status === 'rolled-back')) return previous;
  if (job.status === 'running' && !job.needsRecovery && (!previous || previous.phase === 'running'))
    return previous?.jobId === job.id && previous.operation === job.operation && previous.phase === 'running'
      ? previous
      : { version: 1, jobId: job.id, operation: job.operation, savedAt: now, phase: 'running' };
  if (previous?.jobId !== job.id || previous.operation !== job.operation || job.needsRecovery || !['succeeded', 'rolled-back'].includes(job.status))
    return previous;
  return previous.phase === 'running' ? { ...previous, savedAt: now, phase: 'departing' } : previous;
}
export function armStartedOperation(jobId: string, operation: MaintenanceOperation, storage: ContinuityStorage, now = Date.now()) {
  return writeOperationContinuity({ version: 1, jobId, operation, savedAt: now, phase: 'running' }, storage, now);
}
export const armAcceptedRestore = (jobId: string, storage: ContinuityStorage, now = Date.now()) =>
  armStartedOperation(jobId, 'restore', storage, now);
export const advanceRestoreContinuity = (previous: OperationContinuity | null, job: RestoreJob, reconnecting: boolean, now: number) =>
  advanceOperationContinuity(previous, { ...job, operation: 'restore' }, reconnecting, now);
export function claimOperationReload(jobId: string, storage: ContinuityStorage, now = Date.now()) {
  const marker = readOperationContinuity(storage, now);
  return Boolean(
    marker?.jobId === jobId && marker.phase === 'departing' && writeOperationContinuity({ ...marker, savedAt: now, phase: 'reload' }, storage, now),
  );
}
export function claimOperationBoot(storage: ContinuityStorage, now = Date.now()) {
  const marker = readOperationContinuity(storage, now);
  if (marker?.phase !== 'reload') {
    if (marker?.phase === 'booting') clearOperationContinuity(storage);
    return null;
  }
  const boot = { ...marker, savedAt: now, phase: 'booting' as const };
  return writeOperationContinuity(boot, storage, now) ? boot : null;
}

export const operationPrepaintBootstrap = `(()=>{const decode=${decodeOperationContinuity.toString()};try{const storageName=${JSON.stringify(operationContinuityStorageName)};const raw=sessionStorage.getItem(storageName);const marker=decode(raw);if(marker&&marker.phase==='reload'){sessionStorage.setItem(storageName,JSON.stringify({...marker,phase:'booting',savedAt:Date.now()}));document.documentElement.setAttribute('data-orbis-operation-boot',marker.operation);}else if(!marker||marker.phase==='booting'){sessionStorage.removeItem(storageName);}}catch{}})();`;
