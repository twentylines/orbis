import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppUpdateStage, type AppUpdateStageInput } from '../../docker/app-update-stage';
import {
  appUpdateStorage,
  beginAppImagePinUpdate,
  readAppImagePins,
  readStagedAppUpdate,
  requireAppImagePinUpdate,
  requireStagedAppUpdateActivation,
  writeAppImagePins,
} from '../../docker/app-image-pins';
import type { AppMigrationJournal } from '../app-migration-journal';
import type { AppsRepository } from '../../apps/apps.repository';
import { AppsRepository as RepositoryToken } from '../../apps/apps.repository';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '../../apps/app-files-manager';
import { AppHelpers } from '../../apps/app.helpers';
import { DockerService } from '../../docker/docker.service';
import { MarketplaceService } from '../../marketplace/marketplace.service';
import { SubnetManagerService } from '../../network/subnet-manager.service';
import { TasksService } from '../../tasks/tasks.service';
import { AppLifecycleCommandFactory } from '../../app-lifecycle/app-lifecycle-command.factory';
import type { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import { convertLegacyToYaml } from '@runtipi/common/schemas';
import type { AppUrn } from '@runtipi/common/types';

let root: string;
let input: AppUpdateStageInput;
let stage: AppUpdateStage | undefined;
const binding = { activationSha256: 'a'.repeat(64), imageIds: { web: 'sha256:' + 'b'.repeat(64) } };
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'us-')));
  const metadata = path.join(root, 'apps', 'demo');
  const data = path.join(root, 'data');
  await fs.mkdir(path.dirname(metadata));
  await fs.mkdir(metadata, { mode: 0o750 });
  await fs.mkdir(data);
  await fs.writeFile(path.join(metadata, 'source.json'), 'old-source', { mode: 0o640 });
  await fs.writeFile(path.join(data, 'app.env'), 'OLD_SETTING=original', { mode: 0o600 });
  await fs.writeFile(path.join(data, 'accepted-data'), 'retained-data');
  input = { directory: path.join(root, 'pins'), metadata, env: path.join(data, 'app.env'), appUrn: 'demo:store', requestId: randomUUID() };
});
afterEach(async () => {
  await stage?.close();
  stage = undefined;
  vi.restoreAllMocks();
  await fs.rm(root, { force: true, recursive: true });
});
async function ready(withPins = false) {
  if (withPins)
    await writeAppImagePins(
      input.directory,
      { appUrn: input.appUrn, project: 'demo_store', sourceSha256: 'c'.repeat(64) },
      { version: 1, pointId: randomUUID(), sourceSha256: 'c'.repeat(64), services: binding.imageIds },
    );
  stage = await AppUpdateStage.create(input);
  await fs.mkdir(stage.targetDirectory, { mode: 0o750 });
  await fs.writeFile(path.join(stage.targetDirectory, 'source.json'), 'new-source', { mode: 0o640 });
  await stage.stageTarget('services: {}', 'NEW_SETTING=prepared');
  await stage.recordPulledImages(binding);
  await stage.recordContext({
    appId: 1,
    appCreatedAt: 123,
    fromVersion: 1,
    toVersion: 2,
    requestInputSha256: 'd'.repeat(64),
    authoritySha256: 'e'.repeat(64),
    previousLedger: { baselined: false, migrationIds: [] },
    targetMigrationIds: [],
    updateStatus: 'stopped',
    originalContainers: [],
  });
  return stage;
}
async function reopen() {
  if (!stage) throw new Error('Missing fixture stage');
  const stageId = stage.id;
  await stage.close();
  stage = await AppUpdateStage.open({ ...input, stageId });
  return stage;
}

it('reopens only the original request/stage and preserves the unpublished original metadata and data', async () => {
  const value = await ready();
  const original = (await fs.stat(input.metadata)).ino;
  await reopen();
  expect((await stage?.read())?.phase).toBe('target-ready');
  const selected = await readStagedAppUpdate(input.directory, input.appUrn, value.id);
  expect(await fs.readFile(selected.compose, 'utf8')).toBe('services: {}');
  expect((await fs.stat(input.metadata)).ino).toBe(original);
  expect(await fs.readFile(input.env, 'utf8')).toBe('OLD_SETTING=original');
  await stage?.restoreMetadata();
  expect(await requireAppImagePinUpdate(input.directory, input.appUrn)).toBeNull();
  expect(await fs.readFile(path.join(path.dirname(input.env), 'accepted-data'), 'utf8')).toBe('retained-data');
});

