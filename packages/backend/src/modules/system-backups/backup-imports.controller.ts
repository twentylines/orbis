import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { backupCredentials, backupOperator } from './backup-access';
import { BackupImportsService } from './backup-imports.service';

@Controller('system-backups/imports')
@UseGuards(AuthGuard)
export class BackupImportsController {
  constructor(private readonly imports: BackupImportsService) {}
  @Get()
  list(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.imports.list(backupOperator(request));
  }
  @Post()
  @HttpCode(201)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  create(@Req() request: Request, @Body() body: unknown) {
    return this.imports.create(backupOperator(request), backupCredentials(body));
  }
  @Put(':id/file')
  @HttpCode(200)
  async receive(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Param('id') id: string) {
    const owner = backupOperator(request);
    if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/octet-stream')
      throw new BadRequestException('Upload the backup as an encrypted binary file.');
    const cancelled = () => {
      if (!response.writableEnded) this.imports.abort(id, owner);
    };
    const inputAborted = () => {
      if (!request.complete) cancelled();
    };
    request.once('aborted', inputAborted);
    response.once('close', cancelled);
    try {
      if (request.aborted || response.destroyed) throw new BadRequestException('The upload was disconnected.');
      const result = await this.imports.receive(id, owner, request, request.headers['content-length']);
      if (result.status !== 'uploaded') throw new BadRequestException(result.message);
      return result;
    } finally {
      request.removeListener('aborted', inputAborted);
      response.removeListener('close', cancelled);
    }
  }
  @Post(':id/review')
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  review(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const owner = backupOperator(request);
    const value = backupCredentials(body, true);
    return this.imports.review(id, owner, value, value.passphrase);
  }
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Req() request: Request, @Param('id') id: string) {
    return this.imports.cancel(id, backupOperator(request));
  }
  @Delete(':id')
  remove(@Req() request: Request, @Param('id') id: string) {
    return this.imports.remove(id, backupOperator(request));
  }
}
