import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { backupDiskActive } from '@/common/backup-disk';
import { corePreparationRecoveryHeld, enterBackupMutation, setCorePreparationRecoveryRequired } from '@/common/backup-maintenance';
import { CoreInspectionStore } from './time-machine-core-inspection.store';
import { captureRestoreStartupRole } from './backup-restore-startup';
import { TimeMachineCorePreparationService } from './time-machine-core-preparation.service';
import {
  callCoreBootstrapInspectionRoot,
  callCoreCleanTargetPreparationRoot,
  callCoreRestoreRuntimeRoot,
} from './time-machine-core-bootstrap-client';

vi.mock('./time-machine-core-bootstrap-client', () => ({
  callCoreBootstrapInspectionRoot: vi.fn(),
  callCoreCleanTargetPreparationRoot: vi.fn(),
  callCoreRestoreRuntimeRoot: vi.fn(),
}));
const runtime = vi.mocked(callCoreRestoreRuntimeRoot);
const source = vi.mocked(callCoreBootstrapInspectionRoot);
const target = vi.mocked(callCoreCleanTargetPreparationRoot);
const actor = { userId: 1, sessionBinding: '1'.repeat(64), securityBinding: '2'.repeat(64) };
const pointId = randomUUID();
const requestId = randomUUID();
const point = { pointId, ownerId: 1, archiveSha256: '3'.repeat(64), manifestSha256: '4'.repeat(64) };
const binding = { ...point, actor: { ownerId: 1, sessionBinding: actor.sessionBinding, securityBinding: actor.securityBinding } };
const request = { authMethod: 'session', user: { id: 1, operator: true }, cookies: {}, body: { password: 'discard-me' } } as never;
const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
const runtimeStatus = (phase = 'installed', active = false) =>
  ({ phase, enrollmentActive: active, runtimeAvailable: phase === 'installed' }) as Awaited<ReturnType<typeof callCoreRestoreRuntimeRoot>>;
const sourceStatus = (phase = 'awaiting-approval') =>
  ({ phase, bootstrapCatalogAvailable: phase === 'inspection-complete' }) as Awaited<ReturnType<typeof callCoreBootstrapInspectionRoot>>;
const targetStatus = (phase = 'preparation-complete', active = false) =>
  ({ phase, preparationActive: active, preparedTargetAvailable: phase === 'preparation-complete' }) as Awaited<
    ReturnType<typeof callCoreCleanTargetPreparationRoot>
  >;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-preparation-'));
  const auth = { operatorActionContext: vi.fn().mockResolvedValue(actor), verifySensitiveAction: vi.fn().mockResolvedValue({}) };
  const timeMachine = { coreInspectionBindingPoint: vi.fn().mockResolvedValue(point) };
  const service = new TimeMachineCorePreparationService({ get: () => ({ dataDir: dir }) } as never, auth as never, timeMachine as never);
  await service.onModuleInit();
  return { service, auth, timeMachine, dir };
}
async function fixture() {
  runtime.mockResolvedValue(runtimeStatus());
  source.mockResolvedValue(sourceStatus());
  target.mockResolvedValue(targetStatus());
  const result = await setup();
  fixtures.push(result);
  return result;
}
async function restart(fixture: Awaited<ReturnType<typeof setup>>) {
  await fixture.service.onModuleDestroy();
  fixture.service = new TimeMachineCorePreparationService(
    { get: () => ({ dataDir: fixture.dir }) } as never,
    fixture.auth as never,
    fixture.timeMachine as never,
  );
  await fixture.service.onModuleInit();
  return fixture.service;
}
async function idle() {
  await vi.waitFor(() => expect(backupDiskActive()).toBe(false));
}
afterEach(async () => {
  captureRestoreStartupRole('ordinary');
  for (const fixture of fixtures.splice(0)) {
    // Terminal fixture responses settle held tests; shutdown itself must never release uncertain work.
    fixture.auth.operatorActionContext.mockResolvedValue(actor);
    fixture.timeMachine.coreInspectionBindingPoint.mockResolvedValue(point);
    runtime.mockResolvedValue(runtimeStatus());
    source.mockResolvedValue(sourceStatus('inspection-complete'));
    target.mockResolvedValue(targetStatus());
    await fixture.service.status(pointId, 1, request, requestId).catch(() => undefined);
    await fixture.service.onModuleDestroy();
    await fs.rm(fixture.dir, { recursive: true, force: true });
  }
  vi.resetAllMocks();
  setCorePreparationRecoveryRequired(false);
  expect(backupDiskActive()).toBe(false);
});

