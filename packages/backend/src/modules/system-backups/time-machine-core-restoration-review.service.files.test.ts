import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { TimeMachineCoreReconciliationService } from './time-machine-core-reconciliation.service';
import type { CoreInspectionRecord } from './time-machine-core-inspection.store';
import type { CoreReconciliationRecord } from './time-machine-core-reconciliation.store';
import { callCoreCleanTargetReconciliationRoot } from './time-machine-core-bootstrap-client';
import { callCoreRestorationReviewRoot } from './time-machine-core-restoration-review-client';
vi.mock('@/core/config/configuration.service', () => ({ ConfigurationService: class {} }));
vi.mock('../auth/auth.service', () => ({ AuthService: class {} }));
vi.mock('./time-machine.service', () => ({ TimeMachineService: class {} }));
vi.mock('./time-machine-core-preparation.service', () => ({ TimeMachineCorePreparationService: class {} }));
vi.mock('./backup-restore-startup', () => ({ restoreStartupRole: () => 'ordinary' }));
vi.mock('./time-machine-core-bootstrap-client', () => ({ callCoreCleanTargetReconciliationRoot: vi.fn() }));
vi.mock('./time-machine-core-restoration-review-client', () => ({ callCoreRestorationReviewRoot: vi.fn() }));
const reconciliationRoot = vi.mocked(callCoreCleanTargetReconciliationRoot);
const reviewRoot = vi.mocked(callCoreRestorationReviewRoot);
const actor = { userId: 1, sessionBinding: '1'.repeat(64), securityBinding: '2'.repeat(64) };
const request = { authMethod: 'session', user: { id: 1, operator: true }, cookies: {} } as never;
const rootActor = { ownerId: 1, sessionBinding: actor.sessionBinding, securityBinding: actor.securityBinding };
function fixture() {
  const source: CoreInspectionRecord = {
    version: 2,
    requestId: randomUUID(),
    id: randomUUID(),
    pointId: randomUUID(),
    ownerId: 1,
    archiveSha256: '3'.repeat(64),
    manifestSha256: '4'.repeat(64),
    actor: rootActor,
  };
  const inspection: CoreInspectionRecord = { ...source, id: randomUUID() };
  const destination: CoreInspectionRecord = { ...source, id: randomUUID(), pointId: randomUUID(), requestId: randomUUID() };
  const record: CoreReconciliationRecord = {
    version: 1,
    id: randomUUID(),
    requestId: randomUUID(),
    sourcePreparation: source,
    sourceInspection: inspection,
    destinationInspection: destination,
  };
  const reviewRequestId = randomUUID();
  const mapping = {
    version: 1 as const,
    id: randomUUID(),
    requestId: reviewRequestId,
    reconciliationRequestId: record.requestId,
    reconciliationId: record.id,
    reconciliationSha256: '5'.repeat(64),
  };
  const auth = { operatorActionContext: vi.fn().mockResolvedValue(actor), verifySensitiveAction: vi.fn() };
  const timeMachine = {
    coreInspectionBindingPoint: vi.fn(async (id: string) => {
      const value = id === source.pointId ? source : id === destination.pointId ? destination : undefined;
      if (!value) throw new Error('Unknown fixture point');
      return { pointId: value.pointId, ownerId: value.ownerId, archiveSha256: value.archiveSha256, manifestSha256: value.manifestSha256 };
    }),
  };
  const store = {
    get: vi.fn(async (id: string) => (id === record.requestId ? record : undefined)),
    marked: vi.fn().mockResolvedValue(true),
    mark: vi.fn().mockResolvedValue(undefined),
    review: vi.fn().mockResolvedValue(mapping),
  };
  const sources = { get: vi.fn().mockResolvedValue(source), marked: vi.fn().mockResolvedValue(true) };
  const destinations = {
    get: vi.fn(async (id: string) => (id === inspection.requestId ? inspection : id === destination.requestId ? destination : undefined)),
    marked: vi.fn().mockResolvedValue(true),
  };
  const preparations = { setReconciliationRecoveryRequired: vi.fn() };
  const service = new TimeMachineCoreReconciliationService(
    { get: () => ({ dataDir: '/synthetic-review' }) } as never,
    auth as never,
    timeMachine as never,
    preparations as never,
  );
  Object.assign(service, { store, sources, destinations });
  reconciliationRoot.mockResolvedValue({ phase: 'reconciliation-complete', reconciliationActive: false, reconciledTargetAvailable: true } as never);
  const reviewStatus = {
    version: 1 as const,
    id: mapping.id,
    reconciliationId: record.id,
    phase: 'installation-observed' as const,
    reviewAvailable: true as const,
    scope: 'current-installation-observation-only' as const,
    logicalConsistencyProved: false as const,
    writerQuiescenceProved: false as const,
    activation: false as const,
    environmentProved: false as const,
    restoreAuthority: false as const,
    sourceWrites: false as const,
  };
  reviewRoot.mockResolvedValue(reviewStatus);
  const call = (action: 'review' | 'status' = 'review') =>
    service.restorationReview(source.pointId, 1, request, record.requestId, reviewRequestId, action);
  return { service, call, auth, timeMachine, store, sources, destinations, record, mapping, source, destination, reviewRequestId, reviewStatus };
}
afterEach(() => vi.resetAllMocks());

