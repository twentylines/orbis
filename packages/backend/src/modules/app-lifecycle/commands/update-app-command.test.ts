import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { BackupManager } from '@/modules/backups/backup.manager';
import { DockerService } from '@/modules/docker/docker.service';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { createMockApp } from '@/tests/helpers/app-mocks';
import type { ModuleRef } from '@nestjs/core';
import { convertLegacyToYaml } from '@runtipi/common/schemas';
import type { AppUrn } from '@runtipi/common/types';
import type Dockerode from 'dockerode';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { UpdateAppCommand } from './update-app-command';

vi.mock('@sentry/nestjs', () => ({ captureException: vi.fn() }));

const appUrn = 'app:test' as AppUrn;

const createFixture = (performBackup = true) => {
  const logger = mock<LoggerService>();
  const appFilesManager = mock<AppFilesManager>();
  const dockerService = mock<DockerService>();
  const marketplaceService = mock<MarketplaceService>();
  const appHelpers = mock<AppHelpers>();
  const backupManager = mock<BackupManager>();
  const appsRepository = mock<AppsRepository>();
  const config = mock<ConfigurationService>();
  const docker = mock<Dockerode>();
  const steps: string[] = [];
  let installedSource = 'v1';

  dockerService.composeApp.mockImplementation(async (_urn, command) => {
    steps.push(`compose:${command}`);
    return { success: true, stdout: '', stderr: '' };
  });
  marketplaceService.getSourceDockerComposeYaml.mockResolvedValue({
    path: '/app/apps/test/docker-compose.yml',
    content: convertLegacyToYaml({
      schemaVersion: 2,
      services: [{ name: 'app', image: 'nginx:1.28.0-alpine', isMain: true, internalPort: 80 }],
    }),
  });
  appHelpers.generateEnvFile.mockImplementation(async () => {
    steps.push(`env:${installedSource}`);
  });
  appFilesManager.deleteAppFolder.mockImplementation(async () => {
    steps.push('delete-installed');
  });
  marketplaceService.copyAppFromRepoToInstalled.mockImplementation(async () => {
    steps.push('copy-v2');
    installedSource = 'v2';
  });
  backupManager.backupApp.mockImplementation(async () => {
    steps.push('backup');
  });
  backupManager.cleanupOldBackups.mockResolvedValue(undefined);
  appsRepository.getAppByUrn.mockResolvedValue(createMockApp({ maxBackups: null }));
  config.get.calledWith('userSettings').mockReturnValue({ maxBackups: 7 } as never);

  const services = new Map<unknown, unknown>([
    [LoggerService, logger],
    [AppFilesManager, appFilesManager],
    [DockerService, dockerService],
    [MarketplaceService, marketplaceService],
    [AppHelpers, appHelpers],
    [BackupManager, backupManager],
    [AppsRepository, appsRepository],
    [ConfigurationService, config],
  ]);
  const moduleRef = { get: (token: unknown) => services.get(token) } as ModuleRef;
  const command = new UpdateAppCommand(moduleRef, docker, performBackup);
  const ensureAppDir = vi
    .spyOn(command as UpdateAppCommand & { ensureAppDir: (urn: AppUrn, form: Record<string, unknown>) => Promise<void> }, 'ensureAppDir')
    .mockImplementation(async () => {
      steps.push(`ensure:${installedSource}`);
    });

  return {
    command,
    logger,
    appFilesManager,
    dockerService,
    marketplaceService,
    appHelpers,
    backupManager,
    appsRepository,
    ensureAppDir,
    steps,
    getInstalledSource: () => installedSource,
  };
};

describe('UpdateAppCommand', () => {
  it.each([
    { override: null, expected: 7 },
    { override: 0, expected: 0 },
    { override: 9, expected: 9 },
  ])('uses retention $expected when the stored override is $override', async ({ override, expected }) => {
    const fixture = createFixture();
    fixture.appsRepository.getAppByUrn.mockResolvedValue(createMockApp({ maxBackups: override }));

    const result = await fixture.command.execute(appUrn, {});

    expect(result).toEqual({ success: true, message: `App ${appUrn} updated successfully` });
    expect(fixture.backupManager.cleanupOldBackups).toHaveBeenCalledExactlyOnceWith(appUrn, expected);
    expect(fixture.steps.indexOf('backup')).toBeLessThan(fixture.steps.indexOf('delete-installed'));
    expect(fixture.appsRepository.updateAppById).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'generates the v2 environment after copying and preparing its Compose and before pull (backup=%s)',
    async (performBackup) => {
      const fixture = createFixture(performBackup);
      const form = { SERVICE_LABEL: 'keep', maxBackups: 3, custom: { nested: ['keep', 7] } };
      const before = structuredClone(form);

      const result = await fixture.command.execute(appUrn, form);

      expect(result.success).toBe(true);
      expect(fixture.steps).toEqual([
        ...(performBackup ? ['compose:stop', 'backup'] : []),
        'ensure:v1',
        'env:v1',
        'compose:up --detach --force-recreate --remove-orphans',
        'compose:down --rmi all --remove-orphans',
        'delete-installed',
        'copy-v2',
        'ensure:v2',
        'env:v2',
        'compose:pull',
      ]);
      expect(fixture.appHelpers.generateEnvFile).toHaveBeenCalledTimes(2);
      for (const [urn, passedForm] of fixture.appHelpers.generateEnvFile.mock.calls) {
        expect(urn).toBe(appUrn);
        expect(passedForm).toBe(form);
      }
      expect(form).toEqual(before);
      expect(fixture.ensureAppDir).toHaveBeenNthCalledWith(2, appUrn, form);
      expect(fixture.backupManager.backupApp).toHaveBeenCalledTimes(performBackup ? 1 : 0);
    },
  );

  it('returns failure without pulling or reporting success when a required v2 field fails environment generation', async () => {
    const fixture = createFixture();
    const form = { SERVICE_LABEL: 'preserved' };
    fixture.appHelpers.generateEnvFile.mockImplementation(async () => {
      fixture.steps.push(`env:${fixture.getInstalledSource()}`);
      if (fixture.getInstalledSource() === 'v2') throw new Error('NEW_REQUIRED must be configured');
    });

    const result = await fixture.command.execute(appUrn, form);

    expect(result).toEqual({ success: false, message: 'NEW_REQUIRED must be configured' });
    expect(fixture.steps.slice(-3)).toEqual(['copy-v2', 'ensure:v2', 'env:v2']);
    expect(fixture.dockerService.composeApp).not.toHaveBeenCalledWith(appUrn, 'pull');
    expect(fixture.appsRepository.updateAppById).not.toHaveBeenCalled();
    expect(fixture.backupManager.backupApp).toHaveBeenCalledExactlyOnceWith(appUrn);
    expect(fixture.appHelpers.generateEnvFile).toHaveBeenNthCalledWith(2, appUrn, form);
  });

  it('rejects invalid new Compose before backup, teardown, source replacement or environment generation', async () => {
    const fixture = createFixture();
    fixture.marketplaceService.getSourceDockerComposeYaml.mockResolvedValue({
      path: '/fixture/docker-compose.yml',
      content: { 'x-runtipi': {} },
    });

    const result = await fixture.command.execute(appUrn, {});

    expect(result.success).toBe(false);
    expect(fixture.steps).toEqual([]);
    expect(fixture.appFilesManager.deleteAppFolder).not.toHaveBeenCalled();
    expect(fixture.marketplaceService.copyAppFromRepoToInstalled).not.toHaveBeenCalled();
    expect(fixture.appHelpers.generateEnvFile).not.toHaveBeenCalled();
  });
});
