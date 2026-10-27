import { Module } from '@nestjs/common';
import { SystemController } from './system.controller';
import { SystemService } from './system.service';
import { OrbisReleaseService } from './orbis-release.service';
import { DockerModule } from '../docker/docker.module';
import { ContainerTelemetryService } from './container-telemetry.service';
import { AppsModule } from '../apps/apps.module';
import { MetricHistoryService } from './metric-history.service';
import { HostTelemetryService } from './host-telemetry.service';
import { HostProcessesService } from './host-processes.service';
import { HostSensorsService } from './host-sensors.service';
import { HostDeviceHistoryService } from './host-device-history.service';
import { MonitoringActivityModule } from '@/core/monitoring/monitoring-activity.module';
import { OrbisReleaseChannelsService } from './orbis-release-channels.service';

@Module({
  imports: [DockerModule, AppsModule, MonitoringActivityModule],
  controllers: [SystemController],
  providers: [
    SystemService,
    OrbisReleaseService,
    OrbisReleaseChannelsService,
    ContainerTelemetryService,
    MetricHistoryService,
    HostTelemetryService,
    HostProcessesService,
    HostSensorsService,
    HostDeviceHistoryService,
  ],
  exports: [
    SystemService,
    OrbisReleaseService,
    OrbisReleaseChannelsService,
    ContainerTelemetryService,
    MetricHistoryService,
    HostTelemetryService,
    HostProcessesService,
    HostSensorsService,
    HostDeviceHistoryService,
  ],
})
export class SystemModule {}
