import { QueueModule } from '../queue/queue.module';
import { BackupRestoresService } from './backup-restores.service';
import { BackupRestoresController } from './backup-restores.controller';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AppsModule } from '../apps/apps.module';
import { DockerModule } from '../docker/docker.module';
import { TasksModule } from '../tasks/tasks.module';
import { HostUpdatesModule } from '../host-updates/host-updates.module';
import { BackupRuntimeService } from './backup-runtime.service';
import { SystemBackupsController } from './system-backups.controller';
import { SystemBackupsService } from './system-backups.service';
import { BackupImportsController } from './backup-imports.controller';
import { BackupImportsService } from './backup-imports.service';
import { BackupDatabaseService } from './backup-database.service';
import { BackupRestoreActivationService } from './backup-restore-activation.service';
import { AppLifecycleModule } from '../app-lifecycle/app-lifecycle.module';
import { TimeMachineController } from './time-machine.controller';
import { TimeMachineService } from './time-machine.service';
import { TimeMachineRestoreAuthorization } from './time-machine-restore-authorization';
import { TimeMachineCaptureRuntime, TIME_MACHINE_CAPTURE_IMAGES } from './time-machine-capture-runtime';
import { imageCaptureDocker } from './backup-image-capture';
import { DOCKERODE } from '../docker/docker.module';
import type Dockerode from 'dockerode';
import { DesktopPreferencesModule } from '../desktop-preferences/desktop-preferences.module';
import { CoreCaptureRecoveryService } from './time-machine-core-recovery.service';
import { CoreCaptureRecoveryController } from './time-machine-core-recovery.controller';
import { TimeMachineCoreInspectionController } from './time-machine-core-inspection.controller';
import { TimeMachineCoreInspectionService } from './time-machine-core-inspection.service';
import { TimeMachineCorePreparationController } from './time-machine-core-preparation.controller';
import { TimeMachineCorePreparationService } from './time-machine-core-preparation.service';
import { TimeMachineCoreReconciliationController } from './time-machine-core-reconciliation.controller';
import { TimeMachineCoreReconciliationService } from './time-machine-core-reconciliation.service';

@Module({
  imports: [QueueModule, AuthModule, AppsModule, DockerModule, TasksModule, HostUpdatesModule, AppLifecycleModule, DesktopPreferencesModule],
  controllers: [
    TimeMachineController,
    SystemBackupsController,
    BackupImportsController,
    BackupRestoresController,
    CoreCaptureRecoveryController,
    TimeMachineCoreInspectionController,
    TimeMachineCorePreparationController,
    TimeMachineCoreReconciliationController,
  ],
  exports: [SystemBackupsService, BackupImportsService, TimeMachineService, BackupDatabaseService],
  providers: [
    BackupRestoresService,
    BackupRuntimeService,
    BackupDatabaseService,
    SystemBackupsService,
    BackupImportsService,
    BackupRestoreActivationService,
    TimeMachineService,
    TimeMachineRestoreAuthorization,
    TimeMachineCaptureRuntime,
    CoreCaptureRecoveryService,
    TimeMachineCoreInspectionService,
    TimeMachineCorePreparationService,
    TimeMachineCoreReconciliationService,
    { provide: TIME_MACHINE_CAPTURE_IMAGES, useFactory: (docker: Dockerode) => imageCaptureDocker(docker), inject: [DOCKERODE] },
  ],
})
export class SystemBackupsModule {}
