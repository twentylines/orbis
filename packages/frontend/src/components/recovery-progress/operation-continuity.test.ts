import { expect, test } from 'bun:test';
import type { RestoreJob } from '@/modules/system-backups/contracts';
import {
  advanceOperationContinuity,
  armAcceptedRestore,
  armStartedOperation,
  claimOperationBoot,
  claimOperationReload,
  clearOperationContinuity,
  clearMatchingRestoreContinuity,
  decodeOperationContinuity,
  readOperationContinuity,
  rememberCoreOperation,
  operationContinuityStorageName,
  operationPrepaintBootstrap,
  operationBootFragment,
  operationBootMarker,
  writeOperationContinuity,
} from './operation-continuity';
import { resumeCoreUpdate } from '@/desktop/core-update-state';
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
  expect(advanceOperationContinuity(running, job('succeeded'), false, now)?.phase).toBe('departing');
  expect(advanceOperationContinuity(running, job('rolled-back'), false, now)).toBe(running);
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

test('rollback acknowledgement removes only its own restore marker', () => {
  const storage = memory();
  expect(armStartedOperation(id, 'restore', storage)).toBe(true);
  expect(clearMatchingRestoreContinuity('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', storage)).toBe(false);
  expect(readOperationContinuity(storage)?.jobId).toBe(id);
  expect(clearMatchingRestoreContinuity(id, storage)).toBe(true);
  expect(readOperationContinuity(storage)).toBeNull();
  expect(armStartedOperation(id, 'update', storage)).toBe(true);
  expect(clearMatchingRestoreContinuity(id, storage)).toBe(false);
  expect(readOperationContinuity(storage)?.operation).toBe('update');
  storage.setItem(operationContinuityStorageName, '{invalid');
  expect(clearMatchingRestoreContinuity(id, storage)).toBe(false);
  expect(storage.getItem(operationContinuityStorageName)).toBe('{invalid');
});

test('an accepted target and its real latest phase survive refresh without arming completion', () => {
  const storage = memory();
  const targetTag = 'v0.2.0-beta.3';
  expect(armStartedOperation(id, 'update', storage, now, targetTag)).toBe(true);
  const watch = { id, targetTag, phase: 'offline' as const, refreshIssued: false, message: 'Starting Orbis' };
  expect(rememberCoreOperation(watch, storage, now + 1)).toBe(true);
  const marker = readOperationContinuity(storage, now + 2);
  expect(marker?.targetTag).toBe(targetTag);
  expect(marker?.corePhase).toBe('offline');
  expect(resumeCoreUpdate(marker)?.phase).toBe('offline');
  expect(rememberCoreOperation({ ...watch, targetTag: 'v0.2.0-beta.4' }, storage, now + 2)).toBe(false);
  expect(rememberCoreOperation({ ...watch, id: other }, storage, now + 2)).toBe(false);
  expect(rememberCoreOperation({ ...watch, operation: 'downgrade' }, storage, now + 2)).toBe(false);
  expect(armStartedOperation(id, 'update', storage, now, 'https://untrusted.invalid')).toBe(false);
  for (const extra of [{ targetTag: 'private' }, { corePhase: 'private' }, { targetTag, corePhase: 'complete' }])
    expect(decodeOperationContinuity(JSON.stringify({ ...marker, ...extra }), now + 2)).toBeNull();
});

test('automatic completion remains available when browser storage is blocked', async () => {
  const child = Bun.spawn([process.execPath, new URL('./operation-departure.fixture.tsx', import.meta.url).pathname], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr, stdout }).toEqual({ code: 0, stderr: '', stdout: 'automatic handoff verified' });
});

test('a read-only marker consumes the fallback boot once instead of repeating the reload', () => {
  const storage = memory();
  armStartedOperation(id, 'update', storage, Date.now(), 'v0.2.0-beta.3');
  const readOnly = {
    ...storage,
    setItem() {
      throw new Error('Storage blocked');
    },
  };
  const attributes = new Map<string, string>();
  const location = { hash: operationBootFragment, pathname: '/', search: '' };
  const history = {
    state: null,
    replaceState: (_state: unknown, _title: string, path: string) => {
      expect(path).toBe('/');
      location.hash = '';
    },
  };
  const document = { documentElement: { setAttribute: (key: string, value: string) => attributes.set(key, value) } };
  new Function('sessionStorage', 'document', 'location', 'history', operationPrepaintBootstrap)(readOnly, document, location, history);
  expect(location.hash).toBe('');
  expect(attributes.get('data-orbis-operation-boot')).toBe('update');
  const boot = operationBootMarker(readOperationContinuity(readOnly), attributes.get('data-orbis-operation-boot') ?? null);
  expect(boot?.phase).toBe('booting');
  expect(boot?.jobId).toBe(id);
  expect(operationBootMarker(readOperationContinuity(readOnly), 'restore')?.phase).toBe('running');
});

test('verified returned terminals retain requested identity through departure and refresh without authorizing restore rollback', () => {
  for (const operation of ['update', 'downgrade'] as const) {
    const storage = memory();
    const targetTag = 'v0.2.0-beta.3';
    armStartedOperation(id, operation, storage, now, targetTag);
    expect(
      rememberCoreOperation(
        {
          id,
          operation,
          targetTag,
          phase: 'returned',
          returnedTag: 'v0.2.0-beta.2',
          outcome: 'rolled-back',
          refreshIssued: false,
          message: 'The update did not complete.',
        },
        storage,
        now,
      ),
    ).toBe(true);
    const running = readOperationContinuity(storage, now);
    expect(running?.targetTag).toBe(targetTag);
    expect(running?.corePhase).toBe('returned');
    expect(resumeCoreUpdate(running)?.phase).toBe('checking');
    const terminal = { id, operation, status: 'returned', needsRecovery: false };
    expect(advanceOperationContinuity(null, terminal, false, now)).toBeNull();
    expect(advanceOperationContinuity(running, { ...terminal, id: other }, false, now)).toBe(running);
    expect(advanceOperationContinuity(running, { ...terminal, needsRecovery: true }, false, now)).toBe(running);
    expect(advanceOperationContinuity(running, terminal, true, now)).toBe(running);
    const departing = advanceOperationContinuity(running, terminal, false, now);
    expect(departing?.phase).toBe('departing');
    expect(departing?.targetTag).toBe(targetTag);
    if (!departing) throw new Error('Expected verified returned departure');
    writeOperationContinuity(departing, storage, now);
    expect(claimOperationReload(id, storage, now)).toBe(true);
    const boot = claimOperationBoot(storage, now);
    expect(boot?.corePhase).toBe('returned');
    expect(resumeCoreUpdate(boot)?.phase).toBe('checking');
  }
  const restore = advanceOperationContinuity(null, job('running'), false, now);
  expect(advanceOperationContinuity(restore, { ...job('running'), status: 'returned' }, false, now)).toBe(restore);
});
