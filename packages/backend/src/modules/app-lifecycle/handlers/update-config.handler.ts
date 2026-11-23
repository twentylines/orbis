import { TranslatableError } from '@/common/error/translatable-error';
import { LoggerService } from '@/core/logger/logger.service';
import { ConflictException, HttpStatus, Injectable } from '@nestjs/common';
import type { AppUrn } from '@runtipi/common/types';
import { type } from 'arktype';
import { AppFilesManager } from '../../apps/app-files-manager';
import { AppsRepository } from '../../apps/apps.repository';
import { AppEventsQueue } from '../../queue/entities/app-events';
import { appFormSchema } from '../dto/app-lifecycle.dto';
import { AppValidationService } from '../services/app-validation.service';
import { type HandlerResult, type ILifecycleHandler, generateRequestId } from './base-handler';
import { appSettingsBinding } from '../../apps/app-settings-binding';

export type UpdateConfigParams = {
  form: unknown;
};

@Injectable()
export class UpdateConfigHandler implements ILifecycleHandler<UpdateConfigParams> {
  constructor(
    private readonly logger: LoggerService,
    private readonly appRepository: AppsRepository,
    private readonly appEventsQueue: AppEventsQueue,
    private readonly appFilesManager: AppFilesManager,
    private readonly validationService: AppValidationService,
  ) {}

  async execute(appUrn: AppUrn, params?: UpdateConfigParams): Promise<HandlerResult> {
    return (await this.prepare(appUrn, params)).complete();
  }

  async prepare(appUrn: AppUrn, params?: UpdateConfigParams) {
    const { form } = params ?? { form: {} };

    const parsedForm = appFormSchema(form);

    if (parsedForm instanceof type.errors) {
      throw new TranslatableError('SYSTEM_ERROR_INVALID_BODY', undefined, HttpStatus.BAD_REQUEST, { cause: parsedForm });
    }

    const app = await this.appRepository.getAppByUrn(appUrn);

    if (!app) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', { id: appUrn }, HttpStatus.NOT_FOUND);
    }
    if (!['running', 'stopped'].includes(app.status)) throw new ConflictException('Wait for the current app operation to finish.');

    const appInfo = await this.appFilesManager.getInstalledAppInfo(appUrn);

    if (!appInfo) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', { id: appUrn }, HttpStatus.NOT_FOUND);
    }

    await this.validationService.validateUpdateConfigSettings(appUrn, appInfo, parsedForm, app.id);

    const requestId = generateRequestId();

    const completion = this.appEventsQueue
      .publish({
        command: 'generate_env',
        appUrn,
        requestId,
        form: parsedForm,
        settingsBinding: appSettingsBinding(app),
      })
      .then(
        (result) => ({ result }),
        (error) => ({ error }),
      );

    return {
      complete: async (): Promise<HandlerResult> => {
        const outcome = await completion;
        if ('error' in outcome) throw outcome.error;
        const { success, message } = outcome.result;
        if (!success) {
          this.logger.error(`Failed to update app ${appUrn}: ${message}`);
          throw new TranslatableError('APP_ERROR_APP_FAILED_TO_UPDATE', { id: appUrn }, HttpStatus.INTERNAL_SERVER_ERROR, { cause: message });
        }
        return { requestId };
      },
    };
  }
}
