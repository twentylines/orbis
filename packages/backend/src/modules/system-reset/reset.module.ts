import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ClusterModule } from '../cluster/cluster.module';
import { HostUpdatesModule } from '../host-updates/host-updates.module';
import { SystemBackupsModule } from '../system-backups/system-backups.module';
import { SettingsBackupsModule } from '../system-backups/settings-backups.module';
import { ResetService } from './reset.service';
import { ResetController } from './reset.controller';

@Module({
  imports: [AuthModule, ClusterModule, HostUpdatesModule, SystemBackupsModule, SettingsBackupsModule],
  providers: [ResetService],
  controllers: [ResetController],
  exports: [ResetService],
})
export class ResetModule {}
