import fs from 'node:fs';
import path from 'node:path';
import { APP_DATA_DIR, APP_DIR, DATA_DIR } from '@/common/constants';
import type { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { LoggerService } from '@/core/logger/logger.service';
import type { AppUrn } from '@runtipi/common/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppFilesManager } from '../app-files-manager';

const directories = {
  appDataDir: APP_DATA_DIR,
  appDir: APP_DIR,
  dataDir: DATA_DIR,
};

const validAppConfig = {
  id: 'demo',
  available: true,
  name: 'Demo',
  tipi_version: 1,
  short_desc: 'Demo app',
  author: 'Runtipi',
  source: 'https://example.com/demo',
};

const writeFile = async (filePath: string, content: string) => {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, content);
};

describe('AppFilesManager file security', () => {
  let manager: AppFilesManager;
  let filesystem: FilesystemService;

  beforeEach(() => {
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    } as unknown as LoggerService;

    const configuration = {
      getConfig: vi.fn().mockReturnValue({ directories }),
    } as unknown as ConfigurationService;

    filesystem = new FilesystemService(logger);
    manager = new AppFilesManager(configuration, filesystem, logger);
  });

  it.each(['yaml', 'legacy'] as const)('refuses a %s package declaring inline migrations before its services can be used', async (format) => {
    const urn = 'demo:store' as AppUrn;
    const installed = manager.getAppPaths(urn).appInstalledDir;
    const migrations = [{ id: '001-schema', service: 'migration' }];
    if (format === 'yaml') {
      await writeFile(
        path.join(installed, 'docker-compose.yml'),
        JSON.stringify({ services: { web: { image: 'example:latest' } }, 'x-runtipi': { schema_version: 2, migrations } }),
      );
      await expect(manager.getSourceDockerComposeYaml(urn)).rejects.toThrow('Invalid docker-compose.yml format');
    } else {
      await writeFile(
        path.join(installed, 'docker-compose.json'),
        JSON.stringify({ schemaVersion: 2, services: [{ name: 'web', image: 'example:latest' }], migrations }),
      );
      expect((await manager.getSourceDockerComposeYaml(urn)).content).toBeNull();
    }
    expect(await filesystem.isFile(path.join(installed, format === 'yaml' ? 'docker-compose.yml' : 'docker-compose.json'))).toBe(true);
  });

  it('does not expose installed app description symlink targets', async () => {
    await writeFile(path.join(DATA_DIR, 'apps', 'evil', 'demo', 'config.json'), JSON.stringify(validAppConfig));

    const descriptionPath = path.join(DATA_DIR, 'apps', 'evil', 'demo', 'metadata', 'description.md');
    await fs.promises.mkdir(path.dirname(descriptionPath), { recursive: true });
    await fs.promises.symlink(path.join(DATA_DIR, '.env'), descriptionPath);

    const appInfo = await manager.getInstalledAppInfo('demo:evil' as AppUrn);

    expect(appInfo?.description).toBe('');
  });

  it('does not read app env symlink targets', async () => {
    const envPath = path.join(APP_DATA_DIR, 'evil', 'demo', 'app.env');
    await fs.promises.mkdir(path.dirname(envPath), { recursive: true });
    await fs.promises.symlink(path.join(DATA_DIR, '.env'), envPath);

    const appEnv = await manager.getAppEnv('demo:evil' as AppUrn);

    expect(appEnv.content).toBe('');
  });

  it('refuses an unreadable existing app environment instead of replacing its generated credentials', async () => {
    const envPath = path.join(APP_DATA_DIR, 'store', 'demo', 'app.env');
    await writeFile(envPath, 'EXISTING_VALUE=retained');
    vi.spyOn(filesystem, 'readTextFile').mockResolvedValue(null);
    await expect(manager.getAppEnv('demo:store' as AppUrn)).rejects.toThrow('Failed to read app environment');
    expect(await fs.promises.readFile(envPath, 'utf8')).toBe('EXISTING_VALUE=retained');
  });

  it.each(['', 'EXISTING_VALUE=retained'])('preserves a readable environment, including an empty file', async (content) => {
    await writeFile(path.join(APP_DATA_DIR, 'store', 'demo', 'app.env'), content);
    expect((await manager.getAppEnv('demo:store' as AppUrn)).content).toBe(content);
  });

  it('refuses failed generated Compose writes before reporting the app ready', async () => {
    vi.spyOn(filesystem, 'writeTextFile').mockResolvedValue(false);
    await expect(manager.writeDockerComposeYml('demo:store' as AppUrn, 'services: {}')).rejects.toThrow('Failed to write generated docker compose');
  });

  it('does not read user config symlink targets', async () => {
    const userEnvPath = path.join(DATA_DIR, 'user-config', 'evil', 'demo', 'app.env');
    const userComposePath = path.join(DATA_DIR, 'user-config', 'evil', 'demo', 'docker-compose.yml');
    await fs.promises.mkdir(path.dirname(userEnvPath), { recursive: true });
    await fs.promises.symlink(path.join(DATA_DIR, '.env'), userEnvPath);
    await fs.promises.symlink(path.join(DATA_DIR, '.env'), userComposePath);

    const userEnv = await manager.getUserEnv('demo:evil' as AppUrn);
    const userCompose = await manager.getUserComposeFile('demo:evil' as AppUrn);

    expect(userEnv.content).toBeNull();
    expect(userCompose.content).toBeNull();
  });

  it.each(['deleteAppFolder', 'deleteAppDataDir'] as const)('reports %s failure instead of allowing lifecycle work to continue', async (method) => {
    vi.spyOn(filesystem, 'removeDirectory').mockResolvedValue(false);
    await expect(manager[method]('demo:store' as AppUrn)).rejects.toThrow('could not be removed');
  });

  it('removes only the selected app directories', async () => {
    const urn = 'demo:store' as AppUrn;
    const selected = manager.getAppPaths(urn);
    const other = manager.getAppPaths('other:store' as AppUrn);
    for (const directory of [selected.appInstalledDir, selected.appDataDir, other.appDataDir])
      await writeFile(path.join(directory, 'retained'), 'data');
    await manager.deleteAppDataDir(urn);
    expect(await fs.promises.readFile(path.join(selected.appInstalledDir, 'retained'), 'utf8')).toBe('data');
    await manager.deleteAppFolder(urn);
    expect(fs.existsSync(selected.appDataDir)).toBe(false);
    expect(fs.existsSync(selected.appInstalledDir)).toBe(false);
    expect(await fs.promises.readFile(path.join(other.appDataDir, 'retained'), 'utf8')).toBe('data');
  });
});
