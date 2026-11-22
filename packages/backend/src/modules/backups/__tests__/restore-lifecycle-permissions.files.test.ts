import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { GenerateAppEnvCommand } from '@/modules/app-lifecycle/commands/generate-env-command';
import { InstallAppCommand } from '@/modules/app-lifecycle/commands/install-app-command';
import { ResetAppCommand } from '@/modules/app-lifecycle/commands/reset-app-command';
import { RestartAppCommand } from '@/modules/app-lifecycle/commands/restart-app-command';
import { StartAppCommand } from '@/modules/app-lifecycle/commands/start-app-command';
import { StopAppCommand } from '@/modules/app-lifecycle/commands/stop-app-command';
import { UpdateAppCommand } from '@/modules/app-lifecycle/commands/update-app-command';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { BackupManager } from '@/modules/backups/backup.manager';
import { beginAppImagePinUpdate } from '@/modules/docker/app-image-pins';
import { DockerService } from '@/modules/docker/docker.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { SubnetManagerService } from '@/modules/network/subnet-manager.service';
import { createMockApp } from '@/tests/helpers/app-mocks';
import type { ModuleRef } from '@nestjs/core';
import { convertLegacyToYaml } from '@runtipi/common/schemas';
import type { AppUrn } from '@runtipi/common/types';
import type Dockerode from 'dockerode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

vi.mock('@sentry/nestjs', () => ({ captureException: vi.fn() }));
vi.mock('@/modules/docker/builders/compose.builder', () => ({
  DockerComposeBuilder: class {
    getDockerCompose = () => 'services: {}';
  },
}));

