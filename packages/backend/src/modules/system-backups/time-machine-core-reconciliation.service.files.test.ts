import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { backupDiskActive } from '@/common/backup-disk';
import { corePreparationRecoveryHeld, enterBackupMutation, setCorePreparationRecoveryRequired } from '@/common/backup-maintenance';
import { CoreInspectionStore } from './time-machine-core-inspection.store';
import { CoreReconciliationStore } from './time-machine-core-reconciliation.store';
import { TimeMachineCorePreparationService } from './time-machine-core-preparation.service';
import { TimeMachineCoreReconciliationService } from './time-machine-core-reconciliation.service';
import { captureRestoreStartupRole } from './backup-restore-startup';
import {
  callCoreBootstrapInspectionRoot,
  callCoreCleanTargetPreparationRoot,
  callCoreCleanTargetReconciliationRoot,
} from './time-machine-core-bootstrap-client';

vi.mock('./time-machine-core-bootstrap-client', () => ({
  callCoreBootstrapInspectionRoot: vi.fn(),
  callCoreCleanTargetPreparationRoot: vi.fn(),
  callCoreCleanTargetReconciliationRoot: vi.fn(),
  callCoreRestoreRuntimeRoot: vi.fn(),
}));
vi.mock('@/core/config/configuration.service', () => ({ ConfigurationService: class {} }));
vi.mock('../auth/auth.service', () => ({ AuthService: class {} }));
vi.mock('./time-machine.service', () => ({ TimeMachineService: class {} }));
vi.mock('./backup-restore-startup', () => {
  let role = 'ordinary';
  return {
    restoreStartupRole: () => role,
    captureRestoreStartupRole: (value: string) => {
      role = value;
    },
  };
});
const inspect = vi.mocked(callCoreBootstrapInspectionRoot);
const target = vi.mocked(callCoreCleanTargetPreparationRoot);
const root = vi.mocked(callCoreCleanTargetReconciliationRoot);
const actor = { userId: 1, sessionBinding: '1'.repeat(64), securityBinding: '2'.repeat(64) };
const rootActor = { ownerId: 1, sessionBinding: actor.sessionBinding, securityBinding: actor.securityBinding };
const point = (pointId = randomUUID()) => ({ pointId, ownerId: 1, archiveSha256: '3'.repeat(64), manifestSha256: '4'.repeat(64) });
const request = { authMethod: 'session', user: { id: 1, operator: true }, cookies: {}, body: { password: 'discard-body' } } as never;
const credentials = { password: 'fixture-password' };
const complete = (phase = 'reconciliation-complete', reconciliationActive = false) =>
  ({
    phase,
    reconciliationActive,
    reconciledTargetAvailable: phase === 'reconciliation-complete',
  }) as Awaited<ReturnType<typeof callCoreCleanTargetReconciliationRoot>>;
const fixtures: Awaited<ReturnType<typeof createFixture>>[] = [];
async function createFixture(initialize = true) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-reconciliation-'));
  const sourcePoint = point();
  const destinationPoint = point();
  const auth = { operatorActionContext: vi.fn().mockResolvedValue(actor), verifySensitiveAction: vi.fn().mockResolvedValue({}) };
  const timeMachine = { coreInspectionBindingPoint: vi.fn(async (id: string) => (id === sourcePoint.pointId ? sourcePoint : destinationPoint)) };
  const config = { get: () => ({ dataDir: dir }) } as never;
  const preparations = new TimeMachineCorePreparationService(config, auth as never, timeMachine as never);
  const sourceStore = new CoreInspectionStore(dir, 'core-target-preparations');
  const inspectionStore = new CoreInspectionStore(dir, 'core-bootstrap-inspections');
  const sourceRequest = randomUUID();
  const destinationRequest = randomUUID();
  const sourcePreparation = await sourceStore.reserve(sourceRequest, { ...sourcePoint, actor: rootActor });
  await sourceStore.mark(sourceRequest, sourcePreparation, 'requested');
  await sourceStore.mark(sourceRequest, sourcePreparation, 'settled');
  const sourceInspection = await inspectionStore.reserve(sourceRequest, { ...sourcePoint, actor: rootActor });
  const destinationInspection = await inspectionStore.reserve(destinationRequest, { ...destinationPoint, actor: rootActor });
  for (const record of [sourceInspection, destinationInspection]) {
    for (const intent of ['requested', 'approval-requested', 'approval-settled'] as const)
      await inspectionStore.mark(record.requestId, record, intent);
  }
  const input = {
    requestId: randomUUID(),
    sourcePreparationRequestId: sourceRequest,
    destinationPointId: destinationPoint.pointId,
    destinationPreparationRequestId: destinationRequest,
    action: 'prepare-isolated-reconciled-target' as const,
  };
  const service = new TimeMachineCoreReconciliationService(config, auth as never, timeMachine as never, preparations);
  const result = {
    dir,
    config,
    service,
    preparations,
    auth,
    timeMachine,
    sourcePoint,
    destinationPoint,
    sourcePreparation,
    destinationInspection,
    sourceInspection,
    sourceStore,
    inspectionStore,
    input,
  };
  root.mockResolvedValue(complete());
  target.mockResolvedValue({ phase: 'preparation-complete', preparationActive: false, preparedTargetAvailable: true } as never);
  inspect.mockResolvedValue({ phase: 'inspection-complete', bootstrapCatalogAvailable: true } as never);
  if (initialize) {
    await preparations.onModuleInit();
    await service.onModuleInit();
  }
  return result;
}
async function fixture(initialize = true) {
  const result = await createFixture(initialize);
  fixtures.push(result);
  return result;
}
async function idle() {
  await vi.waitFor(() => expect(backupDiskActive()).toBe(false));
}
afterEach(async () => {
  captureRestoreStartupRole('ordinary');
  root.mockResolvedValue(complete());
  for (const f of fixtures.splice(0)) {
    f.auth.operatorActionContext.mockResolvedValue(actor);
    f.timeMachine.coreInspectionBindingPoint.mockImplementation(async (id) => (id === f.sourcePoint.pointId ? f.sourcePoint : f.destinationPoint));
    await f.service.status(f.sourcePoint.pointId, 1, request, f.input.requestId).catch(() => undefined);
    await f.service.onModuleDestroy();
    await f.preparations.onModuleDestroy();
    await fs.rm(f.dir, { recursive: true, force: true });
  }
  setCorePreparationRecoveryRequired(false);
  vi.resetAllMocks();
  expect(backupDiskActive()).toBe(false);
});

