import type { AppUrn } from '@runtipi/common/types';
import { readOrdinaryUpdateResult, retainOrdinaryUpdateResult } from '../../app-lifecycle/update-result';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { freshInstallSql } from '@/tests/helpers/fresh-install-sql';
import { AppsRepository } from '../../apps/apps.repository';
import { ordinaryUpdateResultBinding } from '../../apps/app-update-commit';
import { AppUpdateStage, type AppUpdateStageInput } from '../../docker/app-update-stage';
import { DockerService } from '../../docker/docker.service';
import { requireAppImagePinUpdate } from '../../docker/app-image-pins';
import { appUpdateStorage } from '../../docker/app-image-pins';
import { AppLifecycleCommandFactory } from '../../app-lifecycle/app-lifecycle-command.factory';
import { requestInputHash } from '../../app-lifecycle/commands/update-app-command';
import { TasksService } from '../../tasks/tasks.service';
import { Test } from '@nestjs/testing';
import { mock } from 'vitest-mock-extended';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { BackupManager } from '../backup.manager';
import { AppLifecycleService } from '../../app-lifecycle/app-lifecycle.service';
import { DOCKERODE } from '../../docker/docker.module';
import { AsyncMutex } from '@/utils/mutex/async-mutex';
import { APP_ASYNC_MUTEX } from '@/utils/mutex/mutex.module';

let root: string;
let input: AppUpdateStageInput;
let stage: AppUpdateStage | undefined;
let factory: AppLifecycleCommandFactory;
let repository: AppsRepository;
let sql: ReturnType<typeof freshInstallSql>;
let activate: ReturnType<typeof vi.fn>;
let prepare: ReturnType<typeof vi.fn>;
let inspect: ReturnType<typeof vi.fn>;
let values: Record<string, unknown>[];
const oldId = 'a'.repeat(64);
const newId = 'b'.repeat(64);
const oldImage = `sha256:${'1'.repeat(64)}`;
const newImage = `sha256:${'2'.repeat(64)}`;
const event = () => ({ command: 'update' as const, requestId: input.requestId, appUrn: 'demo:store' as AppUrn, form: {}, performBackup: false });

