import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Put, Req, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { backupCredentials, backupOperator } from '../system-backups/backup-access';
import { CapsulesService } from './capsules.service';
@Controller('system-backups/capsules')
@UseGuards(AuthGuard)
export class CapsulesController {
  constructor(private readonly capsules: CapsulesService) {}
  @Get() list(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.capsules.list(backupOperator(request));
  }
  @Post('points/:id/export')
  @HttpCode(202)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async start(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Param('id') id: string, @Body() body: unknown) {
    const credentials = backupCredentials(body, true);
    const accepted = await this.capsules.startExport(backupOperator(request), request, credentials, id, credentials.passphrase);
    return this.background(response, request, accepted);
  }
  @Post('imports')
  @HttpCode(201)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  create(@Req() request: Request, @Body() body: unknown) {
    return this.capsules.createImport(backupOperator(request), request, backupCredentials(body));
  }
  @Put('imports/:id/file')
  @HttpCode(200)
  async upload(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Param('id') id: string) {
    if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/octet-stream')
      throw new BadRequestException('Choose an encrypted Time Machine capture file.');
    const abort = new AbortController();
    const cancel = () => {
      if (!response.writableEnded) abort.abort();
    };
    request.once('aborted', cancel);
    response.once('close', cancel);
    try {
      if (request.aborted || response.destroyed) throw new BadRequestException('The upload disconnected.');
      return await this.capsules.upload(id, backupOperator(request), request, request.headers['content-length'], abort.signal);
    } finally {
      request.removeListener('aborted', cancel);
      response.removeListener('close', cancel);
    }
  }
  @Post('imports/:id/review')
  @HttpCode(202)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async review(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Param('id') id: string, @Body() body: unknown) {
    const credentials = backupCredentials(body, true);
    return this.background(response, request, await this.capsules.review(id, backupOperator(request), request, credentials, credentials.passphrase));
  }
  @Post(':id/download')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async download(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Param('id') id: string, @Body() body: unknown) {
    const result = await this.capsules.download(id, backupOperator(request), request, backupCredentials(body));
    response.setHeader('Cache-Control', 'no-store');
    const closed = () => result.stream.destroy();
    response.once('close', closed);
    result.stream.once('close', () => response.removeListener('close', closed));
    if (request.aborted || response.destroyed) result.stream.destroy();
    return new StreamableFile(result.stream, {
      type: 'application/octet-stream',
      length: result.bytes,
      disposition: `attachment; filename="orbis-capture-${id}.orbis-tm"`,
    });
  }
  @Post('imports/:id/core-enrollment/:action')
  @HttpCode(200)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async coreEnrollment(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
    @Param('action') action: string,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (!['prepare', 'approve', 'status', 'reconcile'].includes(action) || !body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException('Choose a portable core enrollment action.');
    const value = body as Record<string, unknown>;
    const keys = ['password', 'totpCode', ...(action === 'prepare' ? ['passphrase'] : action === 'approve' ? ['reviewSha256', 'approvalNonce'] : [])];
    if (Object.keys(value).some((key) => !keys.includes(key))) throw new BadRequestException('The enrollment request has unsupported fields.');
    const credentials = backupCredentials({ password: value.password, ...(value.totpCode !== undefined ? { totpCode: value.totpCode } : {}) });
    const input =
      action === 'prepare'
        ? { passphrase: value.passphrase as string }
        : action === 'approve'
          ? { reviewSha256: value.reviewSha256 as string, approvalNonce: value.approvalNonce as string }
          : undefined;
    return this.capsules.coreEnrollment(
      id,
      backupOperator(request),
      request,
      credentials,
      action as 'prepare' | 'approve' | 'status' | 'reconcile',
      input,
    );
  }
  @Post('imports/:id/core-inspection/:action')
  @HttpCode(200)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async coreInspection(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
    @Param('action') action: string,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (!['prepare', 'approve', 'status'].includes(action) || !body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException('Choose a core inspection action.');
    const value = body as Record<string, unknown>;
    const keys = ['password', 'totpCode', ...(action === 'approve' ? ['reviewSha256', 'approvalNonce', 'executionConsent'] : [])];
    if (Object.keys(value).some((key) => !keys.includes(key))) throw new BadRequestException('The inspection request has unsupported fields.');
    return this.capsules.coreInspection(
      id,
      backupOperator(request),
      request,
      backupCredentials({ password: value.password, ...(value.totpCode !== undefined ? { totpCode: value.totpCode } : {}) }),
      action as 'prepare' | 'approve' | 'status',
      action === 'approve'
        ? { reviewSha256: value.reviewSha256 as string, approvalNonce: value.approvalNonce as string, executionConsent: value.executionConsent }
        : undefined,
    );
  }
  @Post(':id/remove') @HttpCode(200) remove(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.capsules.remove(id, backupOperator(request), request, backupCredentials(body));
  }
  private background<T>(response: Response, request: Request, accepted: { job: T; start: () => void }) {
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
}
