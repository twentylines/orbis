import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type Dockerode from 'dockerode';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BackupRestoresService } from './backup-restores.service';
import { BackupRestoreJournal } from './backup-restore-journal';
import { BackupRequirementError } from './backup-files';
import {
  backupMaintenanceActive,
  enterBackupMutation,
  setBackupRecoveryRequired,
  setRestoreRecoveryRequired,
  acquireBackupMaintenance,
} from '@/common/backup-maintenance';
import { executeRestoreWorker } from './backup-restore-worker';
import { BackupDirectorySwap } from './backup-directory-swap';
import { writeTerminalJson } from './backup-restore-terminal-record';
import { captureRestoreStartupRole, waitForRestoreStartup } from './backup-restore-startup';
import * as operationStatus from '@/common/restoration-root-status';
import { TimeMachineStore } from './time-machine-store';
import type { Request } from 'express';

// This service suite uses real journals and maintenance locks; Docker, authentication and reviewed-source handoff are declared boundaries.
const boundary = vi.hoisted(() => ({
  handoff: vi.fn(),
  discard: vi.fn(),
  bootstrap: vi.fn(),
  verify: vi.fn(),
  cleanup: vi.fn(),
  operation: vi.fn(),
  resume: vi.fn(),
  stageRetained: vi.fn(),
  rootReview: vi.fn(),
  rootCreate: vi.fn(),
  rootBegin: vi.fn(),
  rootStatus: vi.fn(),
  rootLaunch: vi.fn(),
  rootBind: vi.fn(),
  rootWorker: vi.fn(),
  rootRead: vi.fn(),
  rootRevoke: vi.fn(),
  admissionRead: vi.fn(),
  receiptRead: vi.fn(),
}));
vi.mock('./time-machine-retained-root-client', () => ({
  reviewRetainedRoot: boundary.rootReview,
  RetainedRootTransaction: { create: boundary.rootCreate, read: boundary.rootRead },
}));
vi.mock('./time-machine-retained-bootstrap', () => ({ bindRetainedJournal: boundary.rootBind, readRetainedBoundRecord: boundary.admissionRead }));
vi.mock('./time-machine-restore-admission', async (original) => ({
  ...(await original<typeof import('./time-machine-restore-admission')>()),
  readRetainedRestoreReceipt: boundary.receiptRead,
}));
vi.mock('./time-machine-retained-context', () => ({ verifyRetainedRootWorker: boundary.rootWorker }));
vi.mock('./time-machine-retained-stage', () => ({ stageRetainedRuntime: boundary.stageRetained }));
vi.mock('./backup-restore-terminal-cleanup', () => ({ cleanupSettledRestoreAuxiliaries: boundary.cleanup }));
vi.mock('./backup-restore-handoff', () => ({ prepareRestoreHandoff: boundary.handoff, discardUnstartedRestoreHandoff: boundary.discard }));
vi.mock('./backup-restore-bootstrap', async (original) => ({
  ...(await original<typeof import('./backup-restore-bootstrap')>()),
  readRestoreBootstrap: boundary.bootstrap,
}));
vi.mock('./backup-restore-runtime', async (original) => ({
  ...(await original<typeof import('./backup-restore-runtime')>()),
  readRestoreOperation: boundary.operation,
  BackupRestoreDockerRuntime: class {
    verifyWorker = boundary.verify;
    resumeOriginal = boundary.resume;
  },
}));
let root: string;
let service: BackupRestoresService;
let auth: { verifySensitiveAction: ReturnType<typeof vi.fn>; operatorActionContext: ReturnType<typeof vi.fn> };
let apps: { getApps: ReturnType<typeof vi.fn> };
let tasks: { read: ReturnType<typeof vi.fn> };
let host: { status: ReturnType<typeof vi.fn> };
let runtime: { plan: ReturnType<typeof vi.fn> };
let imports: { claimReviewedSource: ReturnType<typeof vi.fn>; claimRetainedSource: ReturnType<typeof vi.fn> };
let logger: { warn: ReturnType<typeof vi.fn> };
let docker: { getContainer: ReturnType<typeof vi.fn> };
let controller: Dockerode.ContainerInspectInfo;
let worker: Dockerode.ContainerInspectInfo;
let start: ReturnType<typeof vi.fn>;
let restart: ReturnType<typeof vi.fn>;
const credentials = { password: 'fixture-password', totpCode: '123456' };
const controllerId = '1'.repeat(64);
const workerId = '3'.repeat(64);
async function journal() {
  const value = await BackupRestoreJournal.create(path.join(root, 'backups', 'restores'), {
    id: randomUUID(),
    nonce: randomUUID(),
    originalController: controllerId,
    candidateController: controllerId,
    verifierController: '2'.repeat(64),
    worker: workerId,
    roots: ['state'],
  });
  worker.Config.Labels = { 'io.orbis.restore': value.state.id, 'io.orbis.restore.nonce': value.state.nonce, 'io.orbis.restore.role': 'worker' };
  return value;
}
beforeEach(async () => {
  vi.resetAllMocks();
  vi.spyOn(operationStatus, 'readRootRestorationState').mockResolvedValue('checking');
  setBackupRecoveryRequired(false);
  setRestoreRecoveryRequired(false);
  captureRestoreStartupRole('ordinary');
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-restores-service-')));
  auth = {
    verifySensitiveAction: vi.fn().mockResolvedValue(undefined),
    operatorActionContext: vi.fn().mockResolvedValue({ userId: 7, sessionBinding: 'session', securityBinding: 'security' }),
  };
  apps = { getApps: vi.fn().mockResolvedValue([{ appName: 'fixture', appStoreSlug: 'catalogue', status: 'running' }]) };
  tasks = { read: vi.fn().mockResolvedValue({ tasks: [] }) };
  host = { status: vi.fn().mockResolvedValue({ enrolled: false, available: false, job: null }) };
  runtime = { plan: vi.fn().mockResolvedValue({ containers: [{ id: '4'.repeat(64), project: 'fixture_catalogue' }] }) };
  imports = { claimReviewedSource: vi.fn().mockResolvedValue(undefined), claimRetainedSource: vi.fn() };
  boundary.stageRetained.mockResolvedValue(undefined);
  boundary.rootCreate.mockResolvedValue({ begin: boundary.rootBegin, status: boundary.rootStatus, launch: boundary.rootLaunch });
  boundary.rootRead.mockResolvedValue({ status: boundary.rootStatus, launch: boundary.rootLaunch, revokeAbsent: boundary.rootRevoke });
  boundary.rootRevoke.mockRejectedValue(new Error('needs review'));
  boundary.rootBegin.mockResolvedValue({ state: 'allocated', binding: {} });
  boundary.rootStatus.mockResolvedValue({ state: 'allocated', binding: {} });
  boundary.rootLaunch.mockResolvedValue({ state: 'allocated' });
  boundary.rootBind.mockImplementation(async (options) => {
    await options.rootStatus();
    await options.verifyRootWorker({});
  });
  boundary.rootWorker.mockResolvedValue(undefined);
  logger = { warn: vi.fn() };
  start = vi.fn().mockResolvedValue(undefined);
  restart = vi.fn().mockResolvedValue(undefined);
  controller = {
    Id: controllerId,
    Image: `sha256:${'a'.repeat(64)}`,
    Config: { Env: [], Labels: {} },
    HostConfig: { NetworkMode: 'fixture', RestartPolicy: { Name: 'no' } },
    NetworkSettings: { Networks: {} },
    Mounts: [],
    State: { Running: true },
  } as unknown as Dockerode.ContainerInspectInfo;
  worker = {
    Id: workerId,
    Config: { Labels: {} },
    State: { Running: false, Restarting: false, Paused: false, StartedAt: '0001-01-01T00:00:00Z' },
    RestartCount: 0,
  } as unknown as Dockerode.ContainerInspectInfo;
  docker = {
    getContainer: vi.fn((id: string) => ({
      inspect: vi.fn(async () => {
        if (id === '2'.repeat(64)) throw Object.assign(new Error('absent'), { statusCode: 404 });
        return id === workerId ? structuredClone(worker) : structuredClone(controller);
      }),
      start,
      restart,
    })),
  };
  service = new BackupRestoresService(
    {
      get: (key: string) =>
        key === 'directories'
          ? { dataDir: root, appDataDir: path.join(root, 'app-data') }
          : key === 'database'
            ? { host: 'database', port: 5432, username: 'fixture', password: 'fixture', database: 'original' }
            : { host: 'queue', username: 'fixture', password: 'fixture' },
    } as never,
    auth as never,
    apps as never,
    tasks as never,
    host as never,
    runtime as never,
    imports as never,
    logger as never,
    docker as never,
  );
  boundary.cleanup.mockResolvedValue(undefined);
  boundary.bootstrap.mockResolvedValue({ identity: {} });
  boundary.verify.mockResolvedValue(workerId);
  boundary.operation.mockResolvedValue({});
  boundary.resume.mockResolvedValue(undefined);
  boundary.handoff.mockImplementation(async (options) => {
    const value = await journal();
    await options.claimReviewedSource(value, async () => undefined);
    return { journal: value, identity: {} };
  });
  boundary.discard.mockImplementation(async (_docker, value: BackupRestoreJournal) => value.advance('discarded'));
});
afterEach(async () => {
  service.onModuleDestroy();
  setBackupRecoveryRequired(false);
  setRestoreRecoveryRequired(false);
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
it('requires fresh account verification before reading state or touching Docker', async () => {
  auth.verifySensitiveAction.mockRejectedValue(new Error('authentication refused'));
  await expect(service.prepare(randomUUID(), 7, credentials, 'a'.repeat(64))).rejects.toThrow('authentication refused');
  expect(docker.getContainer).not.toHaveBeenCalled();
  expect(boundary.handoff).not.toHaveBeenCalled();
  expect(backupMaintenanceActive()).toBe(false);
});
it.each(['tasks', 'host-unavailable', 'host-job', 'unstable-app', 'missing-container', 'backup-recovery'] as const)(
  'rejects %s before creating a handoff',
  async (kind) => {
    if (kind === 'tasks') tasks.read.mockResolvedValue({ tasks: [{ status: 'unconfirmed' }] });
    if (kind === 'host-unavailable') host.status.mockResolvedValue({ enrolled: true, available: false });
    if (kind === 'host-job') host.status.mockResolvedValue({ job: { state: 'interrupted' } });
    if (kind === 'unstable-app') apps.getApps.mockResolvedValue([{ status: 'starting' }]);
    if (kind === 'missing-container') runtime.plan.mockResolvedValue({ containers: [] });
    if (kind === 'backup-recovery') setBackupRecoveryRequired(true);
    await expect(service.prepare(randomUUID(), 7, credentials, 'a'.repeat(64))).rejects.toThrow();
    expect(boundary.handoff).not.toHaveBeenCalled();
    setBackupRecoveryRequired(false);
    expect(backupMaintenanceActive()).toBe(false);
  },
);
it('pins the exact reviewed source under maintenance but leaves the worker inert until launch', async () => {
  const importId = randomUUID();
  const result = await service.prepare(importId, 7, credentials, 'a'.repeat(64));
  expect(result.job?.status).toBe('ready');
  expect(start).not.toHaveBeenCalled();
  expect(enterBackupMutation()).toBeNull();
  expect(imports.claimReviewedSource).toHaveBeenCalledWith(importId, 7, credentials, expect.objectContaining({ manifestSha256: 'a'.repeat(64) }));
  expect(boundary.handoff.mock.calls[0]?.[0].apps).toEqual([{ id: '4'.repeat(64), project: 'fixture_catalogue' }]);
  if (!result.job) throw new Error('Missing prepared fixture');
  await Promise.all([service.launch(result.job.id), service.launch(result.job.id)]);
  expect(boundary.verify).toHaveBeenCalledExactlyOnceWith(workerId, { preparing: true });
  expect(start).toHaveBeenCalledTimes(1);
  expect(backupMaintenanceActive()).toBe(true);
});
it('rejects a retained manifest paired with the wrong protected authority version', async () => {
  const pointId = randomUUID();
  const binding = { pointId, reviewId: randomUUID(), archiveSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), machineId: 'c'.repeat(64) };
  for (const [schema, version] of [
    ['orbis.time-machine-runtime.v4', 1],
    ['orbis.time-machine-runtime.v3', 2],
    ['orbis.time-machine-runtime.v6', 2],
    ['orbis.time-machine-runtime.v4', 4],
  ] as const) {
    await expect(
      service.prepareRetained({
        importId: randomUUID(),
        ownerId: 7,
        binding,
        admitted: {
          manifest: { schema, pointId, legacy: { manifestSha256: binding.manifestSha256, cipherSha256: binding.archiveSha256 } },
          controllerAuthority: { metadata: { version } },
        } as never,
        expectedRuntimeManifestSha256: 'd'.repeat(64),
        admit: vi.fn() as never,
      }),
    ).rejects.toThrow();
  }
  expect(boundary.handoff).not.toHaveBeenCalled();
});

it.each([
  [3, 1, false],
  [4, 2, true],
  [6, 4, true],
] as const)('claims v%i runtime with the matching protected authority and proxy policy', async (format, version, preserveLiveProxy) => {
  const pointId = randomUUID();
  const importId = randomUUID();
  const binding = { pointId, reviewId: randomUUID(), archiveSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), machineId: 'c'.repeat(64) };
  const admitted = {
    manifest: {
      schema: `orbis.time-machine-runtime.v${format}`,
      pointId,
      legacy: { manifestSha256: binding.manifestSha256, cipherSha256: binding.archiveSha256 },
    },
    controllerAuthority: { metadata: { version } },
  };
  const permit = {};
  const admit = vi.fn().mockResolvedValue(permit);
  imports.claimRetainedSource.mockImplementation(async (_id, _owner, _binding, _permit, options) =>
    options.prepare({ directory: root }, new AbortController().signal),
  );
  const journal = await service.prepareRetained({
    importId,
    ownerId: 7,
    binding,
    admitted: admitted as never,
    expectedRuntimeManifestSha256: 'd'.repeat(64),
    admit: admit as never,
  });
  expect(boundary.handoff).toHaveBeenCalledWith(expect.objectContaining({ preserveLiveProxy }));
  expect(admit).toHaveBeenCalledExactlyOnceWith(journal);
  expect(imports.claimRetainedSource).toHaveBeenCalledWith(importId, 7, binding, permit, expect.objectContaining({ journal }));
  expect(boundary.stageRetained).toHaveBeenCalledOnce();
  expect(start).not.toHaveBeenCalled();
  expect(backupMaintenanceActive()).toBe(true);
  const pending = Reflect.get(service, 'pending') as { release: () => void };
  pending.release();
  Reflect.set(service, 'pending', undefined);
});

