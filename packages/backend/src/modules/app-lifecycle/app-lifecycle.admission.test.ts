import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { BackupManager } from '@/modules/backups/backup.manager';
import { AppEventsQueue, appEventSchema, appEventResultSchema } from '@/modules/queue/entities/app-events';
import { TasksService } from '@/modules/tasks/tasks.service';
import { createMockApp } from '@/tests/helpers/app-mocks';
import { AsyncMutex } from '@/utils/mutex/async-mutex';
import { APP_ASYNC_MUTEX } from '@/utils/mutex/mutex.module';
import { AppLifecycleService } from './app-lifecycle.service';
import { AppLifecycleCommandFactory } from './app-lifecycle-command.factory';
import { StartAppHandler } from './handlers/start-app.handler';
import { StopAppHandler } from './handlers/stop-app.handler';
import { RestartAppHandler } from './handlers/restart-app.handler';
import { ResetAppHandler } from './handlers/reset-app.handler';
import { UninstallAppHandler } from './handlers/uninstall-app.handler';
import { RestoreAppHandler } from './handlers/restore-app.handler';
import { InstallAppHandler } from './handlers/install-app.handler';
import { AppJobService } from './services/app-job.service';
import { StatusManagerService } from './services/status-manager.service';

const urn = 'fixture:store' as Parameters<AppLifecycleService['startApp']>[0]['appUrn'];
const actions = ['start', 'stop', 'restart', 'reset', 'uninstall', 'restore', 'backup', 'update'] as const;
type Action = (typeof actions)[number];
let module: TestingModule;
let service: AppLifecycleService;
let mutex: AsyncMutex;
let jobs: ReturnType<typeof mock<AppJobService>>;
let queue: ReturnType<typeof mock<AppEventsQueue>>;
let tasks: ReturnType<typeof mock<TasksService>>;
let backups: ReturnType<typeof mock<BackupManager>>;
let status: ReturnType<typeof mock<StatusManagerService>>;
let repository: ReturnType<typeof mock<AppsRepository>>;
let factory: ReturnType<typeof mock<AppLifecycleCommandFactory>>;
const execute = vi.fn(async () => ({ success: true, message: 'Complete' }));

const request = (action: Action) => {
  switch (action) {
    case 'start':
      return service.startApp({ appUrn: urn });
    case 'stop':
      return service.stopApp({ appUrn: urn });
    case 'restart':
      return service.restartApp({ appUrn: urn });
    case 'reset':
      return service.resetApp({ appUrn: urn });
    case 'uninstall':
      return service.uninstallApp({ appUrn: urn, removeBackups: true });
    case 'restore':
      return service.restoreApp({ appUrn: urn, filename: 'saved.tar.gz' });
    case 'backup':
      return service.backupApp({ appUrn: urn });
    case 'update':
      return service.updateApp({ appUrn: urn, performBackup: false });
  }
};

beforeEach(async () => {
  mutex = new AsyncMutex();
  jobs = mock<AppJobService>();
  queue = mock<AppEventsQueue>();
  queue.publish.mockResolvedValue({ success: true, message: 'Complete' });
  tasks = mock<TasksService>();
  backups = mock<BackupManager>();
  status = mock<StatusManagerService>();
  repository = mock<AppsRepository>();
  factory = mock<AppLifecycleCommandFactory>();
  execute.mockClear();
  jobs.hasUnsettledJob.mockResolvedValue(false);
  tasks.read.mockResolvedValue({ tasks: [] } as never);
  repository.getAppByUrn.mockResolvedValue(createMockApp({ id: 7, status: 'running', config: { VALUE: 'keep' } }));
  factory.createCommand.mockReturnValue({ execute } as never);
  module = await Test.createTestingModule({
    providers: [AppLifecycleService, StartAppHandler, StopAppHandler, RestartAppHandler, ResetAppHandler, UninstallAppHandler, RestoreAppHandler],
  })
    .useMocker((token) => {
      if (token === APP_ASYNC_MUTEX) return mutex;
      if (token === AppJobService) return jobs;
      if (token === AppEventsQueue) return queue;
      if (token === TasksService) return tasks;
      if (token === BackupManager) return backups;
      if (token === StatusManagerService) return status;
      if (token === AppsRepository) return repository;
      if (token === AppLifecycleCommandFactory) return factory;
      return mock();
    })
    .compile();
  service = module.get(AppLifecycleService);
});
afterEach(async () => {
  await module.close();
});

it.each(actions)('refuses %s admission before changing status while a durable operation is unfinished', async (action) => {
  jobs.hasUnsettledJob.mockResolvedValue(true);
  await expect(request(action)).rejects.toThrow('unfinished app operation');
  expect(queue.publish).not.toHaveBeenCalled();
  expect(status.transitionTo).not.toHaveBeenCalled();
  expect(repository.updateAppById).not.toHaveBeenCalled();
  expect(mutex.resourceLocks.size).toBe(0);
});

it('checks the operation record again after acquiring the admission lock', async () => {
  jobs.hasUnsettledJob.mockResolvedValueOnce(false).mockResolvedValue(true);
  await expect(request('uninstall')).rejects.toThrow('unfinished app operation');
  expect(queue.publish).not.toHaveBeenCalled();
  expect(mutex.resourceLocks.size).toBe(0);
});

