import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppHelpers } from '../apps/app.helpers';
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
import { DockerService } from './docker.service';
import type { AppUrn } from '@runtipi/common/types';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({ ...(await original<typeof import('node:child_process')>()), spawn }));
const urn = 'app:test' as AppUrn;
const image = `sha256:${'9'.repeat(64)}`;
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
  apps.getApp.mockResolvedValue({ app: { userConfigEnabled: true } } as never);
  service = new DockerService(mock<LoggerService>(), config, files, mock<FilesystemService>(), apps);
  source = await service.getAppImagePinSource(urn);
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
  it.each(['pull', 'activation'])('handles failed %s without an unusable silent rollback', async (failure) => {
    const installed = path.join(root, 'installed');
    const data = path.join(root, 'data');
    await fs.mkdir(installed, { mode: 0o750 });
    await fs.mkdir(data, { mode: 0o700 });
    const sourceFile = path.join(installed, 'source.json');
    const generated = path.join(installed, 'generated.yml');
    const env = path.join(data, 'app.env');
    const old = convertLegacyToYaml({ schemaVersion: 2, services: [{ name: 'web', image: 'nginx:old', isMain: true, internalPort: 80 }] });
    const next = convertLegacyToYaml({ schemaVersion: 2, services: [{ name: 'web', image: 'nginx:new', isMain: true, internalPort: 80 }] });
    await fs.writeFile(sourceFile, JSON.stringify(old), { mode: 0o640 });
    await fs.writeFile(generated, 'services:\n  web:\n    image: nginx:old', { mode: 0o640 });
    await fs.writeFile(env, 'IMAGE=nginx:old', { mode: 0o600 });
    await fs.writeFile(path.join(data, 'accepted-write'), 'original-data');
    files.getAppPaths.mockReturnValue({ appInstalledDir: installed, appDataDir: data });
    files.getSourceDockerComposeYaml.mockImplementation(async () => ({
      path: sourceFile,
      content: JSON.parse(await fs.readFile(sourceFile, 'utf8')),
    }));
    files.getGeneratedDockerComposeYaml.mockImplementation(async () => ({ path: generated, content: await fs.readFile(generated, 'utf8') }));
    files.getUserComposeFile.mockResolvedValue({ path: '/unused.yml', content: null });
    files.getAppEnv.mockImplementation(async () => ({ path: env, content: await fs.readFile(env, 'utf8') }));
    files.getInstalledAppInfo.mockResolvedValue({ force_pull: true } as never);
    files.writeDockerComposeYml.mockImplementation(async (_urn, content) => {
      await fs.writeFile(generated, content);
    });
    files.deleteAppFolder.mockImplementation(async () => {
      await fs.rm(installed, { recursive: true });
    });
    const marketplace = mock<MarketplaceService>();
    const helpers = mock<AppHelpers>();
    const config = mock<ConfigurationService>();
    const subnet = mock<SubnetManagerService>();
    subnet.allocateSubnet.mockResolvedValue('10.128.10.0/24');
    config.get.calledWith('architecture').mockReturnValue('arm64');
    marketplace.getSourceDockerComposeYaml.mockResolvedValue({ path: '/repository/source.json', content: next });
    marketplace.copyAppFromRepoToInstalled.mockImplementation(async () => {
      await fs.mkdir(installed, { mode: 0o750 });
      await fs.writeFile(sourceFile, JSON.stringify(next), { mode: 0o640 });
    });
    helpers.generateEnvFile.mockImplementation(async () => {
      const current = JSON.parse(await fs.readFile(sourceFile, 'utf8'));
      await fs.writeFile(env, `IMAGE=${current.services.web.image}`, { mode: 0o600 });
    });
    const docker = mock<Dockerode>();
    const container = mock<Dockerode.Container>();
    docker.listContainers.mockResolvedValue([{ Id: 'owned-app' }] as Dockerode.ContainerInfo[]);
    docker.getContainer.mockReturnValue(container);
    container.inspect.mockResolvedValue({ State: { Running: true } } as Dockerode.ContainerInspectInfo);
    docker.pruneContainers.mockResolvedValue({ ContainersDeleted: [], SpaceReclaimed: 0 });
    const services = new Map<unknown, unknown>([
      [LoggerService, mock<LoggerService>()],
      [AppFilesManager, files],
      [DockerService, service],
      [MarketplaceService, marketplace],
      [AppHelpers, helpers],
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
    spawn.mockImplementation((_binary, argv) => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      process.nextTick(async () => {
        const newStart = argv.includes('up') && argv.includes('--wait');
        if (failure === 'activation' && newStart) await fs.writeFile(path.join(data, 'accepted-write'), 'accepted-new-data');
        if ((failure === 'pull' && argv.includes('pull')) || (failure === 'activation' && newStart)) {
          child.stderr.emit('data', Buffer.from('candidate failed'));
          child.emit('close', 1);
        } else child.emit('close', 0);
      });
      return child;
    });
    const updated = await new UpdateAppCommand(moduleRef, docker, false).execute(urn, {});
    expect(updated.success).toBe(false);
    helpers.generateEnvFile.mockClear();
    docker.pruneContainers.mockClear();
    const started = await new StartAppCommand(moduleRef, docker).execute(urn, {});
    if (failure === 'pull') {
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
