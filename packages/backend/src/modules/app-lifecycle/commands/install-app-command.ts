import path from 'node:path';
import { installFreshApp } from './install-fresh-app';
import type Dockerode from 'dockerode';
import type { ModuleRef } from '@nestjs/core';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { verifyInstallRequestOwnership, type InstallRequestOwnership } from '../install-request-receipt';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { DockerService } from '@/modules/docker/docker.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import type { AppEventFormInput, appEventResultSchema } from '@/modules/queue/entities/app-events';
import type { AppUrn } from '@runtipi/common/types';
import { AppLifecycleCommand } from './command';
import { dynamicComposeSchemaYaml } from '@runtipi/common/schemas';
import { type } from 'arktype';

export class InstallAppCommand extends AppLifecycleCommand {
  constructor(
    moduleRef: ModuleRef,
    docker: Dockerode,
    private readonly requestId?: string,
    private readonly ownership?: InstallRequestOwnership,
  ) {
    super(moduleRef, docker);
  }
  private async verifyOwnership(appUrn: AppUrn) {
    // Legacy direct callers may install without creating a migration baseline. The real queue carries its live receipt.
    if (!this.ownership) return;
    if (!this.requestId) throw new Error('The app install request is missing its identity.');
    const reserved = await verifyInstallRequestOwnership(this.ownership, appUrn, this.requestId);
    const current = await this.moduleRef.get(AppsRepository, { strict: false }).getAppByUrn(appUrn);
    if (
      !current ||
      current.status !== 'installing' ||
      current.id !== reserved.id ||
      current.createdAt !== reserved.createdAt ||
      current.appName !== reserved.appName ||
      current.appStoreSlug !== reserved.appStoreSlug ||
      (reserved.version !== undefined && current.version !== reserved.version)
    )
      throw new Error('The app install reservation changed. Its files were preserved.');
    return reserved;
  }

  public async execute(appUrn: AppUrn, form: AppEventFormInput): Promise<typeof appEventResultSchema.infer> {
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });
    const marketplaceService = this.moduleRef.get(MarketplaceService, { strict: false });
    const dockerService = this.moduleRef.get(DockerService, { strict: false });
    const appHelpers = this.moduleRef.get(AppHelpers, { strict: false });
    const envUtils = this.moduleRef.get(EnvUtils, { strict: false });

    const unverifiedStorage = 'This app declares migrations. A fresh install requires verified clean app storage.';
    let installationStarted = false;
    try {
      const owned = await this.verifyOwnership(appUrn);
      if (this.ownership && this.requestId && owned?.version !== undefined) {
        const fresh = await installFreshApp({
          moduleRef: this.moduleRef,
          docker: this.docker,
          appUrn,
          requestId: this.requestId,
          ownership: this.ownership,
          form,
          report: (phase) => this.reportProgress(phase),
          error: (error) => this.handleAppError(error),
        });
        if (fresh !== undefined) return fresh;
      }

      const composeToInstall = await marketplaceService.getSourceDockerComposeYaml(appUrn);
      const compose = dynamicComposeSchemaYaml(composeToInstall.content);
      if (compose instanceof type.errors) {
        logger.error('Compose JSON validation errors:', compose.summary);
        throw new Error(compose.summary);
      }
      // A new database row does not prove the bind or named volumes are fresh.
      // Leave migration history unknown until those data sources can be qualified.
      if ((await appFilesManager.getAppMigrationIds(appUrn, path.dirname(composeToInstall.path))).length) throw new Error(unverifiedStorage);

      if (process.getuid && process.getgid) {
        logger.info(`Installing app ${appUrn} as User ID: ${process.getuid()}, Group ID: ${process.getgid()}`);
      } else {
        logger.info(`Installing app ${appUrn}. No User ID or Group ID found.`);
      }

      await this.verifyOwnership(appUrn);
      installationStarted = true;
      await marketplaceService.copyAppFromRepoToInstalled(appUrn);
      if ((await appFilesManager.getAppMigrationIds(appUrn)).length) throw new Error(unverifiedStorage);
      const config = await appFilesManager.getInstalledAppInfo(appUrn);
      const { content: installedCompose } = await appFilesManager.getSourceDockerComposeYaml(appUrn);
      if (!config || !installedCompose) throw new Error('The installed app package could not be verified.');
      if (owned?.version !== undefined && config.tipi_version !== owned.version)
        throw new Error('The app package version changed after the install was requested. Its files were preserved.');

      // Create app.env file
      logger.info(`Creating app.env file for app ${appUrn}`);
      await appHelpers.generateEnvFile(appUrn, form);

      // Copy data dir
      const appEnv = await appFilesManager.getAppEnv(appUrn);
      const envMap = envUtils.envStringToMap(appEnv.content);

      logger.info(`Copying data dir for app ${appUrn}`);
      await marketplaceService.copyDataDir(appUrn, envMap);

      // Use the checked package rather than falling back to a later catalogue copy.
      await this.ensureAppDir(appUrn, form, { installedCompose });
      await appFilesManager.setAppDataDirPermissions(appUrn);

      await this.verifyOwnership(appUrn);
      try {
        await dockerService.composeApp(appUrn, 'down --rmi all --remove-orphans');
      } catch (_) {
        logger.warn(`No prior containers to remove for app ${appUrn}`);
      }

      await this.verifyOwnership(appUrn);
      // run docker-compose up
      const forcePull = config.force_pull ?? false;

      if (form.skipRun) {
        logger.info(`Skipping docker-compose up for app ${appUrn} as per request`);
        return { success: true, message: `App ${appUrn} installed successfully (skipped run)` };
      }

      await dockerService.composeApp(appUrn, `up --detach --force-recreate --remove-orphans ${forcePull ? '--pull always' : ''}`);
      return { success: true, message: `App ${appUrn} installed successfully` };
    } catch (err) {
      return { ...(await this.handleAppError(err)), statePreserved: !installationStarted };
    }
  }
}
