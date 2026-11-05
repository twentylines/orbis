import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { backupCredentials, backupOperator } from './backup-access';
import { SettingsBackupApplyService } from './settings-backup-apply.service';

@Controller('system-backups/settings-bundles')
@UseGuards(AuthGuard)
export class SettingsBackupApplyController {
  constructor(private readonly restore: SettingsBackupApplyService) {}
  @Get('restores')
  status(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.restore.status(backupOperator(request));
  }
  @Post('imports/:id/restore')
  @HttpCode(202)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async begin(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Param('id') id: string, @Body() body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Choose what to restore from the verified backup.');
    const { selection, ...proof } = body as Record<string, unknown>;
    const credentials = backupCredentials(proof, true);
    const accepted = await this.restore.accept(id, backupOperator(request), request, credentials, selection, credentials.passphrase);
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
  @Post('restores/:id/rollback')
  @HttpCode(200)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  rollback(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.restore.rollback(id, backupOperator(request), request, backupCredentials(body));
  }
}
