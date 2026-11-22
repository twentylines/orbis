import { freshInstallSql } from '@/tests/helpers/fresh-install-sql';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';
import { AppLifecycleCommandFactory } from '../../app-lifecycle/app-lifecycle-command.factory';
import { AppFilesManager } from '../../apps/app-files-manager';
import { AppHelpers } from '../../apps/app.helpers';
import { AppsRepository as RepositoryToken } from '../../apps/apps.repository';
import { MarketplaceService } from '../../marketplace/marketplace.service';
import { SubnetManagerService } from '../../network/subnet-manager.service';
import { TasksService } from '../../tasks/tasks.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { DockerService as DockerToken } from '../../docker/docker.service';
import { readAppMigrationIds, readAppMigrationSources } from '../../apps/app-migrations';
import { migrationRollbackBinding } from '../../apps/app-migration-rollback';
import { rollbackMigratingAppUpdate } from '../../app-lifecycle/commands/rollback-app-update';
import { resumeMigratingAppUpdate } from '../../app-lifecycle/commands/resume-app-migrations';
import { appMigrationCommitBinding, verifyAppMigrationCommitReceipt } from '../../apps/app-migration-commit';
import { requireAppImagePinUpdate } from '../../docker/app-image-pins';
import { convertLegacyToYaml } from '@runtipi/common/schemas';
import type { ModuleRef } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { mock } from 'vitest-mock-extended';
import { LoggerService as LoggerToken } from '@/core/logger/logger.service';
import { AppLifecycleService } from '../../app-lifecycle/app-lifecycle.service';
import { BackupManager } from '../backup.manager';
import { AsyncMutex } from '@/utils/mutex/async-mutex';
import { APP_ASYNC_MUTEX } from '@/utils/mutex/mutex.module';
import { appEventResultSchema } from '../../queue/entities/app-events';
import { DOCKERODE } from '../../docker/docker.module';
import type { AppMigrationSource } from '../../apps/app-migrations';
import { AppUpdateMigrations } from '../../docker/app-update-migrations';
import { AppUpdateStage } from '../../docker/app-update-stage';
import { DockerService } from '../../docker/docker.service';
import type { AppsRepository } from '../../apps/apps.repository';
import { AppStorageWitness } from '../../host-updates/app-storage-observation';
import { ArchiveService } from '@/core/archive/archive.service';
import type { LoggerService } from '@/core/logger/logger.service';
import Dockerode from 'dockerode';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { AppMigrationJournal, migrationHash, type MigrationOperation } from '../app-migration-journal';
import { AppMigrationRunner } from '../../docker/app-migration-runner';
import { BackupDirectorySwap } from '../../system-backups/backup-directory-swap';
import { migrationEngineRequest } from '../../docker/app-migration-engine';
import { parseAppMigration } from '../../docker/app-migration-plan';
import type { AppStorageObservation } from '../../host-updates/app-storage-observation';

const oldId = 'a'.repeat(64);
const newId = 'b'.repeat(64);
const oldImage = 'sha256:' + 'c'.repeat(64);
const newImage = 'sha256:' + 'd'.repeat(64);
const host = '/fixture/app-data/store/demo';
type RecipeBody = {
  Image: string;
  Entrypoint: string[];
  Labels: Record<string, string>;
  HostConfig: { Mounts: { Source: string; Target: string; ReadOnly: boolean }[]; [key: string]: unknown };
  [key: string]: unknown;
};
type EngineRequest = { path: string; method: string; options: Record<string, unknown> };
type Container = {
  Id: string;
  Image: string;
  Name?: string;
  RestartCount?: number;
  State: ReturnType<typeof stateCreated>;
  Config: { Labels: Record<string, string>; [key: string]: unknown };
  HostConfig?: Record<string, unknown>;
  Mounts: { Type: string; Source: string; Destination: string; RW: boolean; Propagation?: string }[];
};

let root: string;
let migrationJournalRoot: string;
let data: string;
let operation: MigrationOperation;
let observation: AppStorageObservation;
let storage: AppStorageWitness;
let archive: ArchiveService;
let docker: Dockerode;
let journal: AppMigrationJournal | undefined;
let original: Container;
let foreign: Container | undefined;
let child: Container | undefined;
let calls: EngineRequest[];
let behavior: string;
let writes: number;
let oldStarts: number;
let oldPauses: number;
let killCount: number;
let definition: ReturnType<typeof parseAppMigration>;
let migrationSource: AppMigrationSource;
let updateStage: AppUpdateStage | undefined;
let coordinator: AppUpdateMigrations | undefined;