it.each(['request', 'stage', 'metadata', 'environment'])('rejects a changed %s tuple without changing files', async (field) => {
  const value = await ready();
  const stageId = value.id;
  await value.close();
  const changed = { ...input, stageId };
  if (field === 'request') changed.requestId = randomUUID();
  if (field === 'stage') changed.stageId = randomUUID();
  if (field === 'metadata') changed.metadata = path.join(root, 'other-app');
  if (field === 'environment') changed.env = path.join(root, 'other.env');
  await expect(AppUpdateStage.open(changed)).rejects.toThrow();
  expect(await fs.readFile(path.join(input.metadata, 'source.json'), 'utf8')).toBe('old-source');
});

it.each(['move-original', 'move-target', 'replace-env'])('resumes a lost %s reply from exact directory positions', async (step) => {
  const value = await ready();
  const target = value.targetDirectory;
  const rename = fs.rename.bind(fs);
  let injected = false;
  const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    await rename(from, to);
    if (
      !injected &&
      (step === 'move-original' ? String(from) === input.metadata : step === 'move-target' ? String(from) === target : String(to) === input.env)
    ) {
      injected = true;
      throw new Error('Synthetic lost rename reply');
    }
  });
  await expect(value.publishTarget()).rejects.toThrow();
  expect(injected).toBe(true);
  spy.mockRestore();
  const resumed = await reopen();
  await resumed.publishTarget();
  expect((await resumed.read()).phase).toBe('prepared');
  expect(await fs.readFile(path.join(input.metadata, 'source.json'), 'utf8')).toBe('new-source');
  expect(await fs.readFile(input.env, 'utf8')).toBe('NEW_SETTING=prepared');
});

it.each(['before', 'after'])('recovers one linked journal publication %s the guard rename', async (position) => {
  const value = await ready();
  const rename = fs.rename.bind(fs);
  let injected = false;
  const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (!injected && String(to).endsWith('.update.json')) {
      injected = true;
      if (position === 'after') await rename(from, to);
      throw new Error('Synthetic guard publication interruption');
    }
    await rename(from, to);
  });
  await expect(value.publishTarget()).rejects.toThrow();
  spy.mockRestore();
  const resumed = await reopen();
  await resumed.publishTarget();
  expect((await resumed.read()).phase).toBe('prepared');
});

it.each(['rollback-target', 'rollback-original', 'restore-env'])('reopens an interrupted %s without replacing unrelated data', async (step) => {
  const value = await ready();
  await value.publishTarget();
  const target = value.targetDirectory;
  const rename = fs.rename.bind(fs);
  let injected = false;
  const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    await rename(from, to);
    if (
      !injected &&
      (step === 'rollback-target' ? String(to) === target : step === 'rollback-original' ? String(to) === input.metadata : String(to) === input.env)
    ) {
      injected = true;
      throw new Error('Synthetic interrupted rollback');
    }
  });
  await expect(value.restoreMetadata()).rejects.toThrow();
  expect(injected).toBe(true);
  spy.mockRestore();
  const resumed = await reopen();
  await resumed.restoreMetadata();
  expect(await fs.readFile(path.join(input.metadata, 'source.json'), 'utf8')).toBe('old-source');
  expect(await fs.readFile(input.env, 'utf8')).toBe('OLD_SETTING=original');
  expect(await fs.readFile(path.join(path.dirname(input.env), 'accepted-data'), 'utf8')).toBe('retained-data');
});

it('never rolls metadata back after target activation and still enforces the saved activation binding', async () => {
  const value = await ready();
  await value.publishTarget();
  await value.activationAttempted();
  await reopen();
  await expect(stage?.restoreMetadata()).rejects.toThrow();
  await requireStagedAppUpdateActivation(input.directory, input.appUrn, value.id, binding);
  await expect(
    requireStagedAppUpdateActivation(input.directory, input.appUrn, value.id, { ...binding, activationSha256: 'd'.repeat(64) }),
  ).rejects.toThrow();
  expect(await fs.readFile(path.join(input.metadata, 'source.json'), 'utf8')).toBe('new-source');
});

