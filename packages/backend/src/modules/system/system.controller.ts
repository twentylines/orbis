import { BadRequestException, Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { LoadDto } from './dto/system.dto';
import { SystemService } from './system.service';
import { ApiResponse } from '@nestjs/swagger';
import { OrbisReleaseService } from './orbis-release.service';
import { ContainerTelemetryService } from './container-telemetry.service';
import { MetricHistoryService } from './metric-history.service';
import { HostTelemetryService } from './host-telemetry.service';
import { HostProcessesService } from './host-processes.service';
import { HostSensorsService } from './host-sensors.service';
import { DriveHealthService } from './drive-health.service';
import { HostDeviceHistoryService } from './host-device-history.service';
import { parseHostHistorySelection } from './host-device-history.model';
import { metricHistoryRanges, type MetricHistoryRange } from '@runtipi/common/schemas';
import { requireReleaseChannel } from './orbis-release-channel';
import { OrbisReleaseChannelsService } from './orbis-release-channels.service';

@Controller('system')
export class SystemController {
  constructor(
    private readonly systemService: SystemService,
    private readonly orbisReleases: OrbisReleaseService,
    private readonly containers: ContainerTelemetryService,
    private readonly history: MetricHistoryService,
    private readonly host: HostTelemetryService,
    private readonly processes: HostProcessesService,
    private readonly hostHistory: HostDeviceHistoryService,
    private readonly sensors: HostSensorsService,
    private readonly drives: DriveHealthService,
    private readonly channels: OrbisReleaseChannelsService,
  ) {}

  @UseGuards(AuthGuard)
  @Get('/load')
  @ApiResponse({ type: LoadDto })
  async systemLoad() {
    const res = await this.systemService.getSystemLoad();
    return LoadDto.parse(res, { reportOnly: true });
  }

  @UseGuards(AuthGuard)
  @Get('/telemetry')
  async telemetry() {
    return this.systemService.getTelemetry();
  }

  @UseGuards(AuthGuard)
  @Get('/host-telemetry')
  hostTelemetry() {
    return this.host.read();
  }

  @UseGuards(AuthGuard)
  @Get('/containers')
  containerTelemetry() {
    return this.containers.read();
  }

  @UseGuards(AuthGuard)
  @Get('/host-processes')
  hostProcesses() {
    return this.processes.read();
  }

  @UseGuards(AuthGuard)
  @Get('/host-sensors')
  hostSensors() {
    return this.sensors.read();
  }

  @UseGuards(AuthGuard)
  @Get('/drives')
  driveHealth() {
    return this.drives.read();
  }

  @UseGuards(AuthGuard)
  @Get('/host-history')
  hostDeviceHistory(@Query('range') range: unknown = '1h', @Query('device') device: unknown = undefined) {
    if (typeof range !== 'string' || !Object.hasOwn(metricHistoryRanges, range)) throw new BadRequestException('Unsupported history range');
    let selection: ReturnType<typeof parseHostHistorySelection>;
    try {
      selection = parseHostHistorySelection(device);
    } catch {
      throw new BadRequestException('Unsupported history device');
    }
    return this.hostHistory.read(range as MetricHistoryRange, selection);
  }

  @UseGuards(AuthGuard)
  @Get('/history')
  metricHistory(@Query('range') range: unknown = '1h') {
    if (typeof range !== 'string' || !Object.hasOwn(metricHistoryRanges, range)) throw new BadRequestException('Unsupported history range');
    return this.history.read(range as MetricHistoryRange);
  }

  @UseGuards(AuthGuard)
  @Get('/build')
  build() {
    return {
      version: process.env.ORBIS_VERSION || 'development',
      commit: process.env.ORBIS_COMMIT || null,
      imageDigest: process.env.ORBIS_IMAGE_DIGEST || null,
      runtipiCompatibility: process.env.TIPI_VERSION || null,
    };
  }

  @UseGuards(AuthGuard)
  @Get('/orbis-release-channels')
  orbisReleaseChannels() {
    return this.channels.status();
  }

  @UseGuards(AuthGuard)
  @Get('/orbis-release')
  async latestOrbisRelease(@Query('channel') channel: unknown) {
    return this.orbisReleases.latest(requireReleaseChannel(channel) ?? (await this.channels.read()).channel);
  }

  @UseGuards(AuthGuard)
  @Get('/orbis-releases')
  async publishedOrbisReleases(@Query('channel') channel: unknown) {
    return this.orbisReleases.listPublished(requireReleaseChannel(channel) ?? (await this.channels.read()).channel);
  }

  @UseGuards(AuthGuard)
  @Get('/orbis-release-history')
  async orbisReleaseHistory(@Query('installed') installed: unknown, @Query('target') target: unknown, @Query('channel') channel: unknown) {
    return this.orbisReleases.history(installed, target, requireReleaseChannel(channel) ?? (await this.channels.read()).channel);
  }

  @Get('/certificate')
  async downloadLocalCertificate(@Res() res: Response) {
    const cert = await this.systemService.getLocalCertificate();

    res.set({
      'Content-Type': 'application/x-pem-file',
      'Content-Disposition': 'attachment; filename=cert.pem',
    });

    return res.send(cert);
  }
}
