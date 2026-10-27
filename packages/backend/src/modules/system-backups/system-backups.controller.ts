import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { SystemBackupsService } from './system-backups.service';
import { backupCredentials as credentials, backupOperator } from './backup-access';

@Controller('system-backups')
@UseGuards(AuthGuard)
export class SystemBackupsController {
  constructor(private readonly backups: SystemBackupsService) {}
  @Get()
  list(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.backups.list(backupOperator(request));
  }
  @Post('export')
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  start(@Req() request: Request, @Body() body: unknown) {
    const owner = backupOperator(request);
    const value = credentials(body, true);
    return this.backups.start(owner, value, value.passphrase);
  }
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Req() request: Request, @Param('id') id: string) {
    return this.backups.cancel(id, backupOperator(request));
  }
  @Post(':id/recover')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  recover(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.backups.recover(id, backupOperator(request), credentials(body));
  }
  @Post(':id/download')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async download(@Req() request: Request, @Param('id') id: string, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const result = await this.backups.download(id, backupOperator(request), credentials(body));
    const disconnected = () => result.stream.destroy();
    response.once('close', disconnected);
    result.stream.once('close', () => response.removeListener('close', disconnected));
    if (response.destroyed || request.aborted) result.stream.destroy();
    response.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(result.stream, {
      type: 'application/octet-stream',
      length: result.bytes,
      disposition: `attachment; filename="orbis-${id}.orbis"`,
    });
  }
  @Delete(':id')
  remove(@Req() request: Request, @Param('id') id: string) {
    return this.backups.remove(id, backupOperator(request));
  }
}