it('reviews a freshly checked completed reconciliation using only its durable server-generated identity', async () => {
  const f = fixture();
  const result = await f.call();
  expect(reconciliationRoot).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ id: f.record.id, sourcePreparationId: f.source.id, destinationInspectionId: f.destination.id, action: 'status' }),
  );
  expect(f.store.mark).toHaveBeenCalledWith(f.record, 'settled');
  expect(f.store.review).toHaveBeenCalledExactlyOnceWith(f.reviewRequestId, f.record, true);
  expect(reviewRoot).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ id: f.mapping.id, reconciliationId: f.record.id, actor: rootActor, action: 'review' }),
  );
  expect(f.auth.verifySensitiveAction).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    state: 'installation-observed',
    reviewAvailable: true,
    restoreSupported: false,
    activationAuthorized: false,
    logicalConsistencyProved: false,
    writerQuiescenceProved: false,
    destinationEvidence: 'saved-capture-only',
  });
  expect(JSON.stringify(result)).not.toContain(actor.sessionBinding);
  expect(JSON.stringify(result)).not.toContain('reconciliationSha256');
});
it('observes only a stored review and never creates or dispatches from status', async () => {
  const f = fixture();
  await f.call('status');
  expect(f.store.review).toHaveBeenCalledExactlyOnceWith(f.reviewRequestId, f.record, false);
  expect(reconciliationRoot).not.toHaveBeenCalled();
  expect(reviewRoot).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: f.mapping.id, reconciliationId: f.record.id, action: 'status' }));
  expect(f.store.mark).not.toHaveBeenCalled();
});
it('keeps a missing review absent without contacting Root', async () => {
  const f = fixture();
  f.store.review.mockResolvedValue(undefined as never);
  expect(await f.call('status')).toMatchObject({ id: null, state: 'not-reviewed', reviewAvailable: false, activationAuthorized: false });
  expect(reviewRoot).not.toHaveBeenCalled();
  expect(reconciliationRoot).not.toHaveBeenCalled();
});
it.each(['reconciling', 'reconciliation-blocked', 'recovery-required'] as const)('refuses %s before review allocation', async (phase) => {
  const f = fixture();
  reconciliationRoot.mockResolvedValue({ phase, reconciliationActive: phase === 'reconciling', reconciledTargetAvailable: false } as never);
  await expect(f.call()).rejects.toThrow();
  expect(f.store.review).not.toHaveBeenCalled();
  expect(reviewRoot).not.toHaveBeenCalled();
});
it.each(['owner', 'session', 'security', 'source', 'destination', 'marker', 'unrequested'] as const)(
  'refuses %s drift before Root review',
  async (drift) => {
    const f = fixture();
    if (drift === 'owner') f.auth.operatorActionContext.mockResolvedValue({ ...actor, userId: 2 });
    if (drift === 'session' || drift === 'security')
      f.auth.operatorActionContext.mockResolvedValue({ ...actor, [drift === 'session' ? 'sessionBinding' : 'securityBinding']: '9'.repeat(64) });
    if (drift === 'source' || drift === 'destination')
      f.timeMachine.coreInspectionBindingPoint.mockImplementation(async (id: string) => {
        const selected = id === f.source.pointId ? f.source : f.destination;
        return {
          pointId: id,
          ownerId: 1,
          archiveSha256: id === (drift === 'source' ? f.source.pointId : f.destination.pointId) ? '9'.repeat(64) : selected.archiveSha256,
          manifestSha256: selected.manifestSha256,
        };
      });
    if (drift === 'marker') f.destinations.marked.mockResolvedValue(false);
    if (drift === 'unrequested') f.store.marked.mockResolvedValue(false);
    await expect(f.call()).rejects.toThrow();
    expect(f.store.review).not.toHaveBeenCalled();
    expect(reviewRoot).not.toHaveBeenCalled();
  },
);
it('checks authorization again after Root returns and does not expose stale review evidence', async () => {
  const f = fixture();
  reviewRoot.mockImplementation(async () => {
    f.auth.operatorActionContext.mockRejectedValue(new Error('revoked'));
    return f.reviewStatus;
  });
  await expect(f.call()).rejects.toThrow('revoked');
});
it('does not turn a missing Root endpoint into a usable review', async () => {
  const f = fixture();
  reviewRoot.mockRejectedValue(new Error('unsupported'));
  await expect(f.call()).rejects.toThrow('unsupported');
});
it('rejects malformed review keys and stopped service before accessing records', async () => {
  const f = fixture();
  await expect(f.service.restorationReview(f.source.pointId, 1, request, f.record.requestId, '../bad', 'review')).rejects.toThrow();
  expect(f.store.get).not.toHaveBeenCalled();
  await f.service.onModuleDestroy();
  await expect(f.call()).rejects.toThrow();
  expect(f.store.get).not.toHaveBeenCalled();
});
