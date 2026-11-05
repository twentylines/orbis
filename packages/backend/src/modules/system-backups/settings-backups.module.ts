import { Module } from '@nestjs/common';
import { ConfigurationModule } from '@/core/config/configuration.module';
import { AuthModule } from '../auth/auth.module';
import { DesktopPreferencesModule } from '../desktop-preferences/desktop-preferences.module';
import { ThemePacksModule } from '../theme-packs/theme-packs.module';
import { SystemBackupsModule } from './system-backups.module';
import { SettingsBackupSourceService } from './settings-backup-source.service';
import { SettingsBackupsService } from './settings-backups.service';
import { SettingsBackupsController } from './settings-backups.controller';
import { SettingsBackupImportsService } from './settings-backup-imports.service';
import { SettingsBackupImportsController } from './settings-backup-imports.controller';
import { SettingsBackupApplyService } from './settings-backup-apply.service';
import { SettingsBackupApplyController } from './settings-backup-apply.controller';

@Module({
  imports: [ConfigurationModule, AuthModule, DesktopPreferencesModule, ThemePacksModule, SystemBackupsModule],
  controllers: [SettingsBackupsController, SettingsBackupImportsController, SettingsBackupApplyController],
  providers: [SettingsBackupSourceService, SettingsBackupsService, SettingsBackupImportsService, SettingsBackupApplyService],
  exports: [SettingsBackupsService, SettingsBackupImportsService],
})
export class SettingsBackupsModule {}
