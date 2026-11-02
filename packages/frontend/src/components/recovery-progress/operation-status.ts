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
let pending: Promise<OperationSnapshot> | null = null;
let latest: OperationSnapshot | null = null;
let checkedAt = 0;
let observedLock = false;
export function operationAllowsDeparture(snapshot: OperationSnapshot) {
  return snapshot.state === 'idle' && snapshot.supported && !snapshot.unavailable;
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
