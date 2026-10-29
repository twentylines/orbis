import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Req, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { backupCredentials, backupOperator } from '../system-backups/backup-access';
import { HostTransferService } from './host-transfer.service';
import { assertPrivateTransferPeer } from './transfer-peer';
import { TransferIngress } from './transfer-ingress';
import { assertPrivateCertificateInspection, inspectPublicCertificate } from './transfer-certificate-inspection';

function fields(body: unknown, allowed: string[]) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key)))
    throw new BadRequestException('Provide only the requested transfer details.');
  return body as Record<string, unknown>;
}
function credentials(body: Record<string, unknown>) {
  return backupCredentials({ password: body.password, ...(body.totpCode === undefined ? {} : { totpCode: body.totpCode }) });
}
const authentication = ['password', 'totpCode'];

@Controller('system-backups/transfers')
export class HostTransferController {
  constructor(
    private readonly transfers: HostTransferService,
    private readonly ingress: TransferIngress,
  ) {}

  @Get()
  @UseGuards(AuthGuard)
  list(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.transfers.list(backupOperator(request));
  }

  @Post('certificates/fingerprint')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @Throttle({ default: { limit: 4, ttl: 60_000 } })
  async certificateFingerprint(@Req() request: Request, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    backupOperator(request);
    const forwarded = request.headers['x-forwarded-for'] !== undefined || request.headers['x-forwarded-proto'] !== undefined;
    const proxies = forwarded ? await this.ingress.addresses(request.socket.remoteAddress ?? '') : [];
    assertPrivateCertificateInspection(request, proxies);
    response.setHeader('Cache-Control', 'no-store');
    return inspectPublicCertificate(body);
  }

  @Post('offers')
  @HttpCode(201)
  @UseGuards(AuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  offer(@Req() request: Request, @Body() body: unknown) {
    const owner = backupOperator(request);
    const value = fields(body, [...authentication, 'backupId', 'confirmExport']);
    return this.transfers.offer(owner, value.backupId, credentials(value), value.confirmExport);
  }

  @Post('offers/:id/approve')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  approve(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const owner = backupOperator(request);
    const value = fields(body, [...authentication, 'destinationFingerprint']);
    return this.transfers.approve(id, owner, credentials(value), value.destinationFingerprint);
  }

  @Post('offers/:id/cancel')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  cancelOffer(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    fields(body, []);
    return this.transfers.cancelOffer(id, backupOperator(request));
  }

  @Post('imports')
  @HttpCode(201)
  @UseGuards(AuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  createImport(@Req() request: Request, @Body() body: unknown) {
    const owner = backupOperator(request);
    const value = fields(body, [
      ...authentication,
      'sourceOrigin',
      'code',
      'sourceCertificatePem',
      'sourceCertificateSha256',
      'confirmSourceCertificate',
    ]);
    return this.transfers.createImport(owner, value.sourceOrigin, value.code, credentials(value), {
      sourceCertificatePem: value.sourceCertificatePem,
      sourceCertificateSha256: value.sourceCertificateSha256,
      confirmSourceCertificate: value.confirmSourceCertificate,
    });
  }

  @Post('imports/:id/start')
  @HttpCode(202)
  @UseGuards(AuthGuard)
  start(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const value = fields(body, ['sourceFingerprint']);
    return this.transfers.start(id, backupOperator(request), value.sourceFingerprint);
  }

  @Post('imports/:id/cancel')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  cancelImport(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    fields(body, []);
    return this.transfers.cancelImport(id, backupOperator(request));
  }

  private async peer(request: Request) {
    const forwarded = request.headers['x-forwarded-for'] !== undefined || request.headers['x-forwarded-proto'] !== undefined;
    const proxies = forwarded ? await this.ingress.addresses(request.socket.remoteAddress ?? '') : [];
    assertPrivateTransferPeer(request, proxies);
  }

  @Post('peer/claim')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async claim(@Req() request: Request, @Body() body: unknown) {
    await this.peer(request);
    return this.transfers.claim(body);
  }

  @Post('peer/status')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async status(@Req() request: Request, @Body() body: unknown) {
    await this.peer(request);
    return this.transfers.peerStatus(body);
  }

  @Post('peer/file')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async file(@Req() request: Request, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    await this.peer(request);
    const result = this.transfers.file(body);
    const disconnected = () => result.stream.destroy();
    response.once('close', disconnected);
    result.stream.once('close', () => response.removeListener('close', disconnected));
    if (response.destroyed || request.aborted) result.stream.destroy();
    response.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(result.stream, { type: 'application/octet-stream', length: result.bytes });
  }
}
