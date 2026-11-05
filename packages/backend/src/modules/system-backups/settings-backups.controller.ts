import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Req, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { backupCredentials, backupOperator } from './backup-access';
import { SettingsBackupsService } from './settings-backups.service';

@Controller('system-backups/settings-bundles')
@UseGuards(AuthGuard)
export class SettingsBackupsController {
  constructor(private readonly backups: SettingsBackupsService) {}

  @Get()
  list(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.backups.list(backupOperator(request));
  }

  @Post()
  @HttpCode(202)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async create(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Body() body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Choose what to include in your backup.');
    const { selection, ...proof } = body as Record<string, unknown>;
    const credentials = backupCredentials(proof, true);
    const accepted = await this.backups.create(backupOperator(request), request, credentials, selection, credentials.passphrase);
    response.setHeader('Cache-Control', 'no-store');
    let started = false;
    const start = () => {
      if (!started) {
        started = true;
        accepted.start();
      }
    };
    response.once('finish', start);
    response.once('close', start);
    if (request.aborted || response.destroyed) start();
    return accepted.job;
  }

  @Post(':id/download')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async download(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Param('id') id: string, @Body() body: unknown) {
    const result = await this.backups.download(id, backupOperator(request), request, backupCredentials(body));
    response.setHeader('Cache-Control', 'no-store');
    const close = () => result.stream.destroy();
    response.once('close', close);
    result.stream.once('close', () => response.removeListener('close', close));
    if (request.aborted || response.destroyed) result.stream.destroy();
    return new StreamableFile(result.stream, {
      type: 'application/octet-stream',
      length: result.bytes,
      disposition: `attachment; filename="orbis-settings-${id}.orbis-settings"`,
    });
  }

  @Post(':id/remove')
  @HttpCode(200)
  remove(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.backups.remove(id, backupOperator(request), request, backupCredentials(body));
  }
}