it('returns promptly, records distinct Root identities before dispatch, and waits without passwords', async () => {
  const { service, auth, dir } = await fixture();
  const waiting = deferred<ReturnType<typeof runtimeStatus>>();
  runtime.mockResolvedValueOnce(runtimeStatus('preparing', true)).mockReturnValueOnce(waiting.promise);
  const started = await service.prepare(pointId, 1, request, requestId);
  expect(started.state).toBe('checking-support');
  await vi.waitFor(() => expect(runtime).toHaveBeenCalledTimes(2));
  expect(source).not.toHaveBeenCalled();
  expect(backupDiskActive()).toBe(true);
  const records = await Promise.all(
    ['core-bootstrap-inspections', 'core-runtime-enrollments', 'core-target-preparations'].map((namespace) =>
      new CoreInspectionStore(dir, namespace as 'core-bootstrap-inspections').get(requestId, binding),
    ),
  );
  expect(new Set(records.map((record) => record?.id)).size).toBe(3);
  expect(await new CoreInspectionStore(dir, 'core-runtime-enrollments').marked(requestId, binding, 'requested')).toBe(true);
  waiting.resolve(runtimeStatus());
  await idle();
  expect(source).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: 'prepare', id: started.id }));
  expect(auth.verifySensitiveAction).not.toHaveBeenCalled();
  expect(auth.operatorActionContext.mock.calls.slice(2).some(([value]) => (value as { body?: unknown }).body)).toBe(false);
  expect((await service.status(pointId, 1, request, requestId)).state).toBe('awaiting-approval');
});

it('does not force an unsupported installed release to inspect or prepare targets', async () => {
  const { service } = await fixture();
  runtime.mockResolvedValue(runtimeStatus('not-supported'));
  await service.prepare(pointId, 1, request, requestId);
  await idle();
  expect(source).not.toHaveBeenCalled();
  expect(target).not.toHaveBeenCalled();
  expect((await service.status(pointId, 1, request, requestId)).state).toBe('not-supported');
});

it('keeps custody after a lost wait and settles only on a proven terminal response', async () => {
  const { service } = await fixture();
  runtime.mockResolvedValueOnce(runtimeStatus('preparing', true)).mockRejectedValueOnce(new Error('lost wait'));
  await service.prepare(pointId, 1, request, requestId);
  await vi.waitFor(() => expect(runtime).toHaveBeenCalledTimes(2));
  await new Promise((resolve) => setImmediate(resolve));
  expect(backupDiskActive()).toBe(true);
  expect(source).not.toHaveBeenCalled();
  runtime.mockResolvedValue(runtimeStatus('recovery-required'));
  expect((await service.status(pointId, 1, request, requestId)).state).toBe('recovery-required');
  expect(backupDiskActive()).toBe(true);
  runtime.mockResolvedValue(runtimeStatus());
  await service.status(pointId, 1, request, requestId);
  await idle();
  expect(source).not.toHaveBeenCalled();
});

it('observes an already dispatched worker after session revocation without launching the next stage', async () => {
  const { service, auth } = await fixture();
  const waiting = deferred<ReturnType<typeof runtimeStatus>>();
  runtime.mockResolvedValueOnce(runtimeStatus('preparing', true)).mockReturnValueOnce(waiting.promise);
  await service.prepare(pointId, 1, request, requestId);
  await vi.waitFor(() => expect(runtime).toHaveBeenCalledTimes(2));
  auth.operatorActionContext.mockRejectedValue(new Error('session revoked'));
  expect(backupDiskActive()).toBe(true);
  waiting.resolve(runtimeStatus());
  await idle();
  expect(source).not.toHaveBeenCalled();
  await expect(service.status(pointId, 1, request, requestId)).rejects.toThrow();
});

it('rejects owner, actor, source and request drift before dispatch', async () => {
  const { service, auth, timeMachine } = await fixture();
  await expect(service.prepare(pointId, 2, request, requestId)).rejects.toThrow();
  timeMachine.coreInspectionBindingPoint.mockResolvedValueOnce({ ...point, pointId: randomUUID() });
  await expect(service.prepare(pointId, 1, request, requestId)).rejects.toThrow();
  await service.prepare(pointId, 1, request, requestId);
  await idle();
  auth.operatorActionContext.mockResolvedValue({ ...actor, sessionBinding: '9'.repeat(64) });
  await expect(service.status(pointId, 1, request, requestId)).rejects.toThrow();
  auth.operatorActionContext.mockResolvedValue(actor);
  timeMachine.coreInspectionBindingPoint.mockResolvedValue({ ...point, archiveSha256: '9'.repeat(64) });
  await expect(service.status(pointId, 1, request, requestId)).rejects.toThrow();
  await expect(service.status(pointId, 1, request, randomUUID())).rejects.toThrow();
});

