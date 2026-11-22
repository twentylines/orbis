import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppUrn } from '@runtipi/common/types';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppStoreFilesManager } from '../../app-stores/app-store-files-manager';
import { readAppPackageAsset } from '../../app-stores/app-package-links';
import { AppFilesManager } from '../../apps/app-files-manager';
import { AppUpdateStage } from '../../docker/app-update-stage';
import { appUpdateStorage } from '../../docker/app-image-pins';
import { readAppMigrationSources } from '../../apps/app-migrations';
import type { AppStore } from '@/core/database/drizzle/types';
import { createMockAppInfo } from '@/tests/helpers/app-mocks';
let root: string;
let stage: AppUpdateStage | undefined;
const urn = 'demo:store' as AppUrn;
beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(await fs.promises.realpath(os.tmpdir()), 'pl-'));
});
afterEach(async () => {
  await stage?.close();
  stage = undefined;
  vi.restoreAllMocks();
  await fs.promises.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const logger = mock<LoggerService>();
  const configuration = {
    get: () => ({ dataDir: root, appDataDir: path.join(root, 'app-data'), appDir: root }),
    getConfig: () => ({ directories: { dataDir: root, appDataDir: path.join(root, 'app-data'), appDir: root } }),
  } as unknown as ConfigurationService;
  const filesystem = new FilesystemService(logger);
  vi.spyOn(filesystem, 'getSafeFilePath').mockImplementation((name) => {
    if (name !== root && !name.startsWith(root + '/')) throw new Error('Outside fixture');
    return name;
  });
  const store = new AppStoreFilesManager(configuration, filesystem, logger, { slug: 'store' } as AppStore);
  const files = new AppFilesManager(configuration, filesystem, logger);
  const repository = path.join(root, 'repos/store/apps/demo');
  await fs.promises.mkdir(path.join(repository, 'metadata'), { recursive: true });
  await fs.promises.writeFile(
    path.join(repository, 'config.json'),
    JSON.stringify(createMockAppInfo({ id: 'demo', categories: ['utilities'], tipi_version: 1, version: '1.0.0' })),
    {
      mode: 0o640,
    },
  );
  await fs.promises.writeFile(path.join(repository, 'metadata/real.jpg'), 'fixture-image', { mode: 0o640 });
  await fs.promises.writeFile(path.join(repository, 'metadata/real.md'), 'Linked description', { mode: 0o640 });
  await fs.promises.symlink('real.jpg', path.join(repository, 'metadata/logo.jpg'));
  await fs.promises.symlink('real.md', path.join(repository, 'metadata/description.md'));
  await fs.promises.writeFile(path.join(repository, 'docker-compose.generated.yml'), 'catalogue generated file must never install', { mode: 0o640 });
  await fs.promises.mkdir(path.join(repository, 'data'));
  await fs.promises.writeFile(path.join(repository, 'data/seed'), 'seed');
  await fs.promises.symlink('seed', path.join(repository, 'data/alias'));
  await fs.promises.mkdir(path.join(root, 'assets'));
  await fs.promises.writeFile(path.join(root, 'assets/default-app-logo.jpg'), 'default-image');
  const paths = files.getAppPaths(urn);
  return { store, files, filesystem, logger, repository, paths };
}
it('installs portable assets/data links, excludes catalogue-generated Compose, and serves linked assets', async () => {
  const f = await fixture();
  await f.store.copyAppFromRepoToInstalled(urn);
  expect(await fs.promises.readlink(path.join(f.paths.appInstalledDir, 'metadata/logo.jpg'))).toBe('real.jpg');
  expect(await fs.promises.readlink(path.join(f.paths.appInstalledDir, 'data/alias'))).toBe('seed');
  await expect(fs.promises.lstat(path.join(f.paths.appInstalledDir, 'docker-compose.generated.yml'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await f.store.getAppImage(urn)).image?.toString()).toBe('fixture-image');
  expect((await f.store.getAppInfoFromAppStore(urn))?.description).toBe('Linked description');
  expect((await f.files.getInstalledAppInfo(urn))?.description).toBe('Linked description');
  expect((await fs.promises.stat(path.join(f.paths.appInstalledDir, 'metadata/real.jpg'))).mode & 0o777).toBe(0o640);
});
it('takes and reopens a linked baseline, publishes a linked target and rolls metadata back without changing app data', async () => {
  const f = await fixture();
  await f.store.copyAppFromRepoToInstalled(urn);
  const env = path.join(f.paths.appDataDir, 'app.env');
  await fs.promises.writeFile(env, 'OLD=true', { mode: 0o600 });
  await fs.promises.writeFile(path.join(f.paths.appDataDir, 'accepted-data'), 'unchanged');
  const input = { directory: path.join(root, 'pins'), appUrn: urn, metadata: f.paths.appInstalledDir, env, requestId: randomUUID() };
  stage = await AppUpdateStage.create(input);
  await f.store.stageAppUpdate(urn, stage.targetDirectory);
  await stage.stageTarget('services: {}', 'NEW=true');
  await stage.recordPulledImages({ activationSha256: 'a'.repeat(64), imageIds: { web: 'sha256:' + 'b'.repeat(64) } });
  const baseline = await stage.readOriginalBaseline();
  expect(await fs.promises.readlink(path.join(baseline.metadata, 'metadata/logo.jpg'))).toBe('real.jpg');
  await stage.recordContext({
    appId: 1,
    appCreatedAt: 123,
    fromVersion: 1,
    toVersion: 2,
    requestInputSha256: 'c'.repeat(64),
    authoritySha256: 'd'.repeat(64),
    previousLedger: { baselined: true, migrationIds: [] },
    targetMigrationIds: [],
    updateStatus: 'stopped',
    originalContainers: [],
  });
  await stage.close();
  stage = await AppUpdateStage.open(input);
  await stage.publishTarget();
  await stage.restoreMetadata();
  expect(await fs.promises.readlink(path.join(f.paths.appInstalledDir, 'metadata/logo.jpg'))).toBe('real.jpg');
  expect(await fs.promises.readFile(path.join(f.paths.appDataDir, 'accepted-data'), 'utf8')).toBe('unchanged');
  expect(await fs.promises.readFile(env, 'utf8')).toBe('OLD=true');
});
it.each(['escape', 'absolute', 'cycle', 'linked-private-compose', 'oversized'] as const)(
  'keeps existing installed files and app data when a new package has %s',
  async (fault) => {
    const f = await fixture();
    await f.store.copyAppFromRepoToInstalled(urn);
    const old = await fs.promises.readFile(path.join(f.paths.appInstalledDir, 'config.json'));
    await fs.promises.writeFile(path.join(f.paths.appDataDir, 'accepted-data'), 'keep');
    if (fault === 'escape') await fs.promises.symlink('../../../../../outside', path.join(f.repository, 'bad'));
    if (fault === 'absolute') await fs.promises.symlink(path.join(f.repository, 'config.json'), path.join(f.repository, 'bad'));
    if (fault === 'cycle') {
      await fs.promises.symlink('b', path.join(f.repository, 'a'));
      await fs.promises.symlink('a', path.join(f.repository, 'b'));
    }
    if (fault === 'linked-private-compose') {
      await fs.promises.symlink('../../../../../outside', path.join(f.repository, 'bad-parent'));
      await fs.promises.symlink('bad-parent/private', path.join(f.repository, 'bad'));
    }
    if (fault === 'oversized') {
      await fs.promises.writeFile(path.join(f.repository, 'large'), 'x');
      await fs.promises.truncate(path.join(f.repository, 'large'), 8 * 1024 * 1024 + 1);
    }
    await expect(f.store.copyAppFromRepoToInstalled(urn)).rejects.toThrow();
    expect(await fs.promises.readFile(path.join(f.paths.appInstalledDir, 'config.json'))).toEqual(old);
    expect(await fs.promises.readFile(path.join(f.paths.appDataDir, 'accepted-data'), 'utf8')).toBe('keep');
  },
);
it('preserves safe dangling links but never serves generated private configuration through an image alias', async () => {
  const f = await fixture();
  await fs.promises.symlink('future-file', path.join(f.repository, 'data/dangling'));
  await f.store.copyAppFromRepoToInstalled(urn);
  expect(await fs.promises.readlink(path.join(f.paths.appInstalledDir, 'data/dangling'))).toBe('future-file');
  await fs.promises.writeFile(path.join(f.paths.appInstalledDir, 'docker-compose.generated.yml'), 'SYNTHETIC_PRIVATE_SETTING');
  await fs.promises.unlink(path.join(f.paths.appInstalledDir, 'metadata/logo.jpg'));
  await fs.promises.symlink('../docker-compose.generated.yml', path.join(f.paths.appInstalledDir, 'metadata/logo.jpg'));
  const selected = await readAppPackageAsset(f.paths.appInstalledDir, 'metadata/logo.jpg').catch(() => undefined);
  expect(selected).toBeUndefined();
});
it('continues refusing linked migration definitions even when package links are otherwise valid', async () => {
  const f = await fixture();
  await fs.promises.mkdir(path.join(f.repository, 'migrations'));
  await fs.promises.writeFile(path.join(f.repository, 'migrations/original'), 'services: {}');
  await fs.promises.symlink('original', path.join(f.repository, 'migrations/001-linked.yml'));
  await f.store.copyAppFromRepoToInstalled(urn);
  await expect(readAppMigrationSources(f.paths.appInstalledDir)).rejects.toThrow();
});
it('detects a changed catalogue snapshot before replacing the installed app', async () => {
  const f = await fixture();
  await f.store.copyAppFromRepoToInstalled(urn);
  const capture = appUpdateStorage.metadataState;
  vi.spyOn(appUpdateStorage, 'metadataState').mockImplementationOnce(async (...args) => {
    const result = await capture(...args);
    await fs.promises.writeFile(path.join(f.repository, 'metadata/real.jpg'), 'changed');
    return result;
  });
  await expect(f.store.copyAppFromRepoToInstalled(urn)).rejects.toThrow();
  expect(await fs.promises.readFile(path.join(f.paths.appInstalledDir, 'metadata/real.jpg'), 'utf8')).toBe('fixture-image');
});
it('writes real app environments privately, including an existing permissive file', async () => {
  const f = await fixture();
  await fs.promises.mkdir(f.paths.appDataDir, { recursive: true });
  const env = path.join(f.paths.appDataDir, 'app.env');
  await fs.promises.writeFile(env, 'old', { mode: 0o644 });
  expect(await f.files.writeAppEnv(urn, 'APP_ONLY=fixture')).toBe(true);
  expect((await fs.promises.stat(env)).mode & 0o777).toBe(0o600);
  expect(await fs.promises.readFile(env, 'utf8')).toContain('APP_ONLY=fixture');
});
it.each(['symlink', 'hardlink', 'parent-link'] as const)('does not overwrite a %s private-file alias', async (fault) => {
  const f = await fixture();
  await fs.promises.mkdir(f.paths.appDataDir, { recursive: true });
  const other = path.join(root, 'other');
  await fs.promises.mkdir(other);
  const original = path.join(other, 'app.env');
  await fs.promises.writeFile(original, 'keep');
  const target = path.join(f.paths.appDataDir, 'app.env');
  if (fault === 'symlink') await fs.promises.symlink(original, target);
  if (fault === 'hardlink') await fs.promises.link(original, target);
  if (fault === 'parent-link') {
    await fs.promises.rm(f.paths.appDataDir, { recursive: true });
    await fs.promises.symlink(other, f.paths.appDataDir);
  }
  expect(await f.files.writeAppEnv(urn, 'replacement')).toBe(false);
  expect(await fs.promises.readFile(original, 'utf8')).toBe('keep');
});
it('treats removal of an absent file as success and creates private temporary directories', async () => {
  const f = await fixture();
  expect(await f.filesystem.removeFile(path.join(root, 'absent'))).toBe(true);
  expect(f.logger.error).not.toHaveBeenCalled();
  const directory = await f.filesystem.createTempDirectory(path.join(root, 'private-'));
  expect(directory).not.toBeNull();
  if (!directory) throw new Error('The private temporary directory was not created.');
  expect((await fs.promises.stat(directory)).mode & 0o777).toBe(0o700);
});

it('restores original installed metadata if package publication fails after moving the old directory', async () => {
  const f = await fixture();
  await f.store.copyAppFromRepoToInstalled(urn);
  const original = (await fs.promises.lstat(f.paths.appInstalledDir)).ino;
  const rename = fs.promises.rename.bind(fs.promises);
  vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
    if (String(from).includes('.package-stage-') && String(to) === f.paths.appInstalledDir) throw new Error('Synthetic package publish failure');
    return rename(from, to);
  });
  await expect(f.store.copyAppFromRepoToInstalled(urn)).rejects.toThrow();
  expect((await fs.promises.lstat(f.paths.appInstalledDir)).ino).toBe(original);
  expect(await fs.promises.readFile(path.join(f.paths.appInstalledDir, 'metadata/real.jpg'), 'utf8')).toBe('fixture-image');
});
it('reads portable directory aliases and returns the actual image format without reading host files', async () => {
  const f = await fixture();
  await fs.promises.mkdir(path.join(f.repository, 'assets'));
  await fs.promises.writeFile(path.join(f.repository, 'assets/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await fs.promises.symlink('../assets', path.join(f.repository, 'metadata/shared'));
  await fs.promises.unlink(path.join(f.repository, 'metadata/logo.jpg'));
  await fs.promises.symlink('shared/icon.svg', path.join(f.repository, 'metadata/logo.jpg'));
  await f.store.copyAppFromRepoToInstalled(urn);
  expect(await fs.promises.readlink(path.join(f.paths.appInstalledDir, 'metadata/shared'))).toBe('../assets');
  expect((await f.store.getAppImage(urn)).contentType).toBe('image/svg+xml');
});
it('removes only a newly created temporary directory when its privacy check fails', async () => {
  const f = await fixture();
  const chmod = fs.promises.chmod.bind(fs.promises);
  const mkdtemp = fs.promises.mkdtemp.bind(fs.promises);
  let created = '';
  vi.spyOn(fs.promises, 'mkdtemp').mockImplementation(async (prefix, options) => {
    const result = await mkdtemp(prefix, options as never);
    created = String(result);
    return result;
  });
  vi.spyOn(fs.promises, 'chmod').mockImplementation(async (name, mode) => {
    if (String(name) === created) throw new Error('Synthetic privacy failure');
    return chmod(name, mode);
  });
  await expect(f.filesystem.createTempDirectory(path.join(root, 'failed-private-'))).rejects.toThrow();
  await expect(fs.promises.lstat(created)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.promises.lstat(f.repository)).toBeDefined();
});

it('resolves parent components after earlier links and refuses a chained escape that lexical normalization would hide', async () => {
  const f = await fixture();
  await f.store.copyAppFromRepoToInstalled(urn);
  await fs.promises.writeFile(path.join(path.dirname(f.repository), 'outside.jpg'), 'SYNTHETIC_OUTSIDE_IMAGE');
  await fs.promises.symlink('.', path.join(f.repository, 'shared'));
  await fs.promises.unlink(path.join(f.repository, 'metadata/logo.jpg'));
  await fs.promises.symlink('../shared/../outside.jpg', path.join(f.repository, 'metadata/logo.jpg'));
  await expect(f.store.copyAppFromRepoToInstalled(urn)).rejects.toThrow();
  await expect(readAppPackageAsset(f.repository, 'metadata/logo.jpg')).rejects.toThrow();
  expect(await fs.promises.readFile(path.join(f.paths.appInstalledDir, 'metadata/real.jpg'), 'utf8')).toBe('fixture-image');
});

it('does not create missing parent directories through a private-file directory alias', async () => {
  const f = await fixture();
  const other = path.join(root, 'alias-target');
  await fs.promises.mkdir(other);
  await fs.promises.mkdir(path.dirname(path.dirname(f.paths.appDataDir)), { recursive: true });
  await fs.promises.symlink(other, path.dirname(f.paths.appDataDir));
  expect(await f.files.writeAppEnv(urn, 'replacement')).toBe(false);
  expect(await fs.promises.readdir(other)).toEqual([]);
});
