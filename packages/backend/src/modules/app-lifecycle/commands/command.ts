import { captureStoppedAppBackup } from './capture-stopped-app-backup';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { DockerComposeBuilder } from '@/modules/docker/builders/compose.builder';
import { DockerService } from '@/modules/docker/docker.service';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { SubnetManagerService } from '@/modules/network/subnet-manager.service';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import type { ModuleRef } from '@nestjs/core';
import type { DynamicComposeSchemaYaml } from '@runtipi/common/schemas';
import type { AppUrn } from '@runtipi/common/types';
import { type } from 'arktype';
import Dockerode from 'dockerode';
import { backupAppWithRuntime } from './backup-app-runtime';
import type { TaskPhase } from '@runtipi/common/schemas/task-history';
import type { AppJobContext } from '../services/app-job.service';

export class AppLifecycleCommand {
  protected job?: AppJobContext;
  setJobContext(job: AppJobContext) {
    this.job = job;
  }
  private progressReporter?: (phase: TaskPhase) => Promise<void>;

  setProgressReporter(reporter: (phase: TaskPhase) => Promise<void>) {
    this.progressReporter = reporter;
  }

  protected async reportProgress(phase: TaskPhase) {
    if (phase === 'recovering') await this.job?.recover();
    await this.progressReporter?.(phase);
  }

  constructor(
    protected moduleRef: ModuleRef,
    protected docker: Dockerode,
  ) {}

  protected async captureStoppedAppBackup(appUrn: AppUrn, snapshotReady?: () => Promise<void>) {
    await captureStoppedAppBackup(this.moduleRef, appUrn, snapshotReady, this.job);
  }

  protected async backupApp(appUrn: AppUrn, resumeAfterSuccess = false) {
    const result = await backupAppWithRuntime({
      appUrn,
      docker: this.docker,
      dockerService: this.moduleRef.get(DockerService, { strict: false }),
      resumeAfterSuccess,
      reportProgress: (phase) => this.reportProgress(phase),
      backup: (snapshotReady) => this.captureStoppedAppBackup(appUrn, snapshotReady),
      job: this.job,
    });
    return result;
  }

  protected async ensureAppDir(
    appUrn: AppUrn,
    form: AppEventFormInput,
    options: { imagePinUpdate?: string; installedCompose?: DynamicComposeSchemaYaml } = {},
  ): Promise<void> {
    await this.moduleRef.get(DockerService, { strict: false }).requireAppImagePinUpdate(appUrn, options.imagePinUpdate);
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });
    const marketplaceService = this.moduleRef.get(MarketplaceService, { strict: false });
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const subnetManager = this.moduleRef.get(SubnetManagerService, { strict: false });
    const configService = this.moduleRef.get(ConfigurationService, { strict: false });

    const pruned = await this.docker
      .pruneContainers({ filters: { label: [`runtipi.appurn=${appUrn}`] } })
      .catch(() => ({ ContainersDeleted: [], SpaceReclaimed: 0 }));

    logger.info('Pruned containers:', pruned.ContainersDeleted, 'Space reclaimed:', pruned.SpaceReclaimed / 1024 / 1024, 'MB');

    let compose = options.installedCompose ?? (await appFilesManager.getSourceDockerComposeYaml(appUrn)).content;

    if (!compose) {
      await marketplaceService.copyAppFromRepoToInstalled(appUrn);
      compose = (await appFilesManager.getSourceDockerComposeYaml(appUrn)).content;
      if (!compose) {
        throw new Error(`Failed to retrieve docker-compose.yml for app ${appUrn}`);
      }
    }

    try {
      const architecture = configService.get('architecture');

      const dockerComposeBuilder = new DockerComposeBuilder();
      const subnet = await subnetManager.allocateSubnet(appUrn);
      const composeFile = dockerComposeBuilder.getDockerCompose(compose, form, appUrn, subnet, architecture);

      await appFilesManager.writeDockerComposeYml(appUrn, composeFile);
    } catch (err) {
      logger.error(`Error generating docker-compose.generated.yml file for app ${appUrn}`);

      if (err instanceof type.errors) {
        const msg = err.summary;
        logger.error(msg);
        logger.error('Report this issue to the appstore maintainer.');
        throw new Error(
          `Error generating docker-compose.generated.yml file for app ${appUrn}.\n${msg}\nReport this issue to the appstore maintainer.`,
        );
      }

      logger.error(err);
      throw new Error(`Error generating docker-compose.generated.yml file for app ${appUrn}.`);
    }
  }

  protected handleAppError = async (err: unknown): Promise<{ success: false; message: string }> => {
    if (err instanceof Error) {
      return { success: false, message: err.message };
    }

    return { success: false, message: `An error occurred: ${String(err)}` };
  };
}
