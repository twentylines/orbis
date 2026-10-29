import { BadRequestException, ForbiddenException, Body, Controller, Delete, Get, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { HostUpdatesGuard } from '../host-updates/host-updates.guard';
import { ClusterService } from './cluster.service';
import { ClusterStateService } from './cluster-state.service';

@Controller('cluster')
export class ClusterController {
  constructor(
    private readonly cluster: ClusterService,
    private readonly state: ClusterStateService,
  ) {}

  private operator(request: Request) {
    if (request.authMethod !== 'session' || request.user?.operator !== true)
      throw new ForbiddenException('An operator session is required for pairing.');
    return request.user.id;
  }

  @Get()
  @UseGuards(AuthGuard)
  describe() {
    return this.state.describe();
  }

  @Post('create')
  @UseGuards(AuthGuard, HostUpdatesGuard)
  create(@Body() body: Record<string, unknown>) {
    return this.state.create(body.name, body.serverName);
  }

  @Put()
  @UseGuards(AuthGuard, HostUpdatesGuard)
  rename(@Body() body: Record<string, unknown>) {
    return this.state.create(body.name, body.serverName);
  }

  @Post('invite')
  @UseGuards(AuthGuard, HostUpdatesGuard)
  invite(@Req() request: Request, @Body() body: Record<string, unknown>) {
    return this.cluster.invite(body, this.operator(request));
  }

  @Post('pair')
  @UseGuards(AuthGuard, HostUpdatesGuard)
  pair(@Req() request: Request, @Body() body: Record<string, unknown>) {
    return this.cluster.pair(body, this.operator(request));
  }

  @Post('accept')
  accept(@Body() body: Record<string, unknown>) {
    return this.state.accept(body);
  }

  @Post('peer')
  peer(@Req() request: Request, @Body() body: Record<string, unknown>) {
    return this.cluster.peer(request.headers, body);
  }

  @Delete('membership')
  @UseGuards(AuthGuard, HostUpdatesGuard)
  leave() {
    return this.state.leave();
  }

  @Delete('servers/:id')
  @UseGuards(AuthGuard, HostUpdatesGuard)
  remove(@Param('id') id: string, @Query('forget') forget?: string) {
    return this.cluster.remove(id, forget === 'true');
  }

  @Get('servers/:id/read/:resource')
  @UseGuards(AuthGuard)
  read(@Param('id') id: string, @Param('resource') resource: string, @Query() params: Record<string, unknown>) {
    return this.cluster.read(id, resource, params);
  }

  @Get('servers/:id/icon')
  @UseGuards(AuthGuard)
  async icon(@Param('id') id: string, @Query('urn') urn: unknown, @Res() response: Response) {
    const result = (await this.cluster.read(id, 'icon', { urn })) as { dataUrl?: unknown };
    const match = typeof result.dataUrl === 'string' ? result.dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/) : null;
    if (!match?.[1] || !match[2] || match[2].length > 1_400_000) throw new BadRequestException('Invalid app icon.');
    response.set({ 'Content-Type': match[1], 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
    return response.send(Buffer.from(match[2], 'base64'));
  }

  @Post('servers/:id/command')
  @UseGuards(AuthGuard, HostUpdatesGuard)
  command(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    if (
      typeof body.action !== 'string' ||
      (body.payload !== undefined && (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)))
    ) {
      throw new BadRequestException('Choose one cluster command.');
    }
    return this.cluster.command(id, body.action, body.payload as Record<string, unknown> | undefined);
  }
}
