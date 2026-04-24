import { LoggerService } from '@/core/logger/logger.service';
import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const firstHeaderValue = (value: string | undefined) => value?.split(',')[0]?.trim();

const getRequestOrigin = (request: Request) => {
  const host = firstHeaderValue((request.headers['x-forwarded-host'] as string) ?? request.headers.host)?.toLowerCase();
  const proto = firstHeaderValue(request.headers['x-forwarded-proto'] as string)?.toLowerCase() ?? request.protocol;

  if (!host || !proto) {
    return undefined;
  }

  try {
    return new URL('/', `${proto}://${host}`).origin.toLowerCase();
  } catch {
    return undefined;
  }
};

const headerOrigin = (value: string | undefined) => {
  if (!value) return undefined;

  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return undefined;
  }
};

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly logger: LoggerService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest() as Request;

    this.logger.debug('HTTP request', request.method, request.url);

    if (!request.user) {
      throw new UnauthorizedException();
    }

    if (request.authMethod === 'forward-auth') {
      throw new UnauthorizedException();
    }

    if (request.authMethod === 'session' && UNSAFE_METHODS.has(request.method)) {
      const requestOrigin = getRequestOrigin(request);
      const origin = headerOrigin(request.headers.origin);
      const refererOrigin = headerOrigin(request.headers.referer);

      if (!requestOrigin || (origin !== requestOrigin && refererOrigin !== requestOrigin)) {
        throw new ForbiddenException('Invalid request origin');
      }
    }

    return true;
  }
}
