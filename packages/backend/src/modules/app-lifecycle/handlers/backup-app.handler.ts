import { TranslatableError } from '@/common/error/translatable-error';
import { ConfigurationService } from '@/core/config/configuration.service';
import { HttpStatus, Injectable } from '@nestjs/common';
import type { AppUrn } from '@runtipi/common/types';
import { AppsRepository } from '../../apps/apps.repository';
import { AppEventsQueue } from '../../queue/entities/app-events';
import { StatusManagerService } from '../services/status-manager.service';
import { type HandlerResult, type ILifecycleHandler, generateRequestId } from './base-handler';
import { StartAppHandler } from './start-app.handler';
import { AppJobService, type JobEvent } from '../services/app-job.service';
import { ConflictException } from '@nestjs/common';

@Injectable()
export class BackupAppHandler implements ILifecycleHandler {
  constructor(
    private readonly appRepository: AppsRepository,
    private readonly appEventsQueue: AppEventsQueue,
    private readonly statusManager: StatusManagerService,
    private readonly startAppHandler: StartAppHandler,
    private readonly config: ConfigurationService,
    private readonly jobs: AppJobService,
  ) {}

  async execute(appUrn: AppUrn): Promise<HandlerResult> {
    if (this.config.get('demoMode')) {
      throw new TranslatableError('SERVER_ERROR_NOT_ALLOWED_IN_DEMO');
    }

    const app = await this.appRepository.getAppByUrn(appUrn);

    if (!app) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', { id: appUrn }, HttpStatus.NOT_FOUND);
    }
    if (app.status !== 'running' && app.status !== 'stopped') throw new ConflictException('Wait for the current app operation to finish.');

    const appStatusBeforeBackup = app.status;
    const requestId = generateRequestId();
    const event: JobEvent = { appUrn, command: 'backup', requestId, form: app.config, jobVersion: 1 };
    await this.jobs.admit(event, app);
    try {
      await this.statusManager.transitionTo(app.id, appUrn, 'backing_up');
    } catch (error) {
      await this.jobs.abandon(event);
      throw error;
    }

    void this.appEventsQueue
      .publish(event)
      .then((result) =>
        this.jobs.withCurrent(event, async () => {
          const { success, message } = result;
          const statePreserved = 'statePreserved' in result && result.statePreserved;
          if ('cancelled' in result && result.cancelled && statePreserved) {
            await this.statusManager.transitionTo(app.id, appUrn, appStatusBeforeBackup);
            return;
          }
          if (success) {
            if (appStatusBeforeBackup === 'running' && !statePreserved) {
              await this.startAppHandler.execute(appUrn);
            } else {
              await this.statusManager.emitSuccess({
                appId: app.id,
                appUrn,
                event: 'backup_success',
                status: appStatusBeforeBackup,
              });
            }
          } else {
            await this.statusManager.emitError({
              appId: app.id,
              appUrn,
              event: 'backup_error',
              status: statePreserved ? appStatusBeforeBackup : 'stopped',
              error: message ?? 'Unknown error',
            });
          }
        }),
      )
      .catch(() => undefined);

    return { requestId };
  }
}
