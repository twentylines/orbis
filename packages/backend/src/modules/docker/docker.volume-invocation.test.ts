import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppUrn } from '@runtipi/common/types';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '../apps/app-files-manager';
import { AppsService } from '../apps/apps.service';
import { DockerService } from './docker.service';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), read: vi.fn(), prepare: vi.fn(), authority: vi.fn() }));
vi.mock('node:child_process', async (original) => ({ ...(await original<typeof import('node:child_process')>()), spawn: mocks.spawn }));
vi.mock('./app-volume-invocation', () => ({ readEffectiveAppCompose: mocks.read, prepareAppVolumeInvocation: mocks.prepare }));
vi.mock('./app-volume-authority', () => ({ readAppVolumeAuthority: mocks.authority }));
const urn = 'app:test' as AppUrn;
const pins = {
  version: 1 as const,
  appUrn: urn,
  project: 'app_test',
  services: [{ name: 'web', mounts: [{ target: '/data', volume: 'restored', readOnly: false }] }],
};
let root: string;
let service: DockerService;
let apps: ReturnType<typeof mock<AppsService>>;
let release: ReturnType<typeof vi.fn>;
let child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
const frozenArgs = ['--project-name', 'app_test', '--project-directory', '/project', '--file', '/proc/self/fd/3'];

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.authority.mockResolvedValue(null);
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'docker-volume-invocation-')));
  const config = mock<ConfigurationService>();
  config.get.calledWith('directories').mockReturnValue({ dataDir: root } as never);
  const files = mock<AppFilesManager>();
  files.getAppEnv.mockResolvedValue({ path: '/app.env', content: '' });
  files.getUserEnv.mockResolvedValue({ path: '/user.env', content: 'SETTING=yes' });
  files.getGeneratedDockerComposeYaml.mockResolvedValue({ path: '/project/generated.yml', content: 'services: {}' });
  files.getUserComposeFile.mockResolvedValue({ path: '/user.yml', content: 'services: {}' });
  apps = mock<AppsService>();
  apps.getApp.mockResolvedValue({ app: { userConfigEnabled: true } } as never);
  service = new DockerService(mock<LoggerService>(), config, files, mock<FilesystemService>(), apps);
  release = vi.fn().mockResolvedValue(undefined);
  mocks.read.mockResolvedValue({ effective: 'model' });
  mocks.prepare.mockImplementation(async () => ({ args: [...frozenArgs], fd: 42, release }));
  child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
  mocks.spawn.mockReturnValue(child);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

it.each([
  { enabled: true, explicit: false },
  { enabled: false, explicit: false },
  { enabled: true, explicit: true },
  { enabled: false, explicit: true },
])('freezes the final pre-pin args with user config $enabled and explicit update $explicit', async ({ enabled, explicit }) => {
  mocks.authority.mockResolvedValue({ pins });
  apps.getApp.mockResolvedValue({ app: { userConfigEnabled: enabled } } as never);
  const tx = randomUUID();
  let options: { imagePins?: 'explicit-update'; imagePinUpdate?: string } = {};
  if (explicit) {
    const dir = path.join(root, 'state', 'time-machine', 'image-pins');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${createHash('sha256').update(urn).digest('hex')}.update.json`);
    await fs.writeFile(file, JSON.stringify({ version: 1, appUrn: urn, id: tx, phase: 'prepared' }), { mode: 0o600 });
    options = { imagePins: 'explicit-update', imagePinUpdate: tx };
  } else {
    vi.spyOn(service, 'readAppImagePins').mockResolvedValue({ pins: {} as never, path: '/image-pins.json' });
  }
  const expected = [
    '--env-file',
    '/app.env',
    ...(enabled ? ['--env-file', '/user.env'] : []),
    '--project-name',
    'app_test',
    '-f',
    '/project/generated.yml',
    ...(enabled ? ['--file', '/user.yml'] : []),
    ...(explicit ? [] : ['--file', '/image-pins.json']),
  ];
  const run = service.composeApp(urn, 'up --detach', options);
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
  expect(mocks.read).toHaveBeenCalledWith(expected, undefined);
  expect(mocks.prepare).toHaveBeenCalledWith({
    effective: { effective: 'model' },
    pins,
    projectDirectory: '/project',
    directory: path.join(root, 'state', 'app-volume-invocations'),
  });
  expect(mocks.read.mock.invocationCallOrder[0]).toBeLessThan(mocks.prepare.mock.invocationCallOrder[0] ?? 0);
  expect(mocks.spawn).toHaveBeenCalledWith(
    'docker-compose',
    [...frozenArgs, 'up', '--detach', ...(explicit ? [] : ['--no-build', '--pull', 'never'])],
    { stdio: ['pipe', 'pipe', 'pipe', 42] },
  );
  expect(release).not.toHaveBeenCalled();
  child.emit('close', 0);
  await expect(run).resolves.toMatchObject({ success: true });
  expect(release).toHaveBeenCalledOnce();
});

it('keeps a log-stream descriptor until the child exits and releases it after close', async () => {
  mocks.authority.mockResolvedValue({ pins });
  const stream = await service.getLogsStream(25, urn);
  expect(mocks.spawn).toHaveBeenCalledWith('docker-compose', [...frozenArgs, 'logs', '--follow', '-n', '25'], {
    stdio: ['pipe', 'pipe', 'pipe', 42],
  });
  expect(release).not.toHaveBeenCalled();
  stream.kill();
  expect(child.kill).toHaveBeenCalledWith('SIGINT');
  child.emit('close', 0);
  await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
});

it('releases the descriptor on spawn error and on nonzero exit', async () => {
  mocks.authority.mockResolvedValue({ pins });
  const first = service.composeApp(urn, 'up');
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
  child.emit('error', new Error('spawn failed'));
  await expect(first).rejects.toThrow('spawn failed');
  expect(release).toHaveBeenCalledTimes(1);
  const second = service.composeApp(urn, 'up');
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(2));
  child.stderr.emit('data', 'compose failed');
  child.emit('close', 1);
  await expect(second).rejects.toThrow('compose failed');
  expect(release).toHaveBeenCalledTimes(2);
});

it('terminates an aborted invocation and releases its descriptor after child exit', async () => {
  mocks.authority.mockResolvedValue({ pins });
  const abort = new AbortController();
  const run = service.composeApp(urn, 'up', { signal: abort.signal });
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
  abort.abort(new Error('cancelled'));
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  expect(release).not.toHaveBeenCalled();
  child.emit('close', null);
  await expect(run).rejects.toThrow('cancelled');
  expect(release).toHaveBeenCalledOnce();
});

it('keeps ordinary no-pin compose invocation unchanged', async () => {
  const run = service.composeApp(urn, 'up --detach');
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.spawn).toHaveBeenCalledWith('docker-compose', [
    '--env-file',
    '/app.env',
    '--env-file',
    '/user.env',
    '--project-name',
    'app_test',
    '-f',
    '/project/generated.yml',
    '--file',
    '/user.yml',
    'up',
    '--detach',
  ]);
  child.emit('close', 0);
  await expect(run).resolves.toMatchObject({ success: true });
  expect(release).not.toHaveBeenCalled();
});

it('never runs compose when durable storage authority is missing or invalid', async () => {
  mocks.authority.mockRejectedValue(new Error('App storage protection is not ready.'));
  await expect(service.composeApp(urn, 'up --detach')).rejects.toThrow('storage protection');
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.spawn).not.toHaveBeenCalled();
});
