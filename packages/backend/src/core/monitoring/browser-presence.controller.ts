import { AuthGuard } from '@/modules/auth/auth.guard';
import { BadRequestException, Body, Controller, ForbiddenException, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { MonitoringActivityService } from './monitoring-activity.service';

@UseGuards(AuthGuard)
@Controller('monitoring')
export class BrowserPresenceController {
  constructor(private readonly activity: MonitoringActivityService) {}
  @Post('presence')
  @HttpCode(204)
  presence(@Req() request: Request, @Body() body: unknown) {
    if (request.authMethod !== 'session') throw new ForbiddenException('A browser session is required.');
    if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).length)
      throw new BadRequestException('Presence has no options.');
    this.activity.touchBrowser();
  }
}
