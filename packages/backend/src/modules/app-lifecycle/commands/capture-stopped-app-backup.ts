import type { ModuleRef } from '@nestjs/core';
import type { AppUrn } from '@runtipi/common/types';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppsRepository } from '../../apps/apps.repository';
import { BackupManager } from '../../backups/backup.manager';
import type { AppJobContext } from '../services/app-job.service';

/** Caller must positively stop and hold the original deployment first. */
export async function captureStoppedAppBackup(moduleRef: ModuleRef, appUrn: AppUrn, snapshotReady?: () => Promise<void>, job?: AppJobContext) {
  const backups = moduleRef.get(BackupManager, { strict: false });
  const repository = moduleRef.get(AppsRepository, { strict: false });
  const config = moduleRef.get(ConfigurationService, { strict: false });
  if (job) await backups.backupApp(appUrn, snapshotReady, job);
  else if (snapshotReady) await backups.backupApp(appUrn, snapshotReady);
  else await backups.backupApp(appUrn);
  const app = await repository.getAppByUrn(appUrn);
  await backups.cleanupOldBackups(appUrn, app?.maxBackups ?? config.get('userSettings').maxBackups);
}
