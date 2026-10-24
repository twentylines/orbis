import { Module } from '@nestjs/common';
import { HostUpdatesController } from './host-updates.controller';
import { HostUpdatesGuard } from './host-updates.guard';
import { HostUpdatesService } from './host-updates.service';
import { OrbisDowngradeService } from './orbis-downgrade.service';
import { AutomaticUpdatesService } from './automatic-updates.service';
import { AutomaticUpdatesController } from './automatic-updates.controller';
import { MonitoringActivityModule } from '@/core/monitoring/monitoring-activity.module';
import { SystemModule } from '../system/system.module';
import { AppsModule } from '../apps/apps.module';
import { MarketplaceModule } from '../marketplace/marketplace.module';
import { AppLifecycleModule } from '../app-lifecycle/app-lifecycle.module';

@Module({
  imports: [MonitoringActivityModule, SystemModule, AppsModule, MarketplaceModule, AppLifecycleModule],
  controllers: [HostUpdatesController, AutomaticUpdatesController],
  providers: [HostUpdatesService, HostUpdatesGuard, OrbisDowngradeService, AutomaticUpdatesService],
  exports: [HostUpdatesService, AutomaticUpdatesService],
})
export class HostUpdatesModule {}
