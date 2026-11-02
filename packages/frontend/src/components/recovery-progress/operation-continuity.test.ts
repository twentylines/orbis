import { expect, test } from 'bun:test';
import type { RestoreJob } from '@/modules/system-backups/contracts';
import {
  advanceOperationContinuity,
  armAcceptedRestore,
  armStartedOperation,
  claimOperationBoot,
  claimOperationReload,
  clearOperationContinuity,
  decodeOperationContinuity,
  readOperationContinuity,
  operationContinuityStorageName,
  operationPrepaintBootstrap,
  writeOperationContinuity,
} from './operation-continuity';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const now = 100000;
const job = (status: RestoreJob['status']): RestoreJob & { operation: 'restore' } => ({
  operation: 'restore',
  id,
  status,
  stage: 'restoring',
  phase: 'restoring',
  message: '',
  needsRecovery: false,
  progressUnavailable: false,
  canCancel: false,
  canRecover: false,
});
function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
test('preview, ready, historical terminal, reconnect and recovery never manufacture a departure', () => {
  for (const status of ['ready', 'succeeded', 'rolled-back', 'recovery-required'] as const)
    expect(advanceOperationContinuity(null, job(status), false, now)).toBeNull();
  const running = advanceOperationContinuity(null, job('running'), false, now);
  expect(running?.phase).toBe('running');
  expect(advanceOperationContinuity(running, job('succeeded'), true, now)).toBe(running);
  expect(advanceOperationContinuity(running, { ...job('succeeded'), needsRecovery: true }, false, now)).toBe(running);
  expect(advanceOperationContinuity(running, { ...job('succeeded'), id: other }, false, now)).toBe(running);
  for (const status of ['succeeded', 'rolled-back'] as const)
    expect(advanceOperationContinuity(running, job(status), false, now)?.phase).toBe('departing');
});
test('accepted start or observed running can cross one confirmed terminal and one boot claim only', () => {
  const storage = memory();
  expect(armAcceptedRestore(id, storage, now)).toBe(true);
  const departing = advanceOperationContinuity(readOperationContinuity(storage, now), job('succeeded'), false, now + 1);
  if (!departing) throw new Error('Expected confirmed departure');
  expect(writeOperationContinuity(departing, storage, now + 1)).toBe(true);
  expect(advanceOperationContinuity(departing, job('running'), false, now + 2)).toBe(departing);
  expect(claimOperationReload(other, storage, now + 2)).toBe(false);
  expect(claimOperationReload(id, storage, now + 2)).toBe(true);
  expect(claimOperationReload(id, storage, now + 2)).toBe(false);
  expect(claimOperationBoot(storage, now + 3)?.phase).toBe('booting');
  expect(claimOperationBoot(storage, now + 4)).toBeNull();
  expect(storage.getItem(operationContinuityStorageName)).toBeNull();
});
test('marker validation rejects stale, future, extra data and malformed IDs without storing user data', () => {
  const base = { operation: 'restore' as const, version: 1 as const, jobId: id, savedAt: now, phase: 'reload' as const };
  expect(decodeOperationContinuity(JSON.stringify(base), now)).toEqual(base);
  for (const patch of [{ savedAt: now + 1 }, { savedAt: now - 120000 }, { jobId: 'bad' }, { phase: 'ready' }, { account: 'private' }, { version: 2 }])
    expect(decodeOperationContinuity(JSON.stringify({ ...base, ...patch }), now)).toBeNull();
  expect(decodeOperationContinuity('x'.repeat(257), now)).toBeNull();
  const storage = memory();
  storage.setItem(operationContinuityStorageName, '{broken');
  expect(readOperationContinuity(storage, now)).toBeNull();
  expect(storage.getItem(operationContinuityStorageName)).toBeNull();
  expect(armAcceptedRestore(id, storage, now)).toBe(true);
  clearOperationContinuity(storage);
  expect(storage.getItem(operationContinuityStorageName)).toBeNull();
  const blocked = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
    removeItem() {
      throw new Error('blocked');
    },
  };
  expect(readOperationContinuity(blocked)).toBeNull();
  expect(armAcceptedRestore(id, blocked)).toBe(false);
});
test('the actual prepaint script consumes one reload marker and never claims a running or repeated boot', () => {
  for (const phase of ['running', 'departing', 'reload', 'booting'] as const) {
    const storage = memory();
    const attributes = new Map<string, string>();
    const callbacks: Array<() => void> = [];
    writeOperationContinuity({ version: 1, operation: 'restore', jobId: id, savedAt: Date.now(), phase }, storage);
    const document = {
      documentElement: {
        setAttribute: (key: string, value: string) => attributes.set(key, value),
        getAttribute: (key: string) => attributes.get(key),
        removeAttribute: (key: string) => attributes.delete(key),
      },
    };
    new Function('sessionStorage', 'document', 'setTimeout', operationPrepaintBootstrap)(storage, document, (callback: () => void) =>
      callbacks.push(callback),
    );
    expect(attributes.has('data-orbis-operation-boot')).toBe(phase === 'reload');
    if (phase === 'reload') {
      expect(readOperationContinuity(storage)?.phase).toBe('booting');
      expect(attributes.get('data-orbis-operation-boot')).toBe('restore');
      expect(callbacks).toHaveLength(0);
    }
  }
});

test('updates and downgrades share one marker but cannot complete each other or arm from historical checks', () => {
  for (const operation of ['update', 'downgrade'] as const) {
    const storage = memory();
    expect(armStartedOperation(id, operation, storage, now)).toBe(true);
    const started = readOperationContinuity(storage, now);
    const terminal = { id, operation, status: 'succeeded', needsRecovery: false };
    expect(advanceOperationContinuity(null, terminal, false, now)).toBeNull();
    expect(advanceOperationContinuity(started, terminal, false, now)?.phase).toBe('departing');
    expect(advanceOperationContinuity(started, { ...terminal, operation: 'restore' }, false, now)).toBe(started);
    expect(advanceOperationContinuity(started, { ...terminal, needsRecovery: true }, false, now)).toBe(started);
  }
});
