export type OperationStatus = {
  state: 'idle' | 'restoring' | 'updating' | 'downgrading' | 'resetting' | 'recovery' | 'checking';
  operation?: 'restore' | 'update' | 'downgrade';
  stage?: 'preparing' | 'downloading' | 'applying' | 'restarting' | 'verifying' | 'restoring' | 'recovering' | 'resetting';
  progress?: number;
};
export type OperationSnapshot = OperationStatus & { supported: boolean; unavailable?: boolean };
export function operationUsesSpace(snapshot: OperationSnapshot | null, acceptedOperation: boolean) {
  return acceptedOperation || Boolean(snapshot && (operationIsWaiting(snapshot) || snapshot.state !== 'idle'));
}
export function resetSceneVisible(snapshot: OperationSnapshot | null, accepted: boolean) {
  return accepted && (!snapshot || snapshot.state === 'resetting' || operationIsWaiting(snapshot));
}
export function operationIsWaiting(snapshot: OperationSnapshot) {
  return snapshot.state === 'checking' || snapshot.unavailable === true;
}
export function operationShowsContent(snapshot: OperationSnapshot | null, authRoute: boolean, matchingTerminal: boolean, departing: boolean) {
  const locked = !snapshot || snapshot.state !== 'idle' || snapshot.unavailable === true;
  return (!locked && !matchingTerminal && !departing) || (authRoute && snapshot?.state === 'recovery' && !snapshot.unavailable);
}
export function parseOperationStatus(value: unknown): OperationStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Restore status is unavailable.');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !['state', 'operation', 'stage', 'progress'].includes(key)) ||
    !['idle', 'restoring', 'updating', 'downgrading', 'resetting', 'recovery', 'checking'].includes(String(record.state))
  )
    throw new Error('Restore status is unavailable.');
  if (record.operation !== undefined && !['restore', 'update', 'downgrade'].includes(String(record.operation)))
    throw new Error('Operation status is unavailable.');
  if (
    record.stage !== undefined &&
    !['preparing', 'downloading', 'applying', 'restarting', 'verifying', 'restoring', 'recovering', 'resetting'].includes(String(record.stage))
  )
    throw new Error('Restore status is unavailable.');
  if (
    record.progress !== undefined &&
    (typeof record.progress !== 'number' || !Number.isFinite(record.progress) || record.progress < 0 || record.progress > 99)
  )
    throw new Error('Restore status is unavailable.');
  return record as OperationStatus;
}
export type OperationStatusTransport = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
export async function readOperationStatus(signal?: AbortSignal, transport: OperationStatusTransport = fetch): Promise<OperationSnapshot> {
  const response = await transport('/api/system/operation-status', {
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
  });
  if (response.status === 404 || response.status === 405) return { state: 'idle', supported: false };
  if (!response.ok) throw new Error('Restore status is unavailable.');
  const raw = await response.text();
  if (raw.length > 2048) throw new Error('Restore status is unavailable.');
  return { ...parseOperationStatus(JSON.parse(raw)), supported: true };
}
export async function confirmResetSnapshot(
  shared: OperationSnapshot,
  accepted: boolean,
  read: () => Promise<OperationSnapshot> = () => readOperationStatus(),
): Promise<OperationSnapshot> {
  if (!accepted || shared.state !== 'idle') return shared;
  try {
    const fresh = await read();
    return fresh.supported ? fresh : { state: 'checking', supported: true, unavailable: true };
  } catch {
    return { state: 'checking', supported: true, unavailable: true };
  }
}
let pending: Promise<OperationSnapshot> | null = null;
let latest: OperationSnapshot | null = null;
let checkedAt = 0;
let observedLock = false;
export function rollbackCanContinue(
  job: { id: string; status: string; needsRecovery: boolean } | null,
  startedId: string | null,
  authority: OperationSnapshot,
) {
  return Boolean(
    job && startedId && job.id === startedId && job.status === 'rolled-back' && !job.needsRecovery && operationAllowsDeparture(authority),
  );
}
export function operationAllowsDeparture(snapshot: OperationSnapshot) {
  return snapshot.state === 'idle' && snapshot.supported && !snapshot.unavailable;
}
export function operationIsSafeTerminal(job: { operation: string; status: string; needsRecovery: boolean }) {
  return !job.needsRecovery && (job.status === 'succeeded' || (job.status === 'returned' && ['update', 'downgrade'].includes(job.operation)));
}
export function operationBootIsReady(
  marker: { phase: string; jobId: string; operation: string } | null,
  job: { id: string; operation: string; status: string; needsRecovery: boolean } | null,
  snapshot: OperationSnapshot | null,
) {
  return Boolean(
    marker?.phase === 'booting' &&
      job &&
      marker.jobId === job.id &&
      marker.operation === job.operation &&
      operationIsSafeTerminal(job) &&
      snapshot &&
      operationAllowsDeparture(snapshot),
  );
}
export function operationSnapshotAfter(previousLock: boolean, next: OperationSnapshot): OperationSnapshot {
  return previousLock && !next.supported ? { state: 'checking', supported: true, unavailable: true } : next;
}
export function loadOperationStatus(force = false): Promise<OperationSnapshot> {
  if (pending) return pending;
  if (!force && latest && Date.now() - checkedAt < 250) return Promise.resolve(latest);
  pending = readOperationStatus()
    .then((snapshot) => {
      const next = operationSnapshotAfter(observedLock, snapshot);
      if (next.supported && !next.unavailable) observedLock = next.state !== 'idle';
      latest = next;
      return next;
    })
    .catch(() => {
      latest = { state: 'checking', supported: true, unavailable: true };
      return latest;
    })
    .finally(() => {
      checkedAt = Date.now();
      pending = null;
    });
  return pending;
}

const acceptedResetKey = 'orbis-reset-accepted';
type ResetMarkerStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export function markResetAccepted(storage?: ResetMarkerStorage) {
  try {
    (storage ?? sessionStorage).setItem(acceptedResetKey, '1');
  } catch {
    // The current document still tracks observed server status.
  }
}
export function hasAcceptedReset(storage?: ResetMarkerStorage) {
  try {
    return (storage ?? sessionStorage).getItem(acceptedResetKey) === '1';
  } catch {
    return false;
  }
}
export function clearAcceptedReset(storage?: ResetMarkerStorage) {
  try {
    (storage ?? sessionStorage).removeItem(acceptedResetKey);
  } catch {
    // Storage may be unavailable.
  }
}
