import { LoggerService } from '@/core/logger/logger.service';
import type { AppUrn } from '@runtipi/common/types';
import { AppLifecycleCommand } from './command';

export class BackupAppCommand extends AppLifecycleCommand {
  public async execute(appUrn: AppUrn) {
    const logger = this.moduleRef.get(LoggerService, { strict: false });

    try {
      logger.info(`Stopping app ${appUrn} for backup`);
      const backup = await this.backupApp(appUrn, true);
      if (!backup.success) return backup;

      logger.info('Backup completed!');

      return { success: true, message: `App ${appUrn} backed up successfully`, statePreserved: true };
    } catch (err) {
      return this.handleAppError(err, appUrn, 'backup');
    }
  }
}