const stateCreated = () => ({
  Running: false,
  Restarting: false,
  Paused: false,
  Dead: false,
  Pid: 0,
  Status: 'created',
  StartedAt: '0001-01-01T00:00:00Z',
  FinishedAt: '0001-01-01T00:00:00Z',
  ExitCode: 0,
  Error: '',
  OOMKilled: false,
});
const stopped = (exitCode = 0) => ({
  ...stateCreated(),
  Status: 'exited',
  ExitCode: exitCode,
  StartedAt: '2026-11-22T00:00:01Z',
  FinishedAt: '2026-11-22T00:00:02Z',
});
const error = () => Object.assign(new Error('Synthetic lost Engine reply'), { statusCode: 500 });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'mr-'));
  migrationJournalRoot = path.join(root, 'operations');
  data = path.join(root, 'data');
  await fs.mkdir(data);
  await fs.mkdir(path.join(data, 'db'));
  await fs.writeFile(path.join(data, 'db', 'version'), 'before');
  const bytes = Buffer.from(
    stringify({
      services: {
        migration: {
          image: 'postgres:16.1',
          user: 'postgres',
          volumes: [host + '/db:/var/lib/postgresql/data'],
          entrypoint: ['/bin/sh', '-euc'],
          command: ['printf migration'],
          environment: { ROLE_INPUT: 'fixture-value' },
        },
      },
    }),
  );
  migrationSource = { id: '001-upgrade', sha256: createHash('sha256').update(bytes).digest('hex'), bytes };
  definition = parseAppMigration(
    { id: '001-upgrade', sha256: createHash('sha256').update(bytes).digest('hex'), bytes },
    { appDataHostPath: host, environment: {} },
  );
  operation = {
    version: 1,
    requestId: randomUUID(),
    stageId: randomUUID(),
    appUrn: 'demo:store',
    appId: 1,
    createdAt: 123,
    fromVersion: 1,
    toVersion: 2,
    previousLedger: { baselined: true, migrationIds: [] },
    images: [
      {
        migrationId: definition.id,
        sourceSha256: definition.sourceSha256,
        definitionSha256: migrationHash(definition),
        imageId: newImage,
        reference: 'docker.io/library/postgres@sha256:' + 'e'.repeat(64),
        platform: 'linux/amd64',
      },
    ],
    originalContainers: [{ id: oldId, imageId: oldImage, service: 'web' }],
  };
  observation = {
    schema: 'orbis.app-storage-observation.v1',
    appUrn: operation.appUrn,
    nonce: 'f'.repeat(64),
    controller: { id: '1'.repeat(64), imageId: 'sha256:' + '2'.repeat(64), startedAt: 'fixture-start', definitionSha256: '3'.repeat(64) },
    daemonSha256: '4'.repeat(64),
    dockerSocket: { device: '1', inode: '2' },
    hostBasePath: '/fixture/app-data',
    hostPath: host,
    containerPath: data,
    directory: { device: String((await fs.stat(data)).dev), inode: String((await fs.stat(data)).ino), uid: 0, gid: 0, mode: 0o700 },
    mountTablesSha256: '5'.repeat(64),
    controllerNamespace: '1:3',
    bindingSha256: '6'.repeat(64),
  };
  original = {
    Id: oldId,
    Image: oldImage,
    State: stopped(),
    Config: {
      Labels: {
        'runtipi.managed': 'true',
        'runtipi.appurn': 'demo:store',
        'com.docker.compose.project': 'demo_store',
        'com.docker.compose.service': 'web',
      },
    },
    Mounts: [{ Type: 'bind', Source: host + '/db', Destination: '/data', RW: true }],
  };
  child = undefined;
  foreign = undefined;
  calls = [];
  behavior = '';
  writes = 0;
  oldStarts = 0;
  oldPauses = 0;
  killCount = 0;
  const handle = async (request: EngineRequest) => {
    calls.push(structuredClone(request));
    if (request.path === '/containers/json?') {
      if (request.options.filters === undefined)
        return [original, ...(child ? [child] : []), ...(foreign ? [foreign] : [])].map(({ Id }) => ({ Id }));
      const filters = JSON.parse(String(request.options.filters)) as { label: string[] };
      return filters.label.some((value: string) => value.startsWith('com.docker.compose.project='))
        ? [{ Id: oldId }]
        : child
          ? [{ Id: child.Id }]
          : [];
    }
    if (request.path === '/distribution/docker.io/library/postgres:16.1/json')
      return { Descriptor: { digest: 'sha256:' + 'e'.repeat(64) }, Platforms: [{ os: 'linux', architecture: 'amd64' }] };
    if (request.path === '/images/create?') return Readable.from(['{"status":"ready"}\n']);
    if (request.path === '/images/' + newImage + '/json' || request.path === '/images/docker.io/library/postgres@sha256:' + 'e'.repeat(64) + '/json')
      return {
        Id: newImage,
        RepoDigests: ['docker.io/library/postgres@sha256:' + 'e'.repeat(64)],
        Os: 'linux',
        Architecture: 'amd64',
        Config: {
          User: 'postgres',
          Env: ['PGDATA=/var/lib/postgresql/data', 'PATH=/usr/bin'],
          Entrypoint: [],
          Cmd: [],
          Volumes: { '/var/lib/postgresql/data': {} },
        },
      };
    if (request.path === '/containers/' + oldId + '/json') {
      if (behavior === 'lost-old-inspection' && oldStarts) throw error();
      return structuredClone(original);
    }
    if (request.path === '/containers/' + oldId + '/stop?') {
      original.State = stopped();
      return {};
    }
    if (request.path === '/containers/' + oldId + '/unpause?') {
      original.State.Paused = false;
      return {};
    }
    if (request.path === '/containers/' + oldId + '/start?') {
      expect((await updateStage?.read())?.rollback?.runtime[oldId]?.phase).toBe('start-intent');
      expect(await fs.readFile(path.join(root, 'metadata/source.json'), 'utf8')).toBe('original');
      oldStarts++;
      if (behavior !== 'old-start-no-run')
        original.State = { ...stopped(), Running: true, Pid: 77, Status: 'running', StartedAt: '2026-11-22T00:00:03Z' };
      if (['lost-old-start', 'old-start-no-run', 'lost-old-inspection'].includes(behavior)) throw error();
      return {};
    }
    if (request.path === '/containers/' + oldId + '/pause?') {
      expect((await updateStage?.read())?.rollback?.runtime[oldId]?.phase).toBe('pause-intent');
      oldPauses++;
      original.State.Paused = true;
      return {};
    }
    if (foreign && request.path === '/containers/' + foreign.Id + '/json') return structuredClone(foreign);
    if (request.path === '/containers/create?') {
      const body = structuredClone(request.options._body) as RecipeBody;
      child = {
        Id: newId,
        Name: '/' + (request.options._query as { name: string }).name,
        Image: body.Image,
        RestartCount: 0,
        Config: { ...body, Entrypoint: body.Entrypoint[0] === '' ? [] : body.Entrypoint },
        HostConfig: body.HostConfig,
        Mounts: body.HostConfig.Mounts.map((mount) => ({
          Type: 'bind',
          Source: behavior === 'wrong-mount' ? '/foreign/data' : mount.Source,
          Destination: mount.Target,
          RW: !mount.ReadOnly,
          Propagation: 'rprivate',
        })),
        State: stateCreated(),
      };
      if (behavior === 'lost-create') throw error();
      return { Id: newId, Warnings: [] };
    }
    if (request.path === '/containers/' + newId + '/json') {
      if (!child || behavior === 'disappeared') throw Object.assign(error(), { statusCode: 404 });
      return structuredClone(child);
    }
    if (request.path === '/containers/' + newId + '/start?') {
      const retained = JSON.parse(await fs.readFile(path.join(migrationJournalRoot, operation.requestId, 'journal.json'), 'utf8'));
      expect(retained.phase).toBe('running');
      expect(retained.runners[0].phase).toBe('start-intent');
      expect(retained.checkpoint.sha256).toMatch(/^[a-f0-9]{64}$/);
      if (behavior === 'lost-start-without-run') throw error();
      if (!child) throw error();
      child.State = { ...stateCreated(), Running: true, Pid: 42, Status: 'running', StartedAt: '2026-11-22T00:00:01Z' };
      writes++;
      await fs.writeFile(path.join(data, 'db', 'version'), 'after');
      if (behavior === 'lost-start') throw error();
      return {};
    }
    if (request.path === '/containers/' + newId + '/wait?') {
      if (!child) throw error();
      if (['wait-error', 'never-stops'].includes(behavior)) throw error();
      if (behavior !== 'lost-start-without-run') child.State = stopped(behavior === 'script-failed' ? 9 : 0);
      if (behavior === 'old-restarted-after-script') original.State = { ...stopped(), Running: true, Pid: 99, Status: 'running' };
      return { StatusCode: 0 };
    }
    if (request.path === '/containers/' + newId + '/kill?') {
      killCount++;
      if (child && behavior !== 'never-stops') child.State = stopped(137);
      return {};
    }
    throw new Error('Unexpected modeled Engine request');
  };
  docker = {
    modem: {
      dial: (request: EngineRequest, callback: (error: unknown, value?: unknown) => void) => {
        void handle({ path: request.path, method: request.method, options: request.options }).then(
          (value) => callback(null, value),
          (error) => callback(error),
        );
      },
    },
  } as unknown as Dockerode;
  // Storage admission/native processes are modeled here; actual files, tar,
  // fsync journal, immutable create body and API ordering are exercised.
  storage = {
    use: async (effect: (client: Dockerode, metadata: AppStorageObservation) => Promise<unknown>) => effect(docker, structuredClone(observation)),
  } as unknown as AppStorageWitness;
  archive = new ArchiveService({ debug: vi.fn() } as unknown as LoggerService);
});
afterEach(async () => {
  await coordinator?.close();
  coordinator = undefined;
  await updateStage?.close();
  updateStage = undefined;
  vi.restoreAllMocks();
  await journal?.close();
  journal = undefined;
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
async function allocate() {
  journal = await AppMigrationJournal.create(path.join(root, 'operations'), operation, storage);
  return journal;
}
async function ready() {
  const value = await allocate();
  await value.capture(storage, data, archive);
  return value;
}
const plans = () => {
  const image = operation.images[0];
  if (!image) throw new Error('Fixture image is unavailable');
  return [{ definition, image }];
};

it('forces a durable private checkpoint containing the old data before an isolated immutable process can start', async () => {
  const value = await ready();
  await new AppMigrationRunner(value, storage).run(plans());
  expect((await value.read()).phase).toBe('migrations-complete');
  expect((await value.read()).runners[0]).toMatchObject({ phase: 'terminal', exitCode: 0, containerId: newId });
  expect(await fs.readFile(path.join(data, 'db/version'), 'utf8')).toBe('after');
  const extracted = path.join(root, 'checkpoint');
  await fs.mkdir(extracted);
  expect((await archive.extractTarGz(path.join(value.directory, 'before.tar.gz'), extracted)).stderr).toBe('');
  expect(await fs.readFile(path.join(extracted, 'db/version'), 'utf8')).toBe('before');
  expect((await fs.stat(path.join(value.directory, 'before.tar.gz'))).mode & 0o777).toBe(0o600);
  const create = calls.find(({ path }) => path === '/containers/create?');
  expect(create?.options._query).toEqual({ name: (await value.read()).runners[0]?.name });
  expect(create?.options._body).toMatchObject({
    Image: newImage,
    HostConfig: {
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      AutoRemove: false,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      RestartPolicy: { Name: 'no' },
    },
  });
  expect(create?.options).not.toHaveProperty('Env');
  expect(killCount).toBe(0);
  expect(writes).toBe(1);
});

it.each(['lost-create', 'lost-start'])('reconciles %s without a duplicate create or start', async (mode) => {
  behavior = mode;
  const value = await ready();
  await new AppMigrationRunner(value, storage).run(plans());
  expect(calls.filter(({ path }) => path === '/containers/create?')).toHaveLength(1);
  expect(calls.filter(({ path }) => path.endsWith('/start?'))).toHaveLength(1);
  expect(writes).toBe(1);
});

it('does not interpret an uncertain unexecuted start or wait result as completion', async () => {
  behavior = 'lost-start-without-run';
  const value = await ready();
  await expect(new AppMigrationRunner(value, storage).run(plans())).rejects.toThrow('verified recovery');
  expect((await value.read()).phase).toBe('recovery-required');
  expect((await value.read()).runners[0]?.phase).toBe('start-intent');
  await expect(new AppMigrationRunner(value, storage).run(plans())).rejects.toThrow();
  expect(calls.filter(({ path }) => path.endsWith('/start?'))).toHaveLength(1);
  expect(writes).toBe(0);
});

it.each(['wait-error', 'never-stops', 'script-failed'])('preserves the checkpoint and refuses completion after %s', async (mode) => {
  behavior = mode;
  const value = await ready();
  await expect(new AppMigrationRunner(value, storage).run(plans())).rejects.toThrow();
  expect((await value.read()).phase).toBe('recovery-required');
  await value.verifyCheckpoint();
  expect(killCount).toBe(mode === 'script-failed' ? 0 : 1);
  expect((await value.read()).runners[0]?.phase).toBe(mode === 'never-stops' ? 'start-intent' : 'terminal');
});

it('does not start a container with a wrong data mount', async () => {
  behavior = 'wrong-mount';
  const value = await ready();
  await expect(new AppMigrationRunner(value, storage).run(plans())).rejects.toThrow();
  expect(writes).toBe(0);
  expect(killCount).toBe(0);
});

it('refuses checkpointing while an original writer is running or has unprotected writable storage', async () => {
  original.State = { ...stopped(), Running: true, Pid: 100, Status: 'running' };
  const value = await allocate();
  await expect(value.capture(storage, data, archive)).rejects.toThrow();
  expect((await value.read()).phase).toBe('capturing');
  expect(writes).toBe(0);
});

it('detects archive corruption before any script start', async () => {
  const value = await ready();
  await fs.appendFile(path.join(value.directory, 'before.tar.gz'), 'changed');
  await expect(new AppMigrationRunner(value, storage).run(plans())).rejects.toThrow();
  expect(writes).toBe(0);
  expect(calls.some(({ path }) => path === '/containers/create?')).toBe(false);
});

it('reopens an exact durable operation and refuses changed request, stage, ledger or private journal bytes', async () => {
  const value = await ready();
  await value.close();
  for (const changed of [
    { ...operation, stageId: randomUUID() },
    { ...operation, previousLedger: { baselined: true, migrationIds: ['000-other'] } },
  ]) {
    await expect(AppMigrationJournal.open(path.join(root, 'operations'), changed)).rejects.toThrow();
  }
  journal = await AppMigrationJournal.open(path.join(root, 'operations'), operation);
  expect((await journal.read()).checkpoint?.sha256).toMatch(/^[a-f0-9]{64}$/);
  await fs.writeFile(path.join(journal.directory, 'journal.json'), '{}');
  await expect(journal.read()).rejects.toThrow();
});

it('retains the target-writes marker even if a later phase requires recovery', async () => {
  const value = await ready();
  await new AppMigrationRunner(value, storage).run(plans());
  await value.activationAttempted();
  await value.requireRecovery();
  expect((await value.read()).targetWritesPossible).toBe(true);
  expect((await value.read()).phase).toBe('recovery-required');
  await expect(new AppMigrationRunner(value, storage).run(plans())).rejects.toThrow();
  expect(writes).toBe(1);
});

it('refuses duplicate live handles and accidental serialization of private state', async () => {
  const value = await allocate();
  await expect(AppMigrationJournal.open(path.join(root, 'operations'), operation)).rejects.toThrow();
  expect(() => JSON.stringify(value)).toThrow();
});

it('does not publish ready when the storage witness rejects its post-capture verification', async () => {
  const value = await allocate();
  const failedPostcheck = {
    use: async (effect: (client: Dockerode, metadata: AppStorageObservation) => Promise<unknown>) => {
      await effect(docker, structuredClone(observation));
      throw new Error('Synthetic changed storage after capture');
    },
  } as unknown as AppStorageWitness;
  await expect(value.capture(failedPostcheck, data, archive)).rejects.toThrow();
  expect((await value.read()).phase).toBe('capturing');
  expect((await value.read()).checkpoint).toBeNull();
  expect((await fs.stat(path.join(value.directory, 'before.tar.gz'))).isFile()).toBe(true);
});

it.each(['original-restarted', 'migration-restarted', 'missing-container'])(
  'revalidates completed work after %s instead of rerunning',
  async (mode) => {
    const value = await ready();
    await new AppMigrationRunner(value, storage).run(plans());
    if (mode === 'original-restarted') original.State = { ...stopped(), Running: true, Pid: 77 };
    else if (mode === 'migration-restarted' && child) child.State = { ...stopped(), Running: true, Pid: 78 };
    else behavior = 'disappeared';
    await expect(new AppMigrationRunner(value, storage).run([])).rejects.toThrow();
    expect((await value.read()).phase).toBe('recovery-required');
    expect(writes).toBe(1);
    expect(calls.filter(({ path }) => path.endsWith('/start?'))).toHaveLength(1);
  },
);

it('reopens a completed operation without requiring historical definitions or starting it again', async () => {
  const value = await ready();
  await new AppMigrationRunner(value, storage).run(plans());
  await value.close();
  journal = await AppMigrationJournal.open(path.join(root, 'operations'), operation);
  await new AppMigrationRunner(journal, storage).run([]);
  expect((await journal.read()).phase).toBe('migrations-complete');
  expect(writes).toBe(1);
});

it('restores the protected baseline before target activation and retains the changed data separately', async () => {
  behavior = 'script-failed';
  const value = await ready();
  const rootIdentity = await fs.stat(data);
  await expect(new AppMigrationRunner(value, storage).run(plans())).rejects.toThrow();
  await new AppMigrationRunner(value, storage).restoreCheckpoint([], data, archive);
  expect((await value.read()).phase).toBe('restored');
  expect(await fs.readFile(path.join(data, 'db/version'), 'utf8')).toBe('before');
  expect((await fs.stat(data)).ino).toBe(rootIdentity.ino);
  const attempt = (await value.read()).restores[0];
  expect(attempt?.phase).toBe('committed');
  expect(await fs.readFile(path.join(data, `.orbis-restore-${attempt?.id}.previous/db/version`), 'utf8')).toBe('after');
  await value.verifyCheckpoint();
  await value.close();
  journal = await AppMigrationJournal.open(path.join(root, 'operations'), operation);
  await new AppMigrationRunner(journal, storage).restoreCheckpoint([], data, archive);
  expect((await journal.read()).restores).toHaveLength(1);
  expect(writes).toBe(1);
});

it('never automatically restores after the target could have written data', async () => {
  const value = await ready();
  await new AppMigrationRunner(value, storage).run(plans());
  await value.activationAttempted();
  await value.requireRecovery();
  await fs.writeFile(path.join(data, 'db/version'), 'new-live-data');
  await expect(new AppMigrationRunner(value, storage).restoreCheckpoint([], data, archive)).rejects.toThrow();
  expect(await fs.readFile(path.join(data, 'db/version'), 'utf8')).toBe('new-live-data');
  expect((await value.read()).restores).toHaveLength(0);
});

it('refuses restoration while a failed owned process cannot be proved stopped', async () => {
  behavior = 'never-stops';
  const value = await ready();
  await expect(new AppMigrationRunner(value, storage).run(plans())).rejects.toThrow();
  // A pre-aborted cleanup must not begin any filesystem moves.
  await expect(new AppMigrationRunner(value, storage).restoreCheckpoint(plans(), data, archive, AbortSignal.abort())).rejects.toThrow();
  expect((await value.read()).restores).toHaveLength(0);
  expect(await fs.readFile(path.join(data, 'db/version'), 'utf8')).toBe('after');
});

it('recovers an interrupted promotion by reversing its recorded moves before a fresh restore', async () => {
  behavior = 'script-failed';
  const value = await ready();
  await expect(new AppMigrationRunner(value, storage).run(plans())).rejects.toThrow();
  const rename = fs.rename.bind(fs);
  let interrupted = false;
  const injected = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    await rename(from, to);
    if (!interrupted && String(from).endsWith('/data/db')) {
      interrupted = true;
      throw new Error('Synthetic lost rename completion');
    }
  });
  await expect(new AppMigrationRunner(value, storage).restoreCheckpoint([], data, archive)).rejects.toThrow();
  expect(interrupted).toBe(true);
  expect((await value.read()).restores[0]?.phase).toBe('promoting');
  injected.mockRestore();
  await value.close();
  journal = await AppMigrationJournal.open(path.join(root, 'operations'), operation);
  await new AppMigrationRunner(journal, storage).restoreCheckpoint([], data, archive);
  expect(await fs.readFile(path.join(data, 'db/version'), 'utf8')).toBe('before');
  expect((await journal.read()).restores.map(({ phase }) => phase)).toEqual(['abandoned', 'committed']);
  expect(writes).toBe(1);
});

