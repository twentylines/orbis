import { AppValidationService } from '../app-lifecycle/services/app-validation.service';
import { createHash, randomUUID } from 'node:crypto';
import { AppUpdateStage } from './app-update-stage';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppHelpers } from '../apps/app.helpers';
import { AppsRepository } from '../apps/apps.repository';
import { BackupManager } from '../backups/backup.manager';
import { MarketplaceService } from '../marketplace/marketplace.service';
import { SubnetManagerService } from '../network/subnet-manager.service';
import { AppLifecycleCommandFactory } from '../app-lifecycle/app-lifecycle-command.factory';
import { UpdateAppCommand } from '../app-lifecycle/commands/update-app-command';
import { StartAppCommand } from '../app-lifecycle/commands/start-app-command';
import type { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import { convertLegacyToYaml } from '@runtipi/common/schemas';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '../apps/app-files-manager';
import { AppsService } from '../apps/apps.service';
import { STAGED_UPDATE_DEFAULT_PLATFORM, readAppImagePins, writeAppImagePins } from './app-image-pins';
import { DockerService } from './docker.service';
import type { AppUrn } from '@runtipi/common/types';
import { createMockApp } from '@/tests/helpers/app-mocks';

const { spawn, readEffectiveAppCompose, prepareFrozenUpdateInvocation } = vi.hoisted(() => ({
  spawn: vi.fn(),
  readEffectiveAppCompose: vi.fn(),
  prepareFrozenUpdateInvocation: vi.fn(),
}));
vi.mock('node:child_process', async (original) => ({ ...(await original<typeof import('node:child_process')>()), spawn }));
vi.mock('./app-volume-invocation', async (original) => ({
  ...(await original<typeof import('./app-volume-invocation')>()),
  readEffectiveAppCompose,
  prepareFrozenUpdateInvocation,
}));
const urn = 'app:test' as AppUrn;
const image = `sha256:${'9'.repeat(64)}`;
const manifest = `nginx@sha256:${'a'.repeat(64)}`;
const targetImage = `sha256:${'b'.repeat(64)}`;
const retaggedImage = `sha256:${'c'.repeat(64)}`;
let root: string;
let service: DockerService;
let files: ReturnType<typeof mock<AppFilesManager>>;
let apps: ReturnType<typeof mock<AppsService>>;
let source: Awaited<ReturnType<DockerService['getAppImagePinSource']>>;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'docker-image-pins-')));
  const config = mock<ConfigurationService>();
  config.get.calledWith('directories').mockReturnValue({ dataDir: root } as never);
  files = mock<AppFilesManager>();
  apps = mock<AppsService>();
  files.getAppEnv.mockResolvedValue({ path: '/app.env', content: '' });
  files.getUserEnv.mockResolvedValue({ path: '/user.env', content: 'SETTING=kept' });
  files.getGeneratedDockerComposeYaml.mockResolvedValue({ path: '/generated.yml', content: 'services:\n  web:\n    image: mutable:tag' });
  files.getUserComposeFile.mockResolvedValue({
    path: '/user.yml',
    content: 'services:\n  worker:\n    image: worker:latest\n  web:\n    image: user:tag',
  });
  files.getSourceDockerComposeYaml.mockResolvedValue({ path: '/source.yml', content: { services: { web: { image: 'source:tag' } } } as never });
  apps.getApp.mockResolvedValue({ app: { id: 1, userConfigEnabled: true } } as never);
  apps.getInstalledApp.mockResolvedValue({ id: 1, userConfigEnabled: true } as never);
  service = new DockerService(mock<LoggerService>(), config, files, mock<FilesystemService>(), apps);
  source = await service.getAppImagePinSource(urn);
  readEffectiveAppCompose.mockReset();
  prepareFrozenUpdateInvocation.mockReset().mockImplementation(async ({ effective, project, projectDirectory }) => ({
    args: ['--project-name', project, '--project-directory', projectDirectory, '--file', '/proc/self/fd/3'],
    fd: 71 + prepareFrozenUpdateInvocation.mock.calls.length,
    sha256: createHash('sha256').update(JSON.stringify(effective)).digest('hex'),
    release: async () => undefined,
  }));
  spawn.mockReset();
  spawn.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => child.emit('close', 0));
    return child;
  });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
const retain = () =>
  service.writeAppImagePins(urn, {
    version: 1,
    pointId: '12345678-1234-4123-8123-123456789abc',
    sourceSha256: source.sourceSha256,
    services: { web: image, worker: image },
  });

describe('uninstall active-image cleanup', () => {
  async function installed() {
    const appInstalledDir = path.join(root, 'apps/test/app');
    const appDataDir = path.join(root, 'app-data/test/app');
    await fs.mkdir(appInstalledDir, { recursive: true });
    await fs.mkdir(appDataDir, { recursive: true });
    files.getAppPaths.mockReturnValue({ appInstalledDir, appDataDir } as never);
    const directory = path.join(root, 'state/time-machine/image-pins');
    const read = () => readAppImagePins(directory, { appUrn: urn, project: 'app_test' });
    return { appInstalledDir, appDataDir, directory, read };
  }

  it('retires active pins only after both app directories are gone, preserving backup inventories', async () => {
    const f = await installed();
    const original = await retain();
    const backup = path.join(root, 'state/time-machine/points', original.pins.pointId);
    await fs.mkdir(backup, { recursive: true });
    const inventory = path.join(backup, 'images.json');
    const bytes = JSON.stringify(original.pins);
    await fs.writeFile(inventory, bytes);
    const finish = await service.prepareAppUninstallCleanup(urn);
    await expect(finish()).rejects.toThrow('App files remain');
    await fs.rm(f.appDataDir, { recursive: true });
    await expect(finish()).rejects.toThrow('App files remain');
    expect(await f.read()).toMatchObject({ pins: original.pins });
    await fs.rm(f.appInstalledDir, { recursive: true });
    await finish();
    expect(await f.read()).toBeNull();
    expect(await fs.readFile(inventory, 'utf8')).toBe(bytes);
    await service.requireAppImagePinUpdate(urn);
  });

  it('supports uninstall with no active image record', async () => {
    const f = await installed();
    const finish = await service.prepareAppUninstallCleanup(urn);
    await fs.rm(f.appInstalledDir, { recursive: true });
    await fs.rm(f.appDataDir, { recursive: true });
    await finish();
    expect(await f.read()).toBeNull();
  });

  it.each([false, true])('preserves a changed or newly appearing active image record, originally present=%s', async (present) => {
    const f = await installed();
    if (present) await retain();
    const finish = await service.prepareAppUninstallCleanup(urn);
    const changed = await writeAppImagePins(f.directory, source, {
      version: 1,
      pointId: randomUUID(),
      sourceSha256: source.sourceSha256,
      services: { web: targetImage, worker: targetImage },
    });
    await fs.rm(f.appInstalledDir, { recursive: true });
    await fs.rm(f.appDataDir, { recursive: true });
    await expect(finish()).rejects.toThrow('App image records changed');
    expect(await f.read()).toMatchObject({ pins: changed.pins });
  });

  it('refuses cleanup when a recovery barrier appears after shutdown', async () => {
    const f = await installed();
    await retain();
    const finish = await service.prepareAppUninstallCleanup(urn);
    const guard = vi.spyOn(service, 'requireAppImagePinUpdate').mockRejectedValue(new Error('Recovery pending.'));
    await expect(finish()).rejects.toThrow('Recovery pending.');
    guard.mockRestore();
    expect(await f.read()).not.toBeNull();
  });
});

