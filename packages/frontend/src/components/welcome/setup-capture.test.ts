import { expect, test } from 'bun:test';
import { historicalPoint } from '@/modules/time-machine/time-machine.test-data';
import { TimeMachineApiError } from '@/modules/time-machine/time-machine-api';
import {
  acknowledgeSetupCapture,
  readSetupCapture,
  setupCaptureStorage,
  priorUnconfirmedSetupCapture,
  reconcileSetupCapture,
  reserveSetupCapture,
  SetupCaptureNotStartedError,
  SetupCaptureTerminalError,
} from './setup-capture';

const attemptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const signal = () => new AbortController().signal;
const missing = () => new TimeMachineApiError(409, 'point-not-found');
const requestCapture = true;
function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
}
test('a capture attempt is durable before requests, owner scoped and reused after reload without storing credentials', () => {
  const storage = memoryStorage();
  const first = reserveSetupCapture(1, storage, () => attemptId);
  expect(readSetupCapture(1, storage)).toEqual(first);
  expect(readSetupCapture(2, storage)).toBeNull();
  expect(reserveSetupCapture(1, storage, () => otherId)).toEqual(first);
  expect(JSON.stringify(first)).not.toContain('password');
  expect(() => reserveSetupCapture(1, null, () => otherId)).toThrow('Browser storage');
  const blocked = {
    getItem: () => null,
    setItem: () => {
      throw new Error('blocked');
    },
  };
  expect(() => reserveSetupCapture(1, blocked, () => otherId)).toThrow('could not be saved');
});
test('response loss is reconciled with the same GET receipt and never duplicates the accepted capture', async () => {
  const storage = memoryStorage();
  const receipt = reserveSetupCapture(1, storage, () => attemptId);
  let accepted = false;
  let unavailable = true;
  let starts = 0;
  const api = {
    read: async (id: string) => {
      expect(id).toBe(attemptId);
      if (!accepted) throw missing();
      if (unavailable) {
        unavailable = false;
        throw new TypeError('Status response also unavailable');
      }
      return { ...historicalPoint(), status: 'capturing' as const, metadata: null };
    },
    start: async (id: string) => {
      expect(readSetupCapture(1, storage)?.attemptId).toBe(id);
      accepted = true;
      starts++;
      throw new TypeError('response lost');
    },
  };
  await expect(reconcileSetupCapture(1, receipt, requestCapture, signal(), storage, api)).rejects.toThrow('response lost');
  expect(readSetupCapture(1, storage)?.phase).toBe('submitted');
  const reloaded = readSetupCapture(1, storage);
  if (!reloaded) throw new Error('Lost durable test receipt');
  expect((await reconcileSetupCapture(1, reloaded, false, signal(), storage, api)).id).toBe(attemptId);
  expect(starts).toBe(1);
  expect(readSetupCapture(1, storage)?.phase).toBe('accepted');
});
test('an unreserved attempt requires the authenticated session and retries the existing UUID only', async () => {
  const storage = memoryStorage();
  const receipt = reserveSetupCapture(1, storage, () => attemptId);
  let starts = 0;
  const api = {
    read: async () => {
      throw missing();
    },
    start: async (id: string) => {
      expect(id).toBe(attemptId);
      starts++;
      return historicalPoint();
    },
  };
  await expect(reconcileSetupCapture(1, receipt, false, signal(), storage, api)).rejects.toBeInstanceOf(SetupCaptureNotStartedError);
  expect(starts).toBe(0);
  await reconcileSetupCapture(1, receipt, requestCapture, signal(), storage, api);
  expect(starts).toBe(1);
});
test('failed, interrupted, ambiguous, foreign and corrupted receipts never produce capture success or a replacement attempt', async () => {
  const storage = memoryStorage();
  const receipt = reserveSetupCapture(1, storage, () => attemptId);
  for (const status of ['failed', 'interrupted'] as const) {
    const api = {
      read: async () => ({ ...historicalPoint(), status, metadata: null }),
      start: async () => {
        throw new Error('Unexpected POST');
      },
    };
    await expect(reconcileSetupCapture(1, receipt, requestCapture, signal(), storage, api)).rejects.toBeInstanceOf(SetupCaptureTerminalError);
    expect(reserveSetupCapture(1, storage, () => otherId)).toEqual(receipt);
  }
  const api = {
    read: async () => {
      throw new TimeMachineApiError(409, 'capture-recovery-required');
    },
    start: async () => {
      throw new Error('Unexpected POST');
    },
  };
  await expect(reconcileSetupCapture(1, receipt, requestCapture, signal(), storage, api)).rejects.toThrow('recovery');
  await expect(reconcileSetupCapture(2, receipt, requestCapture, signal(), storage, api)).rejects.toThrow('receipt changed');
  expect(() => readSetupCapture(1, { getItem: () => '{broken', setItem: () => undefined })).toThrow('needs recovery');
  expect(readSetupCapture(1, storage)?.phase).toBe('pending');
});

