import { Module } from '@nestjs/common';
import { ConfigurationModule } from '@/core/config/configuration.module';
import { AppsModule } from '../apps/apps.module';
import { AppLifecycleModule } from '../app-lifecycle/app-lifecycle.module';
import { SystemModule } from '../system/system.module';
import { HostUpdatesModule } from '../host-updates/host-updates.module';
import { HostUpdatesGuard } from '../host-updates/host-updates.guard';
import { DockerAppsModule } from '../docker-apps/docker-apps.module';
import { MarketplaceModule } from '../marketplace/marketplace.module';
import { ClusterController } from './cluster.controller';
import { ClusterService } from './cluster.service';
import { ClusterStateService } from './cluster-state.service';

@Module({
  imports: [ConfigurationModule, AppsModule, AppLifecycleModule, SystemModule, HostUpdatesModule, DockerAppsModule, MarketplaceModule],
  controllers: [ClusterController],
  providers: [ClusterService, ClusterStateService, HostUpdatesGuard],
})
export class ClusterModule {}