it('does not start compose after its signal is already aborted', async () => {
  const abort = new AbortController();
  abort.abort(new Error('lease expired'));
  await expect(service.composeApp(urn, 'up --detach', { signal: abort.signal })).rejects.toThrow('lease expired');
  expect(spawn).not.toHaveBeenCalled();
});
it('terminates an in-flight compose when its signal is aborted', async () => {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => {
    process.nextTick(() => child.emit('close', null));
    return true;
  });
  spawn.mockReturnValue(child);
  const abort = new AbortController();
  const result = service.composeApp(urn, 'up --detach', { signal: abort.signal });
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
  abort.abort(new Error('lease expired'));
  await expect(result).rejects.toThrow('lease expired');
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
});
it('escalates an unresponsive compose process after cancellation', async () => {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn((signal: string) => {
    if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null));
    return true;
  });
  spawn.mockReturnValue(child);
  const abort = new AbortController();
  const result = service.composeApp(urn, 'up --detach', { signal: abort.signal });
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
  vi.useFakeTimers();
  try {
    abort.abort(new Error('lease expired'));
    const rejected = expect(result).rejects.toThrow('lease expired');
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
  } finally {
    vi.useRealTimers();
  }
});
describe('DockerService retained image composition', () => {
  it('keeps ordinary apps unchanged and makes no pin state on a read', async () => {
    expect((await service.getBaseComposeArgsApp(urn)).args).toEqual([
      '--env-file',
      '/app.env',
      '--env-file',
      '/user.env',
      '--project-name',
      'app_test',
      '-f',
      '/generated.yml',
      '--file',
      '/user.yml',
    ]);
    await expect(fs.stat(path.join(root, 'state'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('appends exact pins after user overrides, replaces forced pulls and retains pins through down/up', async () => {
    const saved = await retain();
    const original = await fs.readFile(saved.path, 'utf8');
    await service.composeApp(urn, 'up --detach --force-recreate --pull always');
    const args = spawn.mock.calls[0]?.[1] as string[];
    expect(args.indexOf(saved.path)).toBeGreaterThan(args.indexOf('/user.yml'));
    expect(args.slice(-2)).toEqual(['--pull', 'never']);
    expect(args).not.toContain('always');
    expect(args).toContain('--no-build');
    await service.composeApp(urn, 'down --rmi all --remove-orphans');
    expect(spawn.mock.calls[1]?.[1]).not.toContain('--rmi');
    await service.composeApp(urn, 'up --detach --pull=always');
    expect(spawn.mock.calls[2]?.[1]).not.toContain('--pull=always');
    expect(await fs.readFile(saved.path, 'utf8')).toBe(original);
  });
  it('fails before Docker on mutable pull/build commands or changed source/user overrides', async () => {
    await retain();
    await expect(service.composeApp(urn, 'pull')).rejects.toThrow();
    await expect(service.composeApp(urn, 'up --build')).rejects.toThrow();
    await expect(service.composeApp(urn, 'run web')).rejects.toThrow();
    files.getUserComposeFile.mockResolvedValue({ path: '/user.yml', content: 'services:\n  web:\n    image: changed:tag' });
    await expect(service.composeApp(urn, 'up --detach')).rejects.toThrow('configuration differs');
    expect(spawn).not.toHaveBeenCalled();
  });
  it('rejects missing service pins including services introduced by user compose', async () => {
    await expect(
      service.writeAppImagePins(urn, {
        version: 1,
        pointId: '12345678-1234-4123-8123-123456789abc',
        sourceSha256: source.sourceSha256,
        services: { web: image },
      }),
    ).rejects.toThrow('do not cover');
  });
  it('rejects Compose includes that could introduce unpinned services', async () => {
    files.getUserComposeFile.mockResolvedValue({
      path: '/user.yml',
      content: 'include: [extra.yml]\nservices:\n  worker:\n    image: worker:latest',
    });
    source = await service.getAppImagePinSource(urn);
    await expect(retain()).rejects.toThrow('services could not be verified');
    expect(spawn).not.toHaveBeenCalled();
  });
  it('rejects an explicit update bypass without a durable same-app transaction', async () => {
    await retain();
    await expect(service.composeApp(urn, 'pull', { imagePins: 'explicit-update' })).rejects.toThrow('needs a retained app update transaction');
    expect(spawn).not.toHaveBeenCalled();
    expect((await service.readAppImagePins(urn))?.pins.services.web).toBe(image);
  });
});

describe('retained update with actual metadata, pin validation and normal start', () => {
  it.each([
    'pull',
    'unpullable',
    'build-with-image',
    'unowned-target',
    'unverified-image',
    'platform-mismatch',
    'activation',
    'override-before-stop',
    'override-after-stop',
    'retag-after-pull',
    'backup-after-pull',
  ])('keeps the retained update safe through %s', async (failure) => {
    const installed = path.join(root, 'installed');
    const data = path.join(root, 'data');
    await fs.mkdir(installed, { mode: 0o750 });
    await fs.mkdir(data, { mode: 0o700 });
    const sourceFile = path.join(installed, 'source.json');
    const generated = path.join(installed, 'docker-compose.generated.yml');
    const env = path.join(data, 'app.env');
    const userEnv = path.join(root, 'fixture-override.env');
    const old = convertLegacyToYaml({ schemaVersion: 2, services: [{ name: 'web', image: 'nginx:old', isMain: true, internalPort: 80 }] });
    const next = convertLegacyToYaml({ schemaVersion: 2, services: [{ name: 'web', image: 'nginx:new', isMain: true, internalPort: 80 }] });
    await fs.writeFile(sourceFile, JSON.stringify(old), { mode: 0o640 });
    await fs.writeFile(generated, 'services:\n  web:\n    image: nginx:old', { mode: 0o640 });
    await fs.writeFile(env, 'IMAGE=nginx:old', { mode: 0o600 });
    await fs.writeFile(userEnv, 'SETTING=kept', { mode: 0o600 });
    await fs.writeFile(path.join(data, 'accepted-write'), 'original-data');
    files.getAppPaths.mockReturnValue({ appInstalledDir: installed, appDataDir: data });
    files.getSourceDockerComposeYaml.mockImplementation(async (_urn, stagedDirectory) => {
      const file = stagedDirectory ? path.join(stagedDirectory, 'source.json') : sourceFile;
      return { path: file, content: JSON.parse(await fs.readFile(file, 'utf8')) };
    });
    files.getGeneratedDockerComposeYaml.mockImplementation(async () => ({ path: generated, content: await fs.readFile(generated, 'utf8') }));
    files.getUserComposeFile.mockResolvedValue({ path: '/unused.yml', content: null });
    files.getAppEnv.mockImplementation(async () => ({ path: env, content: await fs.readFile(env, 'utf8') }));
    files.getUserEnv.mockImplementation(async () => ({ path: userEnv, content: await fs.readFile(userEnv, 'utf8') }));
    files.getInstalledAppInfo.mockResolvedValue({ force_pull: true, tipi_version: 2 } as never);
    files.getAppMigrationIds.mockResolvedValue([]);
    files.writeDockerComposeYml.mockImplementation(async (_urn, content) => {
      await fs.writeFile(generated, content);
    });
    const marketplace = mock<MarketplaceService>();
    const helpers = mock<AppHelpers>();
    const repository = mock<AppsRepository>();
    const backups = mock<BackupManager>();
    backups.backupApp.mockRejectedValue(new Error('Synthetic backup failure'));
    const app = createMockApp({ id: 1, status: 'updating', version: 1, subnet: '10.128.10.0/24' });
    repository.getAppByUrn.mockResolvedValue(app);
    repository.updateAppById.mockImplementation(async (_id, patch) => ({ ...app, ...patch }));
    const config = mock<ConfigurationService>();
    const subnet = mock<SubnetManagerService>();
    subnet.allocateSubnet.mockResolvedValue('10.128.10.0/24');
    subnet.planUpdateSubnet.mockResolvedValue('10.128.10.0/24');
    subnet.reserveUpdateSubnet.mockResolvedValue(undefined);
    config.get.calledWith('architecture').mockReturnValue('arm64');
    marketplace.stageAppUpdate.mockImplementation(async (_urn, stagedDirectory) => {
      await fs.mkdir(stagedDirectory, { mode: 0o750 });
      await fs.writeFile(path.join(stagedDirectory, 'source.json'), JSON.stringify(next), { mode: 0o640 });
    });
    helpers.renderAppEnv.mockResolvedValue('IMAGE=nginx:new');
    helpers.generateEnvFile.mockImplementation(async () => {
      const current = JSON.parse(await fs.readFile(sourceFile, 'utf8'));
      await fs.writeFile(env, `IMAGE=${current.services.web.image}`, { mode: 0o600 });
    });
    const docker = mock<Dockerode>();
    const container = mock<Dockerode.Container>({ id: 'owned-app' });
    let running = true;
    let runningImage = image;
    let mutableImage = targetImage;
    const inspection = mock<Dockerode.Image>();
    inspection.inspect.mockImplementation(async () => {
      if (failure === 'unverified-image') throw new Error('Synthetic image descriptor unavailable');
      return {
        Id: targetImage,
        Architecture: failure === 'platform-mismatch' ? 'amd64' : 'arm64',
        Os: 'linux',
      } as Dockerode.ImageInspectInfo;
    });
    const mutable = mock<Dockerode.Image>();
    mutable.inspect.mockImplementation(async () => ({ Id: mutableImage, Architecture: 'arm64', Os: 'linux' }) as Dockerode.ImageInspectInfo);
    docker.getImage.mockImplementation((reference) => (reference === manifest ? inspection : mutable));
    container.start.mockImplementation(async () => {
      expect(runningImage).toBe(image);
      running = true;
    });
    container.stop.mockImplementation(async () => {
      const directory = path.join(root, 'state', 'time-machine', 'image-pins');
      const stages = (await fs.readdir(directory)).filter((name) => name.startsWith('update-'));
      const journal = JSON.parse(await fs.readFile(path.join(directory, stages[0] ?? '', 'journal.json'), 'utf8'));
      expect(journal.pulledImages).toEqual({
        activationSha256: createHash('sha256').update(JSON.stringify(prepareFrozenUpdateInvocation.mock.lastCall?.[0]?.effective)).digest('hex'),
        imageIds: { web: targetImage },
      });
      running = false;
      if (failure === 'override-after-stop') await fs.writeFile(userEnv, 'SETTING=late-edit');
    });
    docker.listContainers.mockResolvedValue([{ Id: 'owned-app' }] as Dockerode.ContainerInfo[]);
    docker.getContainer.mockReturnValue(container);
    container.inspect.mockImplementation(
      async () =>
        ({
          Id: 'owned-app',
          Image: runningImage,
          Config: {
            Labels: {
              'com.docker.compose.project': 'app_test',
              'com.docker.compose.service': 'web',
              'runtipi.managed': 'true',
              'runtipi.appurn': urn,
            },
          },
          State: { Running: running, Paused: false, Restarting: false },
        }) as unknown as Dockerode.ContainerInspectInfo,
    );
    docker.pruneContainers.mockResolvedValue({ ContainersDeleted: [], SpaceReclaimed: 0 });
    const services = new Map<unknown, unknown>([
      [AppValidationService, { validateUpdateConfigSettings: async () => {} }],
      [LoggerService, mock<LoggerService>()],
      [AppFilesManager, files],
      [DockerService, service],
      [MarketplaceService, marketplace],
      [AppHelpers, helpers],
      [BackupManager, backups],
      [AppsRepository, repository],
      [ConfigurationService, config],
      [SubnetManagerService, subnet],
    ]);
    const moduleRef = { get: (token: unknown) => services.get(token) } as ModuleRef;
    const identity = await service.getAppImagePinSource(urn);
    const pin = await service.writeAppImagePins(urn, {
      version: 1,
      pointId: '12345678-1234-4123-8123-123456789abc',
      sourceSha256: identity.sourceSha256,
      services: { web: image },
    });
    const originalInode = (await fs.stat(installed)).ino;
    let compiledCandidate = '';
    let compiledOverride = '';
    readEffectiveAppCompose.mockImplementation(async (argv: string[], _signal, options) => {
      expect(options).toEqual({ keepRelativePaths: true, resolveImageDigests: true });
      const valueAfter = (name: string, start = 0) => argv[argv.indexOf(name, start) + 1];
      compiledCandidate = await fs.readFile(valueAfter('--file') ?? '', 'utf8');
      const frozenEnv = valueAfter('--env-file', argv.indexOf('--env-file') + 1);
      expect(frozenEnv).not.toBe(userEnv);
      expect((await fs.stat(frozenEnv ?? '')).mode & 0o777).toBe(0o600);
      compiledOverride = await fs.readFile(frozenEnv ?? '', 'utf8');
      expect(await fs.readFile(valueAfter('--file', argv.lastIndexOf('--file')) ?? '', 'utf8')).toContain('${DOCKER_DEFAULT_PLATFORM:-}');
      return {
        name: 'app_test',
        [STAGED_UPDATE_DEFAULT_PLATFORM]: 'linux/arm64/v8',
        services: {
          web:
            failure === 'unpullable'
              ? { build: '.' }
              : {
                  image: manifest,
                  ...(failure === 'build-with-image' ? { build: '.' } : {}),
                  labels: { 'runtipi.managed': 'true', 'runtipi.appurn': failure === 'unowned-target' ? 'foreign:test' : urn },
                  profiles: ['fixture'],
                  environment: { SETTING: compiledOverride },
                },
        },
      };
    });
    let pullOriginal:
      | { metadata: unknown; environment: string; stopped: boolean; candidate: string; hasPin: boolean; userOverrides: boolean }
      | undefined;
    spawn.mockImplementation((_binary, argv) => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      process.nextTick(async () => {
        if (argv.includes('pull')) {
          expect(argv.slice(-2)).toEqual(['--policy', 'always']);
          expect(argv).toEqual(expect.arrayContaining(['--profile', '*']));
          pullOriginal = {
            metadata: JSON.parse(await fs.readFile(sourceFile, 'utf8')),
            environment: await fs.readFile(env, 'utf8'),
            stopped: !running,
            candidate: compiledCandidate,
            hasPin: argv.includes(pin.path),
            userOverrides: compiledOverride === 'SETTING=kept',
          };
          if (failure === 'override-before-stop') await fs.writeFile(userEnv, 'SETTING=late-edit');
          if (failure === 'retag-after-pull' || failure === 'backup-after-pull') mutableImage = retaggedImage;
        }
        const newStart = argv.includes('up') && argv.includes('--wait');
        if (failure === 'activation' && newStart) await fs.writeFile(path.join(data, 'accepted-write'), 'accepted-new-data');
        if ((failure === 'override-after-stop' || failure === 'retag-after-pull') && newStart) {
          running = true;
          runningImage = prepareFrozenUpdateInvocation.mock.lastCall?.[0]?.effective.services.web.image;
        }
        if ((failure === 'pull' && argv.includes('pull')) || (failure === 'activation' && newStart)) {
          child.stderr.emit('data', Buffer.from('candidate failed'));
          child.emit('close', 1);
        } else child.emit('close', 0);
      });
      return child;
    });
    const updated = await new UpdateAppCommand(moduleRef, docker, failure === 'backup-after-pull').execute(urn, {});
    if (failure === 'override-after-stop' || failure === 'retag-after-pull') {
      expect(updated).toMatchObject({ success: true, updateStatus: 'running' });
      expect(await fs.readFile(userEnv, 'utf8')).toBe(failure === 'override-after-stop' ? 'SETTING=late-edit' : 'SETTING=kept');
      expect(repository.updateAppById).toHaveBeenLastCalledWith(
        1,
        expect.objectContaining({
          version: 2,
          status: 'running',
          pendingRestart: failure === 'override-after-stop',
        }),
      );
      expect(readEffectiveAppCompose).toHaveBeenCalledOnce();
      expect(prepareFrozenUpdateInvocation).toHaveBeenCalledTimes(2);
      expect(docker.getImage).toHaveBeenCalledExactlyOnceWith(manifest);
      expect(inspection.inspect).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ platform: '{"os":"linux","architecture":"arm64","variant":"v8"}' }),
      );
      const pullPlan = prepareFrozenUpdateInvocation.mock.calls[0]?.[0]?.effective;
      const activationPlan = prepareFrozenUpdateInvocation.mock.calls[1]?.[0]?.effective;
      expect(pullPlan.services.web).toMatchObject({ image: manifest, platform: 'linux/arm64/v8', environment: { SETTING: 'SETTING=kept' } });
      expect(activationPlan).toEqual({ ...pullPlan, services: { web: { ...pullPlan.services.web, image: targetImage } } });
      if (failure === 'retag-after-pull') expect(mutableImage).toBe(retaggedImage);
      expect(runningImage).toBe(targetImage);
      expect(JSON.parse(await fs.readFile(sourceFile, 'utf8'))).toEqual(next);
      const runtimeCalls = spawn.mock.calls;
      expect(runtimeCalls).toHaveLength(2);
      expect(runtimeCalls.map((call) => call[2]?.stdio?.[3])).toEqual([72, 73]);
      expect(runtimeCalls[1]?.[1]).toEqual(expect.arrayContaining(['--project-directory', installed, '--file', '/proc/self/fd/3', '--wait']));
      expect(runtimeCalls[1]?.[1].slice(-2)).toEqual(['--pull', 'never']);
      expect(runtimeCalls[1]?.[1]).not.toContain(userEnv);
      expect(await service.readAppImagePins(urn)).toBeNull();
      return;
    }
    expect(updated.success).toBe(false);
    if (failure === 'backup-after-pull') {
      expect(updated).toMatchObject({ statePreserved: true, updateStatus: 'running' });
      expect(mutableImage).toBe(retaggedImage);
      expect(runningImage).toBe(image);
      expect(running).toBe(true);
      expect(container.stop).toHaveBeenCalledOnce();
      expect(container.start).toHaveBeenCalledOnce();
      expect(spawn).toHaveBeenCalledOnce();
      expect((await fs.stat(installed)).ino).toBe(originalInode);
      expect((await service.readAppImagePins(urn))?.pins.services.web).toBe(image);
      return;
    }
    if (failure === 'unowned-target') {
      expect(updated.message).toContain('required app ownership labels');
      expect(spawn).not.toHaveBeenCalled();
    } else if (failure === 'unpullable' || failure === 'build-with-image') {
      expect(updated.message).toContain('requires a pullable image');
      expect(spawn).not.toHaveBeenCalled();
    } else {
      expect(pullOriginal).toMatchObject({
        metadata: old,
        environment: 'IMAGE=nginx:old',
        stopped: false,
        candidate: expect.stringContaining('nginx:new'),
        hasPin: false,
        userOverrides: true,
      });
    }
    helpers.generateEnvFile.mockClear();
    docker.pruneContainers.mockClear();
    const started = await new StartAppCommand(moduleRef, docker).execute(urn, {});
    if (failure !== 'activation') {
      expect(container.stop).not.toHaveBeenCalled();
      expect((await fs.stat(installed)).ino).toBe(originalInode);
      expect(JSON.parse(await fs.readFile(sourceFile, 'utf8'))).toEqual(old);
      expect((await fs.stat(sourceFile)).mode & 0o777).toBe(0o640);
      expect(await fs.readFile(env, 'utf8')).toBe('IMAGE=nginx:old');
      expect((await service.readAppImagePins(urn))?.pins.services.web).toBe(image);
      expect(started.success).toBe(true);
      const args = spawn.mock.calls.at(-1)?.[1] as string[];
      expect(args).toContain(pin.path);
      expect(args.slice(-2)).toEqual(['--pull', 'never']);
      expect(await fs.readFile(path.join(data, 'accepted-write'), 'utf8')).toBe('original-data');
    } else {
      expect(container.stop).toHaveBeenCalledOnce();
      expect(updated.message).toContain('explicit recovery');
      expect(started.success).toBe(false);
      expect(started.message).toContain('explicit recovery');
      expect(docker.pruneContainers).not.toHaveBeenCalled();
      expect(helpers.generateEnvFile).not.toHaveBeenCalled();
      expect(JSON.parse(await fs.readFile(sourceFile, 'utf8'))).toEqual(next);
      expect(await fs.readFile(env, 'utf8')).toBe('IMAGE=nginx:new');
      expect(await fs.readFile(path.join(data, 'accepted-write'), 'utf8')).toBe('accepted-new-data');
      marketplace.copyAppFromRepoToInstalled.mockClear();
      const install = new AppLifecycleCommandFactory(moduleRef, docker).createCommand({ command: 'install', appUrn: urn, form: {} } as never);
      await expect(install.execute(urn, {})).rejects.toThrow('explicit recovery');
      expect(marketplace.copyAppFromRepoToInstalled).not.toHaveBeenCalled();
      await expect(service.requireNoPendingAppImageUpdates()).rejects.toThrow('explicit recovery');
      await expect(service.readAppImagePins(urn)).rejects.toThrow('explicit recovery');
    }
  });
});

describe('exact activation reconstruction after a restart', () => {
  let stage: AppUpdateStage | undefined;
  afterEach(async () => {
    await stage?.close();
    stage = undefined;
  });
  async function prepared() {
    const installed = path.join(root, 'installed');
    const data = path.join(root, 'data');
    await fs.mkdir(installed, { mode: 0o750 });
    await fs.mkdir(data, { mode: 0o700 });
    await fs.writeFile(path.join(installed, 'source.json'), 'old', { mode: 0o640 });
    await fs.writeFile(path.join(data, 'app.env'), 'OLD=kept', { mode: 0o600 });
    files.getAppPaths.mockReturnValue({ appInstalledDir: installed, appDataDir: data });
    const created = await service.beginStagedAppUpdate(urn, randomUUID());
    if (!(created.transaction instanceof AppUpdateStage)) throw new Error('Expected request-bound stage');
    stage = created.transaction;
    await fs.mkdir(stage.targetDirectory, { mode: 0o750 });
    await fs.writeFile(path.join(stage.targetDirectory, 'source.json'), 'new', { mode: 0o640 });
    await stage.stageTarget('services: {}', 'TARGET=prepared');
    const effective = {
      name: 'app_test',
      [STAGED_UPDATE_DEFAULT_PLATFORM]: 'linux/arm64/v8',
      services: { web: { image: manifest, labels: { 'runtipi.managed': 'true', 'runtipi.appurn': urn }, environment: { SETTING: 'kept' } } },
    };
    readEffectiveAppCompose.mockResolvedValue(effective);
    const inspection = mock<Dockerode.Image>();
    inspection.inspect.mockResolvedValue({ Id: targetImage, Os: 'linux', Architecture: 'arm64' } as Dockerode.ImageInspectInfo);
    const docker = mock<Dockerode>();
    docker.getImage.mockReturnValue(inspection);
    const plan = await service.prepareStagedAppUpdate(urn, stage.id, docker);
    const binding = await plan.pull();
    await stage.recordPulledImages(binding);
    await stage.recordContext({
      appId: 1,
      appCreatedAt: 123,
      fromVersion: 1,
      toVersion: 2,
      requestInputSha256: 'd'.repeat(64),
      authoritySha256: plan.inputsSha256,
      previousLedger: { baselined: false, migrationIds: [] },
      targetMigrationIds: [],
      updateStatus: 'stopped',
      originalContainers: [],
    });
    await plan.release();
    const requestId = (await stage.read()).requestId;
    await stage.close();
    stage = (await service.reopenStagedAppUpdate(urn, requestId, stage.id)).transaction;
    const dial = vi.fn((_options, callback) => callback(null, { Id: targetImage, Os: 'linux', Architecture: 'arm64' }));
    const local = { modem: { dial } } as unknown as Pick<Dockerode, 'modem'>;
    spawn.mockClear();
    readEffectiveAppCompose.mockClear();
    prepareFrozenUpdateInvocation.mockClear();
    docker.getImage.mockClear();
    // A source tag is allowed to resolve differently now; the saved local ID is authoritative.
    readEffectiveAppCompose.mockResolvedValue({ ...effective, services: { web: { ...effective.services.web, image: 'changed:tag' } } });
    return { docker, local, dial, binding, installed };
  }
  it('rebuilds the exact plan from saved IDs without registry resolution or pulls', async () => {
    const { local, dial, binding, docker, installed } = await prepared();
    if (!stage) throw new Error('Missing stage');
    const resumed = await service.prepareResumedAppUpdate(urn, stage, local);
    expect(resumed.binding).toEqual(binding);
    expect(readEffectiveAppCompose).toHaveBeenCalledExactlyOnceWith(expect.any(Array), undefined, { keepRelativePaths: true });
    expect(prepareFrozenUpdateInvocation.mock.lastCall?.[0]).toMatchObject({
      projectDirectory: installed,
      effective: { services: { web: { image: targetImage, labels: { 'io.orbis.app-update.stage': stage.id } } } },
    });
    expect(dial.mock.calls[0]?.[0]).toMatchObject({ path: `/images/${targetImage}/json`, method: 'GET', abortSignal: expect.any(AbortSignal) });
    expect(docker.getImage).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    await stage.publishTarget();
    await stage.activationAttempted();
    const outcomes = await Promise.allSettled([resumed.activate(), resumed.activate()]);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0]?.[1].slice(-2)).toEqual(['--pull', 'never']);
    await resumed.release();
  });
  it.each(['env', 'compose', 'account'])('rejects changed %s authority before reading Compose or contacting Docker', async (change) => {
    const { local, dial } = await prepared();
    if (!stage) throw new Error('Missing stage');
    if (change === 'env') files.getUserEnv.mockResolvedValue({ path: '/user.env', content: 'EDITED=true' });
    if (change === 'compose') files.getUserComposeFile.mockResolvedValue({ path: '/user.yml', content: 'services: {}' });
    if (change === 'account') apps.getInstalledApp.mockResolvedValue({ id: 2, userConfigEnabled: true } as never);
    await expect(service.prepareResumedAppUpdate(urn, stage, local)).rejects.toThrow();
    expect(readEffectiveAppCompose).not.toHaveBeenCalled();
    expect(dial).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
  it.each(['missing-service', 'extra-service', 'ownership', 'build', 'platform', 'effective-change'])(
    'refuses %s without starting a target',
    async (change) => {
      const { local } = await prepared();
      if (!stage) throw new Error('Missing stage');
      const effective = await readEffectiveAppCompose.getMockImplementation()?.([], undefined, {});
      if (change === 'missing-service') effective.services = {};
      if (change === 'extra-service') effective.services.worker = effective.services.web;
      if (change === 'ownership') effective.services.web.labels['runtipi.appurn'] = 'foreign:test';
      if (change === 'build') effective.services.web.build = '.';
      if (change === 'platform') effective[STAGED_UPDATE_DEFAULT_PLATFORM] = 'linux/amd64';
      if (change === 'effective-change') effective.services.web.environment.SETTING = 'changed';
      const release = vi.fn(async () => {});
      const original = prepareFrozenUpdateInvocation.getMockImplementation();
      prepareFrozenUpdateInvocation.mockImplementation(async (...args) => ({ ...(await original?.(...args)), release }));
      readEffectiveAppCompose.mockResolvedValue(effective);
      await expect(service.prepareResumedAppUpdate(urn, stage, local)).rejects.toThrow();
      if (change === 'effective-change') expect(release).toHaveBeenCalledOnce();
      expect(spawn).not.toHaveBeenCalled();
    },
  );
  it.each(['identity', 'platform', 'missing', 'oversized'])('refuses a %s saved local image', async (change) => {
    const { local, dial } = await prepared();
    if (!stage) throw new Error('Missing stage');
    dial.mockImplementation((_options, callback) =>
      callback(change === 'missing' ? { statusCode: 404 } : null, {
        Id: change === 'identity' ? image : targetImage,
        Os: 'linux',
        Architecture: change === 'platform' ? 'amd64' : 'arm64',
        ...(change === 'oversized' ? { extra: 'a'.repeat(2 * 1024 * 1024) } : {}),
      }),
    );
    await expect(service.prepareResumedAppUpdate(urn, stage, local)).rejects.toThrow();
    expect(prepareFrozenUpdateInvocation).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
  it('rechecks override authority and the durable activation marker immediately before start', async () => {
    const { local } = await prepared();
    if (!stage) throw new Error('Missing stage');
    const beforeMarker = await service.prepareResumedAppUpdate(urn, stage, local);
    await expect(beforeMarker.activate()).rejects.toThrow();
    await beforeMarker.release();
    const plan = await service.prepareResumedAppUpdate(urn, stage, local);
    await stage.publishTarget();
    await stage.activationAttempted();
    files.getUserEnv.mockResolvedValue({ path: '/user.env', content: 'EDITED=true' });
    expect(await plan.isCurrent()).toBe(false);
    await expect(plan.activate()).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
    await plan.release();
  });
  it('reads only explicit sealed target and user environment values for selected migration definitions', async () => {
    await prepared();
    if (!stage) throw new Error('Missing stage');
    const source = { id: 'next', sha256: 'a'.repeat(64), bytes: Buffer.from('fixture') };
    files.getAppMigrations.mockResolvedValue([source]);
    vi.stubEnv('ONLY_IN_CORE', 'must-stay-out');
    try {
      const inputs = await service.readAppUpdateMigrationInputs(urn, stage, ['next']);
      expect(inputs.environment).toEqual({ TARGET: 'prepared', SETTING: 'kept' });
      expect(inputs.sources).toEqual([source]);
      expect(files.getAppMigrations).toHaveBeenCalledExactlyOnceWith(urn, stage.targetDirectory, ['next']);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('refuses changed authority while reading selected migration bytes', async () => {
    await prepared();
    if (!stage) throw new Error('Missing stage');
    files.getAppMigrations.mockImplementation(async () => {
      files.getUserEnv.mockResolvedValue({ path: '/user.env', content: 'EDITED=true' });
      return [];
    });
    await expect(service.readAppUpdateMigrationInputs(urn, stage, [])).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('fresh install frozen invocation', () => {
  it.each([false, true])('persists the exact pre-pull manifest selection across a restart, downloaded=%s', async (downloaded) => {
    const installed = path.join(root, 'selected-installed');
    const data = path.join(root, 'selected-data');
    await fs.mkdir(installed, { mode: 0o750 });
    await fs.mkdir(data, { mode: 0o700 });
    files.getAppPaths.mockReturnValue({ appInstalledDir: installed, appDataDir: data });
    const requestId = randomUUID();
    const selected = await service.beginStagedAppUpdate(urn, requestId, {
      appId: 1,
      appCreatedAt: 123,
      version: 1,
      requestInputSha256: 'd'.repeat(64),
      storageSha256: 'e'.repeat(64),
      initialVolumes: [],
    });
    if (!(selected.transaction instanceof AppUpdateStage)) throw new Error('Missing stage');
    let stage = selected.transaction;
    let plan: Awaited<ReturnType<DockerService['prepareStagedAppUpdate']>> | undefined;
    try {
      await fs.mkdir(stage.targetDirectory, { mode: 0o750 });
      await fs.writeFile(path.join(stage.targetDirectory, 'source.json'), 'selected-package', { mode: 0o640 });
      await stage.recordFreshSubnet('10.128.0.0/24');
      await stage.stageTarget('services: {}', 'FRESH=selected');
      readEffectiveAppCompose.mockResolvedValue({
        name: 'app_test',
        services: {
          web: { image: manifest, labels: { 'runtipi.managed': 'true', 'runtipi.appurn': urn } },
          metrics: { image: manifest, profiles: ['metrics'], labels: { 'runtipi.managed': 'true', 'runtipi.appurn': urn } },
        },
      });
      const inspected = mock<Dockerode.Image>();
      inspected.inspect.mockResolvedValue({ Id: targetImage, Os: 'linux', Architecture: 'amd64' } as Dockerode.ImageInspectInfo);
      const docker = mock<Dockerode>();
      docker.getImage.mockReturnValue(inspected);
      plan = await service.prepareStagedAppUpdate(urn, stage.id, docker, { freshInstall: true, stage });
      const configuration = await plan.freshPullConfiguration();
      await stage.recordFreshPullPlan(plan.inputsSha256, configuration);
      expect((await stage.read()).freshPreparation?.pullPlan?.configuration).toEqual(configuration);
      await expect(stage.recordFreshPullPlan(plan.inputsSha256, { ...configuration, name: 'another-project' })).rejects.toThrow();
      if (downloaded) await plan.pull(); // Its reply or image-binding write may be lost before context exists.
      await plan.release();
      await stage.close();
      stage = (await service.reopenStagedAppUpdate(urn, requestId)).transaction;
      readEffectiveAppCompose.mockReset().mockRejectedValue(new Error('A changed tag must never be resolved again'));
      docker.getImage.mockClear();
      plan = await service.prepareStagedAppUpdate(urn, stage.id, docker, { freshInstall: true, stage });
      expect(readEffectiveAppCompose).not.toHaveBeenCalled();
      expect(await plan.freshPullConfiguration()).toEqual(configuration);
      const binding = await plan.pull();
      await stage.recordPulledImages(binding);
      expect(docker.getImage).toHaveBeenCalledExactlyOnceWith(manifest);
      expect(binding.imageIds).toEqual({ web: targetImage, metrics: targetImage });
      expect(spawn.mock.calls.every((call) => call[1]?.includes('pull') && !call[1]?.includes('up') && !call[1]?.includes('create'))).toBe(true);
      files.getUserEnv.mockResolvedValue({ path: '/user.env', content: 'SETTING=changed' });
      await expect(service.prepareStagedAppUpdate(urn, stage.id, docker, { freshInstall: true, stage })).rejects.toThrow();
      expect(readEffectiveAppCompose).not.toHaveBeenCalled();
    } finally {
      await plan?.release();
      await stage.close();
    }
  });

  it.each([false, true])('creates without starting, then starts only prepared containers without recreation, restart=%s', async (restart) => {
    vi.stubEnv('ORBIS_CORE_PRIVATE_CANARY', 'synthetic-core-only');
    vi.stubEnv('DOCKER_HOST', 'tcp://synthetic-remote:2376');
    vi.stubEnv('DOCKER_CONTEXT', 'synthetic-remote');
    const installed = path.join(root, 'fresh-installed');
    const data = path.join(root, 'fresh-data');
    await fs.mkdir(installed, { mode: 0o750 });
    await fs.mkdir(data, { mode: 0o700 });
    files.getAppPaths.mockReturnValue({ appInstalledDir: installed, appDataDir: data });
    const selected = await service.beginStagedAppUpdate(urn, randomUUID());
    if (!(selected.transaction instanceof AppUpdateStage)) throw new Error('Missing fresh stage');
    let stage = selected.transaction;
    let plan:
      | Awaited<ReturnType<DockerService['prepareStagedAppUpdate']>>
      | Awaited<ReturnType<DockerService['prepareResumedAppUpdate']>>
      | undefined;
    try {
      await fs.mkdir(stage.targetDirectory, { mode: 0o750 });
      await fs.writeFile(path.join(stage.targetDirectory, 'source.json'), 'fresh', { mode: 0o640 });
      await stage.stageTarget('services: {}', 'FRESH=prepared');
      readEffectiveAppCompose.mockResolvedValue({
        name: 'app_test',
        services: {
          web: { image: manifest, labels: { 'runtipi.managed': 'true', 'runtipi.appurn': urn } },
          metrics: { image: manifest, profiles: ['metrics'], labels: { 'runtipi.managed': 'true', 'runtipi.appurn': urn } },
        },
      });
      const inspected = mock<Dockerode.Image>();
      inspected.inspect.mockResolvedValue({ Id: targetImage, Os: 'linux', Architecture: 'amd64' } as Dockerode.ImageInspectInfo);
      const docker = mock<Dockerode>();
      docker.getImage.mockReturnValue(inspected);
      plan = await service.prepareStagedAppUpdate(urn, stage.id, docker, { freshInstall: true });
      await stage.recordPulledImages(await plan.pull());
      await stage.recordContext({
        purpose: 'fresh-install',
        appId: 1,
        appCreatedAt: 123,
        fromVersion: 1,
        toVersion: 1,
        requestInputSha256: 'd'.repeat(64),
        authoritySha256: plan.inputsSha256,
        previousLedger: { baselined: false, migrationIds: [] },
        targetMigrationIds: [],
        updateStatus: 'running',
        originalContainers: [],
      });
      expect(await plan.freshConfiguration()).toMatchObject({ 'x-orbis-fresh-active-services': ['web'], services: { web: { image: targetImage } } });
      await stage.beginFreshStorage('e'.repeat(64), []);
      await stage.beginFreshSeed();
      await stage.confirmFreshSeed();
      await stage.publishTarget();
      const restore = async () => {
        if (!plan) throw new Error('Missing plan');
        const { requestId } = await stage.read();
        await plan.release();
        await stage.close();
        stage = (await service.reopenStagedAppUpdate(urn, requestId)).transaction;
        docker.getImage.mockClear();
        const current = await readEffectiveAppCompose.getMockImplementation()?.([], undefined, {});
        readEffectiveAppCompose.mockResolvedValue({
          ...current,
          services: Object.fromEntries(
            Object.entries(current.services).map(([name, value]) => [name, { ...(value as object), image: 'changed-fixture:tag' }]),
          ),
        });
        readEffectiveAppCompose.mockClear();
        apps.getApp.mockClear();
        const local = {
          modem: {
            dial: (_options: unknown, callback: (error: unknown, result: unknown) => void) =>
              callback(null, { Id: targetImage, Os: 'linux', Architecture: 'amd64' }),
          },
        } as unknown as Pick<Dockerode, 'modem'>;
        await expect(service.prepareResumedAppUpdate(urn, stage, local)).rejects.toThrow();
        const resumed = await service.prepareResumedAppUpdate(urn, stage, local, { freshInstall: true });
        expect(docker.getImage).not.toHaveBeenCalled();
        expect(apps.getApp).not.toHaveBeenCalled();
        expect(readEffectiveAppCompose).toHaveBeenCalledExactlyOnceWith(expect.any(Array), undefined, { keepRelativePaths: true, localSocket: true });
        return resumed;
      };
      if (restart) plan = await restore();
      await expect(plan.activate()).rejects.toThrow();
      expect(spawn).toHaveBeenCalledTimes(1); // only the pull, no possible app start before the baseline
      await plan.createFresh(stage);
      expect((await stage.read()).freshInstall?.createAttempted).toBe(true);
      expect(spawn.mock.lastCall?.[1]).toEqual(expect.arrayContaining(['create', '--no-build', '--pull', 'never']));
      expect(spawn.mock.lastCall?.[1]).not.toContain('up');
      const created = spawn.mock.calls.length;
      await expect(plan.createFresh(stage)).rejects.toThrow();
      expect(spawn).toHaveBeenCalledTimes(created);
      if (restart) {
        plan = await restore();
        await expect(plan.createFresh(stage)).rejects.toThrow();
        expect(spawn).toHaveBeenCalledTimes(created);
      }
      await stage.preparedFreshStorage([
        { id: 'f'.repeat(64), imageId: targetImage, service: 'web', active: true, mountsSha256: 'a'.repeat(64) },
        { id: 'e'.repeat(64), imageId: targetImage, service: 'metrics', active: false, mountsSha256: 'a'.repeat(64) },
      ]);
      await stage.beginFreshBaseline();
      await expect(stage.activationAttempted()).rejects.toThrow();
      await stage.confirmFreshBaseline({ readFreshInstallBaseline: async () => true });
      await stage.pinFreshImages(await service.getAppImagePinSource(urn, stage.id));
      await stage.activationAttempted();
      await plan.activate();
      expect(spawn.mock.lastCall?.[1]).toEqual(expect.arrayContaining(['up', '--no-recreate', '--no-build', '--pull', 'never']));
      expect(spawn.mock.lastCall?.[1]).not.toContain('--force-recreate');
      expect(spawn.mock.lastCall?.[1]).not.toContain('--remove-orphans');
      expect(spawn.mock.lastCall?.[1]?.at(-1)).toBe('web');
      expect(spawn.mock.lastCall?.[1]).not.toContain('metrics');
      expect(spawn.mock.lastCall?.[2]?.env).toMatchObject({ DOCKER_HOST: 'unix:///var/run/docker.sock', DOCKER_CONTEXT: '', DOCKER_TLS_VERIFY: '' });
      expect(spawn.mock.lastCall?.[2]?.env?.ORBIS_CORE_PRIVATE_CANARY).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      await plan?.release();
      await stage.close();
    }
  });
});

it('uses only the app CLI environment for ordinary app commands without changing their configured transport', async () => {
  vi.stubEnv('ORBIS_CORE_PRIVATE_CANARY', 'synthetic-core-only');
  vi.stubEnv('DOCKER_CONTEXT', 'synthetic-configured-context');
  try {
    await service.composeApp(urn, 'up --detach');
    expect(spawn.mock.lastCall?.[2]?.env?.ORBIS_CORE_PRIVATE_CANARY).toBeUndefined();
    expect(spawn.mock.lastCall?.[2]?.env?.DOCKER_CONTEXT).toBe('synthetic-configured-context');
  } finally {
    vi.unstubAllEnvs();
  }
});

it('matches the original deployed configuration with captured overrides, profiles, stage marker and pinned descriptor', async () => {
  const metadata = path.join(root, 'installed');
  const data = path.join(root, 'app-data');
  await fs.mkdir(metadata);
  await fs.mkdir(data);
  await fs.writeFile(path.join(metadata, 'docker-compose.generated.yml'), 'services: {}', { mode: 0o640 });
  await fs.writeFile(path.join(data, 'app.env'), 'COMPOSE_PROFILES=metrics', { mode: 0o600 });
  files.getUserEnv.mockResolvedValue({ path: '/user.env', content: 'SETTING=kept' });
  const stage = await AppUpdateStage.create({
    directory: path.join(root, 'image-pins'),
    appUrn: urn,
    metadata,
    env: path.join(data, 'app.env'),
    requestId: randomUUID(),
  });
  const release = vi.fn(async () => {});
  try {
    await fs.mkdir(stage.targetDirectory, { mode: 0o750 });
    await stage.stageTarget('services: {}', 'NEW=true');
    await stage.recordPulledImages({ activationSha256: '1'.repeat(64), imageIds: { web: targetImage } });
    const source = await stage.readOriginalBaseline();
    readEffectiveAppCompose.mockResolvedValue({
      name: 'app_test',
      services: {
        web: { image: 'nginx:original', labels: { 'runtipi.managed': 'true', 'runtipi.appurn': urn } },
        metrics: { image: 'metrics:original', profiles: ['metrics'] },
        dormant: { image: 'unused:original', profiles: ['unused'] },
      },
    });
    prepareFrozenUpdateInvocation.mockImplementationOnce(async (options) => ({
      args: ['--file', '/proc/self/fd/3'],
      fd: 99,
      sha256: '2'.repeat(64),
      release,
      effective: options.effective,
    }));
    spawn.mockImplementationOnce(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
      process.nextTick(() => {
        child.stdout.emit('data', Buffer.from('web ' + '3'.repeat(64) + '\nmetrics ' + '4'.repeat(64) + '\ndormant ' + '5'.repeat(64)));
        child.emit('close', 0, null);
      });
      return child;
    });
    const marker = randomUUID();
    const model = await service.prepareExistingBaselineConfiguration(urn, stage, { web: marker });
    expect(model).toMatchObject({ activeServices: ['metrics', 'web'], configurationSha256: '2'.repeat(64), serviceHashes: { web: '3'.repeat(64) } });
    expect(readEffectiveAppCompose.mock.calls.at(-1)?.[0]).toEqual(
      expect.arrayContaining([
        '--project-directory',
        metadata,
        '--env-file',
        source.env,
        '--file',
        path.join(source.metadata, 'docker-compose.generated.yml'),
      ]),
    );
    expect(prepareFrozenUpdateInvocation.mock.calls.at(-1)?.[0].effective.services.web.labels['io.orbis.app-update.stage']).toBe(marker);
    expect(prepareFrozenUpdateInvocation.mock.calls.at(-1)?.[0].effective.services.metrics.labels).toBeUndefined();
    expect(spawn.mock.calls.at(-1)?.[1]).toEqual(['--env-file', '/dev/null', '--profile', '*', '--file', '/proc/self/fd/3', 'config', '--hash', '*']);
    expect(spawn.mock.calls.at(-1)?.[2].stdio).toEqual(['ignore', 'pipe', 'pipe', 99]);
    expect(release).toHaveBeenCalledOnce();
    expect((await stage.read()).phase).toBe('target-ready');
  } finally {
    await stage.close();
  }
});
