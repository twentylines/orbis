import { LoggerService } from '@/core/logger/logger.service';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { appSettingsBinding } from '@/modules/apps/app-settings-binding';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import type { AppUrn } from '@runtipi/common/types';
import { AppLifecycleCommand } from './command';
import type { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import { appFormSchema } from '../dto/app-lifecycle.dto';
import { AppValidationService } from '../services/app-validation.service';
import { getAppConfigUpdate } from '../services/app-config';

export class GenerateAppEnvCommand extends AppLifecycleCommand {
  constructor(
    moduleRef: ModuleRef,
    docker: Dockerode,
    private readonly binding?: string,
  ) {
    super(moduleRef, docker);
  }

  public async execute(appUrn: AppUrn, form: AppEventFormInput): Promise<{ success: boolean; message: string }> {
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const appHelpers = this.moduleRef.get(AppHelpers, { strict: false });

    try {
      const repository = this.moduleRef.get(AppsRepository, { strict: false });
      const app = await repository.getAppByUrn(appUrn);
      if (!this.binding || !app || !['running', 'stopped'].includes(app.status) || appSettingsBinding(app) !== this.binding)
        throw new Error('The application changed before its settings could be saved. Refresh and try again.');
      const parsed = appFormSchema.assert(form);
      const info = await this.moduleRef.get(AppFilesManager, { strict: false }).getInstalledAppInfo(appUrn);
      if (!info) throw new Error('Application settings could not be verified.');
      await this.moduleRef.get(AppValidationService, { strict: false }).validateUpdateConfigSettings(appUrn, info, parsed, app.id);
      logger.info(`Regenerating app.env file for app ${appUrn}`);
      await this.ensureAppDir(appUrn, parsed);
      await appHelpers.generateEnvFile(appUrn, parsed);
      await repository.updateSettingsIfCurrent(app, {
        ...getAppConfigUpdate(info, parsed),
        pendingRestart: app.pendingRestart || JSON.stringify(app.config) !== JSON.stringify(parsed),
      });

      return { success: true, message: `App ${appUrn} env file regenerated successfully` };
    } catch (err) {
      return this.handleAppError(err);
    }
  }
}
