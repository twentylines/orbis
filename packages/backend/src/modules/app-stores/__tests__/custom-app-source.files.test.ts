import { castAppUrn } from '@/common/helpers/app-helpers';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { AppStore } from '@/core/database/drizzle/types';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { LoggerService } from '@/core/logger/logger.service';
import { AppStoreFilesManager } from '@/modules/app-stores/app-store-files-manager';
import { withAppRepositoryCustody } from '@/modules/app-stores/app-store-lock';
import type { AppsRepository } from '@/modules/apps/apps.repository';
import { CustomAppService } from '@/modules/custom-apps/custom-apps.service';

const urn = castAppUrn('demo:_user');
const foreignUrn = castAppUrn('demo:elsewhere');
let root: string;
let service: CustomAppService;
let manager: AppStoreFilesManager;
let directories: { dataDir: string; appDataDir: string; appDir: string };
const compose = {
  services: { web: { image: 'alpine:3.23', 'x-runtipi': { is_main: true, internal_port: 3000 } } },
  'x-runtipi': { schema_version: 2 as const },
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'orbis-custom-source-'));
  const dataDir = path.join(root, 'data');
  directories = { dataDir, appDataDir: path.join(dataDir, 'app-data'), appDir: path.join(root, 'app') };
  const logger = { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as LoggerService;
  const config = {
    get: vi.fn((name: string) => (name === 'directories' ? directories : name === 'demoMode' ? false : undefined)),
    getConfig: vi.fn(() => ({ directories })),
  } as unknown as ConfigurationService;
  const filesystem = new FilesystemService(logger);
  vi.spyOn(filesystem, 'getSafeFilePath').mockImplementation((value) => {
    const selected = path.resolve(value);
    if (selected !== root && !selected.startsWith(root + path.sep)) throw new Error('Outside fixture');
    return selected;
  });
  const repository = { getAppByUrn: vi.fn().mockResolvedValue(undefined), createApp: vi.fn() } as unknown as AppsRepository;
  service = new CustomAppService(logger, filesystem, config, repository);
  manager = new AppStoreFilesManager(config, filesystem, logger, { slug: '_user', url: 'https://example.com' } as AppStore);
  await service.createCustomApp({ name: 'demo', config: compose });
  vi.mocked(repository.getAppByUrn).mockResolvedValue({ id: 1 } as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await fs.rm(root, { recursive: true });
});

it('reads the exact custom definition created through the real custom app service', async () => {
  const written = path.join(directories.dataDir, 'apps/_user/demo/docker-compose.yml');
  expect(await fs.readFile(written, 'utf8')).toContain('schema_version: 2');
  const source = await manager.getSourceDockerComposeYaml(urn);
  expect(source.path).toBe(written);
  expect(source.content).toEqual(compose);
});

it('stages that custom package without requiring an unrelated catalogue copy', async () => {
  const destination = path.join(root, 'target');
  await manager.stageAppUpdate(urn, destination);
  expect(JSON.parse(await fs.readFile(path.join(destination, 'config.json'), 'utf8')).id).toBe('demo');
  expect(await fs.readFile(path.join(destination, 'docker-compose.yml'), 'utf8')).toContain('schema_version: 2');
  expect(await fs.readFile(path.join(directories.dataDir, 'apps/_user/demo/docker-compose.yml'), 'utf8')).toContain('schema_version: 2');
});

it('does not replace a custom package directory with itself', async () => {
  const directory = path.join(directories.dataDir, 'apps/_user/demo');
  const before = await fs.stat(directory);
  const content = await fs.readFile(path.join(directory, 'docker-compose.yml'), 'utf8');
  await manager.copyAppFromRepoToInstalled(urn);
  expect((await fs.stat(directory)).ino).toBe(before.ino);
  expect(await fs.readFile(path.join(directory, 'docker-compose.yml'), 'utf8')).toBe(content);
  expect((await fs.readdir(path.dirname(directory))).sort()).toEqual(['demo']);
});

it('does not let an unrelated reserved catalogue overwrite the operator definition', async () => {
  const repository = path.join(directories.dataDir, 'repos/_user/apps/demo');
  await fs.mkdir(repository, { recursive: true });
  await fs.writeFile(path.join(repository, 'docker-compose.yml'), 'x-runtipi: {schema_version: 2}\nservices: {wrong: {image: wrong}}\n');
  expect((await manager.getSourceDockerComposeYaml(urn)).content).toEqual(compose);
});

