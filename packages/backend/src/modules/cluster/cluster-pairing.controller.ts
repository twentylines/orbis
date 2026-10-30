import {
  type ArgumentsHost,
  Body,
  BadRequestException,
  Catch,
  Controller,
  type ExceptionFilter,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  Post,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ConfigurationService } from '@/core/config/configuration.service';
import { assertPrivateTransferPeer } from '../host-transfer/transfer-peer';
import { SESSION_COOKIE_NAME } from '@/common/constants';
import { AuthGuard } from '../auth/auth.guard';
import { HostUpdatesGuard } from '../host-updates/host-updates.guard';
import { digest } from './cluster-transport';
import { ClusterPairingService } from './cluster-pairing.service';

export function pairingInput(request: Request, body: Record<string, unknown>) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    request.body = {};
    throw new BadRequestException('Provide only the requested pairing details.');
  }
  const input = { ...body };
  for (const key of Object.keys(body)) delete body[key];
  request.body = {};
  return input;
}

@Catch()
export class ClusterPairingExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status = error instanceof HttpException ? error.getStatus() : 503;
    const supplied = error instanceof HttpException ? error.getResponse() : undefined;
    const message =
      typeof supplied === 'string' ? supplied : supplied && typeof supplied === 'object' && 'message' in supplied ? supplied.message : undefined;
    // Account requests never enter general error reporting with their request body.
    response.status(status).json({
      statusCode: status,
      message:
        status >= 500 && message !== 'The pairing code could not be saved. Check server storage permissions and free space.'
          ? 'Pairing was not confirmed. Check cluster status on both servers before reconnecting.'
          : message,
    });
  }
}

@Controller('cluster/pairing')
@UseFilters(ClusterPairingExceptionFilter)
export class ClusterPairingController {
  constructor(
    private readonly pairing: ClusterPairingService,
    private readonly config: ConfigurationService,
  ) {}

  private ingress(request: Request) {
    try {
      assertPrivateTransferPeer(request, this.config.get('traefik').trustedProxyIps);
    } catch {
      throw new ForbiddenException('Secure pairing needs a private HTTPS connection and trusted proxy setup on this server.');
    }
  }

  private actor(request: Request) {
    this.ingress(request);
    const session: unknown = request.cookies?.[SESSION_COOKIE_NAME];
    if (request.authMethod !== 'session' || !request.user?.operator || typeof session !== 'string' || !/^[a-f0-9-]{36}$/.test(session))
      throw new ForbiddenException('An operator session is required for pairing.');
    return { userId: request.user.id, session: digest(session) };
  }

  private serverChannel(request: Request) {
    this.ingress(request);
    if (request.headers.origin || request.headers.cookie || request.headers['sec-fetch-site'])
      throw new ForbiddenException('Use HTTPS for account pairing.');
  }

  @Get('access')
  @UseGuards(AuthGuard, HostUpdatesGuard)
  access(@Req() request: Request) {
    try {
      this.ingress(request);
      return { available: true };
    } catch {
      return { available: false, message: 'Secure pairing needs a private HTTPS connection and trusted proxy setup on this server.' };
    }
  }

  @Post('connect')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @UseGuards(AuthGuard, HostUpdatesGuard)
  connect(@Req() request: Request, @Body() body: Record<string, unknown>) {
    return this.pairing.connect(pairingInput(request, body), this.actor(request));
  }

  @Post('complete')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @UseGuards(AuthGuard, HostUpdatesGuard)
  complete(@Req() request: Request, @Body() body: Record<string, unknown>) {
    return this.pairing.complete(pairingInput(request, body), this.actor(request));
  }

  @Post('challenge')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  challenge(@Req() request: Request, @Body() body: Record<string, unknown>) {
    this.serverChannel(request);
    return this.pairing.challenge(pairingInput(request, body));
  }

  @Post('authorize')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  authorize(@Req() request: Request, @Body() body: Record<string, unknown>) {
    this.serverChannel(request);
    return this.pairing.authorize(pairingInput(request, body));
  }
}