it('reauthorizes, binds both saved receipts, returns promptly, and dispatches without retaining credentials', async () => {
  const f = await fixture();
  const started = await f.service.prepare(f.sourcePoint.pointId, 1, request, credentials, f.input);
  expect(started.state).toBe('preparing-reconciliation');
  await idle();
  expect(f.auth.verifySensitiveAction).toHaveBeenCalledExactlyOnceWith(1, 'fixture-password', undefined);
  const stored = await new CoreReconciliationStore(f.dir).get(f.input.requestId);
  expect(stored?.sourceInspection).toEqual(f.sourceInspection);
  expect(stored?.sourcePreparation).toEqual(f.sourcePreparation);
  expect(stored?.destinationInspection).toEqual(f.destinationInspection);
  expect(root).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      action: 'prepare',
      id: started.id,
      sourcePreparationId: f.sourcePreparation.id,
      destinationInspectionId: f.destinationInspection.id,
      actor: rootActor,
    }),
  );
  expect(target).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ action: 'status', id: f.sourcePreparation.id, sourceInspectionId: f.sourceInspection.id }),
  );
  expect(inspect).toHaveBeenCalledTimes(2);
  expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ action: 'status', id: f.sourceInspection.id }));
  expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ action: 'status', id: f.destinationInspection.id }));
  expect(f.auth.operatorActionContext.mock.calls.slice(2).some(([r]) => (r as { body?: unknown }).body)).toBe(false);
  const status = await f.service.status(f.sourcePoint.pointId, 1, request, f.input.requestId);
  expect(status.reconciledTargetAvailable).toBe(true);
  expect(status.destinationEvidence).toBe('saved-capture-only');
  expect(status.activationAuthorized).toBe(false);
  expect(status.restoreSupported).toBe(false);
});

it('never accepts destination substitution or caller-selected job/Root authority', async () => {
  const f = await fixture();
  await f.service.prepare(f.sourcePoint.pointId, 1, request, credentials, f.input);
  await idle();
  const otherPoint = point();
  const other = await f.inspectionStore.reserve(randomUUID(), { ...otherPoint, actor: rootActor });
  for (const intent of ['requested', 'approval-requested'] as const) await f.inspectionStore.mark(other.requestId, other, intent);
  f.timeMachine.coreInspectionBindingPoint.mockImplementation(async (id) =>
    id === otherPoint.pointId ? otherPoint : id === f.sourcePoint.pointId ? f.sourcePoint : f.destinationPoint,
  );
  await expect(
    f.service.prepare(f.sourcePoint.pointId, 1, request, credentials, {
      ...f.input,
      destinationPointId: otherPoint.pointId,
      destinationPreparationRequestId: other.requestId,
    }),
  ).rejects.toThrow();
  root.mockClear();
  const status = await f.service.status(f.sourcePoint.pointId, 1, request, f.input.requestId);
  expect(status.destinationPointId).toBe(f.destinationPoint.pointId);
  expect(root).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ destinationInspectionId: f.destinationInspection.id, action: 'status' }));
});