it('does not replay a SQL callback after an interrupted commit and refuses an absent receipt', async () => {
  const value = await ready();
  await value.publishTarget();
  await value.activationAttempted();
  const callback = vi.fn(async () => {
    throw new Error('Synthetic lost database reply');
  });
  await expect(value.commit(callback)).rejects.toThrow();
  const resumed = await reopen();
  await expect(resumed.commit(callback)).rejects.toThrow();
  const state = { operation: { requestId: input.requestId, stageId: resumed.id, appUrn: input.appUrn } };
  // SQL receipt validation is exercised independently with real Drizzle; these collaborators model its result only.
  const journal = { read: vi.fn(async () => state), confirmCommitted: vi.fn() } as unknown as AppMigrationJournal;
  const repository = { readMigrationCommit: vi.fn(async () => undefined) } as Pick<AppsRepository, 'readMigrationCommit'>;
  await expect(resumed.reconcileCommitted(journal, repository)).rejects.toThrow();
  expect(callback).toHaveBeenCalledTimes(1);
  await expect(requireAppImagePinUpdate(input.directory, input.appUrn)).rejects.toThrow();
  expect(await requireAppImagePinUpdate(input.directory, input.appUrn, resumed.id)).not.toBeNull();
});

it('clears an exact receipt-confirmed stage and retires only its captured image pins', async () => {
  const value = await ready(true);
  await value.publishTarget();
  await value.activationAttempted();
  await expect(
    value.commit(async () => {
      throw new Error('Synthetic lost database reply');
    }),
  ).rejects.toThrow();
  const resumed = await reopen();
  const state = { operation: { requestId: input.requestId, stageId: resumed.id, appUrn: input.appUrn } };
  const confirmCommitted = vi.fn(async () => {});
  const journal = { read: vi.fn(async () => state), confirmCommitted } as unknown as AppMigrationJournal;
  const repository = { readMigrationCommit: vi.fn(async () => ({ sha256: 'e'.repeat(64) })) } as unknown as Pick<
    AppsRepository,
    'readMigrationCommit'
  >;
  await resumed.reconcileCommitted(journal, repository);
  expect(confirmCommitted).toHaveBeenCalledWith('e'.repeat(64));
  expect(await requireAppImagePinUpdate(input.directory, input.appUrn)).toBeNull();
  expect(await readAppImagePins(input.directory, { appUrn: input.appUrn, project: 'demo_store' })).toBeNull();
  expect(await fs.readFile(path.join(input.metadata, 'source.json'), 'utf8')).toBe('new-source');
});

it('refuses a changed retained-image generation and preserves both generations for recovery', async () => {
  const value = await ready(true);
  await writeAppImagePins(
    input.directory,
    { appUrn: input.appUrn, project: 'demo_store', sourceSha256: 'c'.repeat(64) },
    { version: 1, pointId: randomUUID(), sourceSha256: 'c'.repeat(64), services: { web: 'sha256:' + 'f'.repeat(64) } },
  );
  await expect(value.publishTarget()).rejects.toThrow();
  expect((await readAppImagePins(input.directory, { appUrn: input.appUrn, project: 'demo_store' }))?.pins.services.web).toBe(
    'sha256:' + 'f'.repeat(64),
  );
});

it('does not adopt an unbound legacy guard or allow duplicate live handles', async () => {
  const legacy = await beginAppImagePinUpdate(input.directory, input.appUrn, input.metadata, input.env, true);
  await expect(AppUpdateStage.open(input)).rejects.toThrow();
  await legacy.restoreMetadata();
  const value = await ready();
  await expect(AppUpdateStage.open(input)).rejects.toThrow();
  expect(() => JSON.stringify(value)).toThrow();
});

it('rejects a journal gap, public journal and foreign environment', async () => {
  const value = await ready();
  const state = await value.read();
  const paths = appUpdateStorage.stagedPaths(input.directory, value.id);
  await value.close();
  await fs.chmod(path.join(paths.staging, 'journal.json'), 0o644);
  await expect(AppUpdateStage.open(input)).rejects.toThrow();
  await fs.chmod(path.join(paths.staging, 'journal.json'), 0o600);
  await fs.writeFile(path.join(paths.staging, 'journal.json'), JSON.stringify({ ...state, revision: state.revision + 2 }));
  await expect(AppUpdateStage.open(input)).rejects.toThrow();
  await fs.writeFile(path.join(paths.staging, 'journal.json'), JSON.stringify(state));
  stage = await AppUpdateStage.open(input);
  await fs.writeFile(input.env, 'FOREIGN_SETTING=changed');
  await expect(stage.publishTarget()).rejects.toThrow();
});

it('refuses a replaced original directory even when its bytes are identical', async () => {
  const value = await ready();
  await value.close();
  await fs.rename(input.metadata, path.join(root, 'preserved-original'));
  await fs.mkdir(input.metadata, { mode: 0o750 });
  await fs.writeFile(path.join(input.metadata, 'source.json'), 'old-source', { mode: 0o640 });
  await expect(AppUpdateStage.open(input)).rejects.toThrow();
  expect(await fs.readFile(path.join(root, 'preserved-original/source.json'), 'utf8')).toBe('old-source');
});

