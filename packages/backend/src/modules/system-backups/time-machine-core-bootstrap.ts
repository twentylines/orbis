import type { INestApplication } from '@nestjs/common';
import type Dockerode from 'dockerode';
import { AppService } from '@/app.service';
import { ClusterSyncService } from '../cluster/cluster-sync.service';
import { DOCKERODE } from '../docker/docker.module';
import { AutomaticUpdatesService } from '../host-updates/automatic-updates.service';
import { NearbyDiscoveryService } from '../nearby-discovery/discovery.service';
import { QueueFactory } from '../queue/queue.factory';
import { ResetService } from '../system-reset/reset.service';
import { HostDeviceHistoryService } from '../system/host-device-history.service';
import { MetricHistoryService } from '../system/metric-history.service';
import { TasksService } from '../tasks/tasks.service';
import { BackupDatabaseService } from './backup-database.service';
import { BackupImportsService } from './backup-imports.service';
import { BackupRestoresService } from './backup-restores.service';
import { CoreCaptureRecovery } from './time-machine-core-recovery';
import { SettingsBackupApplyService } from './settings-backup-apply.service';
import { SystemBackupsService } from './system-backups.service';
import { TimeMachineService } from './time-machine.service';
import { retainedImageDocker } from './time-machine-retained-images';

/** Called after listen, once Nest has skipped capture-held module hooks. */
export async function continueCoreCaptureAfterListen(app: INestApplication, dataDirectory: string, signal: AbortSignal) {
  const socket = process.env.ORBIS_HOST_SOCKET;
  if (!socket) throw new Error('Snapshot recovery requires the installed host service.');
  const presentation = app.get(AppService);
  const recovery = new CoreCaptureRecovery({
    dataDirectory,
    socket,
    signal,
    docker: retainedImageDocker(app.get<Dockerode>(DOCKERODE), async () => {
      throw new Error('Snapshot publication cannot load images.');
    }),
    queue: app.get(QueueFactory),
    startup: {
      initializeRecovery: async () => {
        await app.get(SettingsBackupApplyService).prepareStartup();
        await app.get(SystemBackupsService).onModuleInit();
        await app.get(BackupRestoresService).prepareStartup();
        await app.get(ResetService).onModuleInit();
      },
      initializeServices: async () => {
        await app.get(TasksService).onModuleInit();
        await app.get(BackupDatabaseService).onModuleInit();
        await app.get(BackupImportsService).onModuleInit();
        await app.get(TimeMachineService).onModuleInit();
        await app.get(AutomaticUpdatesService).onModuleInit();
        await app.get(MetricHistoryService).onModuleInit();
        await app.get(HostDeviceHistoryService).onModuleInit();
        app.get(NearbyDiscoveryService).onModuleInit();
        app.get(ClusterSyncService).onModuleInit();
      },
      preparePresentation: () => presentation.prepareCoreCapturePresentation(),
      activateTimers: () => presentation.activateCoreCaptureTimers(),
    },
    onCleanupFailure: () => console.warn('A completed snapshot left temporary files for storage review.'),
  });
  await recovery.continue();
}