it.each(['password', 'owner', 'session', 'security', 'source', 'destination'] as const)(
  'rejects %s drift before Root reconciliation dispatch',
  async (drift) => {
    const f = await fixture();
    if (drift === 'password') f.auth.verifySensitiveAction.mockRejectedValue(new Error('wrong password'));
    if (drift === 'owner') f.auth.operatorActionContext.mockResolvedValue({ ...actor, userId: 2 });
    if (drift === 'session' || drift === 'security')
      f.auth.verifySensitiveAction.mockImplementation(async () => {
        f.auth.operatorActionContext.mockResolvedValue({ ...actor, [drift === 'session' ? 'sessionBinding' : 'securityBinding']: '9'.repeat(64) });
        return {};
      });
    if (drift === 'source' || drift === 'destination')
      f.timeMachine.coreInspectionBindingPoint.mockImplementation(async (id) => {
        const value = id === f.sourcePoint.pointId ? f.sourcePoint : f.destinationPoint;
        return id === (drift === 'source' ? f.sourcePoint.pointId : f.destinationPoint.pointId) ? { ...value, archiveSha256: '9'.repeat(64) } : value;
      });
    await expect(f.service.prepare(f.sourcePoint.pointId, 1, request, credentials, f.input)).rejects.toThrow();
    expect(root).not.toHaveBeenCalled();
  },
);

it.each(['source', 'source-catalog', 'destination'])('refuses an incomplete %s without manufacturing inspection/catalog metadata', async (side) => {
  const f = await fixture();
  if (side === 'source') target.mockResolvedValue({ phase: 'checking', preparationActive: false, preparedTargetAvailable: false } as never);
  else
    inspect.mockImplementation(
      async ({ id }) =>
        ({
          phase:
            id === (side === 'source-catalog' ? f.sourceInspection.id : f.destinationInspection.id) ? 'awaiting-approval' : 'inspection-complete',
          bootstrapCatalogAvailable: id !== (side === 'source-catalog' ? f.sourceInspection.id : f.destinationInspection.id),
        }) as never,
    );
  await f.service.prepare(f.sourcePoint.pointId, 1, request, credentials, f.input);
  await idle();
  expect(root).not.toHaveBeenCalled();
  expect((await f.service.status(f.sourcePoint.pointId, 1, request, f.input.requestId)).reconciledTargetAvailable).toBe(false);
  const stored = await new CoreReconciliationStore(f.dir).get(f.input.requestId);
  if (!stored) throw new Error('Missing admitted record');
  expect(await new CoreReconciliationStore(f.dir).marked(stored, 'requested')).toBe(false);
});

it('keeps lost-wait custody and status never replays an already dispatched reconciliation', async () => {
  const f = await fixture();
  root.mockResolvedValueOnce(complete('reconciling', true)).mockRejectedValueOnce(new Error('lost wait'));
  await f.service.prepare(f.sourcePoint.pointId, 1, request, credentials, f.input);
  await vi.waitFor(() => expect(root).toHaveBeenCalledTimes(2));
  await new Promise((resolve) => setImmediate(resolve));
  expect(backupDiskActive()).toBe(true);
  root.mockResolvedValue(complete('reconciliation-blocked'));
  expect((await f.service.status(f.sourcePoint.pointId, 1, request, f.input.requestId)).reconciledTargetAvailable).toBe(false);
  expect(backupDiskActive()).toBe(true);
  root.mockResolvedValue(complete());
  await f.service.prepare(f.sourcePoint.pointId, 1, request, credentials, f.input);
  await idle();
  expect(root.mock.calls.filter(([options]) => options.action === 'prepare')).toHaveLength(1);
});

it('rebuilds a durable hold after restart and observes stored destination only, without replay', async () => {
  const f = await fixture();
  const store = new CoreReconciliationStore(f.dir);
  const record = await store.reserve(f.input.requestId, {
    sourcePreparation: f.sourcePreparation,
    sourceInspection: f.sourceInspection,
    destinationInspection: f.destinationInspection,
  });
  await store.mark(record, 'requested');
  await f.service.onModuleDestroy();
  root.mockResolvedValue(complete('checking'));
  f.service = new TimeMachineCoreReconciliationService(f.config, f.auth as never, f.timeMachine as never, f.preparations);
  await f.service.onModuleInit();
  expect(corePreparationRecoveryHeld()).toBe(true);
  expect(enterBackupMutation()).toBeNull();
  expect(
    root.mock.calls.every(([options]) => options.action === 'status' && options.destinationInspectionId === record.destinationInspection.id),
  ).toBe(true);
  root.mockResolvedValue(complete());
  await f.service.status(f.sourcePoint.pointId, 1, request, f.input.requestId);
  expect(corePreparationRecoveryHeld()).toBe(false);
  expect(await store.marked(record, 'settled')).toBe(true);
});

