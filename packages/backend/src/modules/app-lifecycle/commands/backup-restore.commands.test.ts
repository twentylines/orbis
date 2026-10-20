import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { BackupManager } from '@/modules/backups/backup.manager';
import { DockerService } from '@/modules/docker/docker.service';
import type { ModuleRef } from '@nestjs/core';
import type { AppUrn } from '@runtipi/common/types';
import type Dockerode from 'dockerode';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { BackupAppCommand } from './backup-app-command';
import { RestoreAppCommand } from './restore-app-command';

vi.mock('@sentry/nestjs', () => ({ captureException: vi.fn() }));

describe.each(['backup', 'restore'] as const)('%s requires a stopped application', (action) => {
  const appUrn = 'demo:store' as AppUrn;
  const fixture = () => {
    const logger = mock<LoggerService>();
    const dockerService = mock<DockerService>();
    const backupManager = mock<BackupManager>();
    const repository = mock<AppsRepository>();
    const config = mock<ConfigurationService>();
    config.get.calledWith('userSettings').mockReturnValue({ maxBackups: 7 } as never);
    const services = new Map<unknown, unknown>([
      [LoggerService, logger],
      [DockerService, dockerService],
      [BackupManager, backupManager],
      [AppsRepository, repository],
      [ConfigurationService, config],
    ]);
    const moduleRef = { get: (token: unknown) => services.get(token) } as ModuleRef;
    const docker = mock<Dockerode>();
    const command = action === 'backup' ? new BackupAppCommand(moduleRef, docker) : new RestoreAppCommand(moduleRef, docker, 'saved.tar.gz');
    return { command, dockerService, backupManager };
  };

  it('does not read or replace app files when stopping fails', async () => {
    const { command, dockerService, backupManager } = fixture();
    dockerService.composeApp.mockRejectedValue(new Error('The app could not be stopped'));
    expect(await command.execute(appUrn)).toEqual({ success: false, message: 'The app could not be stopped' });
    expect(backupManager.backupApp).not.toHaveBeenCalled();
    expect(backupManager.restoreApp).not.toHaveBeenCalled();
    expect(backupManager.cleanupOldBackups).not.toHaveBeenCalled();
  });

  it('waits for the app to stop before accessing its files', async () => {
    const { command, dockerService, backupManager } = fixture();
    const steps: string[] = [];
    dockerService.composeApp.mockImplementation(async () => {
      steps.push('stopped');
      return { success: true, stdout: '', stderr: '' };
    });
    backupManager.backupApp.mockImplementation(async () => {
      steps.push('backup');
    });
    backupManager.restoreApp.mockImplementation(async () => {
      steps.push('restore');
    });
    expect((await command.execute(appUrn)).success).toBe(true);
    expect(dockerService.composeApp).toHaveBeenCalledExactlyOnceWith(appUrn, 'stop');
    expect(steps).toEqual(['stopped', action]);
  });
});