function container(target: boolean) {
  return {
    Id: target ? newId : oldId,
    Image: target ? newImage : oldImage,
    Config: {
      Labels: {
        'com.docker.compose.project': 'demo_store',
        'com.docker.compose.service': 'web',
        'runtipi.managed': 'true',
        'runtipi.appurn': input.appUrn,
        ...(target ? { 'io.orbis.app-update.stage': stage?.id } : {}),
      },
    },
    State: {
      Running: target,
      Paused: false,
      Restarting: false,
      Dead: false,
      Pid: target ? 42 : 0,
      ...(target ? { Health: { Status: 'healthy' } } : {}),
    },
  };
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ut-')));
  const metadata = path.join(root, 'apps/demo');
  const data = path.join(root, 'data');
  await fs.mkdir(metadata, { recursive: true, mode: 0o750 });
  await fs.mkdir(data, { mode: 0o700 });
  await fs.writeFile(path.join(metadata, 'source.json'), 'original', { mode: 0o640 });
  await fs.writeFile(path.join(data, 'app.env'), 'OLD=true', { mode: 0o600 });
  await fs.writeFile(path.join(data, 'accepted-data'), 'app-writes');
  input = {
    directory: path.join(root, 'state/time-machine/image-pins'),
    appUrn: 'demo:store',
    metadata,
    env: path.join(data, 'app.env'),
    requestId: randomUUID(),
  };
  stage = await AppUpdateStage.create(input);
  await fs.mkdir(stage.targetDirectory, { mode: 0o750 });
  await fs.writeFile(path.join(stage.targetDirectory, 'source.json'), 'target', { mode: 0o640 });
  await stage.stageTarget('services: {}', 'NEW=true');
  await stage.recordPulledImages({ activationSha256: 'e'.repeat(64), imageIds: { web: newImage } });
  await stage.recordContext({
    appId: 7,
    appCreatedAt: 123,
    fromVersion: 1,
    toVersion: 2,
    updateStatus: 'running',
    requestInputSha256: requestInputHash({}),
    authoritySha256: 'f'.repeat(64),
    previousLedger: { baselined: true, migrationIds: ['001-current'] },
    targetMigrationIds: ['001-current'],
    originalContainers: [{ id: oldId, imageId: oldImage, service: 'web', running: true, paused: false, restarting: false }],
  });
  await stage.publishTarget();
  await stage.close();
  stage = undefined;
  sql = freshInstallSql();
  Object.assign(sql.row(), { status: 'updating', migrations_baselined: true, pending_restart: false });
  sql.setIds(['001-current']);
  repository = new AppsRepository(sql.database);
  Object.assign(repository, {
    getAppByUrn: async () => ({ id: sql.row().id, createdAt: sql.row().created_at, version: sql.row().version, status: sql.row().status }),
    getMigrationLedger: async () => ({ baselined: sql.row().migrations_baselined, migrationIds: sql.ids() }),
  });
  values = [container(false)];
  inspect = vi.fn((options: { path: string }, callback: (error: unknown, value: unknown) => void) => {
    if (options.path === '/containers/json?')
      callback(
        null,
        values.map(({ Id }) => ({ Id })),
      );
    else {
      const value = values.find(({ Id }) => options.path === `/containers/${Id}/json`);
      callback(value ? null : { statusCode: 404 }, value);
    }
  });
  activate = vi.fn(async () => {
    expect((await stage?.read())?.phase).toBe('activation-attempted');
    values = [container(true)];
  });
  prepare = vi.fn(async () => ({ isCurrent: async () => true, activate, release: async () => {} }));
  const services = new Map<unknown, unknown>([
    [AppsRepository, repository],
    [TasksService, { progress: async () => {} }],
    [
      DockerService,
      {
        reopenStagedAppUpdate: async (_urn: string, requestId: string) => {
          stage = await AppUpdateStage.open({ ...input, requestId });
          return { transaction: stage, retained: false };
        },
        prepareResumedAppUpdate: prepare,
        readCompletedOrdinaryAppUpdate: async (urn: AppUrn, requestId: string) => {
          if (await appUpdateStorage.updateGuard(input.directory, urn)) return;
          return readOrdinaryUpdateResult(input.directory, urn, requestId);
        },
      },
    ],
  ]);
  factory = new AppLifecycleCommandFactory(
    { get: (token: unknown) => services.get(token) } as ModuleRef,
    { modem: { dial: inspect } } as unknown as Dockerode,
  );
});
afterEach(async () => {
  await stage?.close();
  stage = undefined;
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
const writes = () => sql.queries.filter((query) => query.startsWith('update'));

it.each([false, true])('joins real factory, saved stage and SQL completion, lost reply=%s', async (lost) => {
  if (lost) sql.behavior('lost-terminal-commit');
  expect(await factory.resumeUpdate(event())).toMatchObject({ success: true, updateStatus: 'running' });
  expect(activate).toHaveBeenCalledOnce();
  expect(writes()).toHaveLength(1);
  expect(sql.receipts()).toHaveLength(1);
  expect(sql.row()).toMatchObject({ version: 2, status: 'running' });
  expect(sql.ids()).toEqual(['001-current']);
  expect(await requireAppImagePinUpdate(input.directory, input.appUrn)).toBeNull();
  expect(await fs.readFile(path.join(path.dirname(input.env), 'accepted-data'), 'utf8')).toBe('app-writes');
});

async function interruptedAfterSql() {
  sql.behavior('lost-terminal-commit');
  const readback = vi.spyOn(repository, 'readCurrentOrdinaryUpdateCommit').mockRejectedValue(new Error('Synthetic core restart'));
  expect((await factory.resumeUpdate(event())).success).toBe(false);
  readback.mockRestore();
  const retained = await AppUpdateStage.open(input);
  expect((await retained.read()).phase).toBe('committing');
  await retained.close();
}

it('uses only a positive current SQL receipt after Core restart; never prepares, starts or writes again', async () => {
  await interruptedAfterSql();
  activate.mockClear();
  prepare.mockClear();
  inspect.mockClear();
  const result = await factory.reconcileUpdate(event());
  expect(result).toMatchObject({ success: true, alreadyCompleted: true });
  expect(activate).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  expect(inspect).not.toHaveBeenCalled();
  expect(writes()).toHaveLength(1);
  expect(await requireAppImagePinUpdate(input.directory, input.appUrn)).toBeNull();
});

it.each(['row', 'ledger', 'receipt', 'pending-restart', 'request', 'form'])(
  'preserves the recovery barrier and app data when interrupted completion has changed %s',
  async (fault) => {
    await interruptedAfterSql();
    if (fault === 'row') sql.row().version = 1;
    if (fault === 'ledger') sql.setIds([]);
    if (fault === 'receipt') sql.receipts().splice(0);
    if (fault === 'pending-restart') sql.row().pending_restart = true;
    const data = event();
    if (fault === 'request') data.requestId = randomUUID();
    if (fault === 'form') Object.assign(data.form, { exposed: true });
    expect(await factory.reconcileUpdate(data)).toBeUndefined();
    expect((await factory.resumeUpdate(data)).success).toBe(false);
    expect(writes()).toHaveLength(1);
    expect(activate).toHaveBeenCalledOnce();
    expect(await requireAppImagePinUpdate(input.directory, input.appUrn, stage?.id)).not.toBeNull();
    expect(await fs.readFile(path.join(path.dirname(input.env), 'accepted-data'), 'utf8')).toBe('app-writes');
  },
);

it('never repeats an uncommitted final write after failed receipt insertion', async () => {
  sql.behavior('receipt-insert-failed');
  expect((await factory.resumeUpdate(event())).success).toBe(false);
  expect(sql.row()).toMatchObject({ version: 1, status: 'updating' });
  expect(sql.receipts()).toEqual([]);
  expect(await factory.reconcileUpdate(event())).toBeUndefined();
  expect((await factory.resumeUpdate(event())).success).toBe(false);
  expect(writes()).toHaveLength(1);
  expect(activate).toHaveBeenCalledOnce();
});

it('reconciles commit-verified cleanup interruption without another terminal SQL write', async () => {
  const unlink = fs.unlink.bind(fs);
  const fault = vi.spyOn(fs, 'unlink').mockImplementation(async (selected) => {
    if (String(selected).startsWith(input.directory) && String(selected).endsWith('.update.json')) throw new Error('Synthetic cleanup interruption');
    return unlink(selected);
  });
  expect((await factory.resumeUpdate(event())).success).toBe(false);
  fault.mockRestore();
  const retained = await AppUpdateStage.open(input);
  expect((await retained.read()).phase).toBe('commit-verified');
  await retained.close();
  expect(await factory.reconcileUpdate(event())).toMatchObject({ success: true, alreadyCompleted: true });
  expect(writes()).toHaveLength(1);
});

it('persists an immutable intent before committing, refusing a changed pending-restart result', async () => {
  stage = await AppUpdateStage.open(input);
  await stage.activationAttempted();
  await stage.recordOrdinaryCommit(true);
  await stage.recordOrdinaryCommit(true);
  await expect(stage.recordOrdinaryCommit(false)).rejects.toThrow();
  const result = await ordinaryUpdateResultBinding(stage);
  await stage.close();
  stage = await AppUpdateStage.open(input);
  expect(await ordinaryUpdateResultBinding(stage)).toEqual(result);
  expect(writes()).toHaveLength(0);
});

it('acknowledges a completed update after its guard and staging are gone, without running it again', async () => {
  expect((await factory.resumeUpdate(event())).success).toBe(true);
  prepare.mockClear();
  activate.mockClear();
  inspect.mockClear();
  expect(await factory.resumeUpdate(event())).toMatchObject({ success: true, alreadyCompleted: true });
  expect(await factory.reconcileUpdate(event())).toMatchObject({ success: true, alreadyCompleted: true });
  expect(writes()).toHaveLength(1);
  expect(prepare).not.toHaveBeenCalled();
  expect(activate).not.toHaveBeenCalled();
  expect(inspect).not.toHaveBeenCalled();
  const result = await readOrdinaryUpdateResult(input.directory, event().appUrn, input.requestId);
  expect(result?.version).toBe(2);
  expect((await fs.stat(path.join(input.directory, 'ordinary-results', `${input.requestId}.json`))).mode & 0o777).toBe(0o600);
  if (!result) throw new Error('Missing saved result');
  await retainOrdinaryUpdateResult(input.directory, result);
  await expect(retainOrdinaryUpdateResult(input.directory, { ...result, proofSha256: '0'.repeat(64) })).rejects.toThrow();
});

it('keeps completed-result custody across interrupted staging removal after the guard was retired', async () => {
  const remove = fs.rm.bind(fs);
  const fault = vi.spyOn(fs, 'rm').mockImplementation(async (selected, options) => {
    if (stage && String(selected) === appUpdateStorage.stagedPaths(input.directory, stage.id).staging)
      throw new Error('Synthetic cleanup interruption');
    return remove(selected, options);
  });
  // The read-only completion path can confirm SQL even when deleting inactive staging was interrupted.
  expect(await factory.resumeUpdate(event())).toMatchObject({ success: true, alreadyCompleted: true });
  fault.mockRestore();
  expect(await requireAppImagePinUpdate(input.directory, input.appUrn)).toBeNull();
  expect(writes()).toHaveLength(1);
  expect(await factory.reconcileUpdate(event())).toMatchObject({ success: true, alreadyCompleted: true });
});

it.each(['mode', 'symlink', 'hardlink', 'form', 'other-app', 'different-row'])(
  'never trusts a completed local intent with changed %s',
  async (fault) => {
    expect((await factory.resumeUpdate(event())).success).toBe(true);
    const selected = path.join(input.directory, 'ordinary-results', `${input.requestId}.json`);
    if (fault === 'mode') await fs.chmod(selected, 0o644);
    if (fault === 'symlink') {
      await fs.rename(selected, selected + '.original');
      await fs.symlink(selected + '.original', selected);
    }
    if (fault === 'hardlink') await fs.link(selected, selected + '.alias');
    if (fault === 'different-row') sql.row().created_at = 124;
    const data = event();
    if (fault === 'form') Object.assign(data.form, { exposed: true });
    if (fault === 'other-app') data.appUrn = 'other:store' as AppUrn;
    expect(await factory.reconcileUpdate(data)).toBeUndefined();
    expect(writes()).toHaveLength(1);
    expect(await fs.readFile(path.join(path.dirname(input.env), 'accepted-data'), 'utf8')).toBe('app-writes');
  },
);

it('settles actual Task Centre queue redelivery after SQL completion without repeating the update', async () => {
  await interruptedAfterSql();
  const config = mock<ConfigurationService>();
  config.get.calledWith('directories').mockReturnValue({ dataDir: root } as never);
  const logger = mock<LoggerService>();
  const beforeRestart = new TasksService(config, logger);
  await beforeRestart.enqueue(event());
  await beforeRestart.start(event());
  const tasks = new TasksService(config, logger);
  const backups = mock<BackupManager>();
  backups.hasPendingRestore.mockResolvedValue(false);
  const module = await Test.createTestingModule({ providers: [AppLifecycleService] })
    .useMocker((token) => {
      if (token === AppLifecycleCommandFactory) return factory;
      if (token === TasksService) return tasks;
      if (token === BackupManager) return backups;
      if (token === AppsRepository) return repository;
      if (token === APP_ASYNC_MUTEX) return new AsyncMutex();
      if (token === DOCKERODE) return {};
      return mock();
    })
    .compile();
  try {
    activate.mockClear();
    prepare.mockClear();
    inspect.mockClear();
    const reply = vi.fn(async () => {});
    await module.get(AppLifecycleService).invokeCommand(event(), reply, true);
    expect(reply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ success: true, alreadyCompleted: true }));
    expect((await tasks.read()).tasks).toMatchObject([{ id: input.requestId, status: 'succeeded' }]);
    expect(writes()).toHaveLength(1);
    expect(activate).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    const saved = await fs.readFile(path.join(root, 'state/orbis-tasks/history.json'), 'utf8');
    await module.get(AppLifecycleService).invokeCommand(event(), reply, true);
    expect(writes()).toHaveLength(1);
    expect(await fs.readFile(path.join(root, 'state/orbis-tasks/history.json'), 'utf8')).toBe(saved);
  } finally {
    await module.close();
  }
});

it('exposes retained completion through the actual Docker service only after positive absence of the app barrier', async () => {
  const config = mock<ConfigurationService>();
  config.get.calledWith('directories').mockReturnValue({ dataDir: root } as never);
  const service = new DockerService(mock(), config, mock(), mock(), mock());
  expect(await service.readCompletedOrdinaryAppUpdate(event().appUrn, input.requestId)).toBeUndefined();
  expect((await factory.resumeUpdate(event())).success).toBe(true);
  expect(await service.readCompletedOrdinaryAppUpdate(event().appUrn, input.requestId)).toMatchObject({ version: 2, requestId: input.requestId });
  const guard = appUpdateStorage.updatePath(input.directory, input.appUrn);
  await fs.writeFile(guard, '{}', { mode: 0o600 });
  await expect(service.readCompletedOrdinaryAppUpdate(event().appUrn, input.requestId)).rejects.toThrow();
});
