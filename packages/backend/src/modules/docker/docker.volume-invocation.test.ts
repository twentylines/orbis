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
let logger: ReturnType<typeof mock<LoggerService>>;
let child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
const frozenArgs = ['--project-name', 'app_test', '--project-directory', '/project', '--file', '/proc/self/fd/3'];

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('ORBIS_PARENT_ONLY_CANARY', 'excluded-from-app-interpolation');
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
  logger = mock<LoggerService>();
  service = new DockerService(logger, config, files, mock<FilesystemService>(), apps);
  release = vi.fn().mockResolvedValue(undefined);
  mocks.read.mockResolvedValue({ effective: 'model' });
  mocks.prepare.mockImplementation(async () => ({ args: [...frozenArgs], fd: 42, release }));
  child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
  mocks.spawn.mockReturnValue(child);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

it('preserves Compose output across chunk, whitespace and UTF-8 boundaries without logging interpolated configuration', async () => {
  const run = service.composeApp(urn, 'config --format json');
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
  const text = '{"value":" a café b "}\n';
  const bytes = Buffer.from(text);
  const boundary = bytes.indexOf(Buffer.from('é')) + 1;
  child.stdout.emit('data', bytes.subarray(0, boundary));
  child.stdout.emit('data', bytes.subarray(boundary));
  child.stderr.emit('data', Buffer.from(' first warning\n'));
  child.stderr.emit('data', Buffer.from(' second warning\n'));
  child.emit('close', 0);
  await expect(run).resolves.toEqual({ success: true, stdout: text, stderr: ' first warning\n second warning\n' });
  expect(logger.debug).not.toHaveBeenCalled();
});

it('retains the complete Compose error across stderr chunks', async () => {
  const run = service.composeApp(urn, 'up --detach');
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
  child.stderr.emit('data', Buffer.from('first part\n'));
  child.stderr.emit('data', Buffer.from('last part\n'));
  child.emit('close', 2);
  await expect(run).rejects.toThrow('first part\nlast part');
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
    {
      env: expect.objectContaining({ DOCKER_HOST: 'unix:///var/run/docker.sock', DOCKER_CONTEXT: '', DOCKER_TLS_VERIFY: '' }),
      stdio: ['pipe', 'pipe', 'pipe', 42],
    },
  );
  expect(mocks.spawn.mock.calls[0]?.[2].env).not.toHaveProperty('ORBIS_PARENT_ONLY_CANARY');
  expect(release).not.toHaveBeenCalled();
  child.emit('close', 0);
  await expect(run).resolves.toMatchObject({ success: true });
  expect(release).toHaveBeenCalledOnce();
});

it('runs the restore gate after final Compose preparation and skips spawn on a late refusal', async () => {
  mocks.authority.mockResolvedValue({ pins });
  await expect(
    service.composeApp(urn, 'up --detach', {
      restoreStart: async () => {
        expect(mocks.prepare).toHaveBeenCalledOnce();
        throw new Error('live restore hold');
      },
    }),
  ).rejects.toThrow('live restore hold');
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
});

it('dispatches an admitted restore using the pinned local Docker endpoint', async () => {
  mocks.authority.mockResolvedValue({ pins });
  const run = service.composeApp(urn, 'up --detach', {
    restoreStart: async (effect) => {
      expect(mocks.prepare).toHaveBeenCalledOnce();
      expect(mocks.spawn).not.toHaveBeenCalled();
      return effect();
    },
  });
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
  expect(mocks.spawn).toHaveBeenCalledWith('docker-compose', [...frozenArgs, 'up', '--detach'], {
    env: expect.objectContaining({ DOCKER_HOST: 'unix:///var/run/docker.sock', DOCKER_CONTEXT: '' }),
    stdio: ['pipe', 'pipe', 'pipe', 42],
  });
  child.emit('close', 0);
  await expect(run).resolves.toMatchObject({ success: true });
  expect(release).toHaveBeenCalledOnce();
});

it('keeps a log-stream descriptor until the child exits and releases it after close', async () => {
  mocks.authority.mockResolvedValue({ pins });
  const stream = await service.getLogsStream(25, urn);
  expect(mocks.spawn).toHaveBeenCalledWith('docker-compose', [...frozenArgs, 'logs', '--follow', '-n', '25'], {
    env: expect.objectContaining({ DOCKER_HOST: 'unix:///var/run/docker.sock', DOCKER_CONTEXT: '' }),
    stdio: ['pipe', 'pipe', 'pipe', 42],
  });
  expect(mocks.spawn.mock.calls[0]?.[2].env).not.toHaveProperty('ORBIS_PARENT_ONLY_CANARY');
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

it('keeps ordinary no-pin arguments and configured transport while excluding parent app values', async () => {
  vi.stubEnv('DOCKER_HOST', 'tcp://example.invalid:2376');
  const run = service.composeApp(urn, 'up --detach');
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.spawn).toHaveBeenCalledWith(
    'docker-compose',
    [
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
    ],
    { env: expect.objectContaining({ DOCKER_HOST: 'tcp://example.invalid:2376' }) },
  );
  expect(mocks.spawn.mock.calls[0]?.[2].env).not.toHaveProperty('ORBIS_PARENT_ONLY_CANARY');
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
