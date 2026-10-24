import { AuthGuard } from '@/modules/auth/auth.guard';
import { BadRequestException, Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { HostUpdatesGuard } from './host-updates.guard';
import { HostUpdatesService } from './host-updates.service';
import { OrbisDowngradeService } from './orbis-downgrade.service';

@UseGuards(AuthGuard, HostUpdatesGuard)
@Controller('host-updates')
export class HostUpdatesController {
  constructor(
    private readonly hostUpdates: HostUpdatesService,
    private readonly downgrades: OrbisDowngradeService,
  ) {}

  @Post('downgrade/plan')
  @HttpCode(200)
  downgradePlan(@Body() body: Record<string, unknown>) {
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      typeof body.tag !== 'string' ||
      Object.keys(body).some((key) => key !== 'tag' && key !== 'force') ||
      ('force' in body && typeof body.force !== 'boolean')
    ) {
      throw new BadRequestException('Choose one older Orbis release.');
    }
    return this.downgrades.plan(body.tag, body.force === true);
  }

  @Post('downgrade/apply')
  @HttpCode(202)
  downgradeApply(@Body() body: Record<string, unknown>) {
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      typeof body.planId !== 'string' ||
      Object.keys(body).some((key) => key !== 'planId' && key !== 'force') ||
      ('force' in body && typeof body.force !== 'boolean')
    ) {
      throw new BadRequestException('Confirm one reviewed downgrade.');
    }
    return this.downgrades.apply(body.planId, body.force === true);
  }

  @Get('release-compatibility')
  releaseCompatibility(@Query() query: Record<string, unknown>) {
    if (!query || Object.keys(query).length !== 1 || typeof query.tag !== 'string') {
      throw new BadRequestException('Choose one published Orbis release.');
    }
    return this.downgrades.releaseCompatibility(query.tag);
  }

  @Get('status')
  status() {
    return this.hostUpdates.status();
  }

  @Get('packages')
  packages() {
    return this.hostUpdates.packages();
  }

  @Get('restart')
  restartStatus() {
    return this.hostUpdates.restartStatus();
  }

  @Post('restart/plan')
  @HttpCode(200)
  restartPlan(@Body() body: Record<string, unknown>) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
      throw new BadRequestException('Review a server restart without additional options.');
    }
    return this.hostUpdates.restartPlan();
  }

  @Post('restart/apply')
  @HttpCode(202)
  restartApply(@Body() body: Record<string, unknown>) {
    if (!body || typeof body !== 'object' || Object.keys(body).length !== 1 || !('planId' in body)) {
      throw new BadRequestException('Confirm one reviewed server restart.');
    }
    return this.hostUpdates.restartApply(body.planId);
  }

  @Get('packages/changelog')
  packageChangelog(@Query('name') name: string) {
    return this.hostUpdates.packageChangelog(name);
  }

  @Get('packages/job')
  packageJob() {
    return this.hostUpdates.packageJob();
  }

  @Post('packages/refresh')
  @HttpCode(202)
  packageRefresh(@Body() body: Record<string, unknown>) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
      throw new BadRequestException('Check for system updates without additional options.');
    }
    return this.hostUpdates.packageRefresh();
  }

  @Post('packages/plan')
  @HttpCode(200)
  packagePlan(@Body() body: Record<string, unknown>) {
    if (!body || typeof body !== 'object' || Object.keys(body).length !== 1 || !('names' in body)) {
      throw new BadRequestException('Choose host packages to review.');
    }
    return this.hostUpdates.packagePlan(body.names);
  }

  @Post('packages/apply')
  @HttpCode(202)
  packageApply(@Body() body: Record<string, unknown>) {
    if (!body || typeof body !== 'object' || Object.keys(body).length !== 1 || !('planId' in body)) {
      throw new BadRequestException('Apply one reviewed package plan.');
    }
    return this.hostUpdates.packageApply(body.planId);
  }

  @Post('plan')
  @HttpCode(200)
  plan(@Body() body: Record<string, unknown>) {
    if (!body || Object.keys(body).length !== 1) throw new BadRequestException('Choose one release tag.');
    return this.hostUpdates.plan(body.tag);
  }

  @Post('apply')
  @HttpCode(202)
  apply(@Body() body: Record<string, unknown>) {
    if (!body || Object.keys(body).length !== 1) throw new BadRequestException('Choose one update plan.');
    return this.hostUpdates.apply(body.planId);
  }

  @Post('recover')
  @HttpCode(202)
  recover(@Body() body: Record<string, unknown>) {
    if (!body || Object.keys(body).length !== 1) throw new BadRequestException('Choose one interrupted job.');
    return this.hostUpdates.recover(body.jobId);
  }
}
