import type { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import { BackupManager } from '@/modules/backups/backup.manager';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { DockerService } from '@/modules/docker/docker.service';
import type { AppUrn } from '@runtipi/common/types';
import { AppLifecycleCommand } from './command';

export class UninstallAppCommand extends AppLifecycleCommand {
  constructor(
    moduleRef: ModuleRef,
    docker: Dockerode,
    private readonly removeBackups = false,
  ) {
    super(moduleRef, docker);
  }

  public async execute(appUrn: AppUrn): Promise<{ success: boolean; message: string }> {
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });
    const dockerService = this.moduleRef.get(DockerService, { strict: false });

    try {
      const finish = await dockerService.prepareAppUninstallCleanup(appUrn);
      // Runs only after the worker's app, backup/recovery and image-pin guards.
      // Queueing a request alone must never remove its recovery archives.
      if (this.removeBackups) await this.moduleRef.get(BackupManager, { strict: false }).deleteAppBackupsByUrn(appUrn);
      logger.info(`Uninstalling app ${appUrn}`);

      await dockerService.composeApp(appUrn, 'down --remove-orphans -v --rmi all');
      const remaining = await this.docker.listContainers({
        all: true,
        filters: { label: [`com.docker.compose.project=${appUrn.replace(':', '_')}`] },
      });
      if (!Array.isArray(remaining) || remaining.length) throw new Error('App containers could not be confirmed removed. App files were preserved.');
      logger.info(`Successfully cleaned up all Docker resources for ${appUrn}`);

      await appFilesManager.deleteAppDataDir(appUrn);
      await appFilesManager.deleteAppFolder(appUrn);
      await finish();

      return { success: true, message: `App ${appUrn} uninstalled successfully` };
    } catch (err) {
      return this.handleAppError(err);
    }
  }
}
