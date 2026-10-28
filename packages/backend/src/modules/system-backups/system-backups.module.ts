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

@Module({
  imports: [AuthModule, AppsModule, DockerModule, TasksModule, HostUpdatesModule, AppLifecycleModule],
  controllers: [SystemBackupsController, BackupImportsController, BackupRestoresController],
  providers: [
    BackupRestoresService,
    BackupRuntimeService,
    BackupDatabaseService,
    SystemBackupsService,
    BackupImportsService,
    BackupRestoreActivationService,
  ],
})
export class SystemBackupsModule {}