it('observes a dispatched worker to terminal proof after session revocation', async () => {
  const f = await fixture();
  let finish!: (value: ReturnType<typeof complete>) => void;
  root.mockResolvedValueOnce(complete('reconciling', true)).mockImplementationOnce(
    ({ signal }) =>
      new Promise((resolve, reject) => {
        finish = resolve;
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
  );
  await f.service.prepare(f.sourcePoint.pointId, 1, request, credentials, f.input);
  await vi.waitFor(() => expect(root).toHaveBeenCalledTimes(2));
  f.auth.operatorActionContext.mockRejectedValue(new Error('session revoked'));
  expect(backupDiskActive()).toBe(true);
  finish(complete());
  await idle();
  await expect(f.service.status(f.sourcePoint.pointId, 1, request, f.input.requestId)).rejects.toThrow();
  expect(root.mock.calls.map(([options]) => options.action)).toEqual(['prepare', 'wait']);
});

it('does not let either startup or recovery hold release the other', async () => {
  const f = await fixture(false);
  expect(corePreparationRecoveryHeld()).toBe(true);
  await f.service.onModuleInit();
  expect(corePreparationRecoveryHeld()).toBe(true);
  await f.preparations.onModuleInit();
  expect(corePreparationRecoveryHeld()).toBe(false);
  f.preparations.setReconciliationRecoveryRequired(true);
  await f.preparations.prepareStartup();
  expect(corePreparationRecoveryHeld()).toBe(true);
  f.preparations.setReconciliationRecoveryRequired(false);
  expect(corePreparationRecoveryHeld()).toBe(false);
});

it('keeps reconciliation startup closed when preparation startup finishes first', async () => {
  const f = await fixture(false);
  await f.preparations.onModuleInit();
  expect(corePreparationRecoveryHeld()).toBe(true);
  expect(enterBackupMutation()).toBeNull();
  await f.service.onModuleInit();
  expect(corePreparationRecoveryHeld()).toBe(false);
});

it('finishes the pre-listen recovery check before app startup without waiting for Nest module initialization', async () => {
  const f = await fixture(false);
  await f.preparations.prepareStartup();
  expect(corePreparationRecoveryHeld()).toBe(true);
  expect(enterBackupMutation()).toBeNull();
  const startup = f.service.prepareStartup();
  expect(f.service.prepareStartup()).toBe(startup);
  await startup;
  expect(corePreparationRecoveryHeld()).toBe(false);
  const release = enterBackupMutation();
  expect(release).not.toBeNull();
  release?.();
  await f.service.onModuleInit();
  expect(root).not.toHaveBeenCalled();
});

it('keeps an unsettled Root operation held during the pre-listen recovery check and never dispatches it again', async () => {
  const f = await fixture(false);
  const store = new CoreReconciliationStore(f.dir);
  const record = await store.reserve(f.input.requestId, {
    sourcePreparation: f.sourcePreparation,
    sourceInspection: f.sourceInspection,
    destinationInspection: f.destinationInspection,
  });
  await store.mark(record, 'requested');
  root.mockRejectedValue(new Error('Root status unavailable'));
  await f.preparations.prepareStartup();
  await f.service.prepareStartup();
  expect(corePreparationRecoveryHeld()).toBe(true);
  expect(enterBackupMutation()).toBeNull();
  await f.service.onModuleInit();
  expect(root).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: 'status', id: record.id }));
});

it('fails closed on orphaned durable dispatch rather than replaying or silently forgetting it', async () => {
  const f = await fixture(false);
  const store = new CoreReconciliationStore(f.dir);
  const record = await store.reserve(f.input.requestId, {
    sourcePreparation: f.sourcePreparation,
    sourceInspection: f.sourceInspection,
    destinationInspection: f.destinationInspection,
  });
  await store.mark(record, 'requested');
  await fs.unlink(path.join(store.root, `${record.requestId}.json`));
  await f.preparations.onModuleInit();
  await f.service.onModuleInit();
  expect(corePreparationRecoveryHeld()).toBe(true);
  expect(enterBackupMutation()).toBeNull();
  expect(root).not.toHaveBeenCalled();
});

it('keeps a verifier startup read-only and contacts no Root service', async () => {
  const f = await fixture(false);
  captureRestoreStartupRole('verify');
  await f.preparations.onModuleInit();
  await f.service.onModuleInit();
  expect(corePreparationRecoveryHeld()).toBe(false);
  await expect(fs.stat(path.join(f.dir, 'backups/time-machine/core-target-reconciliations'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(root).not.toHaveBeenCalled();
});
