import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Req, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { SystemBackupsService } from './system-backups.service';
import { BackupImportsService } from './backup-imports.service';
import { optionalBackupCredentials, backupOperator } from './backup-access';

@Controller('system-backups')
@UseGuards(AuthGuard)
export class SystemBackupsController {
  constructor(
    private readonly backups: SystemBackupsService,
    private readonly imports: BackupImportsService,
  ) {}
  @Get()
  list(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.backups.list(backupOperator(request));
  }
  @Get('settings')
  settings(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    backupOperator(request);
    response.setHeader('Cache-Control', 'no-store');
    return this.backups.settings();
  }
  @Put('settings')
  updateSettings(@Req() request: Request, @Body() body: unknown) {
    backupOperator(request);
    return this.backups.updateSettings(body);
  }
  @Post(':id/import')
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async importSaved(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const owner = backupOperator(request);
    const archive = await this.backups.downloadForSession(id, owner, request, optionalBackupCredentials(body));
    return this.imports.receiveServerExport(owner, archive.stream, archive.bytes);
  }
  @Post('export')
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  start(@Req() request: Request, @Body() body: unknown) {
    const owner = backupOperator(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Enter the backup encryption key.');
    const { passphrase, ...proof } = body as Record<string, unknown>;
    if (typeof passphrase !== 'string' || passphrase.length < 8 || !passphrase.trim() || passphrase.length > 1024)
      throw new BadRequestException('Use a backup passphrase between 8 and 1024 characters.');
    return this.backups.startForSession(owner, optionalBackupCredentials(proof), passphrase, request);
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
    return this.backups.recoverForSession(id, backupOperator(request), request, optionalBackupCredentials(body));
  }
  @Post(':id/download')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async download(@Req() request: Request, @Param('id') id: string, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const owner = backupOperator(request);
    const creationSession = body && typeof body === 'object' && !Array.isArray(body) && 'creationSession' in body;
    if (creationSession && (Object.keys(body).length !== 1 || (body.creationSession !== true && body.creationSession !== 'true')))
      throw new BadRequestException('Choose a valid backup download authorization.');
    const result = creationSession
      ? await this.backups.downloadCreated(id, owner, request)
      : await this.backups.downloadForSession(id, owner, request, optionalBackupCredentials(body));
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