it('reopens durable status without replaying enrollment, approval or target work', async () => {
  const { service, dir, auth, timeMachine } = await fixture();
  const started = await service.prepare(pointId, 1, request, requestId);
  await idle();
  const reload = new TimeMachineCorePreparationService({ get: () => ({ dataDir: dir }) } as never, auth as never, timeMachine as never);
  await reload.onModuleInit();
  runtime.mockClear();
  source.mockClear();
  target.mockClear();
  const status = await reload.status(pointId, 1, request, requestId);
  expect(status.id).toBe(started.id);
  expect(status.state).toBe('awaiting-approval');
  expect(source).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: 'status', id: started.id }));
  expect(runtime).not.toHaveBeenCalled();
  expect(target).not.toHaveBeenCalled();
  await reload.onModuleDestroy();
});

it('checks account approval once, then requires an explicit separate target action', async () => {
  const { service, auth } = await fixture();
  await service.prepare(pointId, 1, request, requestId);
  await idle();
  const input = { reviewSha256: '5'.repeat(64), approvalNonce: '6'.repeat(64), executionConsent: {} };
  source.mockResolvedValueOnce(sourceStatus()).mockResolvedValueOnce(sourceStatus('inspection-complete'));
  await service.approve(pointId, 1, request, requestId, { password: 'fixture-password' }, input);
  await idle();
  expect(auth.verifySensitiveAction).toHaveBeenCalledExactlyOnceWith(1, 'fixture-password', undefined);
  expect(target).not.toHaveBeenCalled();
  source.mockResolvedValue(sourceStatus('inspection-complete'));
  const waiting = deferred<ReturnType<typeof targetStatus>>();
  target.mockResolvedValueOnce(targetStatus('initializing', true)).mockReturnValueOnce(waiting.promise);
  await service.prepareTarget(pointId, 1, request, requestId, 'prepare-isolated-clean-target');
  await vi.waitFor(() => expect(target).toHaveBeenCalledTimes(2));
  expect(backupDiskActive()).toBe(true);
  await expect(service.prepareTarget(pointId, 1, request, requestId, 'prepare-isolated-clean-target')).rejects.toThrow();
  waiting.resolve(targetStatus());
  await idle();
  const status = await service.status(pointId, 1, request, requestId);
  expect(status.preparedTargetAvailable).toBe(true);
  expect(status.activationAuthorized).toBe(false);
  expect(status.restoreSupported).toBe(false);
  expect(auth.verifySensitiveAction).toHaveBeenCalledTimes(1);
});

it('refuses a target without the source catalog and refuses changed approval security', async () => {
  const { service, auth } = await fixture();
  await service.prepare(pointId, 1, request, requestId);
  await idle();
  await expect(service.prepareTarget(pointId, 1, request, requestId, 'prepare-isolated-clean-target')).rejects.toThrow();
  await expect(service.prepareTarget(pointId, 1, request, requestId, 'activate' as never)).rejects.toThrow();
  auth.verifySensitiveAction.mockImplementationOnce(async () => {
    auth.operatorActionContext.mockResolvedValue({ ...actor, securityBinding: '9'.repeat(64) });
  });
  source.mockClear();
  await expect(service.approve(pointId, 1, request, requestId, { password: 'fixture-password' }, {} as never)).rejects.toThrow();
  expect(source).not.toHaveBeenCalled();
  expect(target).not.toHaveBeenCalled();
});

it('retains custody when shutdown interrupts an active Root wait', async () => {
  const { service } = await fixture();
  runtime.mockResolvedValueOnce(runtimeStatus('preparing', true)).mockImplementationOnce(
    ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
  );
  await service.prepare(pointId, 1, request, requestId);
  await vi.waitFor(() => expect(runtime).toHaveBeenCalledTimes(2));
  await service.onModuleDestroy();
  expect(backupDiskActive()).toBe(true);
  expect(source).not.toHaveBeenCalled();
  // Mock the independent Root terminal proof for fixture cleanup.
  runtime.mockResolvedValue(runtimeStatus());
  await service.status(pointId, 1, request, requestId);
  await idle();
});

it('retains isolated-target custody through lost transport and unchanged GET status never replays work', async () => {
  const { service } = await fixture();
  await service.prepare(pointId, 1, request, requestId);
  await idle();
  source.mockResolvedValue(sourceStatus('inspection-complete'));
  target.mockResolvedValueOnce(targetStatus('initializing', true)).mockRejectedValueOnce(new Error('lost target wait'));
  await service.prepareTarget(pointId, 1, request, requestId, 'prepare-isolated-clean-target');
  await vi.waitFor(() => expect(target).toHaveBeenCalledTimes(2));
  await new Promise((resolve) => setImmediate(resolve));
  target.mockResolvedValue(targetStatus('checking'));
  expect((await service.status(pointId, 1, request, requestId)).preparedTargetAvailable).toBe(false);
  expect(backupDiskActive()).toBe(true);
  target.mockResolvedValue(targetStatus());
  await service.status(pointId, 1, request, requestId);
  await idle();
  expect(target.mock.calls.filter(([options]) => options.action === 'prepare')).toHaveLength(1);
});

