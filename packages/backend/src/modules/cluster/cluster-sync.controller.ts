import { Body, Controller, ForbiddenException, Get, Param, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { HostUpdatesGuard } from '../host-updates/host-updates.guard';
import { ClusterSyncService } from './cluster-sync.service';

function operator(request: Request) {
  if (request.authMethod !== 'session' || request.user?.operator !== true)
    throw new ForbiddenException('An operator session is required for settings sync.');
  return request.user.id;
}

@Controller('cluster/settings-sync')
export class ClusterSyncController {
  constructor(private readonly sync: ClusterSyncService) {}
  @Get()
  @UseGuards(AuthGuard, HostUpdatesGuard)
  status(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.sync.status(operator(request));
  }
  @Put('receiving')
  @UseGuards(AuthGuard, HostUpdatesGuard)
  receiving(@Req() request: Request, @Body() body: unknown) {
    return this.sync.receiving(operator(request), body);
  }
  @Put('plans/:id')
  @UseGuards(AuthGuard, HostUpdatesGuard)
  save(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.sync.savePlan(operator(request), id, body);
  }
  @Post('plans/:id/run')
  @UseGuards(AuthGuard, HostUpdatesGuard)
  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  run(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.sync.run(operator(request), id, body);
  }
  @Post('peer')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  peer(@Req() request: Request, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.sync.peer(request.headers, body);
  }
}
