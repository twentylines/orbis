import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';

@Injectable()
export class HostUpdatesGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (request.authMethod !== 'session' || request.user?.operator !== true) {
      throw new ForbiddenException('An operator session is required for host updates.');
    }
    return true;
  }
}
