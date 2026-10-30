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
import { ClusterPairingController } from './cluster-pairing.controller';
import { ClusterPairingService } from './cluster-pairing.service';
import { ClusterService } from './cluster.service';
import { ClusterStateService } from './cluster-state.service';
import { MonitoringActivityModule } from '@/core/monitoring/monitoring-activity.module';
import { DesktopPreferencesModule } from '../desktop-preferences/desktop-preferences.module';
import { UserModule } from '../user/user.module';
import { ClusterSyncController } from './cluster-sync.controller';
import { ClusterSyncService } from './cluster-sync.service';
import { ClusterSyncStore } from './cluster-sync.store';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    AuthModule,
    ConfigurationModule,
    AppsModule,
    AppLifecycleModule,
    SystemModule,
    HostUpdatesModule,
    DockerAppsModule,
    MarketplaceModule,
    AppStoreModule,
    MonitoringActivityModule,
    DesktopPreferencesModule,
    UserModule,
  ],
  controllers: [ClusterController, ClusterPairingController, ClusterSyncController],
  providers: [
    ClusterPairingService,
    ClusterService,
    ClusterStateService,
    ClusterInstallService,
    HostUpdatesGuard,
    ClusterSyncService,
    ClusterSyncStore,
  ],
})
export class ClusterModule {}
