import { afterEach, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { Test, type TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type Dockerode from 'dockerode';
import { DATA_DIR } from '@/common/constants';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { appSettingsBinding } from '@/modules/apps/app-settings-binding';
import { BackupManager } from '@/modules/backups/backup.manager';
import { DockerService } from '@/modules/docker/docker.service';
import { DOCKERODE } from '@/modules/docker/docker.module';
import { AppEventsQueue, appEventSchema, appEventResultSchema, type AppEvent } from '@/modules/queue/entities/app-events';
import { TasksService } from '@/modules/tasks/tasks.service';
import { createMockApp, createMockAppInfo } from '@/tests/helpers/app-mocks';
import { AsyncMutex } from '@/utils/mutex/async-mutex';
import { APP_ASYNC_MUTEX } from '@/utils/mutex/mutex.module';
import { AppLifecycleService } from './app-lifecycle.service';
import { AppLifecycleCommandFactory } from './app-lifecycle-command.factory';
import { UpdateConfigHandler } from './handlers/update-config.handler';
import { UpdateAppHandler } from './handlers/update-app.handler';
import { AppJobService } from './services/app-job.service';
import { AppValidationService } from './services/app-validation.service';
import { GenerateAppEnvCommand } from './commands/generate-env-command';

const modules: TestingModule[] = [];
afterEach(async () => {
  await Promise.all(modules.splice(0).map((module) => module.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};
const urn = 'fixture:store' as Parameters<AppLifecycleService['updateAppSettings']>[0]['appUrn'];
const form = { VALUE: 'new-value', openPort: false };

async function fixture() {
  let app = createMockApp({
    id: 7,
    appName: 'fixture',
    appStoreSlug: 'store',
    createdAt: 10,
    updatedAt: 20,
    version: 1,
    status: 'running',
    config: { VALUE: 'original' },
  });
  const info = createMockAppInfo({ id: 'fixture', urn, port: 17890, exposable: true });
  const repository = mock<AppsRepository>();
  const jobs = mock<AppJobService>();
  const backups = mock<BackupManager>();
  const files = mock<AppFilesManager>();
  const helpers = mock<AppHelpers>();
  const validation = mock<AppValidationService>();
  const queue = mock<AppEventsQueue>();
  const config = mock<ConfigurationService>();
  const logger = mock<LoggerService>();
  const updates = mock<UpdateAppHandler>();
  const mutex = new AsyncMutex();
  const writes: string[] = [];
  const sent: AppEvent[] = [];
  let beforeWorker = async () => {};
  const tasks = new TasksService(config, logger);
  config.get.calledWith('directories').mockReturnValue({ dataDir: DATA_DIR } as never);
  repository.getAppByUrn.mockImplementation(async () => structuredClone(app));
  repository.updateAppById.mockImplementation(async (_id, patch) => {
    writes.push('legacy-sql');
    app = { ...app, ...patch };
    return structuredClone(app);
  });
  repository.updateSettingsIfCurrent.mockImplementation(async (expected, patch) => {
    expect(mutex.resourceLocks.has(urn)).toBe(true);
    if (appSettingsBinding(app) !== appSettingsBinding(expected)) throw new Error('The application changed before commit.');
    writes.push('sql');
    app = { ...app, ...patch, updatedAt: 21 };
    return structuredClone(app);
  });
  jobs.hasUnsettledJob.mockResolvedValue(false);
  backups.hasPendingRestore.mockResolvedValue(false);
  files.getInstalledAppInfo.mockResolvedValue(info);
  helpers.generateEnvFile.mockImplementation(async () => {
    expect(mutex.resourceLocks.has(urn)).toBe(true);
    writes.push('env');
  });
  vi.spyOn(GenerateAppEnvCommand.prototype as unknown as { ensureAppDir: () => Promise<void> }, 'ensureAppDir').mockImplementation(async () => {
    expect(mutex.resourceLocks.has(urn)).toBe(true);
    writes.push('compose');
  });
  const module = await Test.createTestingModule({
    providers: [
      AppLifecycleService,
      AppLifecycleCommandFactory,
      UpdateConfigHandler,
      { provide: DockerService, useValue: mock<DockerService>() },
      { provide: AppHelpers, useValue: helpers },
    ],
  })
    .useMocker((token) => {
      if (token === APP_ASYNC_MUTEX) return mutex;
      if (token === AppJobService) return jobs;
      if (token === BackupManager) return backups;
      if (token === AppFilesManager) return files;
      if (token === AppHelpers) return helpers;
      if (token === AppValidationService) return validation;
      if (token === AppsRepository) return repository;
      if (token === AppEventsQueue) return queue;
      if (token === ConfigurationService) return config;
      if (token === TasksService) return tasks;
      if (token === LoggerService) return logger;
      if (token === UpdateAppHandler) return updates;
      if (token === DOCKERODE) return mock<Dockerode>();
      return mock();
    })
    .compile();
  modules.push(module);
  const service = module.get(AppLifecycleService);
  queue.publish.mockImplementation((raw) => {
    const event = appEventSchema.assert(JSON.parse(JSON.stringify(raw)));
    sent.push(event);
    return new Promise((resolve, reject) => {
      void Promise.resolve()
        .then(async () => {
          await beforeWorker();
          await service.invokeCommand(event, async (result) => {
            resolve(appEventResultSchema.assert(JSON.parse(JSON.stringify(result))));
          });
        })
        .catch(reject);
    });
  });
  return {
    service,
    repository,
    jobs,
    backups,
    files,
    helpers,
    validation,
    queue,
    mutex,
    writes,
    sent,
    tasks,
    updates,
    getApp: () => structuredClone(app),
    changeApp: (patch: Partial<typeof app>) => {
      app = { ...app, ...patch };
    },
    beforeDelivery: (work: () => Promise<void>) => {
      beforeWorker = work;
    },
    save: (value = form) => service.updateAppSettings({ appUrn: urn, form: value }),
  };
}

it('saves through the real handler, queue worker and command without holding the admission lock while waiting', async () => {
  const f = await fixture();
  const saved = await f.save();
  expect(saved.requestId).toBe(f.sent[0]?.requestId);
  expect(f.sent[0]).toMatchObject({ command: 'generate_env', settingsBinding: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(f.writes).toEqual(['compose', 'env', 'sql']);
  expect(f.repository.updateAppById).not.toHaveBeenCalled();
  expect(f.getApp()).toMatchObject({ config: expect.objectContaining(form), pendingRestart: true, port: 17890, openPort: false });
  expect(f.validation.validateUpdateConfigSettings).toHaveBeenCalledTimes(2);
  expect(f.mutex.resourceLocks.size).toBe(0);
  expect((await f.tasks.read()).tasks[0]).toMatchObject({ id: saved.requestId, status: 'succeeded' });
});

it('refuses settings admission while a live app operation owns the lock', async () => {
  const f = await fixture();
  const release = await f.mutex.acquire(urn);
  try {
    await expect(f.save()).rejects.toThrow('current app operation');
  } finally {
    release();
  }
  expect(f.queue.publish).not.toHaveBeenCalled();
  expect(f.writes).toEqual([]);
});

it.each(['job', 'restore'] as const)('refuses settings admission while a queued or interrupted %s remains', async (kind) => {
  const f = await fixture();
  if (kind === 'job') f.jobs.hasUnsettledJob.mockResolvedValue(true);
  else f.backups.hasPendingRestore.mockResolvedValue(true);
  await expect(f.save()).rejects.toThrow('unfinished app operation');
  expect(f.queue.publish).not.toHaveBeenCalled();
  expect(f.writes).toEqual([]);
  expect(f.mutex.resourceLocks.size).toBe(0);
});

it.each(['updating', 'backing_up', 'restoring'] as const)('does not queue settings for an app in %s state', async (status) => {
  const f = await fixture();
  f.changeApp({ status });
  await expect(f.save()).rejects.toThrow('current app operation');
  expect(f.writes).toEqual([]);
  expect(f.queue.publish).not.toHaveBeenCalled();
});

it.each(['version', 'config', 'id', 'createdAt'] as const)('refuses a queued save after the app %s changes before delivery', async (field) => {
  const f = await fixture();
  f.beforeDelivery(async () => {
    const current = f.getApp();
    f.changeApp(field === 'config' ? { config: { VALUE: 'newer update' } } : { [field]: Number(current[field]) + 1 });
  });
  await expect(f.save()).rejects.toThrow();
  expect(f.writes).toEqual([]);
  expect(f.repository.updateSettingsIfCurrent).not.toHaveBeenCalled();
  expect(f.mutex.resourceLocks.size).toBe(0);
});

it.each(['job', 'restore'] as const)('rechecks pending %s evidence in the worker before any file mutation', async (kind) => {
  const f = await fixture();
  f.beforeDelivery(async () => {
    if (kind === 'job') f.jobs.hasUnsettledJob.mockResolvedValue(true);
    else f.backups.hasPendingRestore.mockResolvedValue(true);
  });
  await expect(f.save()).rejects.toThrow();
  expect(f.writes).toEqual([]);
  expect(f.backups.recoverRestore).not.toHaveBeenCalled();
});

it('does not overwrite a later update after settings completion has reached the worker', async () => {
  const f = await fixture();
  const entered = deferred();
  const proceed = deferred();
  f.helpers.generateEnvFile.mockImplementation(async () => {
    f.writes.push('env');
    entered.resolve();
    await proceed.promise;
  });
  const saving = f.save();
  void saving.catch(() => entered.resolve());
  await entered.promise;
  f.updates.execute.mockImplementation(async () => {
    f.changeApp({ version: 2, config: { VALUE: 'updated app' } });
    return { requestId: randomUUID() };
  });
  const update = f.service.updateApp({ appUrn: urn, performBackup: false });
  await Promise.resolve();
  expect(f.updates.execute).not.toHaveBeenCalled();
  proceed.resolve();
  await Promise.all([saving, update]);
  expect(f.getApp()).toMatchObject({ version: 2, config: { VALUE: 'updated app' } });
  expect(f.writes).toEqual(['compose', 'env', 'sql']);
  expect(f.mutex.resourceLocks.size).toBe(0);
});

it('does not replay an interrupted or unbound historical settings command', async () => {
  const f = await fixture();
  const data = appEventSchema.assert({ command: 'generate_env', requestId: randomUUID(), appUrn: urn, form });
  const reply = vi.fn(async () => {});
  await f.service.invokeCommand(data, reply);
  expect(reply).toHaveBeenCalledWith(expect.objectContaining({ success: false, statePreserved: true }));
  expect(f.writes).toEqual([]);
  await f.service.invokeCommand(data, reply, true);
  expect(f.writes).toEqual([]);
});

it('acknowledges completed redelivery without applying settings again', async () => {
  const f = await fixture();
  await f.save();
  const data = f.sent[0];
  if (!data) throw new Error('No settings command');
  f.changeApp({ version: 2, config: { VALUE: 'later version' } });
  const reply = vi.fn(async () => {});
  await f.service.invokeCommand(data, reply, true);
  expect(reply).toHaveBeenCalledWith(expect.objectContaining({ success: true, alreadyCompleted: true }));
  expect(f.writes).toEqual(['compose', 'env', 'sql']);
  expect(f.getApp()).toMatchObject({ version: 2, config: { VALUE: 'later version' } });
});

it('does not leak a new app lock when validation or SQL saving fails', async () => {
  const f = await fixture();
  f.repository.updateSettingsIfCurrent.mockRejectedValue(new Error('Commit failed'));
  await expect(f.save()).rejects.toThrow();
  expect(f.mutex.resourceLocks.size).toBe(0);
  expect(f.repository.updateAppById).not.toHaveBeenCalled();
});
