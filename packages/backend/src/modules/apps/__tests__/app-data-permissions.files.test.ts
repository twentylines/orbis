import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeAppDataWritable } from '../app-data-permissions';
import { AppFilesManager } from '../app-files-manager';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { LoggerService } from '@/core/logger/logger.service';
import type { AppUrn } from '@runtipi/common/types';

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'app-mode-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

it('prepares nested data without following links or exposing the private interpolation file', async () => {
  const root = path.join(directory, 'data');
  const other = path.join(directory, 'other');
  await fs.mkdir(path.join(root, 'nested'), { recursive: true, mode: 0o700 });
  await fs.mkdir(other, { mode: 0o700 });
  await fs.writeFile(path.join(root, 'nested', 'seed'), 'data', { mode: 0o600 });
  await fs.writeFile(path.join(root, 'app.env'), 'APP_VALUE=retained', { mode: 0o600 });
  await fs.link(path.join(root, 'app.env'), path.join(root, 'nested', 'environment-alias'));
  await fs.writeFile(path.join(other, 'retained'), 'outside', { mode: 0o600 });
  await fs.symlink(other, path.join(root, 'directory-link'));
  await fs.symlink(path.join(other, 'retained'), path.join(root, 'file-link'));
  await fs.symlink(path.join(other, 'absent'), path.join(root, 'broken-link'));
  await makeAppDataWritable(root);
  expect((await fs.stat(path.join(root, 'nested', 'seed'))).mode & 0o777).toBe(0o777);
  expect((await fs.stat(path.join(root, 'nested'))).mode & 0o777).toBe(0o777);
  expect((await fs.stat(path.join(root, 'app.env'))).mode & 0o777).toBe(0o600);
  expect((await fs.stat(path.join(other, 'retained'))).mode & 0o777).toBe(0o600);
  expect((await fs.stat(other)).mode & 0o777).toBe(0o700);
  expect(await fs.readFile(path.join(root, 'app.env'), 'utf8')).toBe('APP_VALUE=retained');
});

it('refuses a linked or missing data root', async () => {
  const target = path.join(directory, 'target');
  await fs.mkdir(target, { mode: 0o700 });
  await fs.symlink(target, path.join(directory, 'link'));
  await expect(makeAppDataWritable(path.join(directory, 'link'))).rejects.toThrow();
  await expect(makeAppDataWritable(path.join(directory, 'absent'))).rejects.toThrow();
  expect((await fs.stat(target)).mode & 0o777).toBe(0o700);
});

it('propagates chmod errors and closes the opened descriptor', async () => {
  const open = fs.open.bind(fs);
  let closed = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    vi.spyOn(handle, 'chmod').mockRejectedValue(new Error('Permission denied'));
    const close = handle.close.bind(handle);
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      await close();
      closed = true;
    });
    return handle;
  });
  await expect(makeAppDataWritable(directory)).rejects.toThrow('Permission denied');
  expect(closed).toBe(true);
});

it.each(['regular', 'linked', 'directory'] as const)('handles a %s generated Compose destination without deleting existing files', async (kind) => {
  const logger = { error: vi.fn(), debug: vi.fn() } as unknown as LoggerService;
  const filesystem = new FilesystemService(logger);
  vi.spyOn(filesystem, 'getSafeFilePath').mockImplementation((name) => {
    if (name !== directory && !name.startsWith(directory + path.sep)) throw new Error('Outside test directory');
    return name;
  });
  const configuration = {
    getConfig: () => ({ directories: { dataDir: directory, appDataDir: path.join(directory, 'app-data') } }),
  } as unknown as ConfigurationService;
  const manager = new AppFilesManager(configuration, filesystem, logger);
  const urn = 'demo:store' as AppUrn;
  const installed = manager.getAppPaths(urn).appInstalledDir;
  await fs.mkdir(installed, { recursive: true });
  const file = path.join(installed, 'docker-compose.generated.yml');
  const target = path.join(directory, 'operator-compose.yml');
  if (kind === 'directory') {
    await fs.mkdir(file);
    await fs.writeFile(path.join(file, 'retained'), 'kept');
    await expect(manager.writeDockerComposeYml(urn, 'services: {}')).rejects.toThrow('Failed to write generated');
    expect(await fs.readFile(path.join(file, 'retained'), 'utf8')).toBe('kept');
  } else {
    await fs.writeFile(kind === 'linked' ? target : file, 'old', { mode: 0o600 });
    if (kind === 'linked') await fs.symlink(target, file);
    await manager.writeDockerComposeYml(urn, 'services: {}');
    expect(await fs.readFile(file, 'utf8')).toBe('services: {}\n');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    if (kind === 'linked') expect((await fs.lstat(file)).isSymbolicLink()).toBe(true);
  }
});

it.skipIf(process.platform !== 'linux')('keeps Linux traversal on the opened directory if its pathname is replaced', async () => {
  const root = path.join(directory, 'data');
  const moved = path.join(directory, 'original');
  const external = path.join(directory, 'external');
  await fs.mkdir(root, { mode: 0o700 });
  await fs.mkdir(external, { mode: 0o700 });
  await fs.writeFile(path.join(root, 'seed'), 'data', { mode: 0o600 });
  await fs.writeFile(path.join(external, 'kept'), 'outside', { mode: 0o600 });
  const readdir = fs.readdir.bind(fs);
  let replaced = false;
  vi.spyOn(fs, 'readdir').mockImplementation((async (...args: Parameters<typeof fs.readdir>) => {
    if (!replaced) {
      replaced = true;
      await fs.rename(root, moved);
      await fs.symlink(external, root);
    }
    return readdir(...args);
  }) as typeof fs.readdir);
  await makeAppDataWritable(root);
  expect((await fs.stat(path.join(moved, 'seed'))).mode & 0o777).toBe(0o777);
  expect((await fs.stat(path.join(external, 'kept'))).mode & 0o777).toBe(0o600);
});
