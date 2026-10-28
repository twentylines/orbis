import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type Dockerode from 'dockerode';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BackupRestoresService } from './backup-restores.service';
import { BackupRestoreJournal } from './backup-restore-journal';
import { backupMaintenanceActive, enterBackupMutation, setBackupRecoveryRequired, setRestoreRecoveryRequired } from '@/common/backup-maintenance';
import { captureRestoreStartupRole } from './backup-restore-startup';

// This service suite uses real journals and maintenance locks; Docker, authentication and reviewed-source handoff are declared boundaries.
const boundary = vi.hoisted(() => ({ handoff: vi.fn(), discard: vi.fn(), bootstrap: vi.fn(), verify: vi.fn() }));
vi.mock('./backup-restore-handoff', () => ({ prepareRestoreHandoff: boundary.handoff, discardUnstartedRestoreHandoff: boundary.discard }));
vi.mock('./backup-restore-bootstrap', async (original) => ({
  ...(await original<typeof import('./backup-restore-bootstrap')>()),
  readRestoreBootstrap: boundary.bootstrap,
}));
vi.mock('./backup-restore-runtime', async (original) => ({
  ...(await original<typeof import('./backup-restore-runtime')>()),
  BackupRestoreDockerRuntime: class {
    verifyWorker = boundary.verify;
  },
}));
let root: string;
let service: BackupRestoresService;
let auth: { verifySensitiveAction: ReturnType<typeof vi.fn> };
let apps: { getApps: ReturnType<typeof vi.fn> };
let tasks: { read: ReturnType<typeof vi.fn> };
let host: { status: ReturnType<typeof vi.fn> };
let runtime: { plan: ReturnType<typeof vi.fn> };
let imports: { claimReviewedSource: ReturnType<typeof vi.fn> };
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
  setBackupRecoveryRequired(false);
  setRestoreRecoveryRequired(false);
  captureRestoreStartupRole('ordinary');
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-restores-service-')));
  auth = { verifySensitiveAction: vi.fn().mockResolvedValue(undefined) };
  apps = { getApps: vi.fn().mockResolvedValue([{ appName: 'fixture', appStoreSlug: 'catalogue', status: 'running' }]) };
  tasks = { read: vi.fn().mockResolvedValue({ tasks: [] }) };
  host = { status: vi.fn().mockResolvedValue({ enrolled: false, available: false, job: null }) };
  runtime = { plan: vi.fn().mockResolvedValue({ containers: [{ id: '4'.repeat(64), project: 'fixture_catalogue' }] }) };
  imports = { claimReviewedSource: vi.fn().mockResolvedValue(undefined) };
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
    State: { Running: false, Restarting: false, Paused: false },
  } as unknown as Dockerode.ContainerInspectInfo;
  docker = {
    getContainer: vi.fn((id: string) => ({
      inspect: vi.fn(async () => (id === workerId ? structuredClone(worker) : structuredClone(controller))),
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
  boundary.bootstrap.mockResolvedValue({ identity: {} });
  boundary.verify.mockResolvedValue(workerId);
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
it('fails closed on an unowned worker or corrupted progress and offers authorized recovery', async () => {
  const value = await journal();
  worker.State.Running = true;
  worker.Config.Labels = {};
  await fs.writeFile(path.join(value.directory, 'worker-status.json'), '{}', { mode: 0o600 });
  expect((await service.status()).job).toMatchObject({ status: 'recovery-required', progressUnavailable: true, canRecover: true });
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
