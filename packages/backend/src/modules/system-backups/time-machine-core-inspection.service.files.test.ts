import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { backupDiskActive } from '@/common/backup-disk';
import { TimeMachineCoreInspectionService } from './time-machine-core-inspection.service';
import { callCoreLocalInspectionRoot } from './time-machine-core-local-inspection-client';

vi.mock('./time-machine-core-local-inspection-client', () => ({ callCoreLocalInspectionRoot: vi.fn() }));
const rootCall = vi.mocked(callCoreLocalInspectionRoot);
const roots: string[] = [];
const services: TimeMachineCoreInspectionService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.onModuleDestroy()));
  rootCall.mockReset();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const pointId = randomUUID();
const requestId = randomUUID();
const request = {} as never;
const actor = { userId: 1, sessionBinding: '1'.repeat(64), securityBinding: '2'.repeat(64) };
const point = { pointId, ownerId: 1, archiveSha256: '3'.repeat(64), manifestSha256: '4'.repeat(64) };
const response = { phase: 'recovery-required' } as Awaited<ReturnType<typeof callCoreLocalInspectionRoot>>;
async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-inspection-service-'));
  roots.push(dir);
  const auth = { operatorActionContext: vi.fn().mockResolvedValue(actor), verifySensitiveAction: vi.fn().mockResolvedValue({}) };
  const timeMachine = { coreInspectionBindingPoint: vi.fn().mockResolvedValue(point) };
  const service = new TimeMachineCoreInspectionService({ get: () => ({ dataDir: dir }) } as never, auth as never, timeMachine as never);
  services.push(service);
  return { service, auth, timeMachine, dir };
}
function deferred() {
  let resolve!: (value: typeof response) => void;
  const promise = new Promise<typeof response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
it('prepare and pending status use no password, then reload queries Root with the same operation', async () => {
  const { service, auth, timeMachine, dir } = await setup();
  const call = deferred();
  rootCall.mockReturnValueOnce(call.promise);
  const started = await service.prepare(pointId, 1, request, requestId);
  expect(started.state).toBe('preparing');
  expect((await service.status(pointId, 1, request, requestId)).state).toBe('preparing');
  expect(auth.verifySensitiveAction).not.toHaveBeenCalled();
  call.resolve(response);
  await service.onModuleDestroy();
  const reload = new TimeMachineCoreInspectionService({ get: () => ({ dataDir: dir }) } as never, auth as never, timeMachine as never);
  services.push(reload);
  rootCall.mockResolvedValueOnce(response);
  const status = await reload.status(pointId, 1, request, requestId);
  expect(status.id).toBe(started.id);
  expect(status.state).toBe('recovery-required');
  expect(rootCall.mock.calls.at(-1)?.[0]).toMatchObject({ action: 'status', id: started.id, pointId, manifestSha256: point.manifestSha256 });
});
it('verifies password once and rejects a changed account before dispatch', async () => {
  const { service, auth } = await setup();
  rootCall.mockResolvedValue(response);
  await service.prepare(pointId, 1, request, requestId);
  await vi.waitFor(() => expect(rootCall).toHaveBeenCalledTimes(1));
  await vi.waitFor(async () => expect((await service.status(pointId, 1, request, requestId)).state).toBe('recovery-required'));
  rootCall.mockClear();
  auth.verifySensitiveAction.mockImplementationOnce(async () => {
    auth.operatorActionContext.mockResolvedValue({ ...actor, securityBinding: '9'.repeat(64) });
  });
  await expect(service.approve(pointId, 1, request, requestId, { password: 'secret' }, {} as never)).rejects.toThrow();
  expect(auth.verifySensitiveAction).toHaveBeenCalledTimes(1);
  expect(rootCall).not.toHaveBeenCalled();
});
it('does not expose a result when account changes while Root is in flight', async () => {
  const { service, auth } = await setup();
  const call = deferred();
  rootCall.mockReturnValueOnce(call.promise);
  await service.prepare(pointId, 1, request, requestId);
  await vi.waitFor(() => expect(rootCall).toHaveBeenCalledTimes(1));
  auth.operatorActionContext.mockResolvedValue({ ...actor, sessionBinding: '9'.repeat(64) });
  call.resolve(response);
  await vi.waitFor(async () => {
    auth.operatorActionContext.mockResolvedValueOnce(actor);
    await expect(service.status(pointId, 1, request, requestId)).rejects.toThrow();
  });
});
it('rejects wrong ownership and request identities', async () => {
  const { service } = await setup();
  await expect(service.prepare(pointId, 2, request, requestId)).rejects.toThrow();
  await expect(service.status(pointId, 1, request, randomUUID())).rejects.toThrow();
});

it('turns a failed Root call into recovery-required without inventing a live state', async () => {
  const { service } = await setup();
  rootCall.mockRejectedValue(new Error('connection lost'));
  await service.prepare(pointId, 1, request, requestId);
  await vi.waitFor(async () => expect((await service.status(pointId, 1, request, requestId)).state).toBe('recovery-required'));
  expect(rootCall.mock.calls.some(([options]) => options.action === 'status')).toBe(true);
  const calls = rootCall.mock.calls.filter(([options]) => options.action === 'prepare').length;
  rootCall.mockResolvedValue({ ...response, phase: 'inspection-authorized', permitSha256: '5'.repeat(64), permitExpiresAt: Date.now() + 300_000 });
  expect((await service.status(pointId, 1, request, requestId)).state).toBe('inspection-authorized');
  expect(rootCall.mock.calls.filter(([options]) => options.action === 'prepare')).toHaveLength(calls);
});

it('authorizes approval once and holds both leases while Root is pending', async () => {
  const { service, auth } = await setup();
  rootCall.mockResolvedValueOnce(response);
  await service.prepare(pointId, 1, request, requestId);
  await vi.waitFor(async () => {
    rootCall.mockResolvedValue(response);
    expect((await service.status(pointId, 1, request, requestId)).state).toBe('recovery-required');
  });
  const call = deferred();
  rootCall.mockReturnValueOnce(call.promise);
  const credentials = { password: 'secret', totpCode: '123456' };
  const input = { reviewSha256: '3'.repeat(64), approvalNonce: '4'.repeat(64), executionConsent: {} };
  const result = await service.approve(pointId, 1, request, requestId, credentials, input);
  expect(result.state).toBe('authorizing');
  expect(backupDiskActive()).toBe(true);
  expect(auth.verifySensitiveAction).toHaveBeenCalledExactlyOnceWith(1, credentials.password, credentials.totpCode);
  expect((await service.status(pointId, 1, request, requestId)).state).toBe('authorizing');
  call.resolve(response);
  await vi.waitFor(() => expect(backupDiskActive()).toBe(false));
});
