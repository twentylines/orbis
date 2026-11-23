import fs from 'node:fs';
import realFs from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { Volume } from 'memfs';
import { parse as parseYaml } from 'yaml';
import { AppJobService } from '@/modules/app-lifecycle/services/app-job.service';
import type { StagedAppImageUpdate } from '@/modules/docker/app-image-pins';
import os from 'node:os';
import path from 'node:path';
import { APP_DATA_DIR, APP_DIR, DATA_DIR } from '@/common/constants';
import { ArchiveService } from '@/core/archive/archive.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { DATABASE } from '@/core/database/database.module';
import { DatabaseService } from '@/core/database/database.service';
import { appStore } from '@/core/database/drizzle/schema';
import { app as appTable } from '@/core/database/drizzle/schema';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppLifecycleCommandFactory } from '@/modules/app-lifecycle/app-lifecycle-command.factory';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { AppStoreRepository } from '@/modules/app-stores/app-store.repository';
import { AppStoreService } from '@/modules/app-stores/app-store.service';
import { ReposHelpers } from '@/modules/app-stores/repos.helpers';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { AppsService } from '@/modules/apps/apps.service';
import { BackupManager } from '@/modules/backups/backup.manager';
import { DOCKERODE } from '@/modules/docker/docker.module';
import { DockerService } from '@/modules/docker/docker.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { SubnetManagerService } from '@/modules/network/subnet-manager.service';
import { AppEventsQueue, appEventSchema } from '@/modules/queue/entities/app-events';
import { QueueFactory } from '@/modules/queue/queue.factory';
import { TasksService } from '@/modules/tasks/tasks.service';
import { Test } from '@nestjs/testing';
import { fromPartial } from '@total-typescript/shoehorn';
import { eq } from 'drizzle-orm';
import type Dockerode from 'dockerode';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import waitFor from 'wait-for-expect';
import { createAppInStore as createCatalogueApp } from '../utils/create-app-in-store';
import { type TestDatabase, cleanTestData, createTestDatabase } from '../utils/create-test-database';
import { APP_ASYNC_MUTEX } from '@/utils/mutex/mutex.module';
import { AsyncMutex } from '@/utils/mutex/async-mutex';
import { UpdateAppHandler } from '@/modules/app-lifecycle/handlers/update-app.handler';
import { UpdateConfigHandler } from '@/modules/app-lifecycle/handlers/update-config.handler';
import { ResetAppHandler } from '@/modules/app-lifecycle/handlers/reset-app.handler';
import { UninstallAppHandler } from '@/modules/app-lifecycle/handlers/uninstall-app.handler';
import { InstallAppHandler } from '@/modules/app-lifecycle/handlers/install-app.handler';
import { RestartAppHandler } from '@/modules/app-lifecycle/handlers/restart-app.handler';
import { StopAppHandler } from '@/modules/app-lifecycle/handlers/stop-app.handler';
import { StartAppHandler } from '@/modules/app-lifecycle/handlers/start-app.handler';
import { AppStatusSyncService } from '@/modules/app-lifecycle/app-status-sync.service';
import { StatusManagerService } from '@/modules/app-lifecycle/services/status-manager.service';
import { AppValidationService } from '@/modules/app-lifecycle/services/app-validation.service';
import { BackupAppHandler } from '@/modules/app-lifecycle/handlers/backup-app.handler';
import { RestoreAppHandler } from '@/modules/app-lifecycle/handlers/restore-app.handler';

// Real receipt and package files share a private fixture root. Docker is the
// external engine boundary; queue delivery and PostgreSQL remain real.
const fixturePaths = await vi.hoisted(async () => {
  const files = await import('node:fs/promises');
  const paths = await import('node:path');
  const system = await import('node:os');
  const root = await files.mkdtemp(paths.join(await files.realpath(system.tmpdir()), 'orbis-lifecycle-integration-'));
  return { root, app: paths.join(root, 'app'), data: paths.join(root, 'data'), appData: paths.join(root, 'app-data') };
});
vi.mock('@/common/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/common/constants')>()),
  APP_DIR: fixturePaths.app,
  DATA_DIR: fixturePaths.data,
  APP_DATA_DIR: fixturePaths.appData,
}));

// This suite covers an existing, unbaselined data tree. Clean Host-backed
// creation and migration baselines have separate real-file/Engine tests.
const createAppInStore: typeof createCatalogueApp = async (...args) => {
  const info = await createCatalogueApp(...args);
  const data = path.join(APP_DATA_DIR, args[0], info.id);
  await realFs.mkdir(data, { recursive: true });
  await realFs.writeFile(path.join(data, 'retained-data'), 'retained integration fixture');
  return info;
};
async function snapshotTree() {
  const entries: Record<string, string | null> = {};
  async function capture(directory: string, selected: string) {
    entries[selected] = null;
    for (const name of (await realFs.readdir(directory)).sort()) {
      if (selected === '/data/state' && ['orbis-install-requests', 'orbis-app-jobs'].includes(name)) continue;
      const file = path.join(directory, name);
      const relative = path.posix.join(selected, name);
      const info = await realFs.lstat(file);
      if (info.isDirectory()) await capture(file, relative);
      else entries[relative] = '';
    }
  }
  for (const [directory, selected] of [
    [APP_DIR, '/app'],
    [APP_DATA_DIR, '/app-data'],
    [DATA_DIR, '/data'],
  ] as const)
    await capture(directory, selected);
  return Volume.fromJSON(entries).toTree();
}

