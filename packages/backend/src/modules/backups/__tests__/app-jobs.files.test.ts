import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type Dockerode from 'dockerode';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { TasksService } from '@/modules/tasks/tasks.service';
import { appEventSchema } from '@/modules/queue/entities/app-events';
import { AppJobService, type JobEvent } from '@/modules/app-lifecycle/services/app-job.service';
import { AppJobStore } from '@/modules/app-lifecycle/services/app-job.store';
import { createMockApp } from '@/tests/helpers/app-mocks';
import { ArchiveService } from '@/core/archive/archive.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { BackupManager } from '@/modules/backups/backup.manager';
import * as stableCopy from '../stable-backup-copy';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { AppStatusSyncService } from '@/modules/app-lifecycle/app-status-sync.service';
import { SystemEventsQueue } from '@/modules/queue/entities/system-events';
import { AppLifecycleCommandFactory } from '@/modules/app-lifecycle/app-lifecycle-command.factory';
import { BackupAppHandler } from '@/modules/app-lifecycle/handlers/backup-app.handler';
import { StartAppHandler } from '@/modules/app-lifecycle/handlers/start-app.handler';
import { StatusManagerService } from '@/modules/app-lifecycle/services/status-manager.service';
import { AppEventsQueue, appEventResultSchema } from '@/modules/queue/entities/app-events';
import { DockerService } from '@/modules/docker/docker.service';
import { DOCKERODE } from '@/modules/docker/docker.module';
import { APP_ASYNC_MUTEX } from '@/utils/mutex/mutex.module';
import { AsyncMutex } from '@/utils/mutex/async-mutex';
import { SSEService } from '@/core/sse/sse.service';
import { spawnAsync } from '@/common/helpers/exec-helpers';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppLifecycleController } from '@/modules/app-lifecycle/app-lifecycle.controller';
import { InstallRecoveryReviewService } from '@/modules/app-lifecycle/services/install-recovery-review.service';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';

let directory: string;
let app: ReturnType<typeof createMockApp>;
let repository: ReturnType<typeof mock<AppsRepository>>;
let config: ReturnType<typeof mock<ConfigurationService>>;
let tasks: TasksService;
let jobs: AppJobService;
const modules: TestingModule[] = [];
const urn = 'demo:store' as JobEvent['appUrn'];
const event = (command: 'backup' | 'update' = 'update'): JobEvent =>
  appEventSchema.assert({
    command,
    appUrn: urn,
    form: { VALUE: 'original' },
    requestId: randomUUID(),
    jobVersion: 1,
    ...(command === 'update' ? { performBackup: false } : {}),
  }) as JobEvent;
