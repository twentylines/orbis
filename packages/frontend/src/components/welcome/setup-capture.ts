import type { TimeMachinePoint } from '@runtipi/common/schemas/time-machine';
import { readOnboardingCapture, startOnboardingCapture, TimeMachineApiError } from '@/modules/time-machine/time-machine-api';

type CaptureStorage = Pick<Storage, 'getItem' | 'setItem'>;
export type SetupCaptureReceipt = { version: 1; attemptId: string; phase: 'pending' | 'submitted' | 'accepted' | 'failed' | 'skipped' };
export class SetupCaptureNotStartedError extends Error {}
export class SetupCaptureTerminalError extends Error {}
const attemptPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const receiptKey = (ownerId: number) => `orbis-setup-capture-v1:${ownerId}`;
export function setupCaptureStorage(generation: string | null = null, suppliedStorage?: Storage | null): CaptureStorage | null {
  try {
    const storage = suppliedStorage === undefined ? (typeof localStorage === 'undefined' ? null : localStorage) : suppliedStorage;
    storage?.getItem('orbis-setup-capture-v1:storage-check');
    if (!storage || !generation) return storage;
    if (!/^[a-f0-9-]{36}$/.test(generation)) throw new Error('Invalid setup generation');
    return {
      getItem: (key) => storage.getItem(`${key}:${generation}`),
      setItem: (key, value) => storage.setItem(`${key}:${generation}`, value),
    };
  } catch {
    return null;
  }
}
export function priorUnconfirmedSetupCapture(ownerId: number, generation: string | null, suppliedStorage?: Storage | null) {
  if (!generation) return null;
  let storage: Storage | null;
  try {
    storage = suppliedStorage === undefined ? (typeof localStorage === 'undefined' ? null : localStorage) : suppliedStorage;
  } catch {
    throw new Error('Browser storage is unavailable. Review the previous setup capture before starting another.');
  }
  if (!storage) return null;
  const base = receiptKey(ownerId);
  const current = `${base}:${generation}`;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key || key === current || (key !== base && !key.startsWith(`${base}:`))) continue;
    const scoped: CaptureStorage = {
      getItem: () => storage.getItem(key),
      setItem: (_key, value) => storage.setItem(key, value),
    };
    const receipt = readSetupCapture(ownerId, scoped);
    if (receipt && (receipt.phase === 'pending' || receipt.phase === 'submitted')) return { receipt, storage: scoped };
  }
  return null;
}
export function readSetupCapture(ownerId: number, storage = setupCaptureStorage()): SetupCaptureReceipt | null {
  if (!storage) return null;
  const raw = storage.getItem(receiptKey(ownerId));
  if (raw === null) return null;
  try {
    if (raw.length > 256) throw new Error('Invalid receipt');
    const value = JSON.parse(raw);
    if (
      !value ||
      Object.keys(value).sort().join(',') !== 'attemptId,phase,version' ||
      value.version !== 1 ||
      !attemptPattern.test(value.attemptId) ||
      !['pending', 'submitted', 'accepted', 'failed', 'skipped'].includes(value.phase)
    )
      throw new Error('Invalid receipt');
    return value;
  } catch {
    throw new Error('The saved setup capture receipt needs recovery. No new capture was started.');
  }
}
function writeReceipt(ownerId: number, receipt: SetupCaptureReceipt, storage: CaptureStorage | null) {
  if (!storage) throw new Error('Browser storage is unavailable. Enable it before starting the setup capture.');
  const raw = JSON.stringify(receipt);
  try {
    storage.setItem(receiptKey(ownerId), raw);
    if (storage.getItem(receiptKey(ownerId)) !== raw) throw new Error('Receipt was not retained');
  } catch {
    throw new Error('The setup capture receipt could not be saved. No new attempt was created. Retry to check the existing attempt.');
  }
}
export function reserveSetupCapture(ownerId: number, storage = setupCaptureStorage(), createId = () => crypto.randomUUID()): SetupCaptureReceipt {
  const previous = readSetupCapture(ownerId, storage);
  if (previous) return previous;
  const receipt: SetupCaptureReceipt = { version: 1, attemptId: createId(), phase: 'pending' };
  if (!attemptPattern.test(receipt.attemptId)) throw new Error('A safe setup capture ID could not be created.');
  writeReceipt(ownerId, receipt, storage);
  return receipt;
}
export function acknowledgeSetupCapture(ownerId: number, receipt: SetupCaptureReceipt, phase: 'failed', storage = setupCaptureStorage()) {
  if (readSetupCapture(ownerId, storage)?.attemptId !== receipt.attemptId)
    throw new Error('The setup capture receipt changed. Reload to check its status.');
  const acknowledged = { ...receipt, phase };
  writeReceipt(ownerId, acknowledged, storage);
  return acknowledged;
}
export async function reconcileSetupCapture(
  ownerId: number,
  receipt: SetupCaptureReceipt,
  requestCapture: boolean,
  signal: AbortSignal,
  storage = setupCaptureStorage(),
  api = { read: readOnboardingCapture, start: startOnboardingCapture },
): Promise<TimeMachinePoint> {
  signal.throwIfAborted();
  const retained = readSetupCapture(ownerId, storage);
  if (!retained || retained.attemptId !== receipt.attemptId)
    throw new Error('The setup capture receipt changed. Reload to reconcile it before continuing.');
  let point: TimeMachinePoint;
  try {
    point = await api.read(receipt.attemptId, signal);
  } catch (reason) {
    if (!(reason instanceof TimeMachineApiError) || reason.code !== 'point-not-found') throw reason;
    if (!requestCapture) {
      if (retained.phase === 'submitted')
        throw new Error('The previous request is not confirmed. Retry this same capture attempt before continuing.');
      throw new SetupCaptureNotStartedError('No setup capture was created. You can capture later in Time Machine.');
    }
    writeReceipt(ownerId, { ...retained, phase: 'submitted' }, storage);
    try {
      point = await api.start(receipt.attemptId, signal);
    } catch (failure) {
      try {
        point = await api.read(receipt.attemptId, signal);
      } catch (statusFailure) {
        if (statusFailure instanceof TimeMachineApiError && statusFailure.code === 'point-not-found') {
          const rejectedBeforeReservation =
            failure instanceof TimeMachineApiError &&
            ([400, 401, 403, 404, 429].includes(failure.status) ||
              ['host-capture-support-required', 'proxy-layout-migration-required', 'invalid-request'].includes(failure.code ?? ''));
          if (rejectedBeforeReservation && retained.phase !== 'submitted') {
            writeReceipt(ownerId, { ...retained, phase: 'pending' }, storage);
            throw new SetupCaptureNotStartedError('No setup capture was created. You can try again in Time Machine.');
          }
        }
        throw failure;
      }
    }
  }
  if (point.id !== receipt.attemptId) throw new Error('The setup capture does not match its saved receipt. Check recovery before retrying.');
  if (point.status !== 'capturing' && point.status !== 'sealed')
    throw new SetupCaptureTerminalError('The capture failed. You can try again in Time Machine.');
  signal.throwIfAborted();
  if (readSetupCapture(ownerId, storage)?.attemptId !== receipt.attemptId)
    throw new Error('Another setup receipt replaced this attempt. Check its status before continuing.');
  writeReceipt(ownerId, { ...receipt, phase: 'accepted' }, storage);
  return point;
}
