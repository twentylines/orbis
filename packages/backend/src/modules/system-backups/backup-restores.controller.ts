import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { backupCredentials, backupOperator } from './backup-access';
import { BackupRestoresService } from './backup-restores.service';

export function restoreRequest(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Confirm the reviewed backup before restoring.');
  const { importId, manifestSha256, confirmation, ...credentials } = body as Record<string, unknown>;
  if (
    typeof importId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(importId) ||
    typeof manifestSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(manifestSha256) ||
    confirmation !== 'replace-server'
  )
    throw new BadRequestException('Confirm the exact reviewed backup before restoring.');
  return { importId, manifestSha256, credentials: backupCredentials(credentials) };
}
@Controller('system-backups/restores')
@UseGuards(AuthGuard)
export class BackupRestoresController {
  constructor(private readonly restores: BackupRestoresService) {}
  private afterResponse(response: Response, id: string) {
    let started = false;
    const launch = () => {
      if (started) return;
      started = true;
      response.removeListener('finish', launch);
      response.removeListener('close', launch);
      void this.restores.launch(id);
    };
    response.once('finish', launch);
    response.once('close', launch);
    if (response.writableFinished || response.destroyed) launch();
  }
  @Get()
  status(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    backupOperator(request);
    response.setHeader('Cache-Control', 'no-store');
    return this.restores.status();
  }
  @Post()
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async prepare(@Req() request: Request, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const owner = backupOperator(request);
    const input = restoreRequest(body);
    const result = await this.restores.prepare(input.importId, owner, input.credentials, input.manifestSha256);
    if (result.job) this.afterResponse(response, result.job.id);
    return result;
  }
  @Post(':id/cancel')
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async cancel(@Req() request: Request, @Param('id') id: string, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const owner = backupOperator(request);
    const result = await this.restores.cancel(id, owner, backupCredentials(body));
    if (result.job) this.afterResponse(response, result.job.id);
    return result;
  }
  @Post(':id/recover')
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async recover(@Req() request: Request, @Param('id') id: string, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const owner = backupOperator(request);
    const result = await this.restores.recover(id, owner, backupCredentials(body));
    if (result.job) this.afterResponse(response, result.job.id);
    return result;
  }
}
