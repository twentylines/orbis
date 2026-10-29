import { Body, Controller, Get, Header, Post, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { HostUpdatesGuard } from '../host-updates/host-updates.guard';
import { NearbyDiscoveryService } from './discovery.service';

@Controller('nearby-discovery')
@UseGuards(AuthGuard, HostUpdatesGuard)
export class NearbyDiscoveryController {
  constructor(private readonly discovery: NearbyDiscoveryService) {}
  @Get()
  status(@Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.discovery.status();
  }
  @Get('interfaces')
  interfaces(@Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.discovery.interfaces();
  }
  @Post('scan')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 2, ttl: 10_000 } })
  scan(@Body() body: unknown) {
    return this.discovery.scan(body);
  }
  @Post('advertise')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  advertise(@Body() body: unknown) {
    return this.discovery.advertise(body);
  }
  @Post('disable')
  @Header('Cache-Control', 'no-store')
  disable(@Body() body: unknown) {
    return this.discovery.disable(body);
  }
}
