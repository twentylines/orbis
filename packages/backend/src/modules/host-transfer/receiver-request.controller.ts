import { Body, Controller, Get, HttpCode, Param, Post, Req, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { backupCredentials, backupOperator } from '../system-backups/backup-access';
import { TransferIngress } from './transfer-ingress';
import { assertPrivateTransferPeer } from './transfer-peer';
import { ReceiverRequestService } from './receiver-request.service';
import { requestFields } from './receiver-request.types';

const authentication = ['password', 'totpCode'];
const credentials = (body: Record<string, unknown>) =>
  backupCredentials({ password: body.password, ...(body.totpCode === undefined ? {} : { totpCode: body.totpCode }) });

@Controller('system-backups/transfers/requests')
@UseGuards(AuthGuard)
export class ReceiverRequestController {
  constructor(private readonly requests: ReceiverRequestService) {}
  @Get()
  list(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.requests.list(backupOperator(request));
  }
  @Post()
  @HttpCode(201)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  create(@Req() request: Request, @Body() body: unknown) {
    const owner = backupOperator(request);
    const input = requestFields(
      body,
      [...authentication, 'sourceOrigin', 'confirmRequest', 'sourceCertificatePem', 'sourceCertificateSha256', 'confirmSourceCertificate'],
      70 * 1024,
    );
    return this.requests.create(owner, input.sourceOrigin, credentials(input), input.confirmRequest, {
      sourceCertificatePem: input.sourceCertificatePem,
      sourceCertificateSha256: input.sourceCertificateSha256,
      confirmSourceCertificate: input.confirmSourceCertificate,
    });
  }
  @Post('incoming/:id/approve')
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  approve(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const owner = backupOperator(request);
    const input = requestFields(body, [...authentication, 'destinationFingerprint', 'encryption', 'passphrase'], 8192);
    return this.requests.approve(id, owner, credentials(input), input.destinationFingerprint, input.encryption, input.passphrase);
  }
  @Post('incoming/:id/reject')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  reject(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const owner = backupOperator(request);
    const input = requestFields(body, authentication, 8192);
    return this.requests.reject(id, owner, credentials(input));
  }
  @Post('incoming/:id/cancel')
  @HttpCode(200)
  cancelIncoming(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const owner = backupOperator(request);
    requestFields(body, []);
    return this.requests.cancelIncoming(id, owner);
  }
  @Post('outgoing/:id/start')
  @HttpCode(202)
  start(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const owner = backupOperator(request);
    const input = requestFields(body, ['sourceFingerprint', 'confirmReceive']);
    return this.requests.start(id, owner, input.sourceFingerprint, input.confirmReceive);
  }
  @Post('outgoing/:id/cancel')
  @HttpCode(200)
  cancelOutgoing(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const owner = backupOperator(request);
    requestFields(body, []);
    return this.requests.cancelOutgoing(id, owner);
  }
}

@Controller('system-backups/transfers/peer')
export class ReceiverRequestPeerController {
  constructor(
    private readonly requests: ReceiverRequestService,
    private readonly ingress: TransferIngress,
  ) {}
  private async peer(request: Request) {
    const forwarded = request.headers['x-forwarded-for'] !== undefined || request.headers['x-forwarded-proto'] !== undefined;
    const proxies = forwarded ? await this.ingress.addresses(request.socket.remoteAddress ?? '') : [];
    assertPrivateTransferPeer(request, proxies);
    return (request.ip ?? '').replace(/^::ffff:/i, '');
  }
  @Post('request')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async create(@Req() request: Request, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const address = await this.peer(request);
    response.setHeader('Cache-Control', 'no-store');
    return this.requests.peerRequest(body, address);
  }
  @Post('request-status')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async status(@Req() request: Request, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const address = await this.peer(request);
    response.setHeader('Cache-Control', 'no-store');
    return this.requests.peerStatus(body, address);
  }
  @Post('request-cancel')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async cancel(@Req() request: Request, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const address = await this.peer(request);
    response.setHeader('Cache-Control', 'no-store');
    return this.requests.peerCancel(body, address);
  }
  @Post('request-file')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async file(@Req() request: Request, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const address = await this.peer(request);
    const result = await this.requests.peerFile(body, address);
    const disconnected = () => result.stream.destroy();
    response.once('close', disconnected);
    result.stream.once('close', () => response.removeListener('close', disconnected));
    if (response.destroyed || request.aborted) result.stream.destroy();
    response.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(result.stream, { type: 'application/octet-stream', length: result.bytes });
  }
}