it('runs the real request factory and update command through the actual V2 file stage', async () => {
  // Driver and database are models; factory, command, stage, file moves and guard cleanup are real.
  const oldImage = 'sha256:' + '1'.repeat(64);
  let identifier = '2'.repeat(64);
  let running = true;
  let image = oldImage;
  let app = { id: 1, createdAt: 123, status: 'updating', version: 1, subnet: '10.128.1.0/24', migrationsBaselined: false, pendingRestart: false };
  const inspect = () => ({
    Id: identifier,
    Image: image,
    Config: {
      Labels: {
        'com.docker.compose.project': 'demo_store',
        'com.docker.compose.service': 'web',
        'runtipi.managed': 'true',
        'runtipi.appurn': input.appUrn,
        ...(stage ? { 'io.orbis.app-update.stage': stage.id } : {}),
      },
    },
    State: { Running: running, Paused: false, Restarting: false, Dead: false, Pid: running ? 42 : 0 },
  });
  const container = {
    id: identifier,
    inspect: async () => inspect(),
    stop: async () => {
      expect((await stage?.read())?.context).toMatchObject({
        appId: 1,
        appCreatedAt: 123,
        fromVersion: 1,
        toVersion: 2,
        updateStatus: 'running',
        originalContainers: [{ id: identifier, imageId: oldImage, running: true }],
      });
      running = false;
    },
  };
  const docker = {
    listContainers: async () => [{ Id: identifier }],
    getContainer: () => container,
    modem: {
      dial: (options: { path: string }, callback: (error: unknown, value: unknown) => void) => {
        if (options.path === '/containers/json?') callback(null, [{ Id: identifier }]);
        else callback(null, inspect());
      },
    },
  } as unknown as Dockerode;
  let capturedRequest: string | undefined;
  const services = new Map<unknown, unknown>([
    [LoggerService, { error: vi.fn(), debug: vi.fn() }],
    [ConfigurationService, { get: () => 'amd64' }],
    [
      AppFilesManager,
      {
        getInstalledAppInfo: async () => ({ tipi_version: 2 }),
        getAppMigrationIds: async () => [],
        getSourceDockerComposeYaml: async () => ({
          content: convertLegacyToYaml({
            schemaVersion: 2,
            services: [{ name: 'web', image: 'example.invalid/demo:fixture', isMain: true, internalPort: 80 }],
          }),
        }),
      },
    ],
    [AppHelpers, { renderAppEnv: async () => 'NEW_SETTING=prepared' }],
    [
      RepositoryToken,
      {
        getAppByUrn: async () => app,
        commitOrdinaryAppUpdate: async (_stage: AppUpdateStage, result: { version: number; status: string; pendingRestart: boolean | null }) => {
          app = {
            ...app,
            version: result.version,
            status: result.status,
            ...(result.pendingRestart === null ? {} : { pendingRestart: result.pendingRestart }),
          };
          return true;
        },
        readCurrentOrdinaryUpdateCommit: async () => false,
        updateAppById: async (_id: number, patch: Partial<typeof app>) => {
          app = { ...app, ...patch };
          return app;
        },
      },
    ],
    [
      MarketplaceService,
      {
        stageAppUpdate: async (_urn: string, destination: string) => {
          await fs.mkdir(destination, { mode: 0o750 });
          await fs.writeFile(path.join(destination, 'source.json'), 'new-source', { mode: 0o640 });
        },
      },
    ],
    [SubnetManagerService, { planUpdateSubnet: async () => app.subnet, reserveUpdateSubnet: async () => {} }],
    [TasksService, { progress: async () => {} }],
    [
      DockerService,
      {
        requireAppImagePinUpdate: async () => requireAppImagePinUpdate(input.directory, input.appUrn),
        beginStagedAppUpdate: async (_urn: string, requestId: string) => {
          capturedRequest = requestId;
          stage = await AppUpdateStage.create({ ...input, requestId });
          return { transaction: stage, retained: false };
        },
        prepareStagedAppUpdate: async () => ({
          inputsSha256: 'e'.repeat(64),
          isCurrent: async () => true,
          release: async () => {},
          pull: async () => {
            expect(await fs.readFile(path.join(input.metadata, 'source.json'), 'utf8')).toBe('old-source');
            return binding;
          },
          activate: async () => {
            expect((await stage?.read())?.phase).toBe('activation-attempted');
            expect(await fs.readFile(path.join(input.metadata, 'source.json'), 'utf8')).toBe('new-source');
            identifier = '3'.repeat(64);
            running = true;
            image = binding.imageIds.web;
          },
        }),
      },
    ],
  ]);
  const ref = { get: (token: unknown) => services.get(token) } as ModuleRef;
  const event = { command: 'update' as const, requestId: input.requestId, appUrn: 'demo:store' as AppUrn, form: {}, performBackup: false };
  const result = await new AppLifecycleCommandFactory(ref, docker).createCommand(event).execute(event.appUrn, event.form);
  expect(result.success).toBe(true);
  expect(capturedRequest).toBe(input.requestId);
  expect(app).toMatchObject({ version: 2, status: 'running' });
  expect(await requireAppImagePinUpdate(input.directory, input.appUrn)).toBeNull();
  expect(await fs.readFile(path.join(path.dirname(input.env), 'accepted-data'), 'utf8')).toBe('retained-data');
});

