import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
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
import { SentinelService } from './sentinel.service';
import { SentinelReleasesService } from './sentinel-releases.service';
import { InstalledSoftwareService } from './installed-software.service';

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
    private readonly sentinel: SentinelService,
    private readonly sentinelReleases: SentinelReleasesService,
    private readonly installedSoftware: InstalledSoftwareService,
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
  @Get('/installed-software')
  installedSoftwareVersions() {
    return this.installedSoftware.read();
  }

  @UseGuards(AuthGuard)
  @Get('/sentinel')
  sentinelStatus() {
    return this.sentinel.read();
  }

  @UseGuards(AuthGuard)
  @Header('Cache-Control', 'no-store')
  @Get('/sentinel/update-progress')
  sentinelUpdateProgress(@Req() request: Request) {
    if (request.user?.operator !== true) throw new ForbiddenException('An operator session is required.');
    return this.sentinel.readUpdateProgress();
  }

  @UseGuards(AuthGuard)
  @Header('Cache-Control', 'no-store')
  @Get('/sentinel/recovery-access')
  async sentinelRecoveryAccess(@Req() request: Request) {
    const access = await this.sentinel.readRecoveryAccess();
    if (request.user?.operator === true || access.state !== 'configured') return access;
    return { state: access.state, portalUrl: access.portalUrl, unitState: access.unitState };
  }

  @UseGuards(AuthGuard)
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post('/sentinel/enrollment/save-key')
  saveSentinelEmergencyKey(@Req() request: Request, @Body() body: unknown) {
    this.requireRecoveryOperator(request);
    return this.sentinel.recoveryKeyHandoff('save', body);
  }

  @UseGuards(AuthGuard)
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post('/sentinel/enrollment/confirm-key')
  confirmSentinelEmergencyKey(@Req() request: Request, @Body() body: unknown) {
    this.requireRecoveryOperator(request);
    return this.sentinel.recoveryKeyHandoff('confirm', body);
  }

  @UseGuards(AuthGuard)
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post('/sentinel/controller-handoff/plan')
  reviewControllerHandoff(@Req() request: Request, @Body() body: unknown) {
    this.requireRecoveryOperator(request);
    return this.sentinel.reviewControllerHandoff(body);
  }

  @UseGuards(AuthGuard)
  @Header('Cache-Control', 'no-store')
  @HttpCode(202)
  @Post('/sentinel/controller-handoff/apply')
  applyControllerHandoff(@Req() request: Request, @Body() body: unknown) {
    this.requireRecoveryOperator(request);
    return this.sentinel.applyControllerHandoff(body);
  }

  @UseGuards(AuthGuard)
  @Header('Cache-Control', 'no-store')
  @Get('/sentinel/controller-handoff/:planId/status')
  controllerHandoffStatus(@Req() request: Request, @Param('planId') planId: string) {
    this.requireRecoveryOperator(request);
    return this.sentinel.controllerHandoffStatus(planId);
  }

  private requireRecoveryOperator(request: Request) {
    if (request.user?.operator !== true || request.authMethod !== 'session' || !request.secure) {
      throw new ForbiddenException('An HTTPS operator session is required.');
    }
  }

  @UseGuards(AuthGuard)
  @Get('/sentinel-releases')
  sentinelReleaseCatalog(@Query('channel') channel: unknown) {
    if (channel !== undefined && channel !== 'stable' && channel !== 'nightly')
      throw new BadRequestException('Choose a valid Sentinel release channel.');
    return this.sentinelReleases.list(channel ?? 'stable');
  }

  @UseGuards(AuthGuard)
  @Get('/orbis-release-channels')
  orbisReleaseChannels() {
    return this.channels.status();
  }

  @UseGuards(AuthGuard)
  @Get('/orbis-release')
  async latestOrbisRelease(@Query('channel') channel: unknown, @Res() response: Response) {
    const release = await this.orbisReleases.latest(requireReleaseChannel(channel) ?? (await this.channels.read()).channel);
    response.json(release);
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