it('reviews, binds and starts only the protected retained transaction after account rechecks', async () => {
  const pointId = randomUUID();
  const importId = randomUUID();
  const binding = { pointId, reviewId: randomUUID(), archiveSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), machineId: 'c'.repeat(64) };
  const publication = { schema: 'fixture-publication' };
  const admitted = {
    manifest: {
      schema: 'orbis.time-machine-runtime.v3',
      pointId,
      legacy: { manifestSha256: binding.manifestSha256, cipherSha256: binding.archiveSha256 },
    },
    controllerAuthority: {
      metadata: {
        version: 1,
        publication,
        platform: { os: 'linux', architecture: 'arm64' },
        archive: {
          creationReference: `sha256:${'1'.repeat(64)}`,
          platformManifestDigest: `sha256:${'2'.repeat(64)}`,
          configDigest: `sha256:${'3'.repeat(64)}`,
        },
      },
    },
  };
  const admit = vi.fn().mockResolvedValue({});
  imports.claimRetainedSource.mockImplementation(async (_id, _owner, _binding, _permit, options) =>
    options.prepare({ directory: root }, new AbortController().signal),
  );
  const journal = await service.prepareRetained({
    importId,
    ownerId: 7,
    binding,
    admitted: admitted as never,
    expectedRuntimeManifestSha256: 'd'.repeat(64),
    admit: admit as never,
  });
  boundary.rootReview.mockResolvedValue({ publication });
  const verifyAccount = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(service, 'retainedStatus').mockResolvedValue({
    job: {
      id: journal.state.id,
      status: 'running',
      phase: 'allocated',
      stage: 'preparing',
      message: 'Preparing',
      needsRecovery: false,
      progressUnavailable: false,
      canCancel: false,
      canRecover: false,
    },
  });
  await expect(
    service.beginRetainedRoot({
      journal,
      importId,
      ownerId: 7,
      binding,
      admitted: admitted as never,
      expectedRuntimeManifestSha256: 'd'.repeat(64),
      verifyAccount,
      signal: new AbortController().signal,
    }),
  ).resolves.toMatchObject({ job: { id: journal.state.id, status: 'running' } });
  expect(verifyAccount).toHaveBeenCalledTimes(3);
  expect(boundary.rootBind).toHaveBeenCalledOnce();
  expect(boundary.rootWorker).toHaveBeenCalledOnce();
  expect(boundary.rootLaunch).toHaveBeenCalledWith('activate', expect.any(AbortSignal));
  expect(start).not.toHaveBeenCalled();
});

