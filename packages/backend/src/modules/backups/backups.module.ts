import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { AppLifecycleModule } from '../app-lifecycle/app-lifecycle.module';
import { AppsModule } from '../apps/apps.module';
import { BackupManagerModule } from './backup-manager.module';
import { BackupsController } from './backups.controller';
import { BackupsService } from './backups.service';
import { BackupUploadStorage, backupUploadStorage } from './backup-upload.storage';

@Module({
  imports: [AppLifecycleModule, AppsModule, BackupManagerModule, MulterModule.register({ storage: backupUploadStorage })],
  controllers: [BackupsController],
  providers: [BackupsService, { provide: BackupUploadStorage, useValue: backupUploadStorage }],
  exports: [BackupsService],
})
export class BackupsModule {}