it('requires the saved original runtime context before publishing and keeps it immutable on reopen', async () => {
  stage = await AppUpdateStage.create(input);
  await fs.mkdir(stage.targetDirectory, { mode: 0o750 });
  await fs.writeFile(path.join(stage.targetDirectory, 'source.json'), 'new-source', { mode: 0o640 });
  await stage.stageTarget('services: {}', 'NEW_SETTING=prepared');
  await stage.recordPulledImages(binding);
  await expect(stage.publishTarget()).rejects.toThrow();
  const context = {
    appId: 1,
    appCreatedAt: 123,
    fromVersion: 1,
    toVersion: 2,
    requestInputSha256: 'd'.repeat(64),
    authoritySha256: 'e'.repeat(64),
    previousLedger: { baselined: false, migrationIds: [] },
    targetMigrationIds: [],
    updateStatus: 'stopped' as const,
    originalContainers: [],
  };
  await stage.recordContext(context);
  const resumed = await reopen();
  await resumed.recordContext(context);
  await expect(resumed.recordContext({ ...context, fromVersion: 3 })).rejects.toThrow();
  await resumed.publishTarget();
  expect((await resumed.read()).context).toEqual(context);
});

it('restores absence of an original environment file without touching application data', async () => {
  await fs.unlink(input.env);
  const value = await ready();
  await value.publishTarget();
  await reopen();
  await stage?.restoreMetadata();
  await expect(fs.lstat(input.env)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(path.join(path.dirname(input.env), 'accepted-data'), 'utf8')).toBe('retained-data');
});

it('reads the same target and makes private disposable override snapshots before and after publication', async () => {
  const value = await ready();
  for (const published of [false, true]) {
    if (published) await value.publishTarget();
    const target = await value.readTarget();
    expect(target.target).toBe(published ? input.metadata : value.targetDirectory);
    expect(await fs.readFile(target.env, 'utf8')).toBe('NEW_SETTING=prepared');
    let snapshot = '';
    const result = await value.withOverrides({ compose: 'services: {}', env: 'PRIVATE=fixture' }, async (view) => {
      expect(view.target).toBe(target.target);
      expect(view.targetCompose).toBe(target.compose);
      expect(view.targetEnv).toBe(target.env);
      snapshot = path.dirname(view.platform);
      expect((await fs.stat(snapshot)).mode & 0o777).toBe(0o700);
      for (const file of [view.compose, view.env, view.platform]) {
        if (!file) throw new Error('Missing snapshot');
        expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      }
      expect(await fs.readFile(view.env ?? '', 'utf8')).toBe('PRIVATE=fixture');
      expect(await fs.readFile(view.platform, 'utf8')).toContain('${DOCKER_DEFAULT_PLATFORM:-}');
      return 'selected';
    });
    expect(result).toBe('selected');
    await expect(fs.lstat(snapshot)).rejects.toMatchObject({ code: 'ENOENT' });
  }
});
it('removes only its override snapshot after callback failure and preserves staged files', async () => {
  const value = await ready();
  const target = await value.readTarget();
  let snapshot = '';
  await expect(
    value.withOverrides({ compose: null, env: null }, async (view) => {
      snapshot = path.dirname(view.platform);
      expect(view.compose).toBeUndefined();
      expect(view.env).toBeUndefined();
      throw new Error('Synthetic parser failure');
    }),
  ).rejects.toThrow();
  await expect(fs.lstat(snapshot)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(target.env, 'utf8')).toBe('NEW_SETTING=prepared');
  expect((await value.read()).phase).toBe('target-ready');
});
