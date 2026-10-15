import { AuthGuard } from '@/modules/auth/auth.guard';
import { BadRequestException, Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { HostUpdatesGuard } from './host-updates.guard';
import { HostUpdatesService } from './host-updates.service';

@UseGuards(AuthGuard, HostUpdatesGuard)
@Controller('host-updates')
export class HostUpdatesController {
  constructor(private readonly hostUpdates: HostUpdatesService) {}

  @Get('status')
  status() {
    return this.hostUpdates.status();
  }

  @Get('packages')
  packages() {
    return this.hostUpdates.packages();
  }

  @Get('packages/changelog')
  packageChangelog(@Query('name') name: string) {
    return this.hostUpdates.packageChangelog(name);
  }

  @Get('packages/job')
  packageJob() {
    return this.hostUpdates.packageJob();
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
