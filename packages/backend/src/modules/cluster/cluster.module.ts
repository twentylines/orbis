import { Module } from '@nestjs/common';
import { ConfigurationModule } from '@/core/config/configuration.module';
import { AppsModule } from '../apps/apps.module';
import { AppLifecycleModule } from '../app-lifecycle/app-lifecycle.module';
import { SystemModule } from '../system/system.module';
import { HostUpdatesModule } from '../host-updates/host-updates.module';
import { HostUpdatesGuard } from '../host-updates/host-updates.guard';
import { DockerAppsModule } from '../docker-apps/docker-apps.module';
import { MarketplaceModule } from '../marketplace/marketplace.module';
import { AppStoreModule } from '../app-stores/app-store.module';
import { ClusterInstallService } from './cluster-install.service';
import { ClusterController } from './cluster.controller';
import { ClusterService } from './cluster.service';
import { ClusterStateService } from './cluster-state.service';
import { MonitoringActivityModule } from '@/core/monitoring/monitoring-activity.module';

@Module({
  imports: [
    ConfigurationModule,
    AppsModule,
    AppLifecycleModule,
    SystemModule,
    HostUpdatesModule,
    DockerAppsModule,
    MarketplaceModule,
    AppStoreModule,
    MonitoringActivityModule,
  ],
  controllers: [ClusterController],
  providers: [ClusterService, ClusterStateService, ClusterInstallService, HostUpdatesGuard],
})
export class ClusterModule {}