it('does not mistake an authorized inspection worker or a failed approval connection for completion', async () => {
  const { service } = await fixture();
  await service.prepare(pointId, 1, request, requestId);
  await idle();
  source.mockResolvedValueOnce(sourceStatus()).mockRejectedValueOnce(new Error('lost approval reply'));
  await service.approve(pointId, 1, request, requestId, { password: 'fixture-password' }, {} as never);
  await vi.waitFor(() => expect(source.mock.calls.some(([options]) => options.action === 'approve')).toBe(true));
  await new Promise((resolve) => setImmediate(resolve));
  source.mockResolvedValue(sourceStatus('inspection-authorized'));
  await service.status(pointId, 1, request, requestId);
  expect(backupDiskActive()).toBe(true);
  expect(target).not.toHaveBeenCalled();
  source.mockResolvedValue(sourceStatus('inspection-complete'));
  await service.status(pointId, 1, request, requestId);
  await idle();
});

it('rebuilds a durable recovery hold after restart and only observes already dispatched work', async () => {
  const current = await fixture();
  const { dir } = current;
  const stores = (['core-bootstrap-inspections', 'core-runtime-enrollments', 'core-target-preparations'] as const).map(
    (namespace) => new CoreInspectionStore(dir, namespace),
  );
  await Promise.all(stores.map((store) => store.reserve(requestId, binding)));
  await stores[1]?.mark(requestId, binding, 'requested');
  runtime.mockResolvedValue(runtimeStatus('preparing', true));
  const service = await restart(current);
  expect(corePreparationRecoveryHeld()).toBe(true);
  expect(enterBackupMutation()).toBeNull();
  expect(runtime.mock.calls.every(([options]) => options.action === 'status')).toBe(true);
  runtime.mockRejectedValue(new Error('Root unavailable'));
  await service.status(pointId, 1, request, requestId);
  expect(corePreparationRecoveryHeld()).toBe(true);
  runtime.mockResolvedValue(runtimeStatus());
  const result = await service.status(pointId, 1, request, requestId);
  expect(result.state).toBe('ready-to-inspect');
  expect(corePreparationRecoveryHeld()).toBe(false);
  const release = enterBackupMutation();
  expect(release).toBeTypeOf('function');
  release?.();
  await service.prepare(pointId, 1, request, requestId);
  expect(runtime.mock.calls.every(([options]) => options.action === 'status')).toBe(true);
  expect(source).not.toHaveBeenCalled();
  expect(target).not.toHaveBeenCalled();
});

it('fails closed on an orphaned dispatch marker rather than losing unfinished work', async () => {
  const current = await fixture();
  const { dir } = current;
  const store = new CoreInspectionStore(dir, 'core-runtime-enrollments');
  await store.reserve(requestId, binding);
  await store.mark(requestId, binding, 'requested');
  await fs.unlink(path.join(dir, 'backups/time-machine/core-runtime-enrollments', `${requestId}.json`));
  await restart(current);
  expect(corePreparationRecoveryHeld()).toBe(true);
  expect(enterBackupMutation()).toBeNull();
  expect(runtime).not.toHaveBeenCalled();
});

it('never lets a stale status reply settle a newly started approval', async () => {
  const { service } = await fixture();
  await service.prepare(pointId, 1, request, requestId);
  await idle();
  const stale = deferred<ReturnType<typeof sourceStatus>>();
  const approval = deferred<ReturnType<typeof sourceStatus>>();
  source.mockImplementation(({ action }) => {
    if (action === 'status') return stale.promise;
    return approval.promise;
  });
  const reading = service.status(pointId, 1, request, requestId);
  await vi.waitFor(() => expect(source.mock.calls.filter(([options]) => options.action === 'status')).toHaveLength(1));
  source.mockResolvedValueOnce(sourceStatus());
  await service.approve(pointId, 1, request, requestId, { password: 'fixture-password' }, {} as never);
  await vi.waitFor(() => expect(source.mock.calls.some(([options]) => options.action === 'approve')).toBe(true));
  stale.resolve(sourceStatus());
  await reading;
  approval.reject(new Error('lost approval connection'));
  await new Promise((resolve) => setImmediate(resolve));
  expect(backupDiskActive()).toBe(true);
});

it('keeps an isolated verifier startup read-only and never contacts Root', async () => {
  captureRestoreStartupRole('verify');
  const { service, dir } = await fixture();
  await service.prepareStartup();
  await service.onModuleInit();
  expect(await fs.readdir(dir)).toEqual([]);
  expect(corePreparationRecoveryHeld()).toBe(false);
  expect(runtime).not.toHaveBeenCalled();
  expect(source).not.toHaveBeenCalled();
  expect(target).not.toHaveBeenCalled();
});
