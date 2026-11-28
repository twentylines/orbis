import { FreshAppStorage } from '../../docker/app-fresh-storage';
import { copyAppPackage } from '../../app-stores/app-package-copy';
import { Test, type TestingModule } from '@nestjs/testing';
import { mock } from 'vitest-mock-extended';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { AppEventsQueue, appEventSchema } from '@/modules/queue/entities/app-events';
import { BackupManager } from '@/modules/backups/backup.manager';
import { APP_ASYNC_MUTEX } from '@/utils/mutex/mutex.module';
import { AsyncMutex } from '@/utils/mutex/async-mutex';
import { DOCKERODE } from '@/modules/docker/docker.module';
import { hasInstallRequestHold } from '@/modules/app-lifecycle/install-request-receipt';
import { readFreshInstallResult } from '@/modules/app-lifecycle/install-result';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { DockerService } from '@/modules/docker/docker.service';
import { AppUpdateStage } from '@/modules/docker/app-update-stage';
import { appUpdateStorage, readAppImagePins, requireAppImagePinUpdate } from '@/modules/docker/app-image-pins';
import { AppStorageWitness, type AppStorageObservation } from '@/modules/host-updates/app-storage-observation';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { TasksService } from '@/modules/tasks/tasks.service';
import { SubnetManagerService } from '@/modules/network/subnet-manager.service';
import { readAppMigrationIds } from '@/modules/apps/app-migrations';
import { AppLifecycleCommandFactory } from '@/modules/app-lifecycle/app-lifecycle-command.factory';
import { reserveInstallRequest, takeInstallRequestReceipt } from '@/modules/app-lifecycle/install-request-receipt';
import { convertLegacyToYaml } from '@runtipi/common/schemas';
import { createMockApp, createMockAppInfo } from '@/tests/helpers/app-mocks';
import { freshInstallSql } from '@/tests/helpers/fresh-install-sql';