it('preserves the journal and maintenance hold if root begin loses its reply', async () => {
  const pointId = randomUUID();
  const importId = randomUUID();
  const binding = { pointId, reviewId: randomUUID(), archiveSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), machineId: 'c'.repeat(64) };
  const publication = { schema: 'fixture-publication' };
  const admitted = {
    manifest: {
      schema: 'orbis.time-machine-runtime.v3',
      pointId,
      legacy: { manifestSha256: binding.manifestSha256, cipherSha256: binding.archiveSha256 },
    },
    controllerAuthority: {
      metadata: {
        version: 1,
        publication,
        platform: { os: 'linux', architecture: 'arm64' },
        archive: {
          creationReference: `sha256:${'1'.repeat(64)}`,
          platformManifestDigest: `sha256:${'2'.repeat(64)}`,
          configDigest: `sha256:${'3'.repeat(64)}`,
        },
      },
    },
  };
  imports.claimRetainedSource.mockImplementation(async (_id, _owner, _binding, _permit, options) =>
    options.prepare({ directory: root }, new AbortController().signal),
  );
  const journal = await service.prepareRetained({
    importId,
    ownerId: 7,
    binding,
    admitted: admitted as never,
    expectedRuntimeManifestSha256: 'd'.repeat(64),
    admit: vi.fn().mockResolvedValue({}) as never,
  });
  boundary.rootReview.mockResolvedValue({ publication });
  boundary.rootBegin.mockRejectedValue(new Error('lost reply'));
  await expect(
    service.beginRetainedRoot({
      journal,
      importId,
      ownerId: 7,
      binding,
      admitted: admitted as never,
      expectedRuntimeManifestSha256: 'd'.repeat(64),
      verifyAccount: vi.fn().mockResolvedValue(undefined),
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('needs review');
  expect(boundary.discard).not.toHaveBeenCalled();
  expect(boundary.rootLaunch).not.toHaveBeenCalled();
  expect(backupMaintenanceActive()).toBe(true);
  const pending = Reflect.get(service, 'pending') as { release: () => void };
  pending.release();
  Reflect.set(service, 'pending', undefined);
});

it('reconciles a lost begin reply only after protected rollback and idle, releasing the held lease', async () => {
  const active = await journal();
  const pointId = randomUUID();
  const release = vi.fn();
  Reflect.set(service, 'pending', { id: active.state.id, release });
  boundary.receiptRead.mockResolvedValue({ ownerId: 7, binding: { pointId } });
  boundary.admissionRead.mockResolvedValue({ sha256: 'd'.repeat(64) });
  boundary.rootStatus.mockResolvedValue({
    pointId,
    state: 'rolled-back',
    decision: 'rollback',
    binding: null,
    recoverable: false,
    admissionSha256: 'd'.repeat(64),
  });
  vi.mocked(operationStatus.readRootRestorationState).mockResolvedValue('checking');
  expect((await service.retainedStatus(active, 7)).job.status).toBe('recovery-required');
  expect((await active.refresh()).phase).toBe('staging');
  expect(release).not.toHaveBeenCalled();
  vi.mocked(operationStatus.readRootRestorationState).mockResolvedValue('idle');
  expect((await service.retainedStatus(active, 7)).job.status).toBe('rolled-back');
  expect((await active.refresh()).phase).toBe('discarded');
  expect(release).toHaveBeenCalledOnce();
  expect(Reflect.get(service, 'pending')).toBeUndefined();
});
it('continues checking a lost begin without requiring a process restart', async () => {
  const active = await journal();
  const status = vi.spyOn(service, 'retainedStatus').mockResolvedValue({
    job: {
      id: active.state.id,
      status: 'rolled-back',
      phase: 'rolled-back',
      stage: 'complete',
      message: 'Recovered',
      needsRecovery: false,
      progressUnavailable: false,
      canCancel: false,
      canRecover: false,
    },
  });
  vi.useFakeTimers();
  try {
    Reflect.get(service, 'watchRetainedTerminal').call(service, active, 7);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(status).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(4000);
    expect(status).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it('starts protected settlement for an already terminal retained journal', async () => {
  const active = await journal();
  await active.discardStaging();
  await fs.writeFile(path.join(active.directory, 'retained-root-request.json'), '{}', { mode: 0o600 });
  boundary.receiptRead.mockResolvedValue({ ownerId: 7 });
  vi.mocked(operationStatus.readRootRestorationState).mockResolvedValue('checking');
  const status = vi.spyOn(service, 'retainedStatus').mockResolvedValue({ job: { id: active.state.id, status: 'recovery-required' } } as never);
  vi.useFakeTimers();
  try {
    await service.startRetainedSettlement();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(boundary.cleanup).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(status).toHaveBeenCalledOnce());
  } finally {
    vi.useRealTimers();
  }
});
it('reports success only after protected root completion and a cleared maintenance marker', async () => {
  const active = await journal();
  const pointId = randomUUID();
  boundary.receiptRead.mockResolvedValue({ ownerId: 7, binding: { pointId } });
  boundary.admissionRead.mockResolvedValue({ sha256: 'd'.repeat(64) });
  boundary.rootStatus.mockResolvedValue({
    pointId,
    state: 'complete',
    binding: null,
    decision: 'commit',
    recoverable: false,
    admissionSha256: 'd'.repeat(64),
  });
  await fs.writeFile(path.join(active.directory, 'retained-root-request.json'), '{}', { mode: 0o600 });
  expect((await service.status()).job).toMatchObject({ status: 'recovery-required', progressUnavailable: true, canRecover: true });
  expect(backupMaintenanceActive()).toBe(true);
  vi.mocked(operationStatus.readRootRestorationState).mockResolvedValue('idle');
  expect((await service.status()).job).toMatchObject({ status: 'succeeded', stage: 'complete' });
  expect(backupMaintenanceActive()).toBe(false);
  boundary.admissionRead.mockResolvedValue({ sha256: 'e'.repeat(64) });
  await expect(service.retainedStatus(active, 7)).rejects.toThrow('needs review');
});

it('routes a retained job through protected recovery rather than the legacy worker', async () => {
  const active = await journal();
  await fs.writeFile(path.join(active.directory, 'retained-root-request.json'), '{}', { mode: 0o600 });
  const pointId = randomUUID();
  const binding = { pointId, reviewId: randomUUID(), archiveSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), machineId: 'c'.repeat(64) };
  boundary.receiptRead.mockResolvedValue({ ownerId: 7, binding });
  boundary.rootStatus.mockResolvedValue({ pointId, state: 'allocating', binding: null, admissionSha256: 'd'.repeat(64), recoverable: true });
  boundary.admissionRead.mockResolvedValue({ sha256: 'd'.repeat(64) });
  vi.spyOn(TimeMachineStore.prototype, 'load').mockResolvedValue({ ownerId: 7 } as never);
  vi.spyOn(TimeMachineStore.prototype, 'metadata').mockResolvedValue({
    archiveSha256: binding.archiveSha256,
    manifestSha256: binding.manifestSha256,
  } as never);
  vi.spyOn(TimeMachineStore.prototype, 'machineIdentity').mockResolvedValue(binding.machineId);
  const request = { authMethod: 'session', user: { id: 7, operator: true } } as Request;
  const result = await service.recover(active.state.id, 7, credentials, request);
  expect(result).toMatchObject({ rootManaged: true, job: { id: active.state.id } });
  expect(boundary.rootLaunch).toHaveBeenCalledExactlyOnceWith('recover', expect.any(AbortSignal));
  expect(start).not.toHaveBeenCalled();
});

it('recovers incomplete root allocation only after the protected admission hash proves the owner receipt', async () => {
  const active = await journal();
  const pointId = randomUUID();
  const binding = { pointId, reviewId: randomUUID(), archiveSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), machineId: 'c'.repeat(64) };
  boundary.receiptRead.mockResolvedValue({ ownerId: 7, binding });
  boundary.rootStatus.mockResolvedValue({ pointId, state: 'allocating', binding: null, admissionSha256: 'd'.repeat(64) });
  boundary.admissionRead.mockResolvedValue({ sha256: 'e'.repeat(64) });
  const verifyAccount = vi.fn().mockResolvedValue(undefined);
  const options = { restoreId: active.state.id, pointId, ownerId: 7, binding, verifyAccount, signal: new AbortController().signal };
  await expect(service.recoverRetainedRoot(options)).rejects.toThrow('needs review');
  expect(boundary.rootLaunch).not.toHaveBeenCalled();
  boundary.admissionRead.mockResolvedValue({ sha256: 'd'.repeat(64) });
  await expect(service.recoverRetainedRoot(options)).resolves.toEqual({ restoreId: active.state.id });
  expect(boundary.rootLaunch).toHaveBeenCalledExactlyOnceWith('recover', expect.any(AbortSignal));
  expect(verifyAccount).toHaveBeenCalledTimes(3);
});

it('cleans an unbegun handoff only after root revokes its exact request and authenticates the admission', async () => {
  const active = await journal();
  const pointId = randomUUID();
  const binding = { pointId, reviewId: randomUUID(), archiveSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), machineId: 'c'.repeat(64) };
  boundary.receiptRead.mockResolvedValue({ ownerId: 7, binding });
  boundary.admissionRead.mockResolvedValue({ sha256: 'd'.repeat(64) });
  boundary.rootStatus.mockRejectedValue(new Error('no accepted transaction'));
  boundary.rootRevoke.mockResolvedValueOnce({ admissionSha256: 'e'.repeat(64) }).mockResolvedValueOnce({ admissionSha256: 'd'.repeat(64) });
  await fs.writeFile(path.join(active.directory, 'retained-root-request.json'), '{}', { mode: 0o600 });
  await fs.mkdir(path.join(active.directory, 'retained'), { mode: 0o700 });
  const options = {
    restoreId: active.state.id,
    pointId,
    ownerId: 7,
    binding,
    verifyAccount: vi.fn().mockResolvedValue(undefined),
    signal: new AbortController().signal,
  };
  await expect(service.recoverRetainedRoot(options)).rejects.toThrow('needs review');
  expect(boundary.discard).not.toHaveBeenCalled();
  await expect(service.recoverRetainedRoot(options)).resolves.toEqual({ restoreId: active.state.id });
  expect(boundary.discard).toHaveBeenCalledOnce();
  expect(boundary.rootLaunch).not.toHaveBeenCalled();
  expect((await active.refresh()).phase).toBe('discarded');
  await expect(fs.lstat(path.join(active.directory, 'retained'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.lstat(path.join(active.directory, 'retained-root-request.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('releases a failed prepare response while preserving a durable recovery hold', async () => {
  vi.spyOn(service, 'status').mockRejectedValueOnce(new Error('status read failed'));
  await expect(service.prepare(randomUUID(), 7, credentials, 'a'.repeat(64))).rejects.toThrow('needs review');
  expect(start).not.toHaveBeenCalled();
  expect(backupMaintenanceActive()).toBe(true);
  setRestoreRecoveryRequired(false);
  const admitted = enterBackupMutation();
  expect(admitted).not.toBeNull();
  admitted?.();
});
it('releases maintenance after a pre-handoff failure without inventing recovery', async () => {
  boundary.handoff.mockRejectedValue(new Error('boundary failed'));
  await expect(service.prepare(randomUUID(), 7, credentials, 'a'.repeat(64))).rejects.toThrow('needs review');
  expect(backupMaintenanceActive()).toBe(false);
});
it('returns a clear 409 for an unverified managed controller before starting restore', async () => {
  const message = 'This installation cannot restore backups because managed Compose controller support could not be verified.';
  boundary.handoff.mockRejectedValue(new BackupRequirementError(message));
  await expect(service.prepare(randomUUID(), 7, credentials, 'a'.repeat(64))).rejects.toMatchObject({ status: 409, message });
  expect(backupMaintenanceActive()).toBe(false);
});
it('blocks simultaneous preparation and recovery during an unfinished handoff', async () => {
  let finish: (() => void) | undefined;
  const reached = new Promise<void>((resolve) =>
    boundary.handoff.mockImplementation(async () => {
      resolve();
      await new Promise<void>((release) => {
        finish = release;
      });
      throw new Error('fixture completed');
    }),
  );
  const pending = service.prepare(randomUUID(), 7, credentials, 'a'.repeat(64));
  const rejection = expect(pending).rejects.toThrow();
  await reached;
  await expect(service.prepare(randomUUID(), 7, credentials, 'a'.repeat(64))).rejects.toThrow('current operation');
  await expect(service.recover(randomUUID(), 7, credentials)).rejects.toThrow('preparation');
  await expect(service.cancel(randomUUID(), 7, credentials)).rejects.toThrow('preparation');
  finish?.();
  await rejection;
});
it('holds startup consumers for an unstarted restore without clearing backup recovery', async () => {
  await journal();
  setBackupRecoveryRequired(true);
  await service.prepareStartup();
  expect(backupMaintenanceActive()).toBe(true);
  setBackupRecoveryRequired(false);
  expect(backupMaintenanceActive()).toBe(true);
});
it('does not hold candidate or verifier startup needed by the transaction', async () => {
  await journal();
  captureRestoreStartupRole('candidate');
  await service.prepareStartup();
  expect(backupMaintenanceActive()).toBe(false);
});
it('keeps progress available without exposing private messages, paths or transaction nonces', async () => {
  const value = await journal();
  worker.State.Running = true;
  await fs.writeFile(
    path.join(value.directory, 'worker-status.json'),
    JSON.stringify({ status: 'running', stage: 'files', message: '/private/location secret-value', updatedAt: Date.now() }),
    { mode: 0o600 },
  );
  const result = await service.status();
  expect(result.job?.status).toBe('running');
  expect(JSON.stringify(result)).not.toMatch(/private\/location|secret-value|nonce|password/);
});
it('fails closed on an unowned worker or corrupted progress without offering an unverified retry', async () => {
  const value = await journal();
  worker.State.Running = true;
  worker.Config.Labels = {};
  await fs.writeFile(path.join(value.directory, 'worker-status.json'), '{}', { mode: 0o600 });
  expect((await service.status()).job).toMatchObject({ status: 'recovery-required', progressUnavailable: true, canRecover: false });
});
it('requires fresh credentials for cancellation and writes only durable cancel intent', async () => {
  const value = await journal();
  await service.prepareStartup();
  await service.cancel(value.state.id, 7, credentials);
  expect(auth.verifySensitiveAction).toHaveBeenCalledWith(7, credentials.password, credentials.totpCode);
  expect(JSON.parse(await fs.readFile(path.join(value.directory, 'cancel.json'), 'utf8'))).toEqual({
    version: 1,
    id: value.state.id,
    nonce: value.state.nonce,
  });
  expect(start).not.toHaveBeenCalled();
});
it('never cancels a committed restore', async () => {
  const value = await journal();
  await fs.writeFile(path.join(value.directory, 'restore.json'), JSON.stringify({ ...value.state, phase: 'committing', decision: 'commit' }), {
    mode: 0o600,
  });
  await expect(service.cancel(value.state.id, 7, credentials)).rejects.toThrow('finishing');
  await expect(fs.stat(path.join(value.directory, 'cancel.json'))).rejects.toHaveProperty('code', 'ENOENT');
});
it('recovers an incomplete inert handoff and retries a failed verified controller restart', async () => {
  const value = await journal();
  await service.prepareStartup();
  boundary.bootstrap.mockRejectedValue(Object.assign(new Error('absent'), { code: 'ENOENT' }));
  expect((await service.recover(value.state.id, 7, credentials)).job?.stage).toBe('restarting');
  restart.mockRejectedValueOnce(new Error('daemon unavailable'));
  await service.launch(value.state.id);
  expect((await service.status()).job).toMatchObject({ status: 'recovery-required', canRecover: true, canCancel: false });
  await service.recover(value.state.id, 7, credentials);
  await service.launch(value.state.id);
  expect(restart).toHaveBeenCalledTimes(2);
  expect(start).not.toHaveBeenCalled();
});
it('does not start a paused or unverifiable worker', async () => {
  const value = await journal();
  worker.State.Paused = true;
  await service.launch(value.state.id);
  expect(start).not.toHaveBeenCalled();
  expect(logger.warn).toHaveBeenCalled();
  worker.State.Paused = false;
  boundary.verify.mockRejectedValue(new Error('identity mismatch'));
  await service.launch(value.state.id);
  expect(start).not.toHaveBeenCalled();
  expect(backupMaintenanceActive()).toBe(true);
});

it('checks terminal auxiliaries before admitting another restore plan and exposes a safe refusal', async () => {
  boundary.cleanup.mockRejectedValueOnce(new Error('terminal cleanup refused'));
  await expect(service.prepare(randomUUID(), 7, credentials, 'a'.repeat(64))).rejects.toThrow('needs review');
  expect(boundary.cleanup).toHaveBeenCalledTimes(1);
  expect(runtime.plan).not.toHaveBeenCalled();
  expect(boundary.handoff).not.toHaveBeenCalled();
});

async function outcome(value: BackupRestoreJournal, status: string) {
  await fs.writeFile(
    path.join(value.directory, 'worker-status.json'),
    JSON.stringify({ status, stage: 'recovering', message: 'private fixture detail', updatedAt: Date.now() }),
    { mode: 0o600 },
  );
}
async function rollback(value: BackupRestoreJournal) {
  await fs.mkdir(path.join(root, 'state'), { mode: 0o700 });
  const swap = await BackupDirectorySwap.create({ id: value.state.id, root: path.join(root, 'state'), journal: value.rootJournal('state') });
  await swap.seal(new AbortController().signal);
  await value.advance('prepared');
  await value.advance('rolling-back');
  await swap.rollback();
  await value.advance('rolled-back');
}
it('retries the exact worker after rollback health failure and waits for its actual recovered outcome', async () => {
  const value = await journal();
  await rollback(value);
  await outcome(value, 'recovery-required');
  expect((await service.status()).job).toMatchObject({ status: 'recovery-required', needsRecovery: true, canRecover: true, stage: 'recovering' });
  expect(backupMaintenanceActive()).toBe(false);
  boundary.resume.mockRejectedValueOnce(new Error('fixture health failure'));
  start.mockImplementation(async () => {
    worker.State.Running = true;
    await outcome(value, 'running');
    try {
      const result = await executeRestoreWorker({
        docker: docker as never,
        journal: value,
        hostname: workerId,
        signal: new AbortController().signal,
        progress: () => undefined,
      });
      await outcome(value, result === 'completed' ? 'succeeded' : 'rolled-back');
    } catch {
      await outcome(value, 'recovery-required');
    } finally {
      worker.State.Running = false;
    }
  });
  await service.recover(value.state.id, 7, credentials);
  await service.launch(value.state.id);
  expect(boundary.resume).toHaveBeenCalledTimes(1);
  expect((await service.status()).job).toMatchObject({ status: 'recovery-required', canRecover: true });
  expect(backupMaintenanceActive()).toBe(true);
  expect(enterBackupMutation()).toBeNull();
  await fs.unlink(path.join(value.directory, 'worker-status.json'));
  expect((await service.status()).job?.status).toBe('recovery-required');
  expect(backupMaintenanceActive()).toBe(true);
  await outcome(value, 'succeeded');
  expect((await service.status()).job?.status).toBe('recovery-required');
  expect(backupMaintenanceActive()).toBe(true);
  await outcome(value, 'recovery-required');
  await service.recover(value.state.id, 7, credentials);
  await service.launch(value.state.id);
  expect(boundary.resume).toHaveBeenCalledTimes(2);
  expect(start).toHaveBeenCalledTimes(2);
  expect(auth.verifySensitiveAction).toHaveBeenCalledTimes(2);
  expect((await service.status()).job).toMatchObject({ status: 'rolled-back', canRecover: false, needsRecovery: false, stage: 'complete' });
  expect(backupMaintenanceActive()).toBe(false);
  const mutation = enterBackupMutation();
  expect(mutation).not.toBeNull();
  mutation?.();
});
it.each(['running', 'missing'] as const)('never declares rollback recovered with a %s worker outcome', async (kind) => {
  const value = await journal();
  await rollback(value);
  if (kind === 'running') {
    await outcome(value, 'running');
    worker.State.Running = true;
  }
  const result = (await service.status()).job;
  expect(result).toMatchObject({ status: kind === 'running' ? 'running' : 'recovery-required', stage: 'recovering' });
  expect(result?.message).not.toContain('was recovered');
  expect(backupMaintenanceActive()).toBe(false);
});
it.each(['rolled-back', 'completed'] as const)('keeps archived %s outcomes complete after legitimate worker cleanup', async (phase) => {
  const value = await journal();
  await fs.writeFile(
    path.join(value.directory, 'restore.json'),
    JSON.stringify({ ...value.state, phase, decision: phase === 'completed' ? 'commit' : 'rollback' }),
    { mode: 0o600 },
  );
  await outcome(value, phase === 'completed' ? 'succeeded' : 'rolled-back');
  await writeTerminalJson(path.join(root, 'backups', 'restores', 'latest-terminal.json'), {
    version: 1,
    id: value.state.id,
    nonce: value.state.nonce,
    phase,
  });
  await fs.unlink(path.join(root, 'backups', 'restores', 'active.json'));
  docker.getContainer.mockImplementation(() => ({
    inspect: async () => {
      throw Object.assign(new Error('removed'), { statusCode: 404 });
    },
  }));
  expect((await service.status()).job).toMatchObject({
    status: phase === 'completed' ? 'succeeded' : 'rolled-back',
    needsRecovery: false,
    canRecover: false,
    stage: 'complete',
  });
});
it('reports a proved inert discarded handoff without claiming recovery or offering a no-op action', async () => {
  const value = await journal();
  await value.advance('discarded');
  expect((await service.status()).job).toMatchObject({
    status: 'rolled-back',
    canRecover: false,
    needsRecovery: false,
    message: 'Restore stopped before server data was changed. The uploaded backup was not applied.',
  });
});
it('does not offer recovery for a settled transaction whose exact worker is unavailable', async () => {
  const value = await journal();
  await rollback(value);
  await outcome(value, 'recovery-required');
  docker.getContainer.mockImplementation((id: string) => ({
    inspect: async () => {
      if (id === workerId) throw Object.assign(new Error('absent'), { statusCode: 404 });
      return controller;
    },
  }));
  expect((await service.status()).job).toMatchObject({ status: 'recovery-required', canRecover: false, needsRecovery: true });
  boundary.verify.mockRejectedValueOnce(new Error('worker missing'));
  await expect(service.recover(value.state.id, 7, credentials)).rejects.toThrow();
  expect(start).not.toHaveBeenCalled();
});

it('requires fresh authentication before any settled recovery inspection or launch', async () => {
  const value = await journal();
  await rollback(value);
  await outcome(value, 'recovery-required');
  auth.verifySensitiveAction.mockRejectedValueOnce(new Error('fresh verification refused'));
  await expect(service.recover(value.state.id, 7, credentials)).rejects.toThrow('fresh verification refused');
  expect(docker.getContainer).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});
it('admits original normal bootstrap while rollback health recovery is still awaiting its worker outcome', async () => {
  const value = await journal();
  await rollback(value);
  await outcome(value, 'recovery-required');
  const onHeld = vi.fn();
  expect(
    await waitForRestoreStartup({ dataDirectory: root, controller: controllerId, installation: { phase: 'normal', transactionId: null }, onHeld }),
  ).toBe('ordinary');
  expect(onHeld).not.toHaveBeenCalled();
  await service.prepareStartup();
  expect(backupMaintenanceActive()).toBe(false);
  expect((await service.status()).job?.status).toBe('recovery-required');
});
it('reports a completed journal without an outcome as review-only rather than offering a no-op retry', async () => {
  const value = await journal();
  await fs.writeFile(path.join(value.directory, 'restore.json'), JSON.stringify({ ...value.state, phase: 'completed', decision: 'commit' }), {
    mode: 0o600,
  });
  expect((await service.status()).job).toMatchObject({ status: 'recovery-required', canRecover: false, needsRecovery: true });
  await expect(service.recover(value.state.id, 7, credentials)).rejects.toThrow('needs review');
  expect(start).not.toHaveBeenCalled();
});

it.each(['backup-recovery', 'active-backup'] as const)('releases only its successful restore recovery hold while preserving %s', async (kind) => {
  const value = await journal();
  await rollback(value);
  await outcome(value, 'recovery-required');
  await service.recover(value.state.id, 7, credentials);
  expect(backupMaintenanceActive()).toBe(true);
  let release: (() => void) | undefined;
  if (kind === 'backup-recovery') setBackupRecoveryRequired(true);
  else release = await acquireBackupMaintenance(new AbortController().signal);
  await outcome(value, 'rolled-back');
  expect((await service.status()).job).toMatchObject({ status: 'rolled-back', needsRecovery: false });
  expect(backupMaintenanceActive()).toBe(true);
  expect(enterBackupMutation()).toBeNull();
  if (kind === 'backup-recovery') setBackupRecoveryRequired(false);
  else release?.();
  expect(backupMaintenanceActive()).toBe(false);
  const mutation = enterBackupMutation();
  expect(mutation).not.toBeNull();
  mutation?.();
});
it('rejects malformed progress before authorizing a terminal retry and retains its prior recovery hold', async () => {
  const value = await journal();
  await rollback(value);
  await outcome(value, 'recovery-required');
  await service.recover(value.state.id, 7, credentials);
  await fs.writeFile(path.join(value.directory, 'worker-status.json'), '{}', { mode: 0o600 });
  expect((await service.status()).job).toMatchObject({ status: 'recovery-required', canRecover: false, progressUnavailable: true });
  await expect(service.recover(value.state.id, 7, credentials)).rejects.toThrow('needs review');
  await service.launch(value.state.id);
  expect(start).not.toHaveBeenCalled();
  expect(backupMaintenanceActive()).toBe(true);
  expect(enterBackupMutation()).toBeNull();
});

it('does not release its recovery hold from another transaction generation’s matching outcome', async () => {
  const value = await journal();
  await rollback(value);
  await outcome(value, 'recovery-required');
  await service.recover(value.state.id, 7, credentials);
  const next = await journal();
  await next.advance('discarded');
  await outcome(next, 'rolled-back');
  expect((await service.status()).job?.id).toBe(next.state.id);
  expect(backupMaintenanceActive()).toBe(true);
  expect(enterBackupMutation()).toBeNull();
});

it('discards an authorized staged restore when protected review fails before BEGIN', async () => {
  const pointId = randomUUID();
  const importId = randomUUID();
  const binding = { pointId, reviewId: randomUUID(), archiveSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), machineId: 'c'.repeat(64) };
  const admitted = {
    manifest: {
      schema: 'orbis.time-machine-runtime.v6',
      pointId,
      legacy: { manifestSha256: binding.manifestSha256, cipherSha256: binding.archiveSha256 },
    },
    controllerAuthority: {
      metadata: {
        version: 4,
        publication: {},
        platform: { os: 'linux', architecture: 'arm64' },
        archive: {
          creationReference: `sha256:${'1'.repeat(64)}`,
          platformManifestDigest: `sha256:${'2'.repeat(64)}`,
          configDigest: `sha256:${'3'.repeat(64)}`,
        },
      },
    },
  };
  imports.claimRetainedSource.mockImplementation(async (_id, _owner, _binding, _permit, options) =>
    options.prepare({ directory: root }, new AbortController().signal),
  );
  const journal = await service.prepareRetained({
    importId,
    ownerId: 7,
    binding,
    admitted: admitted as never,
    expectedRuntimeManifestSha256: 'd'.repeat(64),
    admit: vi.fn().mockResolvedValue({}) as never,
  });
  boundary.rootReview.mockRejectedValue(new Error('Protected review failed'));
  await expect(
    service.beginRetainedRoot({
      journal,
      importId,
      ownerId: 7,
      binding,
      admitted: admitted as never,
      expectedRuntimeManifestSha256: 'd'.repeat(64),
      verifyAccount: vi.fn().mockResolvedValue(undefined),
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow();
  expect(boundary.rootCreate).not.toHaveBeenCalled();
  expect(boundary.rootBegin).not.toHaveBeenCalled();
  expect(boundary.rootLaunch).not.toHaveBeenCalled();
  expect(boundary.discard).toHaveBeenCalledOnce();
  expect(backupMaintenanceActive()).toBe(false);
});

async function reusableJournal(phase: 'rolled-back' | 'completed' = 'rolled-back') {
  const value = await journal();
  await fs.writeFile(
    path.join(value.directory, 'restore.json'),
    JSON.stringify({ ...value.state, phase, decision: phase === 'completed' ? 'commit' : 'rollback' }),
    { mode: 0o600 },
  );
  Reflect.set(service, 'startup', Promise.resolve());
  boundary.bootstrap.mockResolvedValue({ ownerId: 7, source: { manifest: { sha256: 'a'.repeat(64) } } });
  vi.mocked(operationStatus.readRootRestorationState).mockResolvedValue('idle');
  vi.spyOn(operationStatus, 'readRootCoreState').mockResolvedValue('idle');
  vi.spyOn(service, 'status').mockResolvedValue({
    job: {
      id: value.state.id,
      status: phase === 'completed' ? 'succeeded' : 'rolled-back',
      stage: 'complete',
      phase,
      message: 'Settled',
      needsRecovery: false,
      progressUnavailable: false,
      canCancel: false,
      canRecover: false,
    },
  });
  const reuse = vi.fn().mockImplementation(async () => ({ id: randomUUID(), status: 'uploaded' }));
  Reflect.set(imports, 'reuseRestore', reuse);
  return { value, reuse };
}
it.each(['rolled-back', 'completed'] as const)('reuses only the matching owner archive after a genuinely idle %s outcome', async (phase) => {
  const { value, reuse } = await reusableJournal(phase);
  const result = await service.reuse(value.state.id, 7, {} as Request);
  expect(result.status).toBe('uploaded');
  expect(reuse).toHaveBeenCalledWith(expect.objectContaining({ directory: value.directory }), 7, 'a'.repeat(64), expect.any(AbortSignal));
  expect(auth.verifySensitiveAction).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(value.directory, 'restore.json'), 'utf8')).toContain(phase);
});
it.each([
  'owner',
  'session-changed',
  'identity',
  'active-journal',
  'recovery',
  'progress-unavailable',
  'root-checking',
  'core-updating',
  'task',
  'host',
  'wrong-id',
  'retained',
] as const)('rejects saved archive reuse for %s', async (failure) => {
  const { value, reuse } = await reusableJournal();
  if (failure === 'owner') boundary.bootstrap.mockResolvedValue({ ownerId: 8 });
  if (failure === 'session-changed')
    auth.operatorActionContext.mockResolvedValueOnce({ userId: 7, sessionBinding: 'first', securityBinding: 'security' });
  if (failure === 'identity') controller.Id = '9'.repeat(64);
  if (failure === 'active-journal')
    await fs.writeFile(path.join(value.directory, 'restore.json'), JSON.stringify({ ...value.state, phase: 'staging', decision: null }));
  if (failure === 'recovery' || failure === 'progress-unavailable')
    vi.mocked(service.status).mockResolvedValue({
      job: {
        id: value.state.id,
        status: 'rolled-back',
        stage: 'complete',
        phase: 'rolled-back',
        message: 'Settled',
        needsRecovery: failure === 'recovery',
        progressUnavailable: failure === 'progress-unavailable',
        canCancel: false,
        canRecover: false,
      },
    });
  if (failure === 'root-checking') vi.mocked(operationStatus.readRootRestorationState).mockResolvedValue('checking');
  if (failure === 'core-updating') vi.mocked(operationStatus.readRootCoreState).mockResolvedValue('updating');
  if (failure === 'task') tasks.read.mockResolvedValue({ tasks: [{ status: 'running' }] });
  if (failure === 'host') host.status.mockResolvedValue({ enrolled: true, available: false, job: null });
  if (failure === 'retained') await fs.writeFile(path.join(value.directory, 'retained-root-request.json'), '{}');
  await expect(service.reuse(failure === 'wrong-id' ? randomUUID() : value.state.id, 7, {} as Request)).rejects.toThrow();
  expect(reuse).not.toHaveBeenCalled();
});

it('serializes overlapping archive reuse and releases the guard after the first copy', async () => {
  const { value, reuse } = await reusableJournal();
  let complete: (value: unknown) => void = () => undefined;
  reuse.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const first = service.reuse(value.state.id, 7, {} as Request);
  await vi.waitFor(() => expect(reuse).toHaveBeenCalledOnce());
  await expect(service.reuse(value.state.id, 7, {} as Request)).rejects.toThrow();
  complete({ id: randomUUID(), status: 'uploaded' });
  await expect(first).resolves.toHaveProperty('status', 'uploaded');
  await expect(service.reuse(value.state.id, 7, {} as Request)).resolves.toHaveProperty('status', 'uploaded');
  expect(reuse).toHaveBeenCalledTimes(2);
});
