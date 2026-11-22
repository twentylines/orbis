import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { DockerService } from '@/modules/docker/docker.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { createMockAppInfo } from '@/tests/helpers/app-mocks';
import type { ModuleRef } from '@nestjs/core';
import { convertLegacyToYaml } from '@runtipi/common/schemas';
import type { AppUrn } from '@runtipi/common/types';
import type Dockerode from 'dockerode';
import { expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { InstallAppCommand } from './install-app-command';

const urn = 'demo:store' as AppUrn;

function fixture() {
  const repository = mock<AppsRepository>();
  const docker = mock<DockerService>();
  const appFiles = mock<AppFilesManager>();
  appFiles.getAppMigrationIds.mockResolvedValue([]);
  appFiles.getAppEnv.mockResolvedValue({ path: 'fake', content: '' });
  appFiles.getInstalledAppInfo.mockResolvedValue(createMockAppInfo());
  const marketplace = mock<MarketplaceService>();
  const compose = convertLegacyToYaml({
    schemaVersion: 2,
    services: [{ name: 'web', image: 'example.test/demo:1', isMain: true, internalPort: 80 }],
  });
  appFiles.getSourceDockerComposeYaml.mockResolvedValue({ path: '/installed/app/docker-compose.yml', content: compose });
  marketplace.getSourceDockerComposeYaml.mockResolvedValue({
    path: '/catalog/app/docker-compose.yml',
    content: compose,
  });
  const helpers = mock<AppHelpers>();
  const services = new Map<unknown, unknown>([
    [LoggerService, mock<LoggerService>()],
    [AppFilesManager, appFiles],
    [MarketplaceService, marketplace],
    [DockerService, docker],
    [AppHelpers, helpers],
    [EnvUtils, mock<EnvUtils>()],
    [AppsRepository, repository],
  ]);
  const command = new InstallAppCommand({ get: (token: unknown) => services.get(token) } as ModuleRef, mock<Dockerode>());
  const ensureAppDir = vi.fn();
  Object.assign(command, { ensureAppDir });
  return { command, repository, docker, appFiles, marketplace, helpers, ensureAppDir, compose };
}

it.each([true, false])('installs without claiming a baseline for a legacy package, with skipRun=%s', async (skipRun) => {
  const f = fixture();
  expect(await f.command.execute(urn, { skipRun })).toMatchObject({ success: true });
  expect(f.appFiles.getAppMigrationIds.mock.calls).toEqual([[urn, '/catalog/app'], [urn]]);
  expect(f.repository.replaceMigrationLedger).not.toHaveBeenCalled();
  expect(f.helpers.generateEnvFile).toHaveBeenCalledExactlyOnceWith(urn, { skipRun });
  expect(f.marketplace.copyDataDir).toHaveBeenCalledOnce();
  expect(f.ensureAppDir).toHaveBeenCalledExactlyOnceWith(urn, { skipRun }, { installedCompose: f.compose });
  expect(f.docker.composeApp.mock.calls).toEqual([
    [urn, 'down --rmi all --remove-orphans'],
    ...(skipRun ? [] : [[urn, expect.stringMatching(/^up --detach /)]]),
  ]);
});

it.each([true, false])('refuses unqualified migration storage before copying files, with skipRun=%s', async (skipRun) => {
  const f = fixture();
  f.appFiles.getAppMigrationIds.mockResolvedValueOnce(['001-initialize']);
  expect(await f.command.execute(urn, { skipRun })).toEqual({
    success: false,
    statePreserved: true,
    message: 'This app declares migrations. A fresh install requires verified clean app storage.',
  });
  expect(f.marketplace.copyAppFromRepoToInstalled).not.toHaveBeenCalled();
  expect(f.marketplace.copyDataDir).not.toHaveBeenCalled();
  expect(f.helpers.generateEnvFile).not.toHaveBeenCalled();
  expect(f.ensureAppDir).not.toHaveBeenCalled();
  expect(f.repository.replaceMigrationLedger).not.toHaveBeenCalled();
  expect(f.docker.composeApp).not.toHaveBeenCalled();
});

it('refuses a migration discovered after copying and preserves the changed install state for review', async () => {
  const f = fixture();
  f.appFiles.getAppMigrationIds.mockResolvedValueOnce([]).mockResolvedValueOnce(['001-initialize']);
  expect(await f.command.execute(urn, {})).toMatchObject({ success: false, statePreserved: false });
  expect(f.marketplace.copyAppFromRepoToInstalled).toHaveBeenCalledOnce();
  expect(f.marketplace.copyDataDir).not.toHaveBeenCalled();
  expect(f.helpers.generateEnvFile).not.toHaveBeenCalled();
  expect(f.repository.replaceMigrationLedger).not.toHaveBeenCalled();
  expect(f.docker.composeApp).not.toHaveBeenCalled();
});

it('preserves the reservation when runtime activation failed after possible writes', async () => {
  const f = fixture();
  f.docker.composeApp.mockRejectedValueOnce(new Error('No prior runtime')).mockRejectedValueOnce(new Error('Activation reply lost'));
  expect(await f.command.execute(urn, {})).toMatchObject({ success: false, statePreserved: false, message: 'Activation reply lost' });
  expect(f.repository.replaceMigrationLedger).not.toHaveBeenCalled();
});

it('treats a missing installed package as a failure before environment generation or runtime', async () => {
  const f = fixture();
  f.appFiles.getInstalledAppInfo.mockResolvedValue(null);
  expect(await f.command.execute(urn, {})).toMatchObject({ success: false, statePreserved: false });
  expect(f.helpers.generateEnvFile).not.toHaveBeenCalled();
  expect(f.docker.composeApp).not.toHaveBeenCalled();
});

it('does not refetch an unverified package when the installed compose is missing', async () => {
  const f = fixture();
  f.appFiles.getSourceDockerComposeYaml.mockResolvedValue({ path: '/installed/app/docker-compose.yml', content: null });
  expect(await f.command.execute(urn, {})).toMatchObject({ success: false, statePreserved: false });
  expect(f.marketplace.copyAppFromRepoToInstalled).toHaveBeenCalledOnce();
  expect(f.ensureAppDir).not.toHaveBeenCalled();
  expect(f.helpers.generateEnvFile).not.toHaveBeenCalled();
  expect(f.docker.composeApp).not.toHaveBeenCalled();
});