it('rejects a mismatched custom namespace', async () => {
  await expect(manager.stageAppUpdate(foreignUrn, path.join(root, 'target'))).rejects.toThrow();
  await expect(fs.lstat(path.join(root, 'target'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses a symlinked custom source while preserving the outside target', async () => {
  const directory = path.join(directories.dataDir, 'apps/_user/demo');
  const retained = path.join(root, 'retained');
  await fs.rename(directory, retained);
  await fs.symlink(retained, directory);
  await expect(manager.stageAppUpdate(urn, path.join(root, 'target'))).rejects.toThrow();
  expect(await fs.readFile(path.join(retained, 'docker-compose.yml'), 'utf8')).toContain('schema_version: 2');
  await expect(fs.lstat(path.join(root, 'target'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('defers custom definition edits until the package capture releases custody', async () => {
  let pending: Promise<void> | undefined;
  const directory = path.join(directories.dataDir, 'apps/_user/demo');
  const key = path.resolve(directories.dataDir, 'repos', '_user');
  const changed = { ...compose, services: { web: { ...compose.services.web, image: 'alpine:changed-fixture' } } };
  await withAppRepositoryCustody(key, async () => {
    pending = service.updateCustomApp(urn, changed);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await fs.readFile(path.join(directory, 'docker-compose.yml'), 'utf8')).toContain('image: alpine:3.23');
  });
  await pending;
  expect(await fs.readFile(path.join(directory, 'docker-compose.yml'), 'utf8')).toContain('image: alpine:changed-fixture');
});

it('keeps generated Compose out of a custom package stage', async () => {
  const directory = path.join(directories.dataDir, 'apps/_user/demo');
  await fs.writeFile(path.join(directory, 'docker-compose.generated.yml'), 'generated fixture');
  await manager.stageAppUpdate(urn, path.join(root, 'target'));
  await expect(fs.lstat(path.join(root, 'target/docker-compose.generated.yml'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(path.join(directory, 'docker-compose.generated.yml'), 'utf8')).toBe('generated fixture');
});

it('defers custom logo and notes edits while a package reader holds custody', async () => {
  const metadata = path.join(directories.dataDir, 'apps/_user/demo/metadata');
  const previous = await fs.readFile(path.join(metadata, 'description.md'), 'utf8');
  const pending: Promise<void>[] = [];
  await withAppRepositoryCustody(path.resolve(directories.dataDir, 'repos', '_user'), async () => {
    pending.push(service.updateAppMetadata(urn, '# New notes'));
    pending.push(service.uploadAppImage(urn, Buffer.from('fixture-image')));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await fs.readFile(path.join(metadata, 'description.md'), 'utf8')).toBe(previous);
    await expect(fs.lstat(path.join(metadata, 'logo.jpg'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  await Promise.all(pending);
  expect(await fs.readFile(path.join(metadata, 'description.md'), 'utf8')).toContain('# New notes');
  expect(await fs.readFile(path.join(metadata, 'logo.jpg'), 'utf8')).toBe('fixture-image');
});

it('does not use custom editing routes to mutate another store package', async () => {
  const directory = path.join(directories.dataDir, 'apps/elsewhere/demo/metadata');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'description.md'), 'retained notes');
  await fs.writeFile(path.join(directory, 'logo.jpg'), 'retained image');
  await expect(service.updateCustomApp(foreignUrn, compose)).rejects.toThrow();
  await expect(service.uploadAppImage(foreignUrn, Buffer.from('replacement'))).rejects.toThrow();
  await expect(service.updateAppMetadata(foreignUrn, '# replacement')).rejects.toThrow();
  expect(await fs.readFile(path.join(directory, 'description.md'), 'utf8')).toBe('retained notes');
  expect(await fs.readFile(path.join(directory, 'logo.jpg'), 'utf8')).toBe('retained image');
  await expect(fs.lstat(path.join(directory, '../docker-compose.yml'))).rejects.toMatchObject({ code: 'ENOENT' });
});
