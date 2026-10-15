import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { LoadDto } from './dto/system.dto';
import { SystemService } from './system.service';
import { ApiResponse } from '@nestjs/swagger';
import { OrbisReleaseService } from './orbis-release.service';
import { ContainerTelemetryService } from './container-telemetry.service';

@Controller('system')
export class SystemController {
  constructor(
    private readonly systemService: SystemService,
    private readonly orbisReleases: OrbisReleaseService,
    private readonly containers: ContainerTelemetryService,
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
  @Get('/containers')
  containerTelemetry() {
    return this.containers.read();
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
  @Get('/orbis-release')
  latestOrbisRelease() {
    return this.orbisReleases.latest();
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
