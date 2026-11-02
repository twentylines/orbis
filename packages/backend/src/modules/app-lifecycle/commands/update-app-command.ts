import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import type { AppImagePinUpdate } from '@/modules/docker/app-image-pins';
import { DockerService } from '@/modules/docker/docker.service';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import type { ModuleRef } from '@nestjs/core';
import type { AppUrn } from '@runtipi/common/types';
import type Dockerode from 'dockerode';
import { AppLifecycleCommand } from './command';
import { dynamicComposeSchemaYaml } from '@runtipi/common/schemas';
import { type } from 'arktype';

export class UpdateAppCommand extends AppLifecycleCommand {
  constructor(
    moduleRef: ModuleRef,
    docker: Dockerode,
    private readonly performBackup: boolean = true,
  ) {
    super(moduleRef, docker);
  }

  public async execute(appUrn: AppUrn, form: AppEventFormInput) {
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });
    const dockerService = this.moduleRef.get(DockerService, { strict: false });
    const marketplaceService = this.moduleRef.get(MarketplaceService, { strict: false });
    const appHelpers = this.moduleRef.get(AppHelpers, { strict: false });

    const composeToInstall = await marketplaceService.getSourceDockerComposeYaml(appUrn);
    const compose = dynamicComposeSchemaYaml(composeToInstall.content);

    if (compose instanceof type.errors) {
      logger.error('Compose JSON validation errors:', compose.summary);
      return this.handleAppError(compose.summary, appUrn, 'update_error');
    }

    let update: AppImagePinUpdate | undefined;
    let activationAttempted = false;
    try {
      const retained = await dockerService.readAppImagePins(appUrn);
      let resumeRetainedApp = false;
      if (retained) {
        const containers = await this.docker.listContainers({
          all: true,
          filters: { label: [`com.docker.compose.project=${appUrn.replace(':', '_')}`] },
        });
        for (const container of containers) {
          const current = await this.docker.getContainer(container.Id).inspect();
          if (current.State.Running || current.State.Restarting || current.State.Paused) resumeRetainedApp = true;
        }
      }
      if (this.performBackup) {
        const backup = await this.backupApp(appUrn);
        if (!backup.success) return backup;
      }

      logger.info(`Updating app ${appUrn}`);
      if (retained) {
        await dockerService.composeApp(appUrn, 'down --remove-orphans');
        update = await dockerService.beginRetainedAppImageUpdate(appUrn);
      } else {
        await this.ensureAppDir(appUrn, form);
        await appHelpers.generateEnvFile(appUrn, form);
        try {
          await dockerService.composeApp(appUrn, 'up --detach --force-recreate --remove-orphans');
          await dockerService.composeApp(appUrn, 'down --rmi all --remove-orphans');
        } catch (_) {
          logger.warn(`App ${appUrn} has likely a broken compose file. Continuing with update...`);
        }
      }

      await appFilesManager.deleteAppFolder(appUrn);
      await marketplaceService.copyAppFromRepoToInstalled(appUrn);

      if (update) await this.ensureAppDir(appUrn, form, update.id);
      else await this.ensureAppDir(appUrn, form);
      await appHelpers.generateEnvFile(appUrn, form);

      if (update) {
        await update.prepare();
        const options = { imagePins: 'explicit-update' as const, imagePinUpdate: update.id };
        await dockerService.composeApp(appUrn, 'pull', options);
        if (resumeRetainedApp) {
          await update.activationAttempted();
          activationAttempted = true;
          await dockerService.composeApp(appUrn, 'up --detach --wait --wait-timeout 120', options);
        }
        const transactionId = update.id;
        await update.commit(() => dockerService.retireAppImagePinsAfterUpdate(appUrn, transactionId));
      } else {
        await dockerService.composeApp(appUrn, 'pull');
      }

      return { success: true, message: `App ${appUrn} updated successfully` };
    } catch (err) {
      if (update) {
        if (activationAttempted)
          return this.handleAppError(
            new Error('Retained app update requires explicit recovery. Its metadata and any new app writes were preserved.'),
            appUrn,
            'update_error',
          );
        try {
          await update.restoreMetadata();
        } catch (recoveryError) {
          return this.handleAppError(recoveryError, appUrn, 'update_error');
        }
      }
      return this.handleAppError(err, appUrn, 'update_error');
    }
  }
}