const admit = async (data: JobEvent) => {
  await jobs.admit(data, app);
  app = { ...app, status: data.command === 'backup' ? 'backing_up' : 'updating' };
};
const begin = async (data: JobEvent) => {
  const value = await jobs.begin(data, false);
  expect(value.context).toBeDefined();
  await tasks.start(data);
  if (!value.context) throw new Error('Missing worker context');
  return value.context;
};

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'jobs-'));
  app = createMockApp({ id: 7, createdAt: 123, appName: 'demo', appStoreSlug: 'store', version: 1, status: 'running' });
  repository = mock<AppsRepository>();
  repository.getAppByUrn.mockImplementation(async () => app);
  config = mock<ConfigurationService>();
  config.get.calledWith('directories').mockReturnValue({ dataDir: directory } as never);
  tasks = new TasksService(config, mock<LoggerService>());
  jobs = new AppJobService(config, repository, tasks);
});
afterEach(async () => {
  await Promise.all(modules.splice(0).map((module) => module.close()));
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

it('requires authenticated same-origin cancellation of the exact admitted request through the HTTP controller', async () => {
  const data = event('backup');
  await admit(data);
  const module = await Test.createTestingModule({
    controllers: [AppLifecycleController],
    providers: [
      { provide: AppLifecycleService, useValue: mock<AppLifecycleService>() },
      { provide: InstallRecoveryReviewService, useValue: mock<InstallRecoveryReviewService>() },
      { provide: AppJobService, useValue: jobs },
      { provide: LoggerService, useValue: mock<LoggerService>() },
    ],
  }).compile();
  const server = module.createNestApplication();
  server.use((req: Request, _res: Response, next: NextFunction) => {
    if (req.header('x-fixture-session')) {
      req.authMethod = 'session';
      req.user = { id: 7, operator: true } as Request['user'];
    }
    next();
  });
  await server.init();
  try {
    const api = request(server.getHttpServer());
    const base = `/app-lifecycle/${encodeURIComponent(urn)}`;
    const url = `${base}/jobs/${data.requestId}/cancel`;
    const current = await new AppJobStore(directory).read(data.requestId);
    await api.get(`${base}/job`).expect(401);
    await api.post(url).expect(401);
    await api.post(url).set('x-fixture-session', '1').expect(403);
    await api.post(url).set('x-fixture-session', '1').set('Host', 'orbis.test').set('Origin', 'http://other.test').expect(403);
    await api.get(`${base}/job?requestId=invalid`).set('x-fixture-session', '1').expect(400);
    await api
      .post(`${base}/jobs/invalid/cancel`)
      .set('x-fixture-session', '1')
      .set('Host', 'orbis.test')
      .set('Origin', 'http://orbis.test')
      .expect(400);
    await api
      .post(`${base}/jobs/${randomUUID()}/cancel`)
      .set('x-fixture-session', '1')
      .set('Host', 'orbis.test')
      .set('Origin', 'http://orbis.test')
      .expect(409);
    const view = await api.get(`${base}/job`).set('x-fixture-session', '1').expect(200).expect('Cache-Control', 'private, no-store');
    expect(view.body.job).toMatchObject({ requestId: data.requestId, status: 'queued', cancellable: true });
    expect(await new AppJobStore(directory).read(data.requestId)).toEqual(current);
    const result = await api
      .post(url)
      .set('x-fixture-session', '1')
      .set('Host', 'orbis.test')
      .set('Origin', 'http://orbis.test')
      .expect(201)
      .expect('Cache-Control', 'private, no-store');
    expect(result.body.job).toMatchObject({ requestId: data.requestId, status: 'cancelling', cancellable: false });
    expect((await jobs.begin(data, false)).result).toMatchObject({ cancelled: true, statePreserved: true });
  } finally {
    await server.close();
  }
});

async function backupWorker() {
  const logger = mock<LoggerService>();
  const filesystem = new FilesystemService(logger);
  const safe = filesystem.getSafeFilePath.bind(filesystem);
  vi.spyOn(filesystem, 'getSafeFilePath').mockImplementation((value) =>
    path.resolve(value).startsWith(directory + path.sep) ? path.resolve(value) : safe(value),
  );
  vi.spyOn(filesystem, 'createTempDirectory').mockImplementation((prefix) => fs.mkdtemp(path.join(directory, path.basename(prefix))));
  config.get.calledWith('userSettings').mockReturnValue({ maxBackups: 20 } as never);
  repository.getMigrationLedger.mockResolvedValue({ baselined: true, migrationIds: ['001-schema'] });
  repository.updateAppById.mockImplementation(async (_id, update) => {
    app = { ...app, ...update };
    return app;
  });
  const data = path.join(directory, 'app-data/store/demo');
  const metadata = path.join(directory, 'apps/store/demo');
  for (const name of [data, metadata]) await fs.mkdir(name, { recursive: true });
  await fs.writeFile(path.join(data, 'record'), 'original');
  await fs.writeFile(path.join(metadata, 'docker-compose.yml'), 'services: {}');
  const files = mock<AppFilesManager>();
  files.getAppPaths.mockReturnValue({ appDataDir: data, appInstalledDir: metadata } as never);
  const archive = new ArchiveService(logger);
  const backups = new BackupManager(archive, logger, config, filesystem, files, repository);
  const state = { Running: true, Paused: false, Restarting: false };
  const start = vi.fn(async () => {
    state.Running = true;
  });
  const container = { id: 'original', inspect: async () => ({ State: { ...state } }), start };
  const engine = { listContainers: async () => [{ Id: 'original' }], getContainer: () => container };
  const docker = mock<DockerService>();
  docker.composeApp.mockImplementation(async () => {
    state.Running = false;
    return { stdout: '', stderr: '', success: true };
  });
  const queue = mock<AppEventsQueue>();
  const status = new StatusManagerService(repository, mock<SSEService>(), logger);
  const module = await Test.createTestingModule({
    providers: [
      AppLifecycleService,
      AppLifecycleCommandFactory,
      { provide: AppJobService, useValue: jobs },
      { provide: ConfigurationService, useValue: config },
      { provide: TasksService, useValue: tasks },
      { provide: AppsRepository, useValue: repository },
      { provide: BackupManager, useValue: backups },
      { provide: LoggerService, useValue: logger },
      { provide: DockerService, useValue: docker },
      { provide: DOCKERODE, useValue: engine },
      { provide: AppEventsQueue, useValue: queue },
      { provide: APP_ASYNC_MUTEX, useValue: new AsyncMutex() },
    ],
  })
    .useMocker(() => mock())
    .compile();
  modules.push(module);
  const service = module.get(AppLifecycleService);
  let running: Promise<void> | undefined;
  queue.publish.mockImplementation(
    (request) =>
      new Promise((resolve, reject) => {
        running = service.invokeCommand(appEventSchema.assert(request), async (result) => {
          resolve(appEventResultSchema.assert(JSON.parse(JSON.stringify(result))));
        });
        void running.catch(reject);
      }),
  );
  const handler = new BackupAppHandler(repository, queue, status, mock<StartAppHandler>(), config, jobs);
  return {
    handler,
    queue,
    service,
    state,
    start,
    archive,
    filesystem,
    data,
    docker,
    backups,
    completion: () => {
      if (!running) throw new Error('No queued worker');
      return running;
    },
  };
}

it('cancels through the actual admission, worker, command, snapshot and Task Centre paths during compression', async () => {
  const f = await backupWorker();
  let entered!: () => void;
  const compressing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.spyOn(f.archive, 'createTarGz').mockImplementation(async (_source, _target, signal) => {
    expect(f.state.Running).toBe(true);
    if (!signal) throw new Error('Missing real worker cancellation signal');
    entered();
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    signal.throwIfAborted();
    throw new Error('Expected cancellation');
  });
  const request = await f.handler.execute(urn);
  await compressing;
  await jobs.cancel(urn, request.requestId);
  await f.completion();
  await vi.waitFor(() => expect(app.status).toBe('running'));
  expect(f.start).toHaveBeenCalledOnce();
  expect(f.docker.composeApp).toHaveBeenCalledOnce();
  expect((await tasks.read()).tasks[0]).toMatchObject({ id: request.requestId, status: 'cancelled', cancellable: false });
  expect(await f.backups.listBackupsByAppId(urn)).toHaveLength(0);
  expect(await fs.readFile(path.join(f.data, 'record'), 'utf8')).toBe('original');
  expect((await fs.readdir(directory)).some((name) => name.startsWith(`${urn}-`))).toBe(false);
});

it('does not execute a delayed queued backup after its request was cancelled', async () => {
  const f = await backupWorker();
  let delivery: JobEvent | undefined;
  let settle!: (result: typeof appEventResultSchema.infer) => void;
  f.queue.publish.mockImplementation(
    (value) =>
      new Promise((resolve) => {
        delivery = appEventSchema.assert(value) as JobEvent;
        settle = resolve;
      }),
  );
  const request = await f.handler.execute(urn);
  await jobs.cancel(urn, request.requestId);
  if (!delivery) throw new Error('No queued delivery');
  await f.service.invokeCommand(
    delivery,
    async (value) => {
      settle(value);
    },
    true,
  );
  await vi.waitFor(() => expect(app.status).toBe('running'));
  expect(f.docker.composeApp).not.toHaveBeenCalled();
  expect(f.start).not.toHaveBeenCalled();
  expect((await tasks.read()).tasks[0]?.status).toBe('cancelled');
  await f.service.invokeCommand(
    delivery,
    async (value) => {
      expect(value.cancelled).toBe(true);
    },
    true,
  );
  expect(f.docker.composeApp).not.toHaveBeenCalled();
});

it('cancels during copy and confirms the original app resumes before reporting cancellation', async () => {
  const f = await backupWorker();
  const copy = stableCopy.copyStableBackupTree;
  let entered!: () => void;
  let release!: () => void;
  const copying = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(stableCopy, 'copyStableBackupTree').mockImplementation(async (...args) => {
    if (args[0] === f.data) {
      entered();
      await wait;
    }
    return copy(...args);
  });
  const request = await f.handler.execute(urn);
  await copying;
  await jobs.cancel(urn, request.requestId);
  release();
  await f.completion();
  expect(f.state.Running).toBe(true);
  expect(f.start).toHaveBeenCalledOnce();
  expect((await tasks.read()).tasks[0]?.status).toBe('cancelled');
  expect(await f.backups.listBackupsByAppId(urn)).toHaveLength(0);
});

it('keeps failed runtime recovery interrupted instead of reporting the backup cancelled', async () => {
  const f = await backupWorker();
  let entered!: () => void;
  let release!: () => void;
  const copying = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(stableCopy, 'copyStableBackupTree').mockImplementation(async () => {
    entered();
    await wait;
    throw new Error('Source copy failed');
  });
  f.start.mockRejectedValue(new Error('Could not resume original'));
  const request = await f.handler.execute(urn);
  await copying;
  await jobs.cancel(urn, request.requestId);
  release();
  await f.completion();
  expect(f.state.Running).toBe(false);
  expect((await tasks.read()).tasks[0]?.status).toBe('interrupted');
  expect((await new AppJobStore(directory).read(request.requestId))?.cancelRequestedAt).not.toBeNull();
});

it('waits for an aborted child process to exit before allowing snapshot cleanup', async () => {
  const controller = new AbortController();
  const marker = path.join(directory, 'child.json');
  const source =
    "process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.argv[1],JSON.stringify({pid:process.pid}));setInterval(()=>{},10000)";
  const running = spawnAsync(process.execPath, ['-e', source, marker], { signal: controller.signal });
  await vi.waitFor(async () => {
    expect(await fs.readFile(marker, 'utf8')).toContain('pid');
  });
  const { pid } = JSON.parse(await fs.readFile(marker, 'utf8'));
  controller.abort();
  const result = await running;
  expect(result.stderr).not.toBe('');
  expect(() => process.kill(pid, 0)).toThrow();
}, 10_000);

it.each(['backup', 'update'] as const)('keeps a queued %s cancellation across a controller restart and delayed delivery', async (command) => {
  const data = event(command);
  await admit(data);
  await jobs.cancel(urn, data.requestId);
  const renewedTasks = new TasksService(config, mock<LoggerService>());
  const renewed = new AppJobService(config, repository, renewedTasks);
  const result = await renewed.begin(data, true);
  expect(result).toMatchObject({ result: { cancelled: true, success: false, statePreserved: true, updateStatus: 'running' } });
  expect(result.context).toBeUndefined();
  expect((await renewedTasks.read()).tasks[0]?.status).toBe('cancelled');
  expect((await new AppJobStore(directory).read(data.requestId))?.state).toBe('cancelled');
  expect(await renewed.begin(data, true)).toMatchObject({ result: { cancelled: true } });
});

it('allows one previously unstarted queued request to start after a controller restart', async () => {
  const data = event();
  await admit(data);
  const renewedTasks = new TasksService(config, mock<LoggerService>());
  const renewed = new AppJobService(config, repository, renewedTasks);
  const value = await renewed.begin(data, true);
  expect(value.fresh).toBe(true);
  expect(value.context?.signal.aborted).toBe(false);
  if (!value.context) throw new Error('Missing worker context');
  await renewed.finish(data, value.context, { success: false, statePreserved: true, message: 'Stopped before effects' });
});

it('restores queued controls after restart only from the durable current operation record', async () => {
  const data = event();
  await admit(data);
  const renewedTasks = new TasksService(config, mock<LoggerService>());
  expect((await renewedTasks.read()).tasks[0]?.status).toBe('interrupted');
  const renewed = new AppJobService(config, repository, renewedTasks);
  await renewed.onModuleInit();
  expect((await renewedTasks.read()).tasks[0]).toMatchObject({ status: 'queued', cancellable: true });
  expect((await renewed.getJob(urn, data.requestId)).job?.cancellable).toBe(true);
  await renewed.cancel(urn, data.requestId);
});

it('rejects different requests, applications and changed input without starting a worker', async () => {
  const data = event();
  await admit(data);
  await expect(jobs.cancel(urn, randomUUID())).rejects.toThrow();
  await expect(jobs.cancel('other:store' as typeof urn, data.requestId)).rejects.toThrow();
  await expect(jobs.begin({ ...data, form: { VALUE: 'changed' } }, false)).rejects.toThrow();
  expect((await new AppJobStore(directory).read(data.requestId))?.state).toBe('queued');
});

it.each(['id', 'createdAt', 'version'] as const)('refuses a queued job after its app %s changes', async (field) => {
  const data = event();
  await admit(data);
  app = { ...app, [field]: app[field] + 1 };
  await expect(jobs.begin(data, false)).rejects.toThrow();
  await expect(jobs.cancel(urn, data.requestId)).rejects.toThrow();
});

it('keeps cancellation tied to the current operation when a later request reuses the same app', async () => {
  const first = event();
  await admit(first);
  const context = await begin(first);
  await jobs.finish(first, context, { success: false, statePreserved: true, message: 'No effects' });
  app = { ...app, status: 'running' };
  const second = event();
  await admit(second);
  await expect(jobs.begin(first, true)).rejects.toThrow();
  await expect(jobs.cancel(urn, first.requestId)).rejects.toThrow();
  expect((await new AppJobStore(directory).current(urn))?.requestId).toBe(second.requestId);
  const staleReply = vi.fn(async () => {});
  expect(await jobs.withCurrent(first, staleReply)).toBe(false);
  expect(staleReply).not.toHaveBeenCalled();
});

it('does not admit another operation while an earlier request is unfinished', async () => {
  const data = event();
  await admit(data);
  app = { ...app, status: 'running' };
  await expect(jobs.admit(event(), app)).rejects.toThrow('unfinished operation');
});

it.each([true, false])('serializes cancellation against the deployment cutoff, cancelFirst=%s', async (cancelFirst) => {
  const data = event();
  await admit(data);
  const context = await begin(data);
  const outcomes = await Promise.allSettled(
    cancelFirst ? [jobs.cancel(urn, data.requestId), context.seal()] : [context.seal(), jobs.cancel(urn, data.requestId)],
  );
  expect(outcomes.map((value) => value.status)).toEqual(['fulfilled', 'rejected']);
  expect(context.signal.aborted).toBe(cancelFirst);
  const result = await jobs.finish(data, context, { success: false, statePreserved: true, message: 'Original state preserved' });
  expect(result.cancelled === true).toBe(cancelFirst);
  expect((await tasks.read()).tasks[0]?.status).toBe(cancelFirst ? 'cancelled' : 'failed');
});

it('keeps a live worker cancellable through a requester timeout', async () => {
  const data = event();
  await admit(data);
  const context = await begin(data);
  await tasks.unconfirmed(data);
  expect((await jobs.getJob(urn, data.requestId)).job?.cancellable).toBe(true);
  await jobs.cancel(urn, data.requestId);
  expect(() => context.check()).toThrow('cancelled');
  await context.recover();
  const result = await jobs.finish(data, context, { success: false, statePreserved: true, message: 'Recovered' });
  expect(result.cancelled).toBe(true);
  expect((await tasks.read()).tasks[0]?.status).toBe('cancelled');
});

it('never reports cancellation after failed recovery or replays the original update after restart', async () => {
  const data = event();
  await admit(data);
  const context = await begin(data);
  await jobs.cancel(urn, data.requestId);
  const result = await jobs.finish(data, context, { success: false, statePreserved: false, message: 'Recovery required' });
  expect(result.cancelled).not.toBe(true);
  expect((await tasks.read()).tasks[0]?.status).toBe('interrupted');
  const renewed = new AppJobService(config, repository, tasks);
  expect(await renewed.begin(data, true)).toMatchObject({ result: { success: false } });
  expect((await renewed.begin(data, true)).context).toBeUndefined();
});

it('does not accept a success response after cancellation was accepted', async () => {
  const data = event();
  await admit(data);
  const context = await begin(data);
  await jobs.cancel(urn, data.requestId);
  expect(await jobs.finish(data, context, { success: true, message: 'Unconfirmed completion' })).toMatchObject({ success: false });
  expect((await tasks.read()).tasks[0]?.status).toBe('interrupted');
});

it('retains the prior durable update recovery path without making it cancellable again', async () => {
  const data = event();
  await admit(data);
  await begin(data);
  const renewed = new AppJobService(config, repository, tasks);
  const resumed = await renewed.begin(data, true);
  expect(resumed.context).toBeDefined();
  await expect(renewed.cancel(urn, data.requestId)).rejects.toThrow();
  if (!resumed.context) throw new Error('Missing resumed worker context');
  await renewed.finish(data, resumed.context, { success: true, message: 'Verified receipt', alreadyCompleted: true });
});

it('holds an interrupted backup without repeating an uncertain copy or stop', async () => {
  const data = event('backup');
  await admit(data);
  await begin(data);
  const renewed = new AppJobService(config, repository, tasks);
  expect(await renewed.begin(data, true)).toMatchObject({ result: { success: false } });
});

it('waits for the live worker to confirm recovery during shutdown', async () => {
  const data = event();
  await admit(data);
  const context = await begin(data);
  const shutdown = jobs.onModuleDestroy();
  await vi.waitFor(() => expect(context.signal.aborted).toBe(true));
  await jobs.finish(data, context, { success: false, statePreserved: true, message: 'Recovered' });
  await shutdown;
  app = { ...app, status: 'running' };
  await expect(jobs.admit(event(), app)).rejects.toThrow();
});

it.each(['symlink', 'corrupt', 'permissions'] as const)('fails closed for %s operation records', async (fault) => {
  const data = event();
  await admit(data);
  const file = path.join(directory, 'state/orbis-app-jobs', `${data.requestId}.json`);
  if (fault === 'symlink') {
    await fs.rename(file, file + '.original');
    await fs.symlink(file + '.original', file);
  } else if (fault === 'corrupt') await fs.writeFile(file, '{}');
  else await fs.chmod(file, 0o644);
  await expect(jobs.cancel(urn, data.requestId)).rejects.toThrow();
  await expect(jobs.begin(data, false)).rejects.toThrow();
});

it('allows ordinary status reconciliation when no operation has been admitted', async () => {
  expect(await jobs.hasUnsettledJob(urn)).toBe(false);
});

it.each(['queued', 'running', 'cancel-requested', 'sealed', 'interrupted', 'succeeded', 'failed', 'cancelled'] as const)(
  'reads the persisted %s state before allowing status reconciliation',
  async (state) => {
    const data = event();
    await admit(data);
    const store = new AppJobStore(directory);
    const before = await store.read(data.requestId);
    if (!before) throw new Error('Missing admitted record');
    await store.write({ ...before, state }, before);
    // A restarted service has no live worker. The app pointer still contains the admission snapshot.
    const restarted = new AppJobService(config, repository, new TasksService(config, mock<LoggerService>()));
    const unsettled = !['succeeded', 'failed', 'cancelled'].includes(state);
    expect(await restarted.hasUnsettledJob(urn)).toBe(unsettled);
    app = { ...app, updatedAt: 0 };
    repository.getApps.mockResolvedValue([app]);
    config.get.calledWith('userSettings').mockReturnValue({ eventsTimeout: 5 } as never);
    const docker = mock<Dockerode>();
    docker.listContainers.mockResolvedValue([]);
    const sync = new AppStatusSyncService(
      mock<LoggerService>(),
      repository,
      mock<SSEService>(),
      mock<SystemEventsQueue>(),
      config,
      docker,
      new AsyncMutex(),
      restarted,
    );
    expect(await sync.syncAllAppStatuses()).toMatchObject({ success: true, syncedCount: unsettled ? 0 : 1, skippedCount: unsettled ? 1 : 0 });
    if (unsettled) expect(repository.updateAppById).not.toHaveBeenCalled();
    else expect(repository.updateAppById).toHaveBeenCalledWith(app.id, { status: 'stopped' });
  },
);

it('refuses status reconciliation when the admitted operation record disappears', async () => {
  const data = event();
  await admit(data);
  await fs.unlink(path.join(directory, 'state', 'orbis-app-jobs', `${data.requestId}.json`));
  await expect(jobs.hasUnsettledJob(urn)).rejects.toThrow('operation record');
});

it.each(['appUrn', 'command'] as const)('refuses status reconciliation when the operation %s changes', async (field) => {
  const data = event();
  await admit(data);
  const store = new AppJobStore(directory);
  const before = await store.read(data.requestId);
  if (!before) throw new Error('Missing admitted record');
  const changed = field === 'appUrn' ? { ...before, appUrn: 'other:store' as typeof urn } : { ...before, command: 'backup' as const };
  await store.write(changed, before);
  await expect(jobs.hasUnsettledJob(urn)).rejects.toThrow('operation record');
});

it('preserves a real backup while its durable app operation is unfinished and deletes it after settlement', async () => {
  const fixture = await backupWorker();
  const filename = 'retained.tar.gz';
  const file = path.join(directory, 'backups', 'store', 'demo', filename);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'retained backup bytes');
  const data = event();
  await admit(data);
  await expect(fixture.service.deleteAppBackup({ appUrn: urn, filename })).rejects.toThrow('unfinished app operation');
  expect(await fs.readFile(file, 'utf8')).toBe('retained backup bytes');
  const context = await begin(data);
  await jobs.finish(data, context, { success: true, message: 'Completed' });
  await fixture.service.deleteAppBackup({ appUrn: urn, filename });
  await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([
  ['backup', 'queued'],
  ['backup', 'interrupted'],
  ['update', 'queued'],
  ['update', 'interrupted'],
] as const)('preserves app data and backups against competing actions after a persisted %s/%s restart', async (command, state) => {
  const data = event(command);
  await admit(data);
  const store = new AppJobStore(directory);
  const before = await store.read(data.requestId);
  if (!before) throw new Error('Missing operation fixture');
  await store.write({ ...before, state }, before);
  const restarted = new AppJobService(config, repository, tasks);
  const retained = path.join(directory, 'retained-backup.tar.gz');
  await fs.writeFile(retained, 'retained fixture bytes');
  const execute = vi.fn(async () => {
    await fs.unlink(retained);
    return { success: true, message: 'Removed fixture' };
  });
  const factory = mock<AppLifecycleCommandFactory>();
  factory.createCommand.mockReturnValue({ execute } as never);
  const module = await Test.createTestingModule({ providers: [AppLifecycleService] })
    .useMocker((token) => {
      if (token === AppJobService) return restarted;
      if (token === AppLifecycleCommandFactory) return factory;
      if (token === APP_ASYNC_MUTEX) return new AsyncMutex();
      if (token === TasksService) return tasks;
      if (token === ConfigurationService) return config;
      if (token === AppsRepository) return repository;
      return mock();
    })
    .compile();
  modules.push(module);
  const service = module.get(AppLifecycleService);
  for (const request of [
    () => service.startApp({ appUrn: urn }),
    () => service.stopApp({ appUrn: urn }),
    () => service.restartApp({ appUrn: urn }),
    () => service.resetApp({ appUrn: urn }),
    () => service.uninstallApp({ appUrn: urn, removeBackups: true }),
    () => service.restoreApp({ appUrn: urn, filename: 'retained-backup.tar.gz' }),
    () => service.updateApp({ appUrn: urn, performBackup: false }),
    () => service.backupApp({ appUrn: urn }),
  ])
    await expect(request()).rejects.toThrow('unfinished app operation');
  const delayed = appEventSchema.assert({ command: 'uninstall', appUrn: urn, requestId: randomUUID(), form: {}, removeBackups: true });
  const reply = vi.fn(async (_result: unknown) => {});
  await service.invokeCommand(delayed, reply);
  expect(reply.mock.calls[0]?.[0]).toMatchObject({ success: false, operationBlocked: true });
  expect(execute).not.toHaveBeenCalled();
  expect(repository.updateAppById).not.toHaveBeenCalled();
  expect(await fs.readFile(retained, 'utf8')).toBe('retained fixture bytes');
  expect((await store.read(data.requestId))?.state).toBe(state);
});
