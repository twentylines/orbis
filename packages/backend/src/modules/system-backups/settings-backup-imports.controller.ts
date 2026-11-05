import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { backupCredentials, backupOperator, optionalBackupCredentials } from './backup-access';
import { SettingsBackupImportsService } from './settings-backup-imports.service';

@Controller('system-backups/settings-bundles/imports')
@UseGuards(AuthGuard)
export class SettingsBackupImportsController {
  constructor(private readonly imports: SettingsBackupImportsService) {}
  @Get()
  list(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.imports.list(backupOperator(request));
  }
  @Post()
  @HttpCode(201)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  create(@Req() request: Request, @Body() body: unknown) {
    return this.imports.create(backupOperator(request), request, optionalBackupCredentials(body));
  }
  @Put(':id/file')
  @HttpCode(200)
  async upload(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Param('id') id: string) {
    const owner = backupOperator(request);
    if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/octet-stream')
      throw new BadRequestException('Upload the backup as a binary file.');
    const abort = new AbortController();
    const disconnected = () => {
      if (!response.writableEnded) abort.abort();
    };
    request.once('aborted', disconnected);
    response.once('close', disconnected);
    try {
      if (request.aborted || response.destroyed) throw new BadRequestException('The upload disconnected.');
      return await this.imports.upload(id, owner, request, request.headers['content-length'], abort.signal);
    } finally {
      request.removeListener('aborted', disconnected);
      response.removeListener('close', disconnected);
    }
  }
  @Post(':id/review')
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async review(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const credentials = backupCredentials(body, true);
    const { job } = await this.imports.review(id, backupOperator(request), request, credentials, credentials.passphrase);
    return job;
  }
  @Post(':id/remove')
  @HttpCode(200)
  remove(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.imports.remove(id, backupOperator(request), request, backupCredentials(body));
  }
}