vi.mock('rabbitmq-client', async (importOriginal) => {
  const original = await importOriginal<typeof import('rabbitmq-client')>();
  return {
    ...original,
    Connection: class extends original.Connection {
      constructor(options?: ConstructorParameters<typeof original.Connection>[0]) {
        super(
          process.env.ORBIS_TEST_QUEUE_PORT && typeof options === 'object'
            ? { ...options, hostname: process.env.ORBIS_TEST_QUEUE_HOST ?? options.hostname, port: Number(process.env.ORBIS_TEST_QUEUE_PORT) }
            : options,
        );
      }
    },
  };
});

let db: TestDatabase;
const DB_NAME = 'applifecycletest';

describe('Retained-storage app lifecycle', () => {
  let appLifecycleService: AppLifecycleService;
  let marketplaceService: MarketplaceService;
  let appsRepository: AppsRepository;
  let filesystemService: FilesystemService;
  let appFilesManager: AppFilesManager;
  let backupManager: BackupManager;
  let tasksService: TasksService;
  let taskDirectory: string;
  const configurationService = mock<ConfigurationService>();
  let databaseService = mock<DatabaseService>();
  const dockerService = mock<DockerService>();
  const docker = mock<Dockerode>();
  const containerStates = new Map<string, { running: boolean; resumed: number }>();
  const loggerService = mock<LoggerService>();
  let archiveService: ReturnType<typeof mock<ArchiveService>>;
  const reposHelpers = mock<ReposHelpers>();
  reposHelpers.pullRepo.mockResolvedValue({ success: true, message: '' });

  configurationService.get.calledWith('queue').mockReturnValue({
    host: 'localhost',
    password: 'guest',
    username: 'guest',
  });
  configurationService.get.calledWith('directories').mockReturnValue({
    dataDir: DATA_DIR,
    appDir: APP_DIR,
    appDataDir: APP_DATA_DIR,
  });
  configurationService.get.calledWith('userSettings').mockReturnValue(fromPartial({ eventsTimeout: 10, maxBackups: 1 }));
  configurationService.get.calledWith('demoMode').mockReturnValue(false);
  dockerService.composeApp.mockResolvedValue({ success: true, stdout: '', stderr: '' });

  let queueFactory: QueueFactory;
  let appEventsQueue: AppEventsQueue;
  async function settle(request: Promise<{ requestId: string }>, status: 'succeeded' | 'failed' = 'succeeded') {
    const result = await request;
    await waitFor(async () => {
      expect((await tasksService.read()).tasks.find((task) => task.id === result.requestId)?.status).toBe(status);
    });
    return result;
  }

  beforeAll(async () => {
    db = await createTestDatabase(DB_NAME);
    taskDirectory = await realFs.mkdtemp(path.join(os.tmpdir(), 'orbis-lifecycle-task-history-'));
    const historyConfig = mock<ConfigurationService>();
    historyConfig.get.calledWith('directories').mockReturnValue({ dataDir: taskDirectory } as never);
    tasksService = new TasksService(historyConfig, loggerService);
    await tasksService.onModuleInit();
  });

  afterAll(async () => {
    if (!taskDirectory) return;
    await waitFor(async () => {
      expect((await tasksService.read()).tasks.every((task) => ['succeeded', 'failed', 'interrupted'].includes(task.status))).toBe(true);
    });
    await queueFactory.onModuleDestroy();
    await realFs.rm(taskDirectory, { recursive: true, force: true });
    await realFs.rm(fixturePaths.root, { recursive: true, force: true });
  });

  afterEach(async (context) => {
    if (context.task.result?.state === 'fail') {
      const messages = loggerService.error.mock.calls.map((args) =>
        args.map((value) => (value instanceof Error ? value.message : typeof value === 'string' ? value : '[details]')).join(' '),
      );
      process.stderr.write(messages.join('\n') + '\n');
    }
    await waitFor(async () => {
      expect((await tasksService.read()).tasks.every((task) => ['succeeded', 'failed', 'interrupted'].includes(task.status))).toBe(true);
    });
    await queueFactory.onModuleDestroy();
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    loggerService.error.mockClear();
    const realArchive = new ArchiveService(loggerService);
    archiveService = mock<ArchiveService>();
    archiveService.createTarGz.mockImplementation(realArchive.createTarGz);
    archiveService.extractTarGz.mockImplementation(realArchive.extractTarGz);
    archiveService.listTarGz.mockImplementation(realArchive.listTarGz);
    archiveService.readTarConfig.mockImplementation(realArchive.readTarConfig);
    dockerService.prepareAppUninstallCleanup.mockImplementation(async (appUrn) => async () => {
      for (const directory of [appFilesManager.getAppPaths(appUrn).appInstalledDir, appFilesManager.getAppPaths(appUrn).appDataDir])
        await expect(realFs.lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    queueFactory = new QueueFactory(loggerService, configurationService);
    appEventsQueue = await queueFactory.createQueue({ queueName: `app-events-${randomUUID()}`, workers: 1, eventSchema: appEventSchema });
    for (const directory of [APP_DIR, APP_DATA_DIR, DATA_DIR]) {
      await realFs.rm(directory, { recursive: true, force: true });
      await realFs.mkdir(directory, { recursive: true });
    }
    await realFs.mkdir(path.join(DATA_DIR, 'state'));
    await realFs.mkdir(path.join(DATA_DIR, 'backups'));
    await realFs.writeFile(path.join(DATA_DIR, '.env'), 'ROOT_FOLDER_HOST=/opt/runtipi');
    await realFs.writeFile(path.join(DATA_DIR, 'state', 'seed'), 'seed');
    await cleanTestData(db);
    containerStates.clear();
    dockerService.composeApp.mockImplementation(async (urn, command) => {
      const project = urn.replace(':', '_');
      if (command.startsWith('up ')) {
        containerStates.set(project, { running: true, resumed: containerStates.get(project)?.resumed ?? 0 });
      } else if (command.startsWith('down ')) {
        containerStates.delete(project);
      } else if (command === 'stop') {
        const state = containerStates.get(project);
        if (state) state.running = false;
      }
      return { success: true, stdout: '', stderr: '' };
    });
    docker.listContainers.mockImplementation(async (options) => {
      const filters = options?.filters;
      const project =
        typeof filters === 'object'
          ? filters.label?.find((label: string) => label.startsWith('com.docker.compose.project='))?.split('=')[1]
          : undefined;
      return [...containerStates]
        .filter(([name]) => !project || name === project)
        .map(([name, state]) => fromPartial<Dockerode.ContainerInfo>({ Id: name, State: state.running ? 'running' : 'exited' }));
    });
    docker.getContainer.mockImplementation((id) => {
      const state = containerStates.get(id);
      if (!state) throw new Error('Unknown fixture container');
      const container = mock<Dockerode.Container>({ id });
      const appUrn = id.replace('_', ':');
      container.inspect.mockImplementation(async () =>
        fromPartial({
          Id: id,
          Image: `sha256:${createHash('sha256').update(id).digest('hex')}`,
          Config: {
            Labels: {
              'com.docker.compose.project': id,
              'com.docker.compose.service': id.split('_')[0],
              'runtipi.managed': 'true',
              'runtipi.appurn': appUrn,
            },
          },
          State: { Running: state.running, Paused: false, Restarting: false, Dead: false },
        }),
      );
      container.stop.mockImplementation(async () => {
        state.running = false;
      });
      container.unpause.mockResolvedValue(undefined);
      container.start.mockImplementation(async () => {
        state.running = true;
        state.resumed++;
      });
      return container;
    });
    const staged = new Map<string, { transaction: StagedAppImageUpdate; appUrn: string; environment: string; services: string[] }>();
    dockerService.beginStagedAppUpdate.mockImplementation(async (appUrn) => {
      const app = appFilesManager.getAppPaths(appUrn);
      const workspace = await realFs.mkdtemp(path.join(fixturePaths.root, 'engine-stage-'));
      const targetDirectory = path.join(workspace, 'target');
      const original = path.join(workspace, 'original');
      await realFs.cp(app.appInstalledDir, original, { recursive: true });
      const entry = {
        transaction: mock<StagedAppImageUpdate>({ id: randomUUID(), targetDirectory }),
        appUrn,
        environment: '',
        services: [] as string[],
      };
      const transaction = entry.transaction;
      transaction.stageTarget.mockImplementation(async (compose, environment) => {
        entry.environment = environment;
        entry.services = Object.keys(parseYaml(compose).services);
        await realFs.writeFile(path.join(targetDirectory, 'docker-compose.generated.yml'), compose);
      });
      transaction.publishTarget.mockImplementation(async () => {
        await realFs.rm(app.appInstalledDir, { recursive: true });
        await realFs.cp(targetDirectory, app.appInstalledDir, { recursive: true });
        await realFs.writeFile(path.join(app.appDataDir, 'app.env'), entry.environment);
      });
      transaction.restoreMetadata.mockImplementation(async () => {
        await realFs.rm(app.appInstalledDir, { recursive: true, force: true });
        await realFs.cp(original, app.appInstalledDir, { recursive: true });
      });
      transaction.commit.mockImplementation(async (commit) => {
        await commit();
        await realFs.rm(workspace, { recursive: true });
      });
      staged.set(transaction.id, entry);
      return { transaction, retained: false };
    });
    dockerService.prepareStagedAppUpdate.mockImplementation(async (appUrn, id) => {
      const selected = staged.get(id);
      if (!selected || selected.appUrn !== appUrn) throw new Error('Unknown fixture stage');
      const project = appUrn.replace(':', '_');
      const plan = mock<Awaited<ReturnType<DockerService['prepareStagedAppUpdate']>>>();
      plan.isCurrent.mockResolvedValue(true);
      plan.release.mockResolvedValue(undefined);
      plan.pull.mockImplementation(async () => ({
        activationSha256: createHash('sha256').update(id).digest('hex'),
        imageIds: Object.fromEntries(selected.services.map((name) => [name, `sha256:${createHash('sha256').update(project).digest('hex')}`])),
      }));
      plan.activate.mockImplementation(async () => {
        const state = containerStates.get(project);
        if (!state) throw new Error('Missing fixture deployment');
        state.running = true;
      });
      return plan;
    });
    docker.pruneContainers.mockRejectedValue(null);
    docker.pruneNetworks.mockRejectedValue(null);
    docker.listNetworks.mockResolvedValue([]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        AppLifecycleService,
        MarketplaceService,
        AppStoreService,
        AppStoreRepository,
        FilesystemService,
        BackupManager,
        { provide: QueueFactory, useValue: queueFactory },
        AppLifecycleCommandFactory,
        AppFilesManager,
        AppsRepository,
        EnvUtils,
        AppHelpers,
        AppsService,
        SubnetManagerService,
        StartAppHandler,
        StopAppHandler,
        RestartAppHandler,
        InstallAppHandler,
        UninstallAppHandler,
        ResetAppHandler,
        UpdateConfigHandler,
        UpdateAppHandler,
        AppStatusSyncService,
        StatusManagerService,
        AppValidationService,
        AppJobService,
        BackupAppHandler,
        RestoreAppHandler,
        {
          provide: APP_ASYNC_MUTEX,
          useValue: new AsyncMutex(),
        },
        {
          provide: DockerService,
          useValue: dockerService,
        },
        {
          provide: ReposHelpers,
          useValue: reposHelpers,
        },
        {
          provide: DatabaseService,
          useValue: databaseService,
        },
        {
          provide: DATABASE,
          useValue: db,
        },
        {
          provide: DOCKERODE,
          useValue: docker,
        },
        {
          provide: AppEventsQueue,
          useValue: appEventsQueue,
        },
        {
          provide: ConfigurationService,
          useValue: configurationService,
        },
        {
          provide: LoggerService,
          useValue: loggerService,
        },
        {
          provide: TasksService,
          useValue: tasksService,
        },
        {
          provide: ArchiveService,
          useValue: archiveService,
        },
      ],
    })
      .useMocker(mock)
      .compile();

    appLifecycleService = moduleRef.get(AppLifecycleService);
    databaseService = moduleRef.get(DatabaseService);
    marketplaceService = moduleRef.get(MarketplaceService);
    appsRepository = moduleRef.get(AppsRepository);
    filesystemService = moduleRef.get(FilesystemService);
    appFilesManager = moduleRef.get(AppFilesManager);
    backupManager = moduleRef.get(BackupManager);

    databaseService.db = db;
    const safePath = filesystemService.getSafeFilePath.bind(filesystemService);
    vi.spyOn(filesystemService, 'getSafeFilePath').mockImplementation((name) => {
      if (name === fixturePaths.root || name.startsWith(fixturePaths.root + path.sep)) return name;
      return safePath(name);
    });

    vi.spyOn(filesystemService, 'createTempDirectory').mockImplementation(async (prefix) => {
      return fs.promises.mkdtemp(path.join(fixturePaths.root, `${path.basename(prefix)}-`));
    });

    configurationService.getConfig.mockReturnValue(
      fromPartial({
        demoMode: false,
        directories: { dataDir: DATA_DIR, appDir: APP_DIR, appDataDir: APP_DATA_DIR },
        internalIp: '127.0.0.1',
        envFilePath: '/data/.env',
        rootFolderHost: '/opt/runtipi',
        userSettings: {
          appDataPath: '/opt/runtipi',
        },
      }),
    );

    await db.insert(appStore).values({ slug: 'test', url: 'https://appstore.example.com', hash: 'test', name: 'test', enabled: true }).execute();
    await marketplaceService.initialize();
  });

  describe('install app', () => {
    it('should successfully install app and create expected directory structure', async () => {
      // arrange
      const appInfo = await createAppInStore('test', { id: 'test' });

      // act
      await settle(appLifecycleService.installApp({ appUrn: appInfo.urn, form: {} }));

      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
      });

      // assert
      expect(await snapshotTree()).toMatchSnapshot();
    });

    it('should not delete an existing app-data folder even if the app is reinstalled', async () => {
      // arrange
      const appInfo = await createAppInStore('test', { id: 'test2' });

      await fs.promises.mkdir(`${APP_DATA_DIR}/test/test2/data`, { recursive: true });
      await fs.promises.writeFile(`${APP_DATA_DIR}/test/test2/data/test.txt`, 'test');

      await settle(appLifecycleService.installApp({ appUrn: appInfo.urn, form: {} }));

      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
      });

      // assert
      expect(await snapshotTree()).toMatchSnapshot();
    });
  });

  describe('restore app', () => {
    const prepare = async (status: 'running' | 'stopped') => {
      const info = await createAppInStore('test', { id: `restore-${status}`, tipi_version: 1 });
      await settle(appLifecycleService.installApp({ appUrn: info.urn, form: {}, skipRun: true }));
      await waitFor(async () => expect((await appsRepository.getAppByUrn(info.urn))?.status).toBe('stopped'));
      const { appDataDir, appInstalledDir } = appFilesManager.getAppPaths(info.urn);
      const overrides = path.join(DATA_DIR, 'user-config', 'test', info.id);
      await fs.promises.mkdir(overrides, { recursive: true });
      await fs.promises.writeFile(path.join(overrides, 'app.env'), 'CUSTOM=backup\n');
      await fs.promises.writeFile(path.join(appDataDir, 'data', 'record'), 'backup data');
      await settle(appLifecycleService.backupApp({ appUrn: info.urn }));
      await waitFor(async () => {
        expect((await appsRepository.getAppByUrn(info.urn))?.status).toBe('stopped');
        expect(await backupManager.listBackupsByAppId(info.urn)).toHaveLength(1);
      });
      const [backup] = await backupManager.listBackupsByAppId(info.urn);
      if (!backup) throw new Error('Expected saved fixture backup');
      const file = path.join(appInstalledDir, 'config.json');
      const installed = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      await fs.promises.writeFile(file, JSON.stringify({ ...installed, tipi_version: 2 }));
      const app = await appsRepository.getAppByUrn(info.urn);
      if (!app) throw new Error('Expected installed fixture app');
      await appsRepository.updateAppById(app.id, { version: 2 });
      await fs.promises.writeFile(path.join(overrides, 'app.env'), 'CUSTOM=live\n');
      await fs.promises.writeFile(path.join(appDataDir, 'data', 'record'), 'newer live data');
      if (status === 'running') {
        await appLifecycleService.startApp({ appUrn: info.urn });
        await waitFor(async () => expect((await appsRepository.getAppByUrn(info.urn))?.status).toBe('running'));
      }
      const backupBody = await fs.promises.readFile(await backupManager.getBackupPath(info.urn, backup.id));
      return { info, backup, appDataDir, overrides, backupBody };
    };

    it.each(['stopped', 'running'] as const)(
      'restores the saved files and database version, then preserves the previous %s state',
      async (status) => {
        const { info, backup, appDataDir, overrides, backupBody } = await prepare(status);
        await settle(appLifecycleService.restoreApp({ appUrn: info.urn, filename: backup.id }));
        await waitFor(async () => {
          const app = await appsRepository.getAppByUrn(info.urn);
          expect(app?.status).toBe(status);
          expect(app?.version).toBe(1);
        });
        expect((await appFilesManager.getInstalledAppInfo(info.urn))?.tipi_version).toBe(1);
        expect(await fs.promises.readFile(path.join(appDataDir, 'data', 'record'), 'utf8')).toBe('backup data');
        expect(await fs.promises.readFile(path.join(overrides, 'app.env'), 'utf8')).toBe('CUSTOM=backup\n');
        expect(await backupManager.hasPendingRestore(info.urn)).toBe(false);
        expect(await fs.promises.readFile(await backupManager.getBackupPath(info.urn, backup.id))).toEqual(backupBody);
      },
    );

    it('retains newer live files and database version after extraction fails', async () => {
      const { info, backup, appDataDir, overrides } = await prepare('stopped');
      archiveService.extractTarGz.mockResolvedValueOnce({ stdout: '', stderr: 'No space left on device' });
      await settle(appLifecycleService.restoreApp({ appUrn: info.urn, filename: backup.id }), 'failed');
      await waitFor(async () => expect((await appsRepository.getAppByUrn(info.urn))?.status).toBe('stopped'));
      expect((await appsRepository.getAppByUrn(info.urn))?.version).toBe(2);
      expect((await appFilesManager.getInstalledAppInfo(info.urn))?.tipi_version).toBe(2);
      expect(await fs.promises.readFile(path.join(appDataDir, 'data', 'record'), 'utf8')).toBe('newer live data');
      expect(await fs.promises.readFile(path.join(overrides, 'app.env'), 'utf8')).toBe('CUSTOM=live\n');
      expect(await backupManager.hasPendingRestore(info.urn)).toBe(false);
    });
  });

  describe('update app', () => {
    it('preserves the installed version and data when backup validation fails', async () => {
      const appInfo = await createAppInStore('test', { id: 'rejected-backup', tipi_version: 1 });
      await settle(appLifecycleService.installApp({ appUrn: appInfo.urn, form: {} }));
      await waitFor(async () => {
        expect((await appsRepository.getAppByUrn(appInfo.urn))?.status).toBe('running');
      });
      const { appDataDir } = appFilesManager.getAppPaths(appInfo.urn);
      await fs.promises.writeFile(path.join(appDataDir, 'data', 'preserved.txt'), 'original data');
      await createAppInStore('test', { id: appInfo.id, tipi_version: 2 });
      archiveService.listTarGz.mockRejectedValueOnce(new Error('Archive validation failed'));

      await settle(appLifecycleService.updateApp({ appUrn: appInfo.urn, performBackup: true }), 'failed');

      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
        expect(app?.version).toBe(1);
      });
      expect(containerStates.get(appInfo.urn.replace(':', '_'))).toEqual({ running: true, resumed: 1 });
      expect((await appFilesManager.getInstalledAppInfo(appInfo.urn))?.tipi_version).toBe(1);
      expect(await fs.promises.readFile(path.join(appDataDir, 'data', 'preserved.txt'), 'utf8')).toBe('original data');
      expect(await fs.promises.readdir(`${DATA_DIR}/backups/test/${appInfo.id}`)).toEqual([]);
    });

    it('should successfully update an app to a newer version', async () => {
      // arrange
      const appInfo = await createAppInStore('test', { tipi_version: 1 });

      await settle(appLifecycleService.installApp({ appUrn: appInfo.urn, form: {} }));

      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
        expect(app?.version).toBe(1);
      });

      await createAppInStore('test', { id: appInfo.id, tipi_version: 2 });

      await fs.promises.mkdir(`${APP_DATA_DIR}/test/${appInfo.id}/data`, { recursive: true });
      await fs.promises.writeFile(`${APP_DATA_DIR}/test/${appInfo.id}/data/preserved.txt`, 'data to preserve');

      // act
      await settle(appLifecycleService.updateApp({ appUrn: appInfo.urn, performBackup: false }));

      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
        expect(app?.version).toBe(2);
      });

      const dataFileExists = await fs.promises
        .access(`${APP_DATA_DIR}/test/${appInfo.id}/data/preserved.txt`)
        .then(() => true)
        .catch(() => false);
      expect(dataFileExists).toBe(true);
    });

    it('persists target exposure settings and version together against actual PostgreSQL', async () => {
      const info = await createAppInStore('test', { id: 'target-settings', tipi_version: 1, exposable: true });
      await settle(appLifecycleService.installApp({ appUrn: info.urn, form: { exposed: true, enableAuth: true, domain: 'app.example.test' } }));
      expect(await appsRepository.getAppByUrn(info.urn)).toMatchObject({ version: 1, exposed: true });
      await createAppInStore('test', { id: info.id, tipi_version: 2, exposable: false, port: 8090 });
      await settle(appLifecycleService.updateApp({ appUrn: info.urn, performBackup: false }));
      const saved = await appsRepository.getAppByUrn(info.urn);
      expect(saved).toMatchObject({
        version: 2,
        status: 'running',
        exposed: false,
        exposedLocal: false,
        enableAuth: false,
        domain: null,
        config: { exposed: false, enableAuth: false },
      });
      expect(saved?.config.domain).toBeUndefined();
      expect((await appFilesManager.getAppEnv(info.urn)).content).toContain('APP_EXPOSED=false');
    });

    it('preserves the old PostgreSQL settings and version when target validation fails', async () => {
      const info = await createAppInStore('test', { id: 'invalid-target-settings', tipi_version: 1, exposable: true });
      await settle(appLifecycleService.installApp({ appUrn: info.urn, form: { exposed: false } }));
      const before = await appsRepository.getAppByUrn(info.urn);
      await createAppInStore('test', { id: info.id, tipi_version: 2, exposable: true, force_expose: true });
      await settle(appLifecycleService.updateApp({ appUrn: info.urn, performBackup: false }), 'failed');
      expect(await appsRepository.getAppByUrn(info.urn)).toMatchObject({ version: 1, status: 'running', config: before?.config });
      expect((await appFilesManager.getInstalledAppInfo(info.urn))?.tipi_version).toBe(1);
    });

    it('should keep only the configured number of backups when updating with backups enabled', async () => {
      const appInfo = await createAppInStore('test', { id: 'backup-retention-test', tipi_version: 1 });

      await settle(appLifecycleService.installApp({ appUrn: appInfo.urn, form: {} }));

      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
        expect(app?.version).toBe(1);
      });

      await createAppInStore('test', { id: appInfo.id, tipi_version: 2 });
      await settle(appLifecycleService.updateApp({ appUrn: appInfo.urn, performBackup: true }));

      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
        expect(app?.version).toBe(2);
      });

      await createAppInStore('test', { id: appInfo.id, tipi_version: 3 });
      await settle(appLifecycleService.updateApp({ appUrn: appInfo.urn, performBackup: true }));

      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
        expect(app?.version).toBe(3);
      });

      await waitFor(async () => {
        const backups = await fs.promises.readdir(`${DATA_DIR}/backups/test/${appInfo.id}`);
        expect(backups).toHaveLength(1);
      });
    });
  });

  describe('update all apps', () => {
    it('should update multiple apps that have newer versions available', async () => {
      // arrange
      const app1Info = await createAppInStore('test', { id: 'app1', tipi_version: 1 });
      const app2Info = await createAppInStore('test', { id: 'app2', tipi_version: 2 });
      const app3Info = await createAppInStore('test', { id: 'app3', tipi_version: 3 });

      await settle(appLifecycleService.installApp({ appUrn: app1Info.urn, form: {} }));
      await settle(appLifecycleService.installApp({ appUrn: app2Info.urn, form: {} }));
      await settle(appLifecycleService.installApp({ appUrn: app3Info.urn, form: {} }));

      await waitFor(async () => {
        const app1 = await appsRepository.getAppByUrn(app1Info.urn);
        const app2 = await appsRepository.getAppByUrn(app2Info.urn);
        const app3 = await appsRepository.getAppByUrn(app3Info.urn);
        expect(app1?.status).toBe('running');
        expect(app2?.status).toBe('running');
        expect(app3?.status).toBe('running');
      });

      await createAppInStore('test', { id: 'app1', tipi_version: 2 });
      await createAppInStore('test', { id: 'app3', tipi_version: 4 });

      // act
      await appLifecycleService.updateAllApps();

      await waitFor(async () => {
        const app1 = await appsRepository.getAppByUrn(app1Info.urn);
        expect(app1?.status).toBe('running');
        expect(app1?.version).toBe(2);
      });

      await waitFor(async () => {
        const app3 = await appsRepository.getAppByUrn(app3Info.urn);
        expect(app3?.status).toBe('running');
        expect(app3?.version).toBe(4);
      });

      // assert
      const app1 = await appsRepository.getAppByUrn(app1Info.urn);
      const app2 = await appsRepository.getAppByUrn(app2Info.urn);
      const app3 = await appsRepository.getAppByUrn(app3Info.urn);

      expect(app1?.version).toBe(2);
      expect(app2?.version).toBe(2);
      expect(app3?.version).toBe(4);

      expect(app1?.status).toBe('running');
      expect(app2?.status).toBe('running');
      expect(app3?.status).toBe('running');

      const tree = (await snapshotTree()).replace(
        /-\d+(?:-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.tar\.gz/g,
        '-TIMESTAMP.tar.gz',
      );

      expect(tree).toMatchSnapshot();
    });
  });

  describe('app subnet assignment', () => {
    it('should assign a subnet to an app when started if it has none', async () => {
      // arrange
      const appInfo = await createAppInStore('test', { id: 'subnet-test' });

      await settle(appLifecycleService.installApp({ appUrn: appInfo.urn, form: {} }));

      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
      });

      // Remove subnet value to simulate an app without a subnet
      await db.update(appTable).set({ subnet: null }).where(eq(appTable.appName, appInfo.id)).execute();

      let app = await appsRepository.getAppByUrn(appInfo.urn);
      expect(app?.subnet).toBeNull();

      // act
      await appLifecycleService.startApp({ appUrn: appInfo.urn });

      // assert
      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
      });

      app = await appsRepository.getAppByUrn(appInfo.urn);
      expect(app?.subnet).not.toBeNull();
      expect(app?.subnet).toMatch(/^10\.128\.\d+\.0\/24$/);
    });
  });

  describe('architecture-specific overrides', () => {
    it('should apply architecture-specific overrides when generating docker-compose file', async () => {
      // arrange
      configurationService.get.calledWith('architecture').mockReturnValue('arm64');
      const appInfo = await createAppInStore('test', { id: 'arch-test' });
      const composeJson = {
        services: [
          {
            name: 'app',
            image: 'app:latest',
            isMain: true,
            internalPort: 80,
          },
        ],
        overrides: [
          {
            architecture: 'arm64',
            services: [
              {
                name: 'app',
                image: 'app:arm64-latest',
              },
            ],
          },
        ],
      };

      await fs.promises.mkdir(`${DATA_DIR}/repos/test/apps/arch-test`, { recursive: true });
      await fs.promises.writeFile(`${DATA_DIR}/repos/test/apps/arch-test/docker-compose.json`, JSON.stringify(composeJson));

      // act
      await settle(appLifecycleService.installApp({ appUrn: appInfo.urn, form: {} }));

      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
      });

      // assert
      const composeFileContent = await fs.promises.readFile(`${DATA_DIR}/apps/test/arch-test/docker-compose.generated.yml`, 'utf8');
      expect(composeFileContent).toContain('app:arm64-latest');
      expect(composeFileContent).not.toContain('app:latest');
    });
  });

  describe('stop app', () => {
    it('should successfully stop a running app', async () => {
      // arrange
      const appInfo = await createAppInStore('test', { id: 'stop-test' });

      await settle(appLifecycleService.installApp({ appUrn: appInfo.urn, form: {} }));

      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
      });

      // act
      await appLifecycleService.stopApp({ appUrn: appInfo.urn });

      // assert
      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('stopped');
      });
    });
  });

  describe('start app', () => {
    it('should successfully start a stopped app', async () => {
      // arrange
      const appInfo = await createAppInStore('test', { id: 'start-test' });

      await settle(appLifecycleService.installApp({ appUrn: appInfo.urn, form: {} }));

      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
      });

      await appLifecycleService.stopApp({ appUrn: appInfo.urn });

      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('stopped');
      });

      // act
      await appLifecycleService.startApp({ appUrn: appInfo.urn });

      // assert
      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
      });
    });
  });

  describe('restart app', () => {
    it('should successfully restart a running app', async () => {
      // arrange
      const appInfo = await createAppInStore('test', { id: 'restart-test' });

      await settle(appLifecycleService.installApp({ appUrn: appInfo.urn, form: {} }));

      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
      });

      // act
      await appLifecycleService.restartApp({ appUrn: appInfo.urn });

      // assert
      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
      });
    });
  });

  describe('uninstall app', () => {
    it('should successfully uninstall an installed app', async () => {
      // arrange
      const appInfo = await createAppInStore('test', { id: 'uninstall-test' });

      await settle(appLifecycleService.installApp({ appUrn: appInfo.urn, form: {} }));

      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
      });

      // act
      await appLifecycleService.uninstallApp({ appUrn: appInfo.urn, removeBackups: false });

      // assert
      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app).toBeUndefined();
      });
    });

    it('should successfully uninstall an app and remove its backups when removeBackups is true', async () => {
      // arrange
      const appInfo = await createAppInStore('test', { id: 'uninstall-backup-test' });

      await settle(appLifecycleService.installApp({ appUrn: appInfo.urn, form: {} }));

      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
      });

      // act
      await appLifecycleService.uninstallApp({ appUrn: appInfo.urn, removeBackups: true });

      // assert
      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app).toBeUndefined();
      });
    });
  });

  describe('reset app', () => {
    it('should successfully reset an app and restart it if it was running', async () => {
      // arrange
      const appInfo = await createAppInStore('test', { id: 'reset-test' });

      await settle(appLifecycleService.installApp({ appUrn: appInfo.urn, form: {} }));

      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
      });

      await fs.promises.mkdir(`${APP_DATA_DIR}/test/reset-test/data`, { recursive: true });
      await fs.promises.writeFile(`${APP_DATA_DIR}/test/reset-test/data/test.txt`, 'test data');

      // act
      await appLifecycleService.resetApp({ appUrn: appInfo.urn });

      // assert
      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
      });

      const dataFileExists = await fs.promises
        .access(`${APP_DATA_DIR}/test/reset-test/data/test.txt`)
        .then(() => true)
        .catch(() => false);
      expect(dataFileExists).toBe(false);
    });

    it('should successfully reset an app and keep it stopped if it was stopped', async () => {
      // arrange
      const appInfo = await createAppInStore('test', { id: 'reset-stopped-test' });

      await settle(appLifecycleService.installApp({ appUrn: appInfo.urn, form: {} }));

      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
      });

      await appLifecycleService.stopApp({ appUrn: appInfo.urn });

      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('stopped');
      });

      await fs.promises.mkdir(`${APP_DATA_DIR}/test/reset-stopped-test/data`, { recursive: true });
      await fs.promises.writeFile(`${APP_DATA_DIR}/test/reset-stopped-test/data/test.txt`, 'test data');

      // act
      await appLifecycleService.resetApp({ appUrn: appInfo.urn });

      // assert
      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('stopped');
      });

      const dataFileExists = await fs.promises
        .access(`${APP_DATA_DIR}/test/reset-stopped-test/data/test.txt`)
        .then(() => true)
        .catch(() => false);
      expect(dataFileExists).toBe(false);
    });
  });

  describe('update app config', () => {
    it('should successfully update app configuration', async () => {
      // arrange
      const appInfo = await createAppInStore('test', { id: 'config-test' });

      await settle(appLifecycleService.installApp({ appUrn: appInfo.urn, form: {} }));

      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
      });

      // act
      await appLifecycleService.updateAppSettings({ appUrn: appInfo.urn, form: { TEST_FIELD: 'new-value' } });

      // assert
      const app = await appsRepository.getAppByUrn(appInfo.urn);
      expect(app?.config).toHaveProperty('TEST_FIELD', 'new-value');
    });

    it('should mark app as pending restart when config changes', async () => {
      // arrange
      const appInfo = await createAppInStore('test', { id: 'config-restart-test' });

      await settle(appLifecycleService.installApp({ appUrn: appInfo.urn, form: { TEST_FIELD: 'old-value' } }));

      await waitFor(async () => {
        const app = await appsRepository.getAppByUrn(appInfo.urn);
        expect(app?.status).toBe('running');
      });

      // act
      await appLifecycleService.updateAppSettings({ appUrn: appInfo.urn, form: { TEST_FIELD: 'new-value' } });

      // assert
      const app = await appsRepository.getAppByUrn(appInfo.urn);
      expect(app?.pendingRestart).toBe(true);
    });

    it.each(['version', 'config'] as const)('rejects stale settings against the actual PostgreSQL %s value', async (field) => {
      const info = await createAppInStore('test', { id: `settings-stale-${field}` });
      await settle(appLifecycleService.installApp({ appUrn: info.urn, form: { VALUE: 'original' }, skipRun: true }));
      await waitFor(async () => expect((await appsRepository.getAppByUrn(info.urn))?.status).toBe('stopped'));
      const before = await appsRepository.getAppByUrn(info.urn);
      if (!before) throw new Error('Missing installed fixture app');
      const patch = field === 'version' ? { version: before.version + 1 } : { config: { VALUE: 'newer writer' } };
      await appsRepository.updateAppById(before.id, patch);
      await expect(appsRepository.updateSettingsIfCurrent(before, { config: { VALUE: 'stale writer' } })).rejects.toThrow('application changed');
      const after = await appsRepository.getAppByUrn(info.urn);
      expect(after).toMatchObject(patch);
      expect(after?.config).not.toEqual({ VALUE: 'stale writer' });
    });
  });
});
