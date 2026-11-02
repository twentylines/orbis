import { Body, Controller, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { ResetService } from './reset.service';

@Controller('system-reset')
@UseGuards(AuthGuard)
export class ResetController {
  constructor(private readonly reset: ResetService) {}
  @Post('passkey-options')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  options(@Req() request: Request, @Body() body: unknown) {
    return this.reset.options(request, body);
  }
  @Post()
  @HttpCode(202)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async begin(@Req() request: Request, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const accepted = await this.reset.accept(request, body);
    response.setHeader('Cache-Control', 'no-store');
    response.once('finish', accepted.start);
    response.once('close', accepted.start);
    if (response.destroyed || request.aborted) accepted.start();
    return accepted.job;
  }
  @Post('recover')
  @HttpCode(202)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async recover(@Req() request: Request, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const accepted = await this.reset.accept(request, body, true);
    response.setHeader('Cache-Control', 'no-store');
    response.once('finish', accepted.start);
    response.once('close', accepted.start);
    if (response.destroyed || request.aborted) accepted.start();
    return accepted.job;
  }
}