it('reconciles a lost restore commit reply without replacing data for a second time', async () => {
  behavior = 'script-failed';
  const value = await ready();
  await expect(new AppMigrationRunner(value, storage).run(plans())).rejects.toThrow();
  const commit = BackupDirectorySwap.prototype.commit;
  const injected = vi.spyOn(BackupDirectorySwap.prototype, 'commit').mockImplementationOnce(async function (this: BackupDirectorySwap) {
    await commit.call(this);
    throw new Error('Synthetic lost committed reply');
  });
  await expect(new AppMigrationRunner(value, storage).restoreCheckpoint([], data, archive)).rejects.toThrow();
  injected.mockRestore();
  const restoredInode = (await fs.stat(path.join(data, 'db'))).ino;
  await value.close();
  journal = await AppMigrationJournal.open(path.join(root, 'operations'), operation);
  await new AppMigrationRunner(journal, storage).restoreCheckpoint([], data, archive);
  expect((await journal.read()).restores).toHaveLength(1);
  expect((await fs.stat(path.join(data, 'db'))).ino).toBe(restoredInode);
});

it('binds a reopened swap to its operation ID and app root before examining or moving data', async () => {
  const value = await ready();
  const attempt = await value.beginRestore();
  const location = path.join(value.directory, `restore-${attempt.id}`);
  await BackupDirectorySwap.create({ id: attempt.id, root: data, journal: location });
  await expect(BackupDirectorySwap.open(location, { id: randomUUID(), root: data })).rejects.toThrow();
  await expect(BackupDirectorySwap.open(location, { id: attempt.id, root: path.join(root, 'different') })).rejects.toThrow();
  expect(await fs.readFile(path.join(data, 'db/version'), 'utf8')).toBe('before');
});

it.each([host, host + '/db', '/fixture/app-data', '/'])(
  'refuses a foreign writable container overlapping %s before checkpoint or recovery',
  async (source) => {
    foreign = { ...structuredClone(original), Id: '9'.repeat(64), Mounts: [{ Type: 'bind', Source: source, Destination: '/foreign', RW: true }] };
    const value = await allocate();
    await expect(value.capture(storage, data, archive)).rejects.toThrow();
    expect((await value.read()).checkpoint).toBeNull();
    expect(writes).toBe(0);
  },
);

