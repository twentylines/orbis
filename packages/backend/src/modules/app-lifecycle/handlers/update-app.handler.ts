import { TranslatableError } from '@/common/error/translatable-error';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { ConflictException, HttpStatus, Injectable } from '@nestjs/common';
import type { AppUrn } from '@runtipi/common/types';
import semver from 'semver';
import { AppsRepository } from '../../apps/apps.repository';
import { MarketplaceService } from '../../marketplace/marketplace.service';
import { AppEventsQueue } from '../../queue/entities/app-events';
import { StatusManagerService } from '../services/status-manager.service';
import { type HandlerResult, type ILifecycleHandler, generateRequestId } from './base-handler';
import { AppJobService, type JobEvent } from '../services/app-job.service';

export type UpdateAppParams = {
  performBackup: boolean;
};

@Injectable()
export class UpdateAppHandler implements ILifecycleHandler<UpdateAppParams> {
  constructor(
    private readonly logger: LoggerService,
    private readonly appRepository: AppsRepository,
    private readonly appEventsQueue: AppEventsQueue,
    private readonly statusManager: StatusManagerService,
    private readonly config: ConfigurationService,
    private readonly marketplaceService: MarketplaceService,
    private readonly jobs: AppJobService,
  ) {}

  async execute(appUrn: AppUrn, params?: UpdateAppParams): Promise<HandlerResult> {
    const { performBackup } = params ?? { performBackup: false };
    const app = await this.appRepository.getAppByUrn(appUrn);

    if (!app) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', { id: appUrn }, HttpStatus.NOT_FOUND);
    }
    if (app.status !== 'running' && app.status !== 'stopped') throw new ConflictException('Wait for the current app operation to finish.');

    const version = this.config.get('version');

    const { minTipiVersion } = await this.marketplaceService.getAppUpdateInfo(appUrn);
    if (minTipiVersion && semver.valid(version) && semver.lt(version, minTipiVersion)) {
      throw new TranslatableError('APP_UPDATE_ERROR_MIN_TIPI_VERSION', { id: appUrn, minVersion: minTipiVersion });
    }

    const requestId = generateRequestId();
    const event: JobEvent = { command: 'update', appUrn, requestId, form: app.config, performBackup, jobVersion: 1 };
    await this.jobs.admit(event, app);
    try {
      await this.statusManager.transitionTo(app.id, appUrn, 'updating');
    } catch (error) {
      await this.jobs.abandon(event);
      throw error;
    }
    const reportFailure = (message: string) => {
      this.logger.error(`Failed to update app ${appUrn}: ${message}`);
      this.statusManager.emitEvent({ appUrn, event: 'update_error', error: message });
    };

    void this.appEventsQueue
      .publish(event)
      .then((result) =>
        this.jobs.withCurrent(event, async () => {
          const updateStatus = 'updateStatus' in result ? result.updateStatus : undefined;
          if (result.success) {
            if (updateStatus || ('alreadyCompleted' in result && result.alreadyCompleted))
              this.statusManager.emitEvent({ appUrn, event: 'update_success' });
            else reportFailure('The updated deployment could not be confirmed.');
            return;
          }
          if ('statePreserved' in result && result.statePreserved)
            await this.appRepository.updateAppById(app.id, { status: updateStatus ?? app.status });
          if ('cancelled' in result && result.cancelled) return;
          reportFailure(result.message);
        }),
      )
      .catch(() => reportFailure('The app update outcome could not be confirmed.'));

    return { requestId };
  }
}
