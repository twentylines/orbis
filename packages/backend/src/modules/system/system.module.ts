import { Module } from '@nestjs/common';
import { SystemController } from './system.controller';
import { SystemService } from './system.service';
import { OrbisReleaseService } from './orbis-release.service';
import { DockerModule } from '../docker/docker.module';
import { ContainerTelemetryService } from './container-telemetry.service';
import { AppsModule } from '../apps/apps.module';
import { MetricHistoryService } from './metric-history.service';

@Module({
  imports: [DockerModule, AppsModule],
  controllers: [SystemController],
  providers: [SystemService, OrbisReleaseService, ContainerTelemetryService, MetricHistoryService],
  exports: [],
})
export class SystemModule {}