it('serializes concurrent execution handles and refuses closing an in-flight journal', async () => {
  const value = await ready();
  let release = () => {};
  let started = () => {};
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const extract = archive.extractTarGz;
  vi.spyOn(archive, 'extractTarGz').mockImplementationOnce(async (...args) => {
    started();
    await blocked;
    return extract(...args);
  });
  const first = new AppMigrationRunner(value, storage).restoreCheckpoint([], data, archive);
  await entered;
  await expect(new AppMigrationRunner(value, storage).run(plans())).rejects.toThrow();
  await expect(value.close()).rejects.toThrow();
  release();
  await first;
  expect((await value.read()).phase).toBe('restored');
  expect(writes).toBe(0);
});

it('sends create values in the body and aborts a hanging wait through the installed Docker client', async () => {
  const received: { url: string; body: string }[] = [];
  let waitSeen = () => {};
  let waitClosed = () => {};
  const waiting = new Promise<void>((resolve) => {
    waitSeen = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    waitClosed = resolve;
  });
  const server = http.createServer((request, response) => {
    if (request.url?.includes('/wait')) {
      waitSeen();
      response.on('close', () => waitClosed());
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ url: request.url ?? '', body: Buffer.concat(chunks).toString() });
      response.writeHead(201, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ Id: newId }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP fixture unavailable');
    const client = new Dockerode({ host: '127.0.0.1', port: address.port, version: 'v1.47' });
    await migrationEngineRequest(
      client,
      '/containers/create?',
      'POST',
      { _query: { name: 'fixture' }, _body: { Image: newImage, Env: ['ROLE_INPUT=fixture-value'] } },
      AbortSignal.timeout(2000),
    );
    expect(received[0]?.url).toBe('/v1.47/containers/create?name=fixture');
    expect(JSON.parse(received[0]?.body ?? '')).toEqual({ Image: newImage, Env: ['ROLE_INPUT=fixture-value'] });
    const abort = new AbortController();
    const pending = migrationEngineRequest(client, `/containers/${newId}/wait?`, 'POST', { condition: 'not-running' }, abort.signal);
    const refusal = expect(pending).rejects.toThrow('verified recovery');
    await waiting;
    abort.abort();
    await refusal;
    await closed;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

it('persists SQL intent for a stopped target and never restores on an uncertain commit result', async () => {
  const value = await ready();
  await new AppMigrationRunner(value, storage).run(plans());
  // The target was not started. SQL uncertainty must still fence restoration.
  await value.beginCommit();
  expect((await value.read()).targetWritesPossible).toBe(false);
  expect((await value.read()).commitAttempted).toBe(true);
  await value.requireRecovery();
  await value.close();
  journal = await AppMigrationJournal.open(path.join(root, 'operations'), operation);
  await expect(new AppMigrationRunner(journal, storage).restoreCheckpoint([], data, archive)).rejects.toThrow();
  await expect(new AppMigrationRunner(journal, storage).run(plans())).rejects.toThrow();
  expect(await fs.readFile(path.join(data, 'db/version'), 'utf8')).toBe('after');
  expect((await journal.read()).restores).toHaveLength(0);
});

it('retains an exact commit acknowledgement across restart and rejects a different receipt', async () => {
  const value = await ready();
  await new AppMigrationRunner(value, storage).run(plans());
  await value.activationAttempted();
  await value.beginCommit();
  const receipt = '0'.repeat(64);
  await value.confirmCommitted(receipt);
  await value.close();
  journal = await AppMigrationJournal.open(path.join(root, 'operations'), operation);
  expect((await journal.read()).commitReceiptSha256).toBe(receipt);
  await journal.confirmCommitted(receipt);
  await expect(journal.confirmCommitted('1'.repeat(64))).rejects.toThrow();
  expect((await journal.read()).phase).toBe('committed');
});

it('requires completed migrations before creating any SQL commit intent', async () => {
  const value = await ready();
  await expect(value.beginCommit()).rejects.toThrow();
  expect((await value.read()).commitAttempted).toBe(false);
});

it('does not finish the migration batch if the original writer restarts after its last script', async () => {
  behavior = 'old-restarted-after-script';
  const value = await ready();
  await expect(new AppMigrationRunner(value, storage).run(plans())).rejects.toThrow();
  expect((await value.read()).phase).toBe('recovery-required');
  expect((await value.read()).runners[0]?.exitCode).toBe(0);
  await expect(value.beginCommit()).rejects.toThrow();
});

async function prepareUpdate(
  options: { changedInputs?: boolean; wrongDataPath?: boolean; unbaselined?: boolean; originallyStopped?: boolean; paused?: boolean } = {},
) {
  const metadata = path.join(root, 'metadata');
  await fs.mkdir(metadata, { mode: 0o750 });
  await fs.writeFile(path.join(metadata, 'source.json'), 'original', { mode: 0o640 });
  await fs.writeFile(path.join(data, 'app.env'), 'OLD=true', { mode: 0o600 });
  updateStage = await AppUpdateStage.create({
    directory: path.join(root, 'pins'),
    appUrn: operation.appUrn,
    metadata,
    env: path.join(data, 'app.env'),
    requestId: operation.requestId,
  });
  operation.stageId = updateStage.id;
  await fs.mkdir(updateStage.targetDirectory, { mode: 0o750 });
  await fs.writeFile(path.join(updateStage.targetDirectory, 'source.json'), 'target', { mode: 0o640 });
  await updateStage.stageTarget('services: {}', 'NEW=true');
  await updateStage.recordPulledImages({ activationSha256: 'f'.repeat(64), imageIds: { web: newImage } });
  await updateStage.recordContext({
    appId: operation.appId,
    appCreatedAt: operation.createdAt,
    fromVersion: operation.fromVersion,
    toVersion: operation.toVersion,
    requestInputSha256: '9'.repeat(64),
    authoritySha256: '8'.repeat(64),
    previousLedger: { ...operation.previousLedger, baselined: !options.unbaselined },
    targetMigrationIds: [definition.id],
    updateStatus: options.originallyStopped ? 'stopped' : 'running',
    originalContainers: [
      { id: oldId, imageId: oldImage, service: 'web', running: !options.originallyStopped, paused: !!options.paused, restarting: false },
    ],
  });
  const close = vi.fn(async () => {});
  Object.assign(storage, { close });
  vi.spyOn(AppStorageWitness, 'open').mockResolvedValue(storage);
  let reads = 0;
  const service = {
    readAppUpdateMigrationInputs: async () => ({
      sources: [migrationSource],
      environment: {
        APP_DATA_DIR: options.wrongDataPath ? '/foreign/data' : host,
        BOUND_VALUE: options.changedInputs && ++reads > 1 ? 'changed' : 'saved',
      },
    }),
  } as unknown as DockerService;
  coordinator = await AppUpdateMigrations.prepare({
    stage: updateStage,
    appUrn: operation.appUrn as never,
    service,
    docker,
    localDirectory: data,
    journalRoot: migrationJournalRoot,
    socketPath: path.join(root, 'modeled-host.sock'),
    architecture: 'amd64',
    archive,
  });
  return { close, service };
}
it('connects sealed update inputs, real checkpoint/runner and acknowledged atomic completion', async () => {
  await prepareUpdate();
  if (!coordinator || !updateStage) throw new Error('Missing coordinator');
  expect((await coordinator.journal.read()).phase).toBe('allocated');
  expect(writes).toBe(0);
  await coordinator.capture();
  await coordinator.run();
  expect(await fs.readFile(path.join(data, 'db/version'), 'utf8')).toBe('after');
  expect(writes).toBe(1);
  await updateStage.publishTarget();
  await coordinator.activationAttempted();
  await updateStage.activationAttempted();
  await coordinator.beginCommit();
  const commit = vi.fn(async (state) => {
    expect(state).toMatchObject({ phase: 'commit-intent', targetWritesPossible: true, commitAttempted: true });
    expect(state.operation.images[0].definitionSha256).toBe(migrationHash(definition));
    return { sha256: '7'.repeat(64) };
  });
  await updateStage.commit(async () => coordinator?.commit({ commitMigration: commit } as unknown as AppsRepository, 'running'));
  expect(commit).toHaveBeenCalledOnce();
  expect((await coordinator.journal.read()).phase).toBe('committed');
  expect((await coordinator.journal.read()).commitReceiptSha256).toBe('7'.repeat(64));
  expect(await fs.stat(path.join(root, 'operations', operation.requestId, 'before.tar.gz'))).toBeTruthy();
});
it('restores data before metadata after a failed migration without advancing its ledger', async () => {
  await prepareUpdate();
  if (!coordinator || !updateStage) throw new Error('Missing coordinator');
  await coordinator.capture();
  behavior = 'script-failed';
  await expect(coordinator.run()).rejects.toThrow();
  expect(await fs.readFile(path.join(data, 'db/version'), 'utf8')).toBe('after');
  await coordinator.recoverBeforeActivation();
  expect(await fs.readFile(path.join(data, 'db/version'), 'utf8')).toBe('before');
  expect(await fs.readFile(path.join(data, 'app.env'), 'utf8')).toBe('OLD=true');
  await updateStage.restoreMetadata();
  expect((await coordinator.journal.read()).phase).toBe('restored');
});
it.each(['activation', 'commit'] as const)('keeps checkpoint and data after an uncertain %s outcome', async (point) => {
  await prepareUpdate();
  if (!coordinator || !updateStage) throw new Error('Missing coordinator');
  await coordinator.capture();
  await coordinator.run();
  await updateStage.publishTarget();
  if (point === 'activation') {
    await coordinator.activationAttempted();
    await updateStage.activationAttempted();
  } else {
    await coordinator.beginCommit();
    await expect(
      updateStage.commit(async () =>
        coordinator?.commit(
          {
            commitMigration: async () => {
              throw new Error('Synthetic lost SQL reply');
            },
          } as unknown as AppsRepository,
          'stopped',
        ),
      ),
    ).rejects.toThrow();
  }
  await expect(coordinator.recoverBeforeActivation()).rejects.toThrow();
  expect(await fs.readFile(path.join(data, 'db/version'), 'utf8')).toBe('after');
  expect((await coordinator.journal.read()).checkpoint).not.toBeNull();
});
it.each(['changedInputs', 'wrongDataPath', 'unbaselined'] as const)('refuses %s during preparation without any app data write', async (fault) => {
  await expect(prepareUpdate({ [fault]: true })).rejects.toThrow();
  expect(writes).toBe(0);
  expect(child).toBeUndefined();
  expect(await fs.readFile(path.join(data, 'db/version'), 'utf8')).toBe('before');
});
it('requires the original writers to be stopped before creating the checkpoint', async () => {
  await prepareUpdate();
  if (!coordinator) throw new Error('Missing coordinator');
  original.State = { ...stopped(), Running: true, Pid: 99, Status: 'running' };
  await expect(coordinator.capture()).rejects.toThrow();
  expect(writes).toBe(0);
});
it('refuses changed physical storage before first activation or SQL intent', async () => {
  await prepareUpdate();
  if (!coordinator) throw new Error('Missing coordinator');
  await coordinator.capture();
  await coordinator.run();
  observation.mountTablesSha256 = '0'.repeat(64);
  await expect(coordinator.activationAttempted()).rejects.toThrow();
  await expect(coordinator.beginCommit()).rejects.toThrow();
  expect((await coordinator.journal.read()).targetWritesPossible).toBe(false);
  expect((await coordinator.journal.read()).commitAttempted).toBe(false);
});

it.each([
  'success',
  'script-failed',
  'lost-sql-reply',
  'lost-activation-reply',
  'queue-lost-sql-reply',
  'legacy-success',
  'legacy-lost-baseline-reply',
  'legacy-script-failed',
  'legacy-resume-intent',
  'legacy-resume-confirmed',
  'legacy-resume-preparation',
  'legacy-resume-allocated',
  'legacy-resume-ready',
  'legacy-resume-queued',
  'legacy-resume-partial',
  'legacy-resume-missing',
  'legacy-resume-linked',
] as const)('runs the normal factory/command migration path through %s', async (outcome) => {
  const legacy = outcome.startsWith('legacy-');
  const failedMigration = outcome.endsWith('script-failed');
  const restarting = outcome.startsWith('legacy-resume-');
  let refusedBaselineRead = false;
  let userBackups = 0;
  const completed = outcome === 'success' || outcome === 'queue-lost-sql-reply' || (legacy && !failedMigration);
  const baselineSql = freshInstallSql();
  Object.assign(baselineSql.row(), { id: 1, status: 'updating' });
  const baselineRepository = new RepositoryToken(baselineSql.database);
  const metadata = path.join(root, 'metadata');
  const pinDirectory = path.join(root, 'pins');
  migrationJournalRoot = path.join(root, 'state/orbis-app-migrations');
  await fs.mkdir(metadata, { mode: 0o750 });
  await fs.writeFile(path.join(metadata, 'source.json'), 'original', { mode: 0o640 });
  if (legacy) {
    await fs.writeFile(path.join(metadata, 'config.json'), JSON.stringify({ tipi_version: 1 }), { mode: 0o640 });
    await fs.mkdir(path.join(metadata, 'migrations'));
    await fs.writeFile(path.join(metadata, 'migrations/000-installed.yml'), 'old script must never execute', { mode: 0o640 });
    original.Config.Labels['com.docker.compose.config-hash'] = '4'.repeat(64);
    if (outcome === 'legacy-lost-baseline-reply' || outcome === 'legacy-resume-intent') baselineSql.behavior('lost-commit');
  }
  await fs.writeFile(path.join(data, 'app.env'), 'OLD=true', { mode: 0o600 });
  original.State = { ...stopped(), Running: true, Pid: 77, Status: 'running' };
  Object.assign(storage, { close: async () => {} });
  vi.spyOn(AppStorageWitness, 'open').mockResolvedValue(storage);
  const app = { id: 1, createdAt: 123, version: 1, status: 'updating', migrationsBaselined: !legacy, subnet: '10.128.10.0/24' };
  const ledger = { baselined: !legacy, migrationIds: [] as string[] };
  const phases: string[] = [];
  let targetLive = false;
  let targetStarts = 0;
  let originalStarts = 0;
  let commits = 0;
  let receiptRaw: unknown;
  const targetId = '6'.repeat(64);
  const target = () => ({
    ...structuredClone(original),
    Id: targetId,
    Image: newImage,
    Config: { Labels: { ...original.Config.Labels, 'io.orbis.app-update.stage': updateStage?.id } },
    State: { ...stopped(), Running: true, Pid: 88, Status: 'running', Health: { Status: 'healthy' } },
  });
  const baseDial = docker.modem.dial.bind(docker.modem);
  docker.modem.dial = ((request: EngineRequest, callback: (error: unknown, value?: unknown) => void) => {
    if (
      targetLive &&
      request.path === '/containers/json?' &&
      request.options.filters &&
      String(request.options.filters).includes('com.docker.compose.project=')
    )
      callback(null, [{ Id: targetId }]);
    else if (targetLive && request.path === `/containers/${targetId}/json`) callback(null, target());
    else baseDial(request as never, callback);
  }) as typeof docker.modem.dial;
  Object.assign(docker, {
    listContainers: async () => [{ Id: targetLive ? targetId : oldId }],
    getContainer: (id: string) => ({
      id,
      inspect: async () => (id === oldId ? structuredClone(original) : target()),
      stop: async () => {
        original.State = stopped();
      },
      unpause: async () => {
        original.State.Paused = false;
      },
      start: async () => {
        expect(await fs.readFile(path.join(data, 'db/version'), 'utf8')).toBe('before');
        expect(await fs.readFile(path.join(metadata, 'source.json'), 'utf8')).toBe('original');
        originalStarts++;
        original.State = { ...stopped(), Running: true, Pid: 77, Status: 'running' };
      },
    }),
  });
  const source = convertLegacyToYaml({ schemaVersion: 2, services: [{ name: 'web', image: 'nginx:latest', isMain: true, internalPort: 80 }] });
  const services = new Map<unknown, unknown>([
    [
      AppFilesManager,
      {
        getAppPaths: () => ({ appInstalledDir: metadata, appDataDir: data }),
        getInstalledAppInfo: async () => ({ tipi_version: 2 }),
        getSourceDockerComposeYaml: async () => ({ content: source }),
        getAppMigrationIds: async (_urn: unknown, directory: string) => [...(await readAppMigrationIds(directory ?? metadata))],
      },
    ],
    [AppHelpers, { renderAppEnv: async () => `APP_DATA_DIR=${host}` }],
    [
      MarketplaceService,
      {
        stageAppUpdate: async (_urn: unknown, directory: string) => {
          await fs.mkdir(path.join(directory, 'migrations'), { recursive: true, mode: 0o750 });
          await fs.writeFile(path.join(directory, 'source.json'), JSON.stringify(source), { mode: 0o640 });
          await fs.writeFile(path.join(directory, 'migrations', `${migrationSource.id}.yml`), migrationSource.bytes, { mode: 0o640 });
          if (legacy) await fs.writeFile(path.join(directory, 'migrations/000-installed.yml'), 'old script must never execute', { mode: 0o640 });
        },
      },
    ],
    [ConfigurationService, { get: (key: string) => (key === 'architecture' ? 'amd64' : { dataDir: root }) }],
    [SubnetManagerService, { planUpdateSubnet: async () => app.subnet, reserveUpdateSubnet: async () => {} }],
    [ArchiveService, archive],
    [
      BackupManager,
      {
        hasPendingRestore: async () => false,
        backupApp: async () => {
          expect(original.State.Running).toBe(false);
          expect(writes).toBe(0);
          userBackups++;
        },
        cleanupOldBackups: async () => {},
      },
    ],
    [
      TasksService,
      {
        progress: async (_event: unknown, phase: string) => {
          phases.push(phase);
        },
      },
    ],
    [
      RepositoryToken,
      {
        getAppByUrn: async () => app,
        getMigrationLedger: async () => ledger,
        commitExistingAppBaseline: async (...args: Parameters<RepositoryToken['commitExistingAppBaseline']>) => {
          try {
            return await baselineRepository.commitExistingAppBaseline(...args);
          } finally {
            app.migrationsBaselined = baselineSql.row().migrations_baselined === true;
            ledger.baselined = app.migrationsBaselined;
            ledger.migrationIds = baselineSql.ids();
          }
        },
        readExistingAppBaseline: (...args: Parameters<RepositoryToken['readExistingAppBaseline']>) => {
          if (outcome === 'legacy-resume-intent' && !refusedBaselineRead) {
            refusedBaselineRead = true;
            throw new Error('Synthetic lost database read');
          }
          return baselineRepository.readExistingAppBaseline(...args);
        },
        settleMigrationRollback: async (state: Parameters<typeof migrationRollbackBinding>[0], status: string) => {
          const selected = migrationRollbackBinding(state);
          expect(app.version).toBe(selected.fromVersion);
          expect(ledger).toEqual(selected.previousLedger);
          app.status = status;
          return true;
        },
        readMigrationRollback: async (state: Parameters<typeof migrationRollbackBinding>[0], status: string) => {
          const selected = migrationRollbackBinding(state);
          return (
            app.id === selected.appId &&
            app.createdAt === selected.createdAt &&
            app.version === selected.fromVersion &&
            app.status === status &&
            JSON.stringify(ledger) === JSON.stringify(selected.previousLedger)
          );
        },
        readMigrationCommit: async (state: Parameters<typeof appMigrationCommitBinding>[0]) =>
          receiptRaw ? verifyAppMigrationCommitReceipt(receiptRaw, state) : undefined,
        commitMigration: async (state: Parameters<typeof appMigrationCommitBinding>[0], status: string) => {
          expect(state).toMatchObject({ phase: 'commit-intent', commitAttempted: true, targetWritesPossible: true });
          const binding = appMigrationCommitBinding(state);
          receiptRaw = { ...binding.binding, committedAt: 12345 };
          const receipt = verifyAppMigrationCommitReceipt(receiptRaw, state);
          commits++;
          app.version = 2;
          app.status = status;
          ledger.migrationIds = binding.ledger.migrationIds;
          if (outcome === 'lost-sql-reply' || outcome === 'queue-lost-sql-reply') throw new Error('Synthetic lost SQL reply');
          return receipt;
        },
      },
    ],
    [
      DockerToken,
      {
        requireAppImagePinUpdate: async () => requireAppImagePinUpdate(pinDirectory, operation.appUrn),
        beginStagedAppUpdate: async () => {
          updateStage = await AppUpdateStage.create({
            directory: pinDirectory,
            appUrn: operation.appUrn,
            metadata,
            env: path.join(data, 'app.env'),
            requestId: operation.requestId,
          });
          operation.stageId = updateStage.id;
          if (restarting && outcome !== 'legacy-resume-intent')
            vi.spyOn(updateStage, 'restoreMetadata').mockRejectedValueOnce(new Error('Synthetic controller stopped before cleanup'));
          if (outcome === 'legacy-resume-confirmed')
            vi.spyOn(updateStage, 'recordContext').mockRejectedValueOnce(new Error('Synthetic controller stopped before context'));
          if (outcome === 'legacy-resume-allocated' || outcome === 'legacy-resume-partial' || outcome === 'legacy-resume-linked')
            vi.spyOn(updateStage, 'confirmMigrationPreparation').mockRejectedValueOnce(
              new Error('Synthetic controller stopped after journal allocation'),
            );
          return { transaction: updateStage, retained: false };
        },
        reopenStagedAppUpdate: async (_urn: unknown, requestId: string) => {
          updateStage = await AppUpdateStage.open({
            directory: pinDirectory,
            appUrn: operation.appUrn,
            metadata,
            env: path.join(data, 'app.env'),
            requestId,
          });
          return { transaction: updateStage, retained: false };
        },
        prepareResumedAppUpdate: async () => ({
          isCurrent: async () => true,
          release: async () => {},
          activate: async () => {
            if (!restarting) throw new Error('Uncertain target must not start twice');
            expect((await updateStage?.read())?.phase).toBe('activation-attempted');
            targetStarts++;
            targetLive = true;
          },
        }),
        prepareExistingBaselineConfiguration: async () => ({
          authoritySha256: '8'.repeat(64),
          configurationSha256: '9'.repeat(64),
          activeServices: ['web'],
          serviceHashes: { web: '4'.repeat(64) },
        }),
        verifyExistingBaselineInputs: async () => {},
        prepareStagedAppUpdate: async () => ({
          inputsSha256: '8'.repeat(64),
          release: async () => {},
          isCurrent: async () => true,
          pull: async () => ({ activationSha256: 'f'.repeat(64), imageIds: { web: newImage } }),
          activate: async () => {
            const saved = JSON.parse(await fs.readFile(path.join(migrationJournalRoot, operation.requestId, 'journal.json'), 'utf8'));
            expect(saved).toMatchObject({ phase: 'activation-attempted', targetWritesPossible: true });
            expect((await updateStage?.read())?.phase).toBe('activation-attempted');
            targetStarts++;
            targetLive = true;
            if (outcome === 'lost-activation-reply') throw new Error('Synthetic lost activation reply');
          },
        }),
        readAppUpdateMigrationInputs: async (_urn: unknown, stage: AppUpdateStage, pending: string[]) => ({
          environment: { APP_DATA_DIR: host },
          sources: await readAppMigrationSources((await stage.readTarget()).target, pending),
        }),
      },
    ],
  ]);
  const ref = { get: (token: unknown) => services.get(token) } as ModuleRef;
  behavior = failedMigration ? 'script-failed' : '';
  const event = {
    command: 'update' as const,
    requestId: operation.requestId,
    appUrn: operation.appUrn as never,
    form: {},
    performBackup: outcome === 'legacy-resume-ready',
  };
  const factory = new AppLifecycleCommandFactory(ref, docker);
  if (outcome === 'legacy-resume-preparation')
    vi.spyOn(AppUpdateMigrations, 'prepare').mockRejectedValueOnce(new Error('Synthetic controller stopped before journal allocation'));
  if (outcome === 'legacy-resume-ready' || outcome === 'legacy-resume-missing' || outcome === 'legacy-resume-queued') {
    const prepare = AppUpdateMigrations.prepare.bind(AppUpdateMigrations);
    vi.spyOn(AppUpdateMigrations, 'prepare').mockImplementationOnce(async (input) => {
      const created = await prepare(input);
      await created.close();
      throw new Error('Synthetic controller stopped after preparation confirmation');
    });
  }
  let result: typeof appEventResultSchema.infer;
  if (outcome === 'queue-lost-sql-reply') {
    const tasks = new TasksService(services.get(ConfigurationService) as ConfigurationService, mock<LoggerService>());
    const progress = tasks.progress.bind(tasks);
    vi.spyOn(tasks, 'progress').mockImplementation(async (event, phase) => {
      phases.push(phase);
      await progress(event, phase);
    });
    services.set(TasksService, tasks);
    services.set(AppLifecycleCommandFactory, factory);
    const module = await Test.createTestingModule({ providers: [AppLifecycleService] })
      .useMocker((token) => {
        if (services.has(token)) return services.get(token);
        if (token === DOCKERODE) return docker;
        if (token === APP_ASYNC_MUTEX) return new AsyncMutex();
        if (token === BackupManager) return { hasPendingRestore: async () => false };
        if (token === LoggerToken) return mock<LoggerService>();
        return mock();
      })
      .compile();
    try {
      const reply = vi.fn().mockResolvedValue(undefined);
      await module.get(AppLifecycleService).invokeCommand(event, reply);
      result = appEventResultSchema.assert(reply.mock.calls[0]?.[0]);
      expect(result).toMatchObject({ success: true, alreadyCompleted: true });
      expect((await tasks.read()).tasks[0]?.status).toBe('succeeded');
    } finally {
      await module.close();
    }
  } else result = await factory.createCommand(event).execute(event.appUrn, event.form);
  if (restarting) {
    expect(result.success).toBe(false);
    expect(writes).toBe(0);
    expect(targetStarts).toBe(0);
    const before = calls.filter(({ path }) => path.startsWith('/distribution/')).length;
    const baselineWrites = baselineSql.queries.filter((query) => query.startsWith('update')).length;
    const damaged = ['legacy-resume-partial', 'legacy-resume-missing', 'legacy-resume-linked'].includes(outcome);
    const operationDirectory = path.join(migrationJournalRoot, operation.requestId);
    if (outcome === 'legacy-resume-partial') await fs.unlink(path.join(operationDirectory, 'journal.json'));
    if (outcome === 'legacy-resume-missing') await fs.rm(operationDirectory, { recursive: true });
    if (outcome === 'legacy-resume-linked') {
      await fs.rename(operationDirectory, operationDirectory + '-preserved');
      await fs.symlink(operationDirectory + '-preserved', operationDirectory);
    }
    if (outcome === 'legacy-resume-queued') {
      const tasks = new TasksService(services.get(ConfigurationService) as ConfigurationService, mock<LoggerService>());
      const progress = tasks.progress.bind(tasks);
      vi.spyOn(tasks, 'progress').mockImplementation(async (event, phase) => {
        phases.push(phase);
        await progress(event, phase);
      });
      await tasks.start(event); // Persisted running work from the interrupted process.
      services.set(TasksService, tasks);
      services.set(AppLifecycleCommandFactory, factory);
      const module = await Test.createTestingModule({ providers: [AppLifecycleService] })
        .useMocker((token) => {
          if (services.has(token)) return services.get(token);
          if (token === DOCKERODE) return docker;
          if (token === APP_ASYNC_MUTEX) return new AsyncMutex();
          return mock();
        })
        .compile();
      try {
        const reply = vi.fn().mockResolvedValue(undefined);
        await module.get(AppLifecycleService).invokeCommand(event, reply, true);
        result = appEventResultSchema.assert(reply.mock.calls[0]?.[0]);
        expect((await tasks.read()).tasks[0]?.status).toBe('succeeded');
      } finally {
        await module.close();
      }
    } else result = await factory.resumeUpdate(event);
    if (damaged) {
      expect(result.success).toBe(false);
      expect(writes).toBe(0);
      expect(targetStarts).toBe(0);
      expect(calls.filter(({ path }) => path.startsWith('/distribution/'))).toHaveLength(before);
      expect(baselineSql.queries.filter((query) => query.startsWith('update'))).toHaveLength(baselineWrites);
      expect(await fs.readFile(path.join(data, 'db/version'), 'utf8')).toBe('before');
      await expect(requireAppImagePinUpdate(pinDirectory, operation.appUrn)).rejects.toThrow();
      const saved = await AppUpdateStage.open({
        directory: pinDirectory,
        appUrn: operation.appUrn,
        metadata,
        env: path.join(data, 'app.env'),
        requestId: operation.requestId,
      });
      try {
        expect((await saved.read()).phase).toBe('target-ready');
      } finally {
        await saved.close();
      }
      if (outcome === 'legacy-resume-missing') await expect(fs.lstat(operationDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
      if (outcome === 'legacy-resume-partial') expect(await fs.readdir(operationDirectory)).toEqual([]);
      if (outcome === 'legacy-resume-linked') expect((await fs.lstat(operationDirectory)).isSymbolicLink()).toBe(true);
      return;
    }
    expect(baselineSql.queries.filter((query) => query.startsWith('update'))).toHaveLength(baselineWrites);
    if (outcome === 'legacy-resume-allocated' || outcome === 'legacy-resume-ready')
      expect(calls.filter(({ path }) => path.startsWith('/distribution/'))).toHaveLength(before);
    expect(userBackups).toBe(outcome === 'legacy-resume-ready' ? 1 : 0);
  }
  if (failedMigration) {
    expect(result).toMatchObject({ success: false, statePreserved: true, updateStatus: 'running' });
    expect(commits).toBe(0);
    expect(targetStarts).toBe(0);
    expect(oldStarts + originalStarts).toBe(1);
    expect(app.version).toBe(1);
    expect(await fs.readFile(path.join(data, 'db/version'), 'utf8')).toBe('before');
  } else {
    expect(result.success, result.message).toBe(completed);
    expect(commits).toBe(outcome === 'lost-activation-reply' ? 0 : 1);
    expect(targetStarts).toBe(1);
    expect(oldStarts + originalStarts).toBe(0);
    expect(app.version).toBe(outcome === 'lost-activation-reply' ? 1 : 2);
    expect(ledger.migrationIds).toEqual(outcome === 'lost-activation-reply' ? [] : [...(legacy ? ['000-installed'] : []), definition.id]);
    if (legacy) {
      expect(baselineSql.receipts()).toHaveLength(1);
      expect(writes).toBe(1);
    }
    expect(await fs.readFile(path.join(data, 'db/version'), 'utf8')).toBe('after');
    expect(phases).toEqual(
      expect.arrayContaining(
        outcome === 'lost-activation-reply' ? ['backing_up', 'migrating', 'starting'] : ['backing_up', 'migrating', 'verifying', 'committing'],
      ),
    );
    expect(phases.indexOf('migrating')).toBeLessThan(phases.indexOf('starting'));
  }
  const retained = JSON.parse(await fs.readFile(path.join(migrationJournalRoot, operation.requestId, 'journal.json'), 'utf8'));
  expect(retained.phase).toBe(
    completed ? 'committed' : failedMigration ? 'restored' : outcome === 'lost-activation-reply' ? 'activation-attempted' : 'commit-intent',
  );
  expect(retained.checkpoint).not.toBeNull();
  if (outcome !== 'lost-sql-reply' && outcome !== 'lost-activation-reply')
    expect(await requireAppImagePinUpdate(pinDirectory, operation.appUrn)).toBeNull();
  else {
    updateStage = await AppUpdateStage.open({
      directory: pinDirectory,
      appUrn: operation.appUrn,
      metadata,
      env: path.join(data, 'app.env'),
      requestId: operation.requestId,
      stageId: operation.stageId,
    });
    expect((await updateStage.read()).phase).toBe(outcome === 'lost-sql-reply' ? 'committing' : 'activation-attempted');
    await updateStage.close();
    const distributions = calls.filter(({ path }) => path.startsWith('/distribution/')).length;
    if (outcome === 'lost-sql-reply') {
      const repository = services.get(RepositoryToken) as Pick<AppsRepository, 'readMigrationCommit'>;
      const read = repository.readMigrationCommit;
      try {
        repository.readMigrationCommit = async () => undefined;
        expect(await factory.reconcileUpdate(event)).toBeUndefined();
        expect(commits).toBe(1);
        expect(targetStarts).toBe(1);
        expect(writes).toBe(1);
        expect(JSON.parse(await fs.readFile(path.join(migrationJournalRoot, operation.requestId, 'journal.json'), 'utf8')).phase).toBe(
          'commit-intent',
        );
      } finally {
        repository.readMigrationCommit = read;
      }
    }
    const resumed = outcome === 'lost-sql-reply' ? await factory.reconcileUpdate(event) : await factory.resumeUpdate(event);
    expect(resumed?.success).toBe(true);
    if (outcome === 'lost-sql-reply') expect(resumed).toMatchObject({ alreadyCompleted: true });
    expect(commits).toBe(1);
    expect(targetStarts).toBe(1);
    expect(oldStarts + originalStarts).toBe(0);
    expect(app.version).toBe(2);
    expect(ledger.migrationIds).toEqual([definition.id]);
    expect(calls.filter(({ path }) => path.startsWith('/distribution/'))).toHaveLength(distributions);
    expect(await requireAppImagePinUpdate(pinDirectory, operation.appUrn)).toBeNull();
    expect(JSON.parse(await fs.readFile(path.join(migrationJournalRoot, operation.requestId, 'journal.json'), 'utf8')).phase).toBe('committed');
  }
});

it('reopens a ready operation with saved immutable images and runs its pending script once without registry resolution', async () => {
  const { service } = await prepareUpdate();
  if (!coordinator || !updateStage) throw new Error('Missing coordinator');
  await coordinator.capture();
  await coordinator.close();
  coordinator = undefined;
  const distributions = calls.filter(({ path }) => path.startsWith('/distribution/')).length;
  coordinator = await AppUpdateMigrations.resume({
    stage: updateStage,
    appUrn: operation.appUrn as never,
    service,
    docker,
    localDirectory: data,
    journalRoot: migrationJournalRoot,
    socketPath: path.join(root, 'modeled-host.sock'),
    archive,
  });
  await coordinator.run();
  expect(writes).toBe(1);
  expect((await coordinator.journal.read()).phase).toBe('migrations-complete');
  expect(calls.filter(({ path }) => path.startsWith('/distribution/'))).toHaveLength(distributions);
});
it.each(['appId', 'createdAt', 'fromVersion', 'stageId', 'appUrn', 'previousLedger', 'originalContainers', 'migrationIds'] as const)(
  'rejects an incompatible saved %s binding before opening the journal for use',
  async (field) => {
    await prepareUpdate();
    if (!coordinator) throw new Error('Missing coordinator');
    const selected = (await coordinator.journal.read()).operation;
    await coordinator.close();
    coordinator = undefined;
    const { images, ...rest } = selected;
    const expected = { ...rest, migrationIds: images.map(({ migrationId }) => migrationId) };
    const changed: Record<string, unknown> = {
      appId: 2,
      createdAt: 124,
      fromVersion: 2,
      stageId: randomUUID(),
      appUrn: 'other:store',
      previousLedger: { baselined: true, migrationIds: ['prior'] },
      originalContainers: [],
      migrationIds: ['other'],
    };
    await expect(AppMigrationJournal.openBound(migrationJournalRoot, { ...expected, [field]: changed[field] })).rejects.toThrow();
    expect(writes).toBe(0);
  },
);

function rollbackRepository(fault = '') {
  let status = 'updating';
  let attempts = 0;
  return {
    repository: {
      settleMigrationRollback: async (state: Parameters<typeof migrationRollbackBinding>[0], selected: string) => {
        migrationRollbackBinding(state);
        attempts++;
        status = selected;
        if (fault === 'lost-status' && attempts === 1) throw new Error('Synthetic lost rollback SQL reply');
        return true;
      },
      readMigrationRollback: async (state: Parameters<typeof migrationRollbackBinding>[0], selected: string) => {
        migrationRollbackBinding(state);
        return status === selected;
      },
    } as unknown as AppsRepository,
    status: () => status,
    attempts: () => attempts,
  };
}
async function failPreparedMigration(options: { originallyStopped?: boolean; paused?: boolean } = {}) {
  const selected = await prepareUpdate(options);
  if (!coordinator || !updateStage) throw new Error('Missing coordinator');
  await coordinator.capture();
  behavior = 'script-failed';
  await expect(coordinator.run()).rejects.toThrow();
  behavior = '';
  return selected;
}
async function reopenRollback(service: DockerService) {
  if (!coordinator || !updateStage) throw new Error('Missing operation');
  const state = await updateStage.read();
  await coordinator.close();
  coordinator = undefined;
  await updateStage.close();
  updateStage = await AppUpdateStage.open({
    directory: path.join(root, 'pins'),
    metadata: state.metadata,
    env: state.env,
    requestId: state.requestId,
    appUrn: state.appUrn,
    stageId: state.id,
  });
  coordinator = await AppUpdateMigrations.resume({
    stage: updateStage,
    appUrn: operation.appUrn as never,
    service,
    docker,
    localDirectory: data,
    journalRoot: migrationJournalRoot,
    socketPath: path.join(root, 'modeled-host.sock'),
    archive,
  });
}
it('retains old runtime context after metadata restoration and completes it after a new controller instance', async () => {
  const { service } = await failPreparedMigration();
  if (!coordinator || !updateStage) throw new Error('Missing operation');
  await updateStage.retainRollback(coordinator.journal);
  await coordinator.recoverBeforeActivation();
  await updateStage.restoreMetadata();
  expect((await updateStage.read()).phase).toBe('rolled-back');
  expect((await updateStage.read()).rollback?.phase).toBe('retained');
  await expect(requireAppImagePinUpdate(path.join(root, 'pins'), operation.appUrn)).rejects.toThrow();
  await reopenRollback(service);
  if (!coordinator || !updateStage) throw new Error('Missing reopened operation');
  const database = rollbackRepository();
  expect(
    await rollbackMigratingAppUpdate({
      stage: updateStage,
      migrations: coordinator,
      repository: database.repository,
      docker,
      appUrn: operation.appUrn as never,
    }),
  ).toBe('running');
  expect(oldStarts).toBe(1);
  expect(database.status()).toBe('running');
  expect(await fs.readFile(path.join(data, 'db/version'), 'utf8')).toBe('before');
  expect(await requireAppImagePinUpdate(path.join(root, 'pins'), operation.appUrn)).toBeNull();
});
it('does not restore the archive again or repeat a start after the old app accepted writes across a lost reply', async () => {
  const { service } = await failPreparedMigration();
  if (!coordinator || !updateStage) throw new Error('Missing operation');
  const database = rollbackRepository();
  behavior = 'lost-old-inspection';
  await expect(
    rollbackMigratingAppUpdate({
      stage: updateStage,
      migrations: coordinator,
      repository: database.repository,
      docker,
      appUrn: operation.appUrn as never,
    }),
  ).rejects.toThrow();
  expect(oldStarts).toBe(1);
  expect((await updateStage.read()).rollback?.runtime[oldId]?.phase).toBe('start-intent');
  await fs.writeFile(path.join(data, 'db/version'), 'accepted-old-app-write');
  behavior = '';
  await reopenRollback(service);
  if (!coordinator || !updateStage) throw new Error('Missing reopened operation');
  await rollbackMigratingAppUpdate({
    stage: updateStage,
    migrations: coordinator,
    repository: database.repository,
    docker,
    appUrn: operation.appUrn as never,
  });
  expect(oldStarts).toBe(1);
  expect(writes).toBe(1);
  expect(await fs.readFile(path.join(data, 'db/version'), 'utf8')).toBe('accepted-old-app-write');
});
it('keeps an unconfirmed old start held instead of issuing another start on retry', async () => {
  const { service } = await failPreparedMigration();
  if (!coordinator || !updateStage) throw new Error('Missing operation');
  const database = rollbackRepository();
  behavior = 'old-start-no-run';
  await expect(
    rollbackMigratingAppUpdate({
      stage: updateStage,
      migrations: coordinator,
      repository: database.repository,
      docker,
      appUrn: operation.appUrn as never,
    }),
  ).rejects.toThrow();
  expect(oldStarts).toBe(1);
  expect(database.attempts()).toBe(0);
  behavior = '';
  await reopenRollback(service);
  if (!coordinator || !updateStage) throw new Error('Missing reopened operation');
  await expect(
    rollbackMigratingAppUpdate({
      stage: updateStage,
      migrations: coordinator,
      repository: database.repository,
      docker,
      appUrn: operation.appUrn as never,
    }),
  ).rejects.toThrow();
  expect(oldStarts).toBe(1);
  expect(database.attempts()).toBe(0);
  await expect(requireAppImagePinUpdate(path.join(root, 'pins'), operation.appUrn)).rejects.toThrow();
});
it('finishes a paused original through durable start/pause intents and leaves a stopped original stopped', async () => {
  await failPreparedMigration({ paused: true });
  if (!coordinator || !updateStage) throw new Error('Missing operation');
  const database = rollbackRepository();
  await rollbackMigratingAppUpdate({
    stage: updateStage,
    migrations: coordinator,
    repository: database.repository,
    docker,
    appUrn: operation.appUrn as never,
  });
  expect(oldStarts).toBe(1);
  expect(oldPauses).toBe(1);
  expect(original.State.Paused).toBe(true);
});
it('does not start a previously stopped original while settling rollback', async () => {
  await failPreparedMigration({ originallyStopped: true });
  if (!coordinator || !updateStage) throw new Error('Missing operation');
  const database = rollbackRepository();
  expect(
    await rollbackMigratingAppUpdate({
      stage: updateStage,
      migrations: coordinator,
      repository: database.repository,
      docker,
      appUrn: operation.appUrn as never,
    }),
  ).toBe('stopped');
  expect(oldStarts).toBe(0);
  expect(oldPauses).toBe(0);
  expect(database.status()).toBe('stopped');
});
it('keeps runtime proof and the original context after a lost old-status commit and reconciles without archive replay', async () => {
  const { service } = await failPreparedMigration();
  if (!coordinator || !updateStage) throw new Error('Missing operation');
  const database = rollbackRepository('lost-status');
  await expect(
    rollbackMigratingAppUpdate({
      stage: updateStage,
      migrations: coordinator,
      repository: database.repository,
      docker,
      appUrn: operation.appUrn as never,
    }),
  ).rejects.toThrow();
  expect(oldStarts).toBe(1);
  expect((await updateStage.read()).rollback?.runtime[oldId]?.phase).toBe('verified');
  await fs.writeFile(path.join(data, 'db/version'), 'old-write-after-sql');
  await reopenRollback(service);
  if (!coordinator || !updateStage) throw new Error('Missing reopened operation');
  await rollbackMigratingAppUpdate({
    stage: updateStage,
    migrations: coordinator,
    repository: database.repository,
    docker,
    appUrn: operation.appUrn as never,
  });
  expect(oldStarts).toBe(1);
  expect(await fs.readFile(path.join(data, 'db/version'), 'utf8')).toBe('old-write-after-sql');
});
it('does not resume an original while a recovered migration process is unexpectedly active', async () => {
  await failPreparedMigration();
  if (!coordinator || !updateStage) throw new Error('Missing operation');
  await updateStage.retainRollback(coordinator.journal);
  await coordinator.recoverBeforeActivation();
  await updateStage.restoreMetadata();
  if (!child) throw new Error('Missing child');
  child.State = { ...stateCreated(), Running: true, Pid: 42, Status: 'running' };
  const database = rollbackRepository();
  await expect(
    rollbackMigratingAppUpdate({
      stage: updateStage,
      migrations: coordinator,
      repository: database.repository,
      docker,
      appUrn: operation.appUrn as never,
    }),
  ).rejects.toThrow();
  expect(oldStarts).toBe(0);
  expect(database.attempts()).toBe(0);
});

it('routes retained rollback through interrupted migration recovery and reports the failed update with the previous app restored', async () => {
  migrationJournalRoot = path.join(root, 'state', 'orbis-app-migrations');
  const { service } = await failPreparedMigration();
  if (!coordinator || !updateStage) throw new Error('Missing operation');
  await updateStage.retainRollback(coordinator.journal);
  await coordinator.recoverBeforeActivation();
  await updateStage.restoreMetadata();
  await coordinator.close();
  coordinator = undefined;
  const database = rollbackRepository();
  Object.assign(database.repository, {
    getAppByUrn: async () => ({ id: operation.appId, createdAt: operation.createdAt, version: operation.fromVersion, status: 'updating' }),
    getMigrationLedger: async () => operation.previousLedger,
  });
  const services = new Map<unknown, unknown>([
    [RepositoryToken, database.repository],
    [DockerService, service],
    [ArchiveService, archive],
    [ConfigurationService, { get: () => ({ dataDir: root }) }],
    [AppFilesManager, { getAppPaths: () => ({ appDataDir: data }) }],
  ]);
  const report = vi.fn(async () => {});
  const result = await resumeMigratingAppUpdate({
    moduleRef: { get: (token: unknown) => services.get(token) } as ModuleRef,
    docker,
    appUrn: operation.appUrn as never,
    stage: updateStage,
    report,
  });
  expect(result).toMatchObject({ success: false, statePreserved: true, updateStatus: 'running' });
  expect(report).toHaveBeenCalledWith('recovering');
  expect(oldStarts).toBe(1);
  expect(writes).toBe(1);
  expect(database.status()).toBe('running');
  expect(await requireAppImagePinUpdate(path.join(root, 'pins'), operation.appUrn)).toBeNull();
});