let root: string;
let stage: AppUpdateStage | undefined;
const modules: TestingModule[] = [];
const urn = createAppUrn('demo', 'store');
const imageId = 'sha256:' + 'a'.repeat(64);
const mainId = 'b'.repeat(64);
const newId = 'c'.repeat(64);
const mainImage = 'sha256:' + 'd'.repeat(64);
const host = '/fixture/app-data/store/demo';
const never = () => ({ Running: false, Paused: false, Restarting: false, Dead: false, Pid: 0, StartedAt: '0001-01-01T00:00:00Z' });
type Container = {
  Id: string;
  Image: string;
  Config: { Labels: Record<string, string> };
  State: Record<string, unknown>;
  Mounts: Record<string, unknown>[];
};
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'fi-'));
});
afterEach(async () => {
  await Promise.all(modules.splice(0).map((module) => module.close()));
  await stage?.close();
  stage = undefined;
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
async function fixture(
  options: {
    ids?: string[];
    skipRun?: boolean;
    named?: boolean;
    hidden?: boolean;
    oldVolume?: boolean;
    foreign?: boolean;
    fault?: string;
    readonlyVolume?: boolean;
    profiles?: boolean;
    links?: boolean;
    unseededBind?: { createHostPath: boolean };
  } = {},
) {
  const data = path.join(root, 'app-data/store/demo');
  const metadata = path.join(root, 'apps/store/demo');
  const pins = path.join(root, 'state/time-machine/image-pins');
  const catalogue = path.join(root, 'catalogue');
  await fs.mkdir(catalogue, { mode: 0o750 });
  const info = createMockAppInfo({ tipi_version: 1, version: '1.0.0' });
  const source = convertLegacyToYaml({ schemaVersion: 2, services: [{ name: 'web', image: 'example.test/demo:1', isMain: true, internalPort: 80 }] });
  await fs.writeFile(path.join(catalogue, 'config.json'), JSON.stringify(info), { mode: 0o640 });
  await fs.writeFile(path.join(catalogue, 'source.json'), JSON.stringify(source), { mode: 0o640 });
  if (!options.unseededBind) {
    await fs.mkdir(path.join(catalogue, 'data'), { mode: 0o750 });
    await fs.writeFile(path.join(catalogue, 'data/version.template'), 'seed={{VALUE}}', { mode: 0o640 });
  }
  if (options.links) {
    await fs.symlink('version.template', path.join(catalogue, 'data/alias'));
    await fs.symlink('future-file', path.join(catalogue, 'data/dangling'));
    await fs.mkdir(path.join(catalogue, 'data/configs'));
    await fs.symlink('../version.template', path.join(catalogue, 'data/configs/version-link'));
    await fs.symlink('configs', path.join(catalogue, 'data/shared-dir'));
  }
  for (const id of options.ids ?? ['001-first', '002-current']) {
    await fs.mkdir(path.join(catalogue, 'migrations'), { mode: 0o750, recursive: true });
    await fs.writeFile(path.join(catalogue, 'migrations', id + '.yml'), 'services: {}', { mode: 0o640 });
  }
  const sql = freshInstallSql();
  const repository = new AppsRepository(sql.database);
  vi.spyOn(repository, 'getAppByUrn').mockImplementation(async () =>
    createMockApp({
      id: 7,
      createdAt: 123,
      appName: 'demo',
      appStoreSlug: 'store',
      version: Number(sql.row().version),
      status: String(sql.row().status) as never,
      migrationsBaselined: sql.row().migrations_baselined === true,
      subnet: null,
    }),
  );
  vi.spyOn(repository, 'getMigrationLedger').mockImplementation(async () => ({
    baselined: sql.row().migrations_baselined === true,
    migrationIds: sql.ids(),
  }));
  const request = { requestId: randomUUID(), owner: randomUUID(), skipRun: !!options.skipRun };
  const reservation = { id: 7, createdAt: 123, appName: 'demo', appStoreSlug: 'store', version: 1 };
  await reserveInstallRequest(root, urn, request, async () => reservation);
  const claim = await takeInstallRequestReceipt(root, { ...request, app: reservation });
  if (!claim) throw new Error('Missing owned fixture');
  const children = new Map<string, Container>();
  const volumes = new Map<string, Record<string, unknown>>();
  const named = 'demo_store_db';
  const anonymous = 'anonymous-' + randomUUID();
  const metricsAnonymous = anonymous + '-metrics';
  const volume = (name: string, logical?: string) => ({
    Name: name,
    Driver: 'local',
    Mountpoint: '/var/lib/docker/volumes/' + name + '/_data',
    Scope: 'local',
    Options: null,
    Labels: logical ? { 'com.docker.compose.project': 'demo_store', 'com.docker.compose.volume': logical } : {},
    CreatedAt: '2026-11-22T00:00:00Z',
  });
  if (options.oldVolume || options.readonlyVolume) volumes.set(named, volume(named, 'db'));
  const main: Container = {
    Id: mainId,
    Image: mainImage,
    Config: { Labels: { 'com.docker.compose.project': 'runtipi' } },
    State: { ...never(), Running: true, Pid: 20, StartedAt: '2026-11-22T00:00:00Z' },
    Mounts: [{ Type: 'bind', Source: '/fixture/app-data', Destination: '/app-data', RW: true }],
  };
  children.set(mainId, main);
  if (options.foreign)
    children.set('e'.repeat(64), {
      ...structuredClone(main),
      Id: 'e'.repeat(64),
      Config: { Labels: {} },
      Mounts: [{ Type: 'bind', Source: host, Destination: '/shared', RW: true }],
    });
  const calls: string[] = [];
  const docker = {
    modem: {
      dial: (request: { path: string }, callback: (error: unknown, body?: unknown) => void) => {
        calls.push(request.path);
        if (request.path === '/containers/json?')
          return callback(
            null,
            [...children.keys()].map((Id) => ({ Id })),
          );
        if (request.path === '/volumes?') return callback(null, { Volumes: [...volumes.values()] });
        if (request.path.startsWith('/volumes/')) {
          const value = volumes.get(request.path.slice('/volumes/'.length));
          return value ? callback(null, value) : callback({ statusCode: 404 });
        }
        if (request.path === `/images/${imageId}/json`)
          return callback(null, { Id: imageId, Config: { Volumes: options.hidden ? { '/hidden': {} } : null } });
        const match = /^\/containers\/([a-f0-9]{64})\/json$/.exec(request.path);
        if (match) {
          const value = children.get(match[1] ?? '');
          return value ? callback(null, value) : callback({ statusCode: 404 });
        }
        return callback(new Error('Unexpected fixture Engine request'));
      },
    },
  } as unknown as Dockerode;
  let observation: AppStorageObservation;
  vi.spyOn(AppStorageWitness, 'open').mockImplementation(async () => {
    const stat = await fs.stat(data);
    observation = {
      schema: 'orbis.app-storage-observation.v1',
      appUrn: urn,
      nonce: '1'.repeat(64),
      daemonSha256: '2'.repeat(64),
      dockerSocket: { device: '1', inode: '2' },
      hostBasePath: '/fixture/app-data',
      hostPath: host,
      containerPath: data,
      directory: { device: String(stat.dev), inode: String(stat.ino), uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777 },
      mountTablesSha256: '3'.repeat(64),
      controllerNamespace: '1:2',
      bindingSha256: '4'.repeat(64),
      controller: { id: mainId, imageId: mainImage, startedAt: String(main.State.StartedAt), definitionSha256: '5'.repeat(64) },
    };
    return {
      use: async (effect: (client: Dockerode, value: AppStorageObservation) => Promise<unknown>) => effect(docker, structuredClone(observation)),
      close: async () => {},
    } as unknown as AppStorageWitness;
  });
  const mountDefinitions: Record<string, unknown>[] = [
    {
      type: 'bind',
      source: host + '/data',
      target: '/config',
      read_only: false,
      ...(options.unseededBind ? { bind: { create_host_path: options.unseededBind.createHostPath } } : {}),
    },
  ];
  if (options.named || options.oldVolume || options.readonlyVolume)
    mountDefinitions.push({ type: 'volume', source: 'db', target: '/database', read_only: !!options.readonlyVolume });
  const effective = {
    name: 'demo_store',
    'x-orbis-fresh-active-services': ['web'],
    services: {
      web: { image: imageId, volumes: mountDefinitions },
      ...(options.profiles ? { metrics: { image: imageId, profiles: ['metrics'], volumes: [] } } : {}),
    },
    volumes: options.named || options.oldVolume || options.readonlyVolume ? { db: { name: named } } : {},
  };
  let pulls = 0;
  let creates = 0;
  let starts = 0;
  let interruptedAfterStart = false;
  const plan = {
    inputsSha256: '6'.repeat(64),
    pull: async () => {
      pulls++;
      return { activationSha256: '7'.repeat(64), imageIds: { web: imageId, ...(options.profiles ? { metrics: imageId } : {}) } };
    },
    isCurrent: async () => {
      if (options.fault === 'after-start' && starts > 0 && !interruptedAfterStart) {
        interruptedAfterStart = true;
        return false;
      }
      return options.fault !== 'changed-input';
    },
    release: async () => {},
    freshConfiguration: async () => effective,
    freshPullConfiguration: async () => effective,
    createFresh: async (selected: AppUpdateStage) => {
      creates++;
      expect(sql.row().migrations_baselined).toBe(false);
      expect(starts).toBe(0);
      await selected.freshCreationAttempted();
      expect((await selected.read()).freshInstall?.createAttempted).toBe(true);
      if (options.named && !volumes.has(named)) volumes.set(named, volume(named, 'db'));
      if (options.hidden) {
        volumes.set(anonymous, volume(anonymous));
        if (options.profiles) volumes.set(metricsAnonymous, volume(metricsAnonymous));
      }
      const mounts: Record<string, unknown>[] = [{ Type: 'bind', Source: host + '/data', Destination: '/config', RW: true }];
      if (options.named || options.oldVolume || options.readonlyVolume)
        mounts.push({ Type: 'volume', Source: volume(named).Mountpoint, Name: named, Destination: '/database', RW: !options.readonlyVolume });
      if (options.hidden) mounts.push({ Type: 'volume', Source: volume(anonymous).Mountpoint, Name: anonymous, Destination: '/hidden', RW: true });
      const value: Container = {
        Id: newId,
        Image: imageId,
        Config: {
          Labels: {
            'com.docker.compose.project': 'demo_store',
            'com.docker.compose.service': 'web',
            'runtipi.managed': 'true',
            'runtipi.appurn': urn,
            'io.orbis.app-update.stage': selected.id,
          },
        },
        State: never(),
        Mounts: mounts,
      };
      if (options.fault === 'already-started') value.State = { ...never(), StartedAt: '2026-11-22T00:00:01Z' };
      children.set(newId, value);
      if (options.profiles)
        children.set('f'.repeat(64), {
          ...structuredClone(value),
          Id: 'f'.repeat(64),
          Config: { Labels: { ...value.Config.Labels, 'com.docker.compose.service': 'metrics' } },
          Mounts: options.hidden
            ? [{ Type: 'volume', Source: volume(metricsAnonymous).Mountpoint, Name: metricsAnonymous, Destination: '/hidden', RW: true }]
            : [],
        });
      if (options.fault === 'create-partial') children.delete(newId);
      if (options.fault === 'create-lost' || options.fault === 'create-partial') throw new Error('Synthetic lost create reply');
    },
    activate: async () => {
      starts++;
      expect(sql.row().migrations_baselined).toBe(true);
      expect((await stage?.read())?.phase).toBe('activation-attempted');
      const value = children.get(newId);
      if (!value) throw new Error('Missing created app');
      value.State = {
        Running: true,
        Paused: false,
        Restarting: false,
        Dead: false,
        Pid: 42,
        StartedAt: '2026-11-22T00:00:02Z',
        Health: { Status: 'healthy' },
      };
      await fs.writeFile(path.join(data, 'accepted-after-start'), 'keep-new-data');
      if (options.fault === 'start-partial') value.State.Health = { Status: 'unhealthy' };
      if (options.fault === 'start-lost' || options.fault === 'start-partial') throw new Error('Synthetic lost activation reply');
    },
  };
  const service = {
    readAppImageUpdateGuard: async () => appUpdateStorage.updateGuard(pins, urn),
    requireAppImagePinUpdate: async (_urn: unknown, id?: string) => requireAppImagePinUpdate(pins, urn, id),
    verifyFreshInstallInputs: async () => {
      if (!(await plan.isCurrent())) throw new Error('Changed fixture inputs');
    },
    reopenStagedAppUpdate: async (_urn: unknown, requestId: string, stageId?: string) => {
      stage = await AppUpdateStage.open({ directory: pins, appUrn: urn, metadata, env: path.join(data, 'app.env'), requestId, stageId });
      return { transaction: stage, retained: false };
    },
    beginStagedAppUpdate: async (
      _urn: unknown,
      _requestId: string,
      freshPreparation?: import('../../docker/app-update-stage').AppUpdateStageInput['freshPreparation'],
    ) => {
      stage = await AppUpdateStage.create({
        directory: pins,
        appUrn: urn,
        metadata,
        env: path.join(data, 'app.env'),
        requestId: request.requestId,
        ...(freshPreparation ? { freshPreparation } : {}),
      });
      return { transaction: stage, retained: false };
    },
    prepareStagedAppUpdate: async () => plan,
    prepareResumedAppUpdate: async () => plan,
    getAppImagePinSource: async () => ({ appUrn: urn, project: 'demo_store', sourceSha256: '8'.repeat(64) }),
  };
  const files = {
    getAppPaths: () => ({ appDataDir: data, appInstalledDir: metadata }),
    getInstalledAppInfo: async (_urn: unknown, directory = metadata) => JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8')),
    getSourceDockerComposeYaml: async (_urn: unknown, directory = metadata) => ({
      path: path.join(directory, 'source.json'),
      content: JSON.parse(await fs.readFile(path.join(directory, 'source.json'), 'utf8')),
    }),
    getAppMigrationIds: async (_urn: unknown, directory = metadata) => [...(await readAppMigrationIds(directory))],
  };
  const phases: string[] = [];
  const backups = mock<BackupManager>();
  backups.hasPendingRestore.mockResolvedValue(false);
  const services = new Map<unknown, unknown>([
    [
      TasksService,
      {
        progress: async (_event: unknown, phase: string) => {
          phases.push(phase);
        },
      },
    ],
    [AppFilesManager, files],
    [AppsRepository, repository],
    [BackupManager, backups],
    [DockerService, service],
    [ConfigurationService, { get: (key: string) => (key === 'architecture' ? 'amd64' : { dataDir: root }) }],
    [SubnetManagerService, { planUpdateSubnet: async () => '10.128.0.0/24', reserveUpdateSubnet: async () => {} }],
    [
      MarketplaceService,
      {
        stageAppUpdate: async (_urn: unknown, target: string) => {
          await copyAppPackage(catalogue, target);
        },
      },
    ],
    [AppHelpers, { renderAppEnv: async () => `APP_DATA_DIR=${host}\nVALUE=prepared` }],
    [LoggerService, { error: () => {} }],
  ]);
  const ref = { get: (token: unknown) => services.get(token) } as ModuleRef;
  const factory = new AppLifecycleCommandFactory(ref, docker);
  const form = { skipRun: !!options.skipRun };
  const command = factory.createCommand({ command: 'install', requestId: request.requestId, appUrn: urn, form }, claim.ownership);
  return {
    execute: () => command.execute(urn, form),
    async redeliver(selectedForm = form) {
      // Fresh service/factory instances deliberately have no live original ownership token.
      const freshFactory = new AppLifecycleCommandFactory(ref, docker);
      const config = services.get(ConfigurationService) as ConfigurationService;
      const tasks = new TasksService(config, mock<LoggerService>());
      const event = appEventSchema.assert({ command: 'install', requestId: request.requestId, appUrn: urn, form: selectedForm });
      await tasks.enqueue(event);
      const module = await Test.createTestingModule({ providers: [AppLifecycleService] })
        .useMocker((token) => {
          if (token === TasksService) return tasks;
          if (token === AppLifecycleCommandFactory) return freshFactory;
          if (token === APP_ASYNC_MUTEX) return new AsyncMutex();
          if (token === AppsRepository) return repository;
          if (token === BackupManager) return backups;
          if (token === DOCKERODE) return docker;
          if (token === AppEventsQueue) return mock<AppEventsQueue>();
          return mock();
        })
        .compile();
      modules.push(module);
      const reply = vi.fn().mockResolvedValue(undefined);
      await module.get(AppLifecycleService).invokeCommand(event, reply, true);
      return { reply: reply.mock.calls[0]?.[0], task: (await tasks.read()).tasks.find((task) => task.id === request.requestId) };
    },
    repository,
    backups,
    root,
    request,
    result: () => readFreshInstallResult(root, urn, request.requestId),
    sql,
    data,
    metadata,
    pins,
    children,
    volumes,
    calls,
    phases,
    pulls: () => pulls,
    creates: () => creates,
    starts: () => starts,
    plan,
    claim,
  };
}
it.each([false, true])('prepares an unseeded Compose bind source before activation, skipRun=%s', async (skipRun) => {
  const f = await fixture({ skipRun, unseededBind: { createHostPath: true } });
  await expect(fs.lstat(path.join(f.data, 'data'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await f.execute()).toMatchObject({ success: true, updateStatus: skipRun ? 'stopped' : 'running' });
  expect((await fs.lstat(path.join(f.data, 'data'))).isDirectory()).toBe(true);
  expect(f.starts()).toBe(skipRun ? 0 : 1);
});

it('keeps a missing bind source absent when the Compose configuration forbids creation', async () => {
  const f = await fixture({ unseededBind: { createHostPath: false } });
  expect(await f.execute()).toMatchObject({ success: false });
  await expect(fs.lstat(path.join(f.data, 'data'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(f.starts()).toBe(0);
  expect(f.sql.row().migrations_baselined).toBe(false);
});

it.each([false, true])('runs the real fresh install and atomic baseline with historical IDs, skipRun=%s', async (skipRun) => {
  const f = await fixture({ skipRun });
  expect(await f.execute()).toMatchObject({ success: true, updateStatus: skipRun ? 'stopped' : 'running' });
  expect(f.sql.row()).toMatchObject({ version: 1, status: skipRun ? 'stopped' : 'running', migrations_baselined: true });
  expect(f.sql.ids()).toEqual(['001-first', '002-current']);
  expect(f.creates()).toBe(1);
  expect(f.starts()).toBe(skipRun ? 0 : 1);
  expect(f.phases).toEqual(['preparing', 'pulling_images', 'publishing', ...(skipRun ? [] : ['starting']), 'verifying', 'committing']);
  expect(await fs.readFile(path.join(f.data, 'data/version'), 'utf8')).toBe('seed=prepared');
  expect(await requireAppImagePinUpdate(f.pins, urn)).toBeNull();
  expect((await readAppImagePins(f.pins, { appUrn: urn, project: 'demo_store' }))?.pins.services).toEqual({ web: imageId });
});
it('records a positively empty baseline for a clean package without migrations', async () => {
  const f = await fixture({ ids: [] });
  expect((await f.execute()).success).toBe(true);
  expect(f.sql.row().migrations_baselined).toBe(true);
  expect(f.sql.ids()).toEqual([]);
});
it.each([{ named: true }, { hidden: true }, { named: true, hidden: true }])(
  'accounts for new named and hidden image volumes: %j',
  async (options) => {
    const f = await fixture(options);
    expect((await f.execute()).success).toBe(true);
    expect(f.sql.row().migrations_baselined).toBe(true);
  },
);
it('keeps existing read-only volumes usable without treating them as fresh writable data', async () => {
  const f = await fixture({ readonlyVolume: true });
  expect((await f.execute()).success).toBe(true);
});
it.each([{ oldVolume: true }, { foreign: true }, { fault: 'already-started' }, { fault: 'changed-input' }])(
  'refuses unqualified state before baseline or first start: %j',
  async (options) => {
    const f = await fixture(options);
    expect(await f.execute()).toMatchObject({ success: false, statePreserved: false });
    expect(f.sql.row().migrations_baselined).toBe(false);
    expect(f.sql.ids()).toEqual([]);
    expect(f.starts()).toBe(0);
  },
);
it('reconciles a lost baseline SQL reply by positive state instead of issuing another update', async () => {
  const f = await fixture();
  f.sql.behavior('lost-commit');
  expect((await f.execute()).success).toBe(true);
  expect(f.sql.queries.filter((query) => query.startsWith('update'))).toHaveLength(2);
  expect(f.starts()).toBe(1);
});
it.each(['create-lost', 'start-lost'])('confirms a completed effect after %s without repeating it', async (fault) => {
  const f = await fixture({ fault, named: true, hidden: true });
  expect(await f.execute()).toMatchObject({ success: true, updateStatus: 'running' });
  expect(f.creates()).toBe(1);
  expect(f.starts()).toBe(1);
  expect(f.sql.queries.filter((query) => query.startsWith('update'))).toHaveLength(2);
  expect(await requireAppImagePinUpdate(f.pins, urn)).toBeNull();
  expect(await fs.readFile(path.join(f.data, 'accepted-after-start'), 'utf8')).toBe('keep-new-data');
});
it.each(['create-partial', 'start-partial'])('keeps the operation and all possible new data after %s', async (fault) => {
  const f = await fixture({ fault });
  expect(await f.execute()).toMatchObject({ success: false, statePreserved: false });
  expect(f.creates()).toBe(1);
  expect(f.starts()).toBe(fault === 'start-partial' ? 1 : 0);
  await expect(requireAppImagePinUpdate(f.pins, urn)).rejects.toThrow();
  if (fault === 'start-partial') {
    expect(f.sql.row().migrations_baselined).toBe(true);
    expect(await fs.readFile(path.join(f.data, 'accepted-after-start'), 'utf8')).toBe('keep-new-data');
  }
});

it('prepares inactive profile storage without starting that optional service', async () => {
  const f = await fixture({ profiles: true });
  expect((await f.execute()).success).toBe(true);
  expect(f.children.get('f'.repeat(64))?.State).toMatchObject({ Running: false, Pid: 0, StartedAt: '0001-01-01T00:00:00Z' });
  expect(f.children.get(newId)?.State.Running).toBe(true);
  expect((await readAppImagePins(f.pins, { appUrn: urn, project: 'demo_store' }))?.pins.services).toEqual({ web: imageId, metrics: imageId });
});

it('finishes a healthy post-start interruption through fresh queue/factory instances without repeating app effects', async () => {
  const f = await fixture({ fault: 'after-start', named: true, hidden: true });
  expect((await f.execute()).success).toBe(false);
  expect(f.sql.row().status).toBe('installing');
  f.sql.row().status = 'stopped'; // The original worker's failed-outcome settlement, not a fresh install reservation.
  const controller = f.children.get(mainId);
  if (!controller) throw new Error('Missing controller fixture');
  controller.State.StartedAt = '2026-11-22T01:00:00Z'; // The new Host witness must describe the restarted controller.
  const completed = await f.redeliver();
  expect(completed.reply).toMatchObject({ success: true, alreadyCompleted: true, updateStatus: 'running' });
  expect(completed.task?.status).toBe('succeeded');
  expect(f.sql.row().status).toBe('running');
  expect(f.creates()).toBe(1);
  expect(f.starts()).toBe(1);
  expect(f.sql.queries.filter((query) => query.startsWith('update'))).toHaveLength(2);
  expect(await hasInstallRequestHold(root, urn)).toBe(false);
  expect(await fs.readFile(path.join(f.data, 'accepted-after-start'), 'utf8')).toBe('keep-new-data');
});

it.each(['journal', 'guard', 'stage-removal'])('recovers terminal completion after a lost %s write/cleanup reply', async (fault) => {
  const f = await fixture({ named: true, hidden: true });
  const rename = fs.rename.bind(fs);
  const unlink = fs.unlink.bind(fs);
  const remove = fs.rm.bind(fs);
  let injected = false;
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (!injected && fault === 'journal' && f.sql.receipts().length && String(to).endsWith('/journal.json')) {
      injected = true;
      throw new Error('Synthetic interrupted terminal journal publication');
    }
    return rename(from, to);
  });
  vi.spyOn(fs, 'unlink').mockImplementation(async (name) => {
    if (!injected && fault === 'guard' && String(name).endsWith('.update.json')) {
      injected = true;
      throw new Error('Synthetic interrupted guard cleanup');
    }
    return unlink(name);
  });
  vi.spyOn(fs, 'rm').mockImplementation(async (name, options) => {
    if (!injected && fault === 'stage-removal' && String(name).endsWith(`update-${stage?.id}`) && f.sql.receipts().length) {
      injected = true;
      throw new Error('Synthetic interrupted terminal stage cleanup');
    }
    return remove(name, options);
  });
  expect((await f.execute()).success).toBe(false);
  expect(injected).toBe(true);
  expect(f.sql.receipts()).toHaveLength(1);
  const updates = f.sql.queries.filter((query) => query.startsWith('update')).length;
  const completed = await f.redeliver();
  expect(completed.reply).toMatchObject({ success: true, alreadyCompleted: true });
  expect(completed.task?.status).toBe('succeeded');
  expect(f.sql.queries.filter((query) => query.startsWith('update'))).toHaveLength(updates);
  expect(f.creates()).toBe(1);
  expect(f.starts()).toBe(1);
  expect(await hasInstallRequestHold(root, urn)).toBe(false);
});

it.each(['receipt-unlink', 'completed-directory', 'task-result'])('reconciles a committed install interrupted during %s cleanup', async (fault) => {
  const f = await fixture();
  expect((await f.execute()).success).toBe(true);
  const unlink = fs.unlink.bind(fs);
  const removeDirectory = fs.rmdir.bind(fs);
  let injected = false;
  vi.spyOn(fs, 'unlink').mockImplementation(async (name) => {
    if (fault === 'receipt-unlink' && !injected && String(name).includes(`completed-${f.request.requestId}`)) {
      injected = true;
      throw new Error('Synthetic cleanup interruption');
    }
    return unlink(name);
  });
  vi.spyOn(fs, 'rmdir').mockImplementation(async (name) => {
    if (fault === 'completed-directory' && !injected && String(name).endsWith(`completed-${f.request.requestId}`)) {
      injected = true;
      throw new Error('Synthetic cleanup interruption');
    }
    return removeDirectory(name);
  });
  if (fault === 'task-result') await f.claim();
  else {
    await expect(f.claim()).rejects.toThrow();
    expect(injected).toBe(true);
  }
  const writes = f.sql.queries.filter((query) => query.startsWith('update')).length;
  const completed = await f.redeliver();
  expect(completed.reply).toMatchObject({ success: true, alreadyCompleted: true });
  expect(completed.task?.status).toBe('succeeded');
  expect(await hasInstallRequestHold(root, urn)).toBe(false);
  expect(f.sql.queries.filter((query) => query.startsWith('update'))).toHaveLength(writes);
  expect(f.starts()).toBe(1);
});

it('never retries an unacknowledged terminal SQL attempt after restart', async () => {
  const f = await fixture();
  const commit = vi.spyOn(f.repository, 'commitFreshInstall').mockRejectedValue(new Error('Synthetic unknown SQL outcome'));
  expect((await f.execute()).success).toBe(false);
  expect(await f.result()).toBeDefined();
  expect(f.sql.receipts()).toEqual([]);
  expect((await f.redeliver()).reply).toMatchObject({ success: false });
  expect(commit).toHaveBeenCalledOnce();
  expect(f.starts()).toBe(1);
  expect(await hasInstallRequestHold(root, urn)).toBe(true);
  expect(await fs.readFile(path.join(f.data, 'accepted-after-start'), 'utf8')).toBe('keep-new-data');
});

it.each(['unhealthy', 'mounts', 'inputs', 'request', 'restore'])('preserves post-start recovery instead of accepting changed %s', async (fault) => {
  const f = await fixture({ fault: 'after-start' });
  expect((await f.execute()).success).toBe(false);
  const app = f.children.get(newId);
  if (!app) throw new Error('Missing app fixture');
  if (fault === 'unhealthy') app.State.Health = { Status: 'unhealthy' };
  if (fault === 'mounts') app.Mounts[0] = { ...app.Mounts[0], Source: '/different/data' };
  if (fault === 'inputs') vi.spyOn(f.plan, 'isCurrent').mockResolvedValue(false);
  if (fault === 'restore') f.backups.hasPendingRestore.mockResolvedValue(true);
  const completed = await f.redeliver(fault === 'request' ? { skipRun: true } : undefined);
  expect(completed.reply).toMatchObject({ success: false });
  expect(completed.task?.status).toBe('interrupted');
  expect(f.sql.receipts()).toEqual([]);
  expect(f.starts()).toBe(1);
  expect(await hasInstallRequestHold(root, urn)).toBe(true);
});

it('acknowledges a lost terminal database reply from its exact receipt', async () => {
  const f = await fixture();
  f.sql.behavior('lost-terminal-commit');
  expect((await f.execute()).success).toBe(true);
  expect(f.sql.receipts()).toHaveLength(1);
  expect(f.sql.queries.filter((query) => query.startsWith('update'))).toHaveLength(2);
  expect(f.starts()).toBe(1);
});

it('keeps an unfinished stage when a preserved historical receipt disagrees with the current ledger', async () => {
  const f = await fixture();
  const unlink = fs.unlink.bind(fs);
  let interrupted = false;
  vi.spyOn(fs, 'unlink').mockImplementation(async (name) => {
    if (!interrupted && String(name).endsWith('.update.json')) {
      interrupted = true;
      throw new Error('Synthetic cleanup interruption');
    }
    return unlink(name);
  });
  expect((await f.execute()).success).toBe(false);
  expect(f.sql.receipts()).toHaveLength(1);
  f.sql.setIds([]);
  expect((await f.redeliver()).reply).toMatchObject({ success: false });
  expect(await hasInstallRequestHold(root, urn)).toBe(true);
  await expect(requireAppImagePinUpdate(f.pins, urn)).rejects.toThrow();
  expect(f.starts()).toBe(1);
});

it.each(['edited', 'linked'])('refuses a %s completion intent without clearing the request', async (fault) => {
  const f = await fixture();
  expect((await f.execute()).success).toBe(true);
  const name = path.join(root, 'state/orbis-app-migrations/install-results', `${f.request.requestId}.json`);
  if (fault === 'edited') {
    const value = JSON.parse(await fs.readFile(name, 'utf8'));
    value.status = 'stopped';
    await fs.writeFile(name, JSON.stringify(value));
  } else {
    const saved = name + '.fixture';
    await fs.rename(name, saved);
    await fs.symlink(saved, name);
  }
  const updates = f.sql.queries.filter((query) => query.startsWith('update')).length;
  expect((await f.redeliver()).reply).toMatchObject({ success: false });
  expect(await hasInstallRequestHold(root, urn)).toBe(true);
  expect(f.sql.queries.filter((query) => query.startsWith('update'))).toHaveLength(updates);
  expect(f.starts()).toBe(1);
});

it.each([false, true])('runs the actual fresh install with portable seed links and rendered template targets, skipRun=%s', async (skipRun) => {
  const f = await fixture({ links: true, skipRun });
  expect(await f.execute()).toMatchObject({ success: true, updateStatus: skipRun ? 'stopped' : 'running' });
  expect(await fs.readlink(path.join(f.data, 'data/alias'))).toBe('version');
  expect(await fs.readFile(path.join(f.data, 'data/alias'), 'utf8')).toBe('seed=prepared');
  expect(await fs.readlink(path.join(f.data, 'data/configs/version-link'))).toBe('../version');
  expect(await fs.readlink(path.join(f.data, 'data/shared-dir'))).toBe('configs');
  expect(await fs.readlink(path.join(f.data, 'data/dangling'))).toBe('future-file');
  expect(f.sql.row().migrations_baselined).toBe(true);
  expect(f.creates()).toBe(1);
  expect(f.starts()).toBe(skipRun ? 0 : 1);
});

it.each([
  'before-initialized',
  'initialized',
  'volume-intent',
  'seed-ready',
  'published',
  'created',
  'prepared',
  'baseline-committed',
  'baselined',
  'pinned',
] as const)('continues the actual saved fresh install after %s interruption without repeating completed effects', async (point) => {
  const f = await fixture({ named: true, hidden: true, profiles: true, links: true });
  let interrupted = false;
  const after = <T extends (...args: never[]) => Promise<unknown>>(original: T) =>
    async function (this: unknown, ...args: Parameters<T>) {
      const result = await original.apply(this, args);
      if (!interrupted) {
        interrupted = true;
        throw new Error('Synthetic saved install interruption');
      }
      return result;
    };
  const stopAfter = (
    method:
      | 'beginFreshStorage'
      | 'recordFreshVolume'
      | 'confirmFreshSeed'
      | 'publishTarget'
      | 'preparedFreshStorage'
      | 'confirmFreshBaseline'
      | 'pinFreshImages',
  ) => {
    const original = AppUpdateStage.prototype[method];
    vi.spyOn(AppUpdateStage.prototype, method).mockImplementation(after(original) as never);
  };
  if (point === 'before-initialized') {
    const initialize = AppUpdateStage.prototype.beginFreshStorage;
    vi.spyOn(AppUpdateStage.prototype, 'beginFreshStorage').mockImplementation(async function (this: AppUpdateStage, ...args) {
      if (!interrupted) {
        interrupted = true;
        throw new Error('Synthetic pre-allocation interruption');
      }
      return initialize.apply(this, args);
    });
  }
  if (point === 'initialized') stopAfter('beginFreshStorage');
  if (point === 'volume-intent') stopAfter('recordFreshVolume');
  if (point === 'seed-ready') stopAfter('confirmFreshSeed');
  if (point === 'published') stopAfter('publishTarget');
  if (point === 'created') {
    const prepared = FreshAppStorage.prototype.prepared;
    vi.spyOn(FreshAppStorage.prototype, 'prepared').mockImplementation(async function (this: FreshAppStorage, ...args) {
      if (!interrupted) {
        interrupted = true;
        throw new Error('Synthetic lost create acknowledgement');
      }
      return prepared.apply(this, args);
    });
  }
  if (point === 'prepared') stopAfter('preparedFreshStorage');
  if (point === 'baseline-committed') {
    const confirm = AppUpdateStage.prototype.confirmFreshBaseline;
    vi.spyOn(AppUpdateStage.prototype, 'confirmFreshBaseline').mockImplementation(async function (this: AppUpdateStage, ...args) {
      if (!interrupted) {
        interrupted = true;
        throw new Error('Synthetic lost baseline acknowledgement');
      }
      return confirm.apply(this, args);
    });
  }
  if (point === 'baselined') stopAfter('confirmFreshBaseline');
  if (point === 'pinned') stopAfter('pinFreshImages');
  expect((await f.execute()).success).toBe(false);
  expect(interrupted).toBe(true);
  const priorWrites = f.sql.queries.filter((query) => query.startsWith('update')).length;
  if (point === 'prepared') f.sql.row().status = 'stopped'; // Existing failed-request settlement preserves its exact receipt.
  const completed = await f.redeliver();
  expect(completed.reply).toMatchObject({ success: true, alreadyCompleted: true, updateStatus: 'running' });
  expect(completed.task?.status).toBe('succeeded');
  expect(f.creates()).toBe(1);
  expect(f.starts()).toBe(1);
  expect(f.sql.queries.filter((query) => query.startsWith('update'))).toHaveLength(2);
  if (['baseline-committed', 'baselined', 'pinned'].includes(point)) expect(priorWrites).toBe(1);
  expect(f.sql.ids()).toEqual(['001-first', '002-current']);
  expect(f.children.get('f'.repeat(64))?.State).toMatchObject({ Running: false, Pid: 0 });
  expect(await fs.readFile(path.join(f.data, 'data/alias'), 'utf8')).toBe('seed=prepared');
  expect(await hasInstallRequestHold(root, urn)).toBe(false);
  const writes = f.sql.queries.filter((query) => query.startsWith('update')).length;
  expect((await f.redeliver()).reply).toMatchObject({ success: true, alreadyCompleted: true });
  expect(f.sql.queries.filter((query) => query.startsWith('update'))).toHaveLength(writes);
  expect(f.creates()).toBe(1);
  expect(f.starts()).toBe(1);
});

it.each(['seed', 'create', 'baseline', 'start'] as const)('holds an uncertain %s intent without repeating it or overwriting data', async (point) => {
  const f = await fixture({ named: true });
  const methods = { seed: 'beginFreshSeed', create: 'freshCreationAttempted', baseline: 'beginFreshBaseline', start: 'activationAttempted' } as const;
  const method = methods[point];
  const original = AppUpdateStage.prototype[method];
  let interrupted = false;
  vi.spyOn(AppUpdateStage.prototype, method).mockImplementation(async function (this: AppUpdateStage) {
    await original.call(this);
    if (!interrupted) {
      interrupted = true;
      throw new Error('Synthetic uncertain install effect');
    }
  });
  expect((await f.execute()).success).toBe(false);
  const creates = f.creates();
  const starts = f.starts();
  const writes = f.sql.queries.filter((query) => query.startsWith('update')).length;
  await fs.writeFile(path.join(f.data, 'keep-interrupted-data'), 'possible-app-data');
  expect((await f.redeliver()).reply).toMatchObject({ success: false });
  expect(f.creates()).toBe(creates);
  expect(f.starts()).toBe(starts);
  expect(f.sql.queries.filter((query) => query.startsWith('update'))).toHaveLength(writes);
  expect(await hasInstallRequestHold(root, urn)).toBe(true);
  expect(await fs.readFile(path.join(f.data, 'keep-interrupted-data'), 'utf8')).toBe('possible-app-data');
});

it.each(['changed', 'extra', 'linked'] as const)('does not create or rewrite a saved install with %s seed data', async (point) => {
  const f = await fixture({ links: true });
  const confirm = AppUpdateStage.prototype.confirmFreshSeed;
  let interrupted = false;
  vi.spyOn(AppUpdateStage.prototype, 'confirmFreshSeed').mockImplementation(async function (this: AppUpdateStage) {
    await confirm.call(this);
    if (!interrupted) {
      interrupted = true;
      throw new Error('Synthetic seed-ready interruption');
    }
  });
  expect((await f.execute()).success).toBe(false);
  const selected = path.join(f.data, 'data/version');
  if (point === 'changed') await fs.writeFile(selected, 'retained-user-data');
  if (point === 'extra') await fs.writeFile(path.join(f.data, 'data/extra'), 'retained-user-data');
  if (point === 'linked') {
    await fs.rename(selected, selected + '.retained');
    await fs.symlink(selected + '.retained', selected);
  }
  expect((await f.redeliver()).reply).toMatchObject({ success: false });
  expect(f.creates()).toBe(0);
  expect(f.starts()).toBe(0);
  expect(f.sql.receipts()).toEqual([]);
  expect(await hasInstallRequestHold(root, urn)).toBe(true);
  if (point === 'changed') expect(await fs.readFile(selected, 'utf8')).toBe('retained-user-data');
});

it('finishes a never-started skip-run install after preparation restart without starting any profile', async () => {
  const f = await fixture({ skipRun: true, named: true, hidden: true, profiles: true });
  const prepared = AppUpdateStage.prototype.preparedFreshStorage;
  let interrupted = false;
  vi.spyOn(AppUpdateStage.prototype, 'preparedFreshStorage').mockImplementation(async function (this: AppUpdateStage, ...args) {
    await prepared.apply(this, args);
    if (!interrupted) {
      interrupted = true;
      throw new Error('Synthetic preparation interruption');
    }
  });
  expect((await f.execute()).success).toBe(false);
  expect((await f.redeliver()).reply).toMatchObject({ success: true, updateStatus: 'stopped' });
  expect(f.creates()).toBe(1);
  expect(f.starts()).toBe(0);
  expect(f.sql.ids()).toEqual(['001-first', '002-current']);
});

it('resumes an interrupted metadata rename when installed apps and control state are on separate mounts', async () => {
  const f = await fixture({ named: true, hidden: true });
  const rename = fs.rename.bind(fs);
  let interrupted = false;
  let retained: string | undefined;
  const metadataMount = path.dirname(f.metadata) + path.sep;
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(from).startsWith(metadataMount) !== String(to).startsWith(metadataMount)) {
      throw Object.assign(new Error('Simulated cross-mount rename'), { code: 'EXDEV' });
    }
    await rename(from, to);
    if (!interrupted && String(from) === f.metadata && String(to).endsWith('/previous-live')) {
      interrupted = true;
      retained = path.dirname(String(to));
      throw new Error('Synthetic interrupted metadata move');
    }
  });
  expect((await f.execute()).success).toBe(false);
  expect(interrupted).toBe(true);
  if (!retained) throw new Error('Missing retained app metadata');
  expect((await fs.stat(retained)).mode & 0o777).toBe(0o700);
  await expect(fs.lstat(f.metadata)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await f.redeliver()).reply).toMatchObject({ success: true, alreadyCompleted: true });
  expect(f.creates()).toBe(1);
  expect(f.starts()).toBe(1);
  expect(await fs.readFile(path.join(f.data, 'data/version'), 'utf8')).toBe('seed=prepared');
  await expect(fs.lstat(retained)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['target', 'selected', 'downloaded', 'bound'] as const)('resumes the same sealed fresh request before context after %s', async (point) => {
  const f = await fixture({ named: true, hidden: true, profiles: true });
  let interrupted = false;
  if (point === 'target') {
    const original = AppUpdateStage.prototype.stageTarget;
    vi.spyOn(AppUpdateStage.prototype, 'stageTarget').mockImplementation(async function (this: AppUpdateStage, ...args) {
      await original.apply(this, args);
      if (!interrupted) {
        interrupted = true;
        throw new Error('Synthetic sealed target interruption');
      }
    });
  }
  if (point === 'selected') {
    const original = AppUpdateStage.prototype.recordFreshPullPlan;
    vi.spyOn(AppUpdateStage.prototype, 'recordFreshPullPlan').mockImplementation(async function (this: AppUpdateStage, ...args) {
      await original.apply(this, args);
      if (!interrupted) {
        interrupted = true;
        throw new Error('Synthetic pre-download interruption');
      }
    });
  }
  if (point === 'downloaded') {
    const original = f.plan.pull;
    vi.spyOn(f.plan, 'pull').mockImplementation(async () => {
      const result = await original();
      if (!interrupted) {
        interrupted = true;
        throw new Error('Synthetic lost image-download reply');
      }
      return result;
    });
  }
  if (point === 'bound') {
    const original = AppUpdateStage.prototype.recordPulledImages;
    vi.spyOn(AppUpdateStage.prototype, 'recordPulledImages').mockImplementation(async function (this: AppUpdateStage, ...args) {
      await original.apply(this, args);
      if (!interrupted) {
        interrupted = true;
        throw new Error('Synthetic pre-context interruption');
      }
    });
  }
  expect((await f.execute()).success).toBe(false);
  expect(interrupted).toBe(true);
  const priorPulls = f.pulls();
  expect((await f.redeliver()).reply).toMatchObject({ success: true, alreadyCompleted: true });
  expect(f.pulls()).toBe(point === 'bound' ? priorPulls : priorPulls + 1);
  expect(f.creates()).toBe(1);
  expect(f.starts()).toBe(1);
  expect(f.sql.ids()).toEqual(['001-first', '002-current']);
  expect(await hasInstallRequestHold(root, urn)).toBe(false);
});

it.each([false, true])('acknowledges fully copied seed data after a lost readiness write without copying again, skipRun=%s', async (skipRun) => {
  const f = await fixture({ skipRun, links: true });
  const original = AppUpdateStage.prototype.confirmFreshSeed;
  let interrupted = false;
  const confirm = vi.spyOn(AppUpdateStage.prototype, 'confirmFreshSeed').mockImplementation(async function (this: AppUpdateStage) {
    if (!interrupted) {
      interrupted = true;
      throw new Error('Synthetic unacknowledged completed copy');
    }
    return original.call(this);
  });
  expect((await f.execute()).success).toBe(false);
  const seed = path.join(f.data, 'data/version');
  const before = await fs.stat(seed);
  expect((await f.redeliver()).reply).toMatchObject({ success: true, updateStatus: skipRun ? 'stopped' : 'running' });
  const after = await fs.stat(seed);
  expect([after.dev, after.ino, after.mtimeMs, after.ctimeMs]).toEqual([before.dev, before.ino, before.mtimeMs, before.ctimeMs]);
  expect(await fs.readFile(seed, 'utf8')).toBe('seed=prepared');
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(f.creates()).toBe(1);
  expect(f.starts()).toBe(skipRun ? 0 : 1);
});

it.each(['partial', 'changed', 'extra'] as const)('keeps unacknowledged %s seed data instead of rewriting or creating containers', async (point) => {
  const f = await fixture({ links: true });
  vi.spyOn(AppUpdateStage.prototype, 'confirmFreshSeed').mockRejectedValue(new Error('Synthetic missing readiness acknowledgement'));
  expect((await f.execute()).success).toBe(false);
  const selected = path.join(f.data, 'data/version');
  if (point === 'partial') await fs.unlink(selected);
  if (point === 'changed') await fs.writeFile(selected, 'preserved-interrupted-data');
  if (point === 'extra') await fs.writeFile(path.join(f.data, 'data/new-data'), 'preserved-interrupted-data');
  expect((await f.redeliver()).reply).toMatchObject({ success: false });
  expect(f.creates()).toBe(0);
  expect(f.starts()).toBe(0);
  expect(f.sql.receipts()).toEqual([]);
  expect(await hasInstallRequestHold(root, urn)).toBe(true);
  if (point === 'changed') expect(await fs.readFile(selected, 'utf8')).toBe('preserved-interrupted-data');
});

it('preserves an unsealed package instead of replacing it from a later catalogue during redelivery', async () => {
  const f = await fixture();
  vi.spyOn(AppUpdateStage.prototype, 'stageTarget').mockRejectedValue(new Error('Synthetic interrupted package preparation'));
  expect((await f.execute()).success).toBe(false);
  expect((await f.redeliver()).reply).toMatchObject({ success: false });
  expect(f.pulls()).toBe(0);
  expect(f.creates()).toBe(0);
  expect(f.starts()).toBe(0);
  expect(f.sql.receipts()).toEqual([]);
  expect(await hasInstallRequestHold(root, urn)).toBe(true);
  expect(await fs.readFile(path.join(stage?.targetDirectory ?? '', 'config.json'), 'utf8')).toContain('1.0.0');
});

it.each(['version', 'ledger', 'inputs', 'storage', 'form'] as const)('holds pre-context recovery when its saved %s changed', async (point) => {
  const f = await fixture();
  const record = AppUpdateStage.prototype.recordPulledImages;
  let interrupted = false;
  vi.spyOn(AppUpdateStage.prototype, 'recordPulledImages').mockImplementation(async function (this: AppUpdateStage, ...args) {
    await record.apply(this, args);
    if (!interrupted) {
      interrupted = true;
      throw new Error('Synthetic pre-context interruption');
    }
  });
  expect((await f.execute()).success).toBe(false);
  if (point === 'version') f.sql.row().version = 2;
  if (point === 'ledger') f.sql.setIds(['unknown-history']);
  if (point === 'inputs') vi.spyOn(f.plan, 'isCurrent').mockResolvedValue(false);
  if (point === 'storage') {
    await fs.rename(f.data, f.data + '.retained');
    await fs.mkdir(f.data, { mode: 0o777 });
  }
  expect((await f.redeliver(point === 'form' ? { skipRun: true } : undefined)).reply).toMatchObject({ success: false });
  expect(f.pulls()).toBe(1);
  expect(f.creates()).toBe(0);
  expect(f.starts()).toBe(0);
  expect(f.sql.receipts()).toEqual([]);
  expect(await hasInstallRequestHold(root, urn)).toBe(true);
});

it('does not promote an old unbound target into a fresh preparation request', async () => {
  const f = await fixture();
  await fs.mkdir(f.metadata, { recursive: true, mode: 0o750 });
  await fs.mkdir(f.data, { recursive: true, mode: 0o777 });
  stage = await AppUpdateStage.create({
    directory: f.pins,
    appUrn: urn,
    requestId: f.request.requestId,
    metadata: f.metadata,
    env: path.join(f.data, 'app.env'),
  });
  await copyAppPackage(path.join(root, 'catalogue'), stage.targetDirectory);
  await stage.stageTarget('services: {}', 'APP_DATA_DIR=' + host);
  await stage.close();
  expect((await f.redeliver()).reply).toMatchObject({ success: false });
  expect(f.pulls()).toBe(0);
  expect(f.creates()).toBe(0);
  expect(f.starts()).toBe(0);
  expect(await hasInstallRequestHold(root, urn)).toBe(true);
});