it('preserves install-recovery stop and uninstall when no app job remains', async () => {
  module.get(InstallAppHandler).requireNoInstallHold = vi.fn(async () => {
    throw new Error('Held install');
  });
  queue.publish.mockResolvedValue({ success: true, message: 'Complete' });
  await request('stop');
  await request('uninstall');
  expect(queue.publish).toHaveBeenCalledTimes(2);
  expect(module.get(InstallAppHandler).requireNoInstallHold).not.toHaveBeenCalled();
});

it.each(['start', 'stop', 'restart', 'reset', 'uninstall', 'restore', 'backup', 'update', 'install'] as const)(
  'refuses a delayed legacy %s message before restore recovery or command execution',
  async (command) => {
    jobs.hasUnsettledJob.mockResolvedValue(true);
    const event = appEventSchema.assert({ command, appUrn: urn, requestId: randomUUID(), form: {}, filename: 'saved.tar.gz' });
    const reply = vi.fn(async (_result: unknown) => {});
    await service.invokeCommand(event, reply);
    expect(appEventResultSchema.assert(reply.mock.calls[0]?.[0])).toMatchObject({ success: false, operationBlocked: true, statePreserved: true });
    expect(factory.createCommand).not.toHaveBeenCalled();
    expect(backups.recoverRestore).not.toHaveBeenCalled();
    expect(tasks.start).not.toHaveBeenCalled();
    expect(tasks.finish).not.toHaveBeenCalled();
    expect(mutex.resourceLocks.size).toBe(0);
  },
);

it.each(['start', 'stop', 'restart', 'reset', 'uninstall', 'restore'] as const)(
  'does not overwrite the newer job status from a blocked %s response',
  async (action) => {
    queue.publish.mockImplementation((raw) => {
      jobs.hasUnsettledJob.mockResolvedValue(true); // Another admitted operation precedes delayed delivery.
      const event = appEventSchema.assert(raw);
      return new Promise((resolve, reject) => {
        void service.invokeCommand(event, async (result) => resolve(appEventResultSchema.assert(result))).catch(reject);
      });
    });
    await request(action);
    await vi.waitFor(() => expect(status.emitEvent).toHaveBeenCalledWith(expect.objectContaining({ event: action + '_error' })));
    expect(status.emitError).not.toHaveBeenCalled();
    expect(status.emitSuccess).not.toHaveBeenCalled();
    expect(status.deleteApp).not.toHaveBeenCalled();
    expect(repository.updateAppById).not.toHaveBeenCalled();
    expect(factory.createCommand).not.toHaveBeenCalled();
    expect(queue.publish).toHaveBeenCalledOnce();
  },
);

it.each(['before-lock', 'under-lock'] as const)('does not mutate an app when the operation record is unavailable %s', async (phase) => {
  if (phase === 'before-lock') jobs.hasUnsettledJob.mockRejectedValue(new Error('Unavailable record'));
  else jobs.hasUnsettledJob.mockResolvedValueOnce(false).mockRejectedValue(new Error('Unavailable record'));
  await expect(request('uninstall')).rejects.toThrow('Unavailable record');
  expect(status.transitionTo).not.toHaveBeenCalled();
  expect(queue.publish).not.toHaveBeenCalled();
  expect(mutex.resourceLocks.size).toBe(0);
});

it.each(['record', 'history'] as const)('keeps the blocked response safe when the %s is unavailable', async (failure) => {
  if (failure === 'record') jobs.hasUnsettledJob.mockRejectedValue(new Error('Unavailable record'));
  else {
    jobs.hasUnsettledJob.mockResolvedValue(true);
    tasks.read.mockRejectedValue(new Error('Unavailable history'));
  }
  const event = appEventSchema.assert({ command: 'uninstall', appUrn: urn, requestId: randomUUID(), form: {}, removeBackups: true });
  const reply = vi.fn(async (_result: unknown) => {});
  await service.invokeCommand(event, reply);
  expect(reply.mock.calls[0]?.[0]).toMatchObject({ success: false, operationBlocked: true, statePreserved: true });
  expect(factory.createCommand).not.toHaveBeenCalled();
  expect(backups.recoverRestore).not.toHaveBeenCalled();
  expect(mutex.resourceLocks.size).toBe(0);
});

it.each(['queued', 'running', 'succeeded', 'failed', 'interrupted'] as const)(
  'preserves the recorded %s history when another job blocks a duplicate action',
  async (recorded) => {
    jobs.hasUnsettledJob.mockResolvedValue(true);
    const event = appEventSchema.assert({ command: 'uninstall', appUrn: urn, requestId: randomUUID(), form: {}, removeBackups: true });
    tasks.read.mockResolvedValue({
      tasks: [
        { id: event.requestId, appUrn: urn, action: 'uninstall', status: recorded, startedAt: recorded === 'queued' ? null : '2026-11-23T00:00:00Z' },
      ],
    } as never);
    const reply = vi.fn(async (_result: unknown) => {});
    await service.invokeCommand(event, reply);
    expect(reply.mock.calls[0]?.[0]).toMatchObject({ success: false, operationBlocked: true });
    if (recorded === 'queued') expect(tasks.finish).toHaveBeenCalledExactlyOnceWith(event, false);
    else expect(tasks.finish).not.toHaveBeenCalled();
    expect(factory.createCommand).not.toHaveBeenCalled();
  },
);
