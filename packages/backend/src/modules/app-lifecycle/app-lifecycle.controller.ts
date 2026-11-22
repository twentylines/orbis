import { castAppUrn } from '@/common/helpers/app-helpers';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { AppLifecycleService } from './app-lifecycle.service';
import { AppFormBody, AppJobDto, LifecycleRequestDto, UninstallAppBody, UpdateAppBody } from './dto/app-lifecycle.dto';
import { ApiQuery, ApiResponse } from '@nestjs/swagger';
import { AppJobService } from './services/app-job.service';
import type { Request } from 'express';
import { InstallRecoveryReviewService } from './services/install-recovery-review.service';

@UseGuards(AuthGuard)
@Controller('app-lifecycle')
export class AppLifecycleController {
  constructor(
    private readonly appLifecycleService: AppLifecycleService,
    private readonly installRecoveryReview: InstallRecoveryReviewService,
    private readonly jobs: AppJobService,
  ) {}

  @Get(':urn/job')
  @Header('Cache-Control', 'private, no-store')
  @ApiResponse({ type: AppJobDto })
  @ApiQuery({ name: 'requestId', required: false, type: String })
  async getAppJob(@Param('urn') urn: string, @Query('requestId') requestId?: string) {
    if (requestId && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(requestId))
      throw new BadRequestException('Invalid operation identifier.');
    return AppJobDto.parse(await this.jobs.getJob(castAppUrn(urn), requestId));
  }

  @Post(':urn/jobs/:requestId/cancel')
  @Header('Cache-Control', 'private, no-store')
  @ApiResponse({ type: AppJobDto })
  async cancelAppJob(@Param('urn') urn: string, @Param('requestId') requestId: string) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(requestId))
      throw new BadRequestException('Invalid operation identifier.');
    return AppJobDto.parse(await this.jobs.cancel(castAppUrn(urn), requestId));
  }

  @Get(':urn/install-recovery')
  @Header('Cache-Control', 'private, no-store')
  reviewInterruptedInstall(@Req() request: Request, @Param('urn') urn: string) {
    if (request.authMethod !== 'session' || request.user?.operator !== true) {
      throw new ForbiddenException('An operator session is required to review an interrupted install.');
    }
    let appUrn: ReturnType<typeof castAppUrn>;
    try {
      appUrn = castAppUrn(urn);
    } catch {
      throw new BadRequestException('Invalid application identifier.');
    }
    return this.installRecoveryReview.review(appUrn);
  }

  @Post(':urn/install')
  @ApiResponse({ type: LifecycleRequestDto })
  async installApp(@Param('urn') urn: string, @Body() body: AppFormBody) {
    const res = await this.appLifecycleService.installApp({ appUrn: castAppUrn(urn), form: body });
    return LifecycleRequestDto.parse(res, { reportOnly: true });
  }

  @Post(':urn/start')
  @ApiResponse({ type: LifecycleRequestDto })
  async startApp(@Param('urn') urn: string) {
    const res = await this.appLifecycleService.startApp({ appUrn: castAppUrn(urn) });
    return LifecycleRequestDto.parse(res, { reportOnly: true });
  }

  @Post(':urn/stop')
  @ApiResponse({ type: LifecycleRequestDto })
  async stopApp(@Param('urn') urn: string) {
    const res = await this.appLifecycleService.stopApp({ appUrn: castAppUrn(urn) });
    return LifecycleRequestDto.parse(res, { reportOnly: true });
  }

  @Post(':urn/restart')
  @ApiResponse({ type: LifecycleRequestDto })
  async restartApp(@Param('urn') urn: string) {
    const res = await this.appLifecycleService.restartApp({ appUrn: castAppUrn(urn) });
    return LifecycleRequestDto.parse(res, { reportOnly: true });
  }

  @Delete(':urn/uninstall')
  @ApiResponse({ type: LifecycleRequestDto })
  async uninstallApp(@Param('urn') urn: string, @Body() body: UninstallAppBody) {
    const res = await this.appLifecycleService.uninstallApp({ appUrn: castAppUrn(urn), removeBackups: body.removeBackups });
    return LifecycleRequestDto.parse(res, { reportOnly: true });
  }

  @Post(':urn/reset')
  @ApiResponse({ type: LifecycleRequestDto })
  async resetApp(@Param('urn') urn: string) {
    const res = await this.appLifecycleService.resetApp({ appUrn: castAppUrn(urn) });
    return LifecycleRequestDto.parse(res, { reportOnly: true });
  }

  @Patch(':urn/update')
  @ApiResponse({ type: LifecycleRequestDto })
  async updateApp(@Param('urn') urn: string, @Body() body: UpdateAppBody) {
    const res = await this.appLifecycleService.updateApp({ appUrn: castAppUrn(urn), performBackup: body.performBackup });
    return LifecycleRequestDto.parse(res, { reportOnly: true });
  }

  @Patch(':urn/update-config')
  @ApiResponse({ type: LifecycleRequestDto })
  async updateAppSettings(@Param('urn') urn: string, @Body() body: AppFormBody) {
    const res = await this.appLifecycleService.updateAppSettings({ appUrn: castAppUrn(urn), form: body });
    return LifecycleRequestDto.parse(res, { reportOnly: true });
  }

  @Patch('update-all')
  async updateAllApps() {
    return this.appLifecycleService.updateAllApps();
  }

  @Post('start-all')
  async startAllApps() {
    return this.appLifecycleService.startAllApps();
  }

  @Post('stop-all')
  async stopAllApps() {
    return this.appLifecycleService.stopAllApps();
  }

  @Post('restart-all')
  async restartAllApps() {
    return this.appLifecycleService.restartAllApps();
  }
}