describe('Restored app permissions across lifecycle commands on real files', () => {
  let root: string;
  let data: string;
  let moduleRef: ModuleRef;
  let docker: Dockerode;
  let dockerService: ReturnType<typeof mock<DockerService>>;
  const urn = 'demo:store' as AppUrn;
  const config = {
    id: 'demo',
    name: 'Demo',
    available: true,
    tipi_version: 1,
    short_desc: 'Demo',
    author: 'Orbis',
    source: 'https://example.com/demo',
  };
  const source = convertLegacyToYaml({ schemaVersion: 2, services: [{ name: 'demo', image: 'example.com/demo:1', isMain: true, internalPort: 80 }] });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'orbis-lifecycle-permissions-'));
    data = path.join(root, 'app-data/store/demo');
    const app = path.join(root, 'data/apps/store/demo');
    const catalogue = path.join(root, 'catalogue/demo');
    await fs.mkdir(path.join(data, 'private'), { recursive: true, mode: 0o700 });
    await fs.chmod(path.join(data, 'private'), 0o700);
    for (const [name, mode] of [
      ['secret', 0o600],
      ['private/key', 0o400],
      ['private/record', 0o640],
    ] as const) {
      await fs.writeFile(path.join(data, name), Buffer.from([0, 255, 128, 10]), { mode });
      await fs.utimes(path.join(data, name), 1700000000, 1700000000);
    }
    const logger = mock<LoggerService>();
    const configuration = mock<ConfigurationService>();
    configuration.getConfig.mockReturnValue({ directories: { dataDir: path.join(root, 'data'), appDataDir: path.join(root, 'app-data') } } as never);
    configuration.get.mockReturnValue('arm64' as never);
    const filesystem = new FilesystemService(logger);
    // Keep the real file operations inside this isolated host fixture.
    vi.spyOn(filesystem, 'getSafeFilePath').mockImplementation((filePath) => {
      const relative = path.relative(root, filePath);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Path is outside the fixture');
      return path.resolve(root, relative);
    });
    const files = new AppFilesManager(configuration, filesystem, logger);
    vi.spyOn(files, 'getSourceDockerComposeYaml').mockResolvedValue({ path: path.join(app, 'docker-compose.yml'), content: source });
    const copyApp = async (destination: string) => {
      await fs.mkdir(destination, { recursive: true });
      await fs.writeFile(path.join(destination, 'config.json'), JSON.stringify(config));
    };
    await copyApp(app);
    await copyApp(catalogue);
    const marketplace = mock<MarketplaceService>();
    marketplace.getSourceDockerComposeYaml.mockResolvedValue({ path: path.join(catalogue, 'source.yml'), content: source });
    marketplace.copyAppFromRepoToInstalled.mockImplementation(async () => copyApp(app));
    marketplace.stageAppUpdate.mockImplementation(async (_urn, destination) => copyApp(destination));
    marketplace.copyDataDir.mockImplementation(async () => {
      await fs.writeFile(path.join(data, 'template'), 'initial app template', { mode: 0o600 });
    });
    const helpers = mock<AppHelpers>();
    helpers.generateEnvFile.mockImplementation(async () => {
      await fs.writeFile(path.join(data, 'app.env'), 'GENERATED=yes\n');
    });
    helpers.renderAppEnv.mockResolvedValue('GENERATED=yes\n');
    const subnet = mock<SubnetManagerService>();
    subnet.allocateSubnet.mockResolvedValue('10.21.0.0/24');
    subnet.planUpdateSubnet.mockResolvedValue('10.21.0.0/24');
    dockerService = mock<DockerService>();
    dockerService.composeApp.mockResolvedValue({ success: true, stdout: '', stderr: '' });
    dockerService.beginStagedAppUpdate.mockImplementation(async () => ({
      transaction: await beginAppImagePinUpdate(path.join(root, 'update-transactions'), urn, app, path.join(data, 'app.env'), true),
      retained: false,
    }));
    const plan = mock<Awaited<ReturnType<DockerService['prepareStagedAppUpdate']>>>();
    plan.pull.mockResolvedValue({ activationSha256: '6'.repeat(64), imageIds: { demo: `sha256:${'4'.repeat(64)}` } });
    plan.isCurrent.mockResolvedValue(true);
    plan.release.mockResolvedValue(undefined);
    dockerService.prepareStagedAppUpdate.mockResolvedValue(plan);
    const repository = mock<AppsRepository>();
    const installed = createMockApp({ status: 'updating', subnet: '10.21.0.0/24' });
    repository.getAppByUrn.mockResolvedValue(installed);
    repository.updateAppById.mockImplementation(async (_id, patch) => ({ ...installed, ...patch }));
    const services = new Map<unknown, unknown>([
      [AppFilesManager, files],
      [LoggerService, logger],
      [ConfigurationService, configuration],
      [MarketplaceService, marketplace],
      [AppHelpers, helpers],
      [SubnetManagerService, subnet],
      [DockerService, dockerService],
      [AppsRepository, repository],
      [BackupManager, mock<BackupManager>()],
      [EnvUtils, { envStringToMap: () => new Map() }],
    ]);
    moduleRef = { get: (token: unknown) => services.get(token) } as ModuleRef;
    docker = mock<Dockerode>();
    vi.mocked(docker.listContainers).mockResolvedValue([]);
    vi.mocked(docker.pruneContainers).mockResolvedValue({ ContainersDeleted: [], SpaceReclaimed: 0 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  const protectedFiles = async () =>
    Promise.all(
      ['secret', 'private', 'private/key', 'private/record'].map(async (name) => {
        const file = path.join(data, name);
        const info = await fs.stat(file);
        return {
          name,
          mode: info.mode & 0o7777,
          uid: info.uid,
          gid: info.gid,
          mtime: info.mtimeMs,
          ...(info.isFile() ? { bytes: await fs.readFile(file) } : {}),
        };
      }),
    );

  for (const Command of [StartAppCommand, StopAppCommand, RestartAppCommand, GenerateAppEnvCommand, UpdateAppCommand]) {
    it(`${Command.name} preserves restored private modes, owners, contents and timestamps`, async () => {
      const before = await protectedFiles();
      const command = Command === UpdateAppCommand ? new UpdateAppCommand(moduleRef, docker, false) : new Command(moduleRef, docker);
      const result = await command.execute(urn, {});
      expect(result.success, result.message).toBe(true);
      if (Command === UpdateAppCommand) await expect(fs.readFile(path.join(data, 'app.env'), 'utf8')).resolves.toBe('GENERATED=yes\n');
      expect(await protectedFiles()).toEqual(before);
    });
  }

  it('prepares installation templates before startup without broadening secrets created by the app', async () => {
    const repository = moduleRef.get(AppsRepository);
    vi.mocked(repository.getAppByUrn).mockResolvedValueOnce(createMockApp({ status: 'installing' }));
    dockerService.composeApp.mockImplementation(async (_urn, command) => {
      if (command.startsWith('up ')) {
        expect((await fs.stat(path.join(data, 'template'))).mode & 0o777).toBe(0o777);
        await fs.writeFile(path.join(data, 'runtime-created.key'), 'private app key', { mode: 0o600 });
      }
      return { success: true, stdout: '', stderr: '' };
    });
    const result = await new InstallAppCommand(moduleRef, docker).execute(urn, {});
    expect(result.success, result.message).toBe(true);
    expect((await fs.stat(path.join(data, 'runtime-created.key'))).mode & 0o777).toBe(0o600);
  });

  it('prepares freshly reset templates for the next start', async () => {
    expect((await new ResetAppCommand(moduleRef, docker).execute(urn, {})).success).toBe(true);
    expect((await fs.stat(path.join(data, 'template'))).mode & 0o777).toBe(0o777);
    await expect(fs.stat(path.join(data, 'secret'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
