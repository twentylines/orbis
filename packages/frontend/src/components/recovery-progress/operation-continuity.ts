import type { RestoreJob } from '@/modules/system-backups/contracts';
import { validCoreUpdate, type CoreUpdateWatch } from '@/desktop/core-update-state';
import { operationIsSafeTerminal } from './operation-status';

export const operationContinuityStorageName = 'orbis-operation-continuity-v1';
export const operationDepartureMs = 1100;
export const operationBootFragment = '#orbis-operation-boot';
export type MaintenanceOperation = 'restore' | 'update' | 'downgrade';
export type OperationJob = { id: string; operation: MaintenanceOperation; status: string; needsRecovery: boolean };
export type OperationContinuity = {
  operation: MaintenanceOperation;
  version: 1;
  jobId: string;
  savedAt: number;
  phase: 'running' | 'departing' | 'reload' | 'booting';
  targetTag?: string;
  corePhase?: CoreUpdateWatch['phase'];
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
  if (!raw || raw.length > 512) return null;
  try {
    const value = JSON.parse(raw);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !['jobId', 'operation', 'phase', 'savedAt', 'version', 'targetTag', 'corePhase'].includes(key))
    )
      return null;
    if (
      value.targetTag !== undefined &&
      (value.operation === 'restore' ||
        typeof value.targetTag !== 'string' ||
        value.targetTag.length > 100 ||
        !/^v\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/.test(value.targetTag))
    )
      return null;
    if (
      value.corePhase !== undefined &&
      (!value.targetTag || !['downloading', 'updating', 'offline', 'checking', 'failed', 'ready', 'returned'].includes(value.corePhase))
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
export function operationBootMarker(marker: OperationContinuity | null, bootOperation: string | null): OperationContinuity | null {
  return marker && marker.operation === bootOperation && ['running', 'departing'].includes(marker.phase) ? { ...marker, phase: 'booting' } : marker;
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
  if (previous?.jobId !== job.id || previous.operation !== job.operation || !operationIsSafeTerminal(job)) return previous;
  return previous.phase === 'running' ? { ...previous, savedAt: now, phase: 'departing' } : previous;
}
export function armStartedOperation(
  jobId: string,
  operation: MaintenanceOperation,
  storage: ContinuityStorage,
  now = Date.now(),
  targetTag?: string,
) {
  if (targetTag !== undefined && !validCoreUpdate(jobId, targetTag)) return false;
  return writeOperationContinuity(
    { version: 1, jobId, operation, savedAt: now, phase: 'running', ...(targetTag ? { targetTag } : {}) },
    storage,
    now,
  );
}
export function rememberCoreOperation(watch: CoreUpdateWatch, storage: ContinuityStorage, now = Date.now()) {
  const marker = readOperationContinuity(storage, now);
  if (
    !marker ||
    marker.jobId !== watch.id ||
    marker.operation !== (watch.operation ?? 'update') ||
    (marker.targetTag && marker.targetTag !== watch.targetTag)
  )
    return false;
  return writeOperationContinuity({ ...marker, targetTag: watch.targetTag, corePhase: watch.phase, savedAt: now }, storage, now);
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

export const operationPrepaintBootstrap = `(()=>{const decode=${decodeOperationContinuity.toString()};let fallback=false;try{fallback=typeof location!=='undefined'&&location.hash===${JSON.stringify(operationBootFragment)};if(fallback)history.replaceState(history.state,'',location.pathname+location.search);}catch{}try{const storageName=${JSON.stringify(operationContinuityStorageName)};const marker=decode(sessionStorage.getItem(storageName));if(marker&&(marker.phase==='reload'||(fallback&&['running','departing'].includes(marker.phase)))){try{sessionStorage.setItem(storageName,JSON.stringify({...marker,phase:'booting',savedAt:Date.now()}));}catch{}document.documentElement.setAttribute('data-orbis-operation-boot',marker.operation);}else if(!marker||marker.phase==='booting'){sessionStorage.removeItem(storageName);}}catch{}})();`;