test('not-created attempts keep their ID and a verified terminal result is recorded without deleting its receipt', async () => {
  const storage = memoryStorage();
  const receipt = reserveSetupCapture(1, storage, () => attemptId);
  const api = {
    read: async () => {
      throw missing();
    },
    start: async () => {
      throw new TimeMachineApiError(403);
    },
  };
  await expect(reconcileSetupCapture(1, receipt, requestCapture, signal(), storage, api)).rejects.toBeInstanceOf(SetupCaptureNotStartedError);
  expect(readSetupCapture(1, storage)?.phase).toBe('pending');
  expect(reserveSetupCapture(1, storage, () => otherId).attemptId).toBe(attemptId);
  await expect(
    reconcileSetupCapture(1, receipt, requestCapture, signal(), storage, {
      read: async () => ({ ...historicalPoint(), status: 'failed' as const, metadata: null }),
      start: async () => {
        throw new Error('Unexpected POST');
      },
    }),
  ).rejects.toBeInstanceOf(SetupCaptureTerminalError);
  expect(acknowledgeSetupCapture(1, receipt, 'failed', storage).phase).toBe('failed');
  expect(readSetupCapture(1, storage)?.attemptId).toBe(attemptId);
});

test('a lost submitted request cannot be abandoned from a later missing lookup or an unrelated rejected retry', async () => {
  const storage = memoryStorage();
  const receipt = reserveSetupCapture(1, storage, () => attemptId);
  const networkApi = {
    read: async () => {
      throw missing();
    },
    start: async () => {
      throw new TypeError('Request response lost');
    },
  };
  await expect(reconcileSetupCapture(1, receipt, requestCapture, signal(), storage, networkApi)).rejects.toThrow('response lost');
  expect(readSetupCapture(1, storage)?.phase).toBe('submitted');
  await expect(reconcileSetupCapture(1, receipt, false, signal(), storage, networkApi)).rejects.toThrow('previous request is not confirmed');
  await expect(
    reconcileSetupCapture(1, receipt, requestCapture, signal(), storage, {
      ...networkApi,
      start: async () => {
        throw new TimeMachineApiError(403);
      },
    }),
  ).rejects.toBeInstanceOf(TimeMachineApiError);
  expect(readSetupCapture(1, storage)?.phase).toBe('submitted');
});

test('reset generations start setup afresh while preserving and locating an unconfirmed earlier capture', () => {
  const values = new Map<string, string>();
  const raw: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  const old = setupCaptureStorage(null, raw);
  const receipt = reserveSetupCapture(1, old, () => attemptId);
  raw.setItem('orbis-setup-capture-v1:1', JSON.stringify({ ...receipt, phase: 'submitted' }));
  const generation = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const current = setupCaptureStorage(generation, raw);
  expect(readSetupCapture(1, current)).toBeNull();
  const prior = priorUnconfirmedSetupCapture(1, generation, raw);
  expect(prior?.receipt).toEqual({ ...receipt, phase: 'submitted' });
  if (!prior) throw new Error('Expected a previous capture');
  expect(readSetupCapture(1, prior.storage)).toEqual(prior.receipt);
  expect(raw.getItem('orbis-setup-capture-v1:1')).toContain(attemptId);
  acknowledgeSetupCapture(1, prior.receipt, 'failed', prior.storage);
  expect(priorUnconfirmedSetupCapture(1, generation, raw)).toBeNull();
  expect(reserveSetupCapture(1, current, () => otherId).attemptId).toBe(otherId);
  expect(readSetupCapture(1, old)?.attemptId).toBe(attemptId);
});

test('blocked browser storage is handled without losing the previous-capture safety check', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    expect(setupCaptureStorage()).toBeNull();
    expect(setupCaptureStorage('cccccccc-cccc-4ccc-8ccc-cccccccccccc')).toBeNull();
    expect(() => priorUnconfirmedSetupCapture(1, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')).toThrow('Browser storage is unavailable');
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
