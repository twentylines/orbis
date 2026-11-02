import { Body, Controller, Get, Header, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { AccountSecurityService } from './account-security.service';
import { backupCredentials, backupOperator } from '../system-backups/backup-access';

@Controller('account-security')
@UseGuards(AuthGuard)
export class AccountSecurityController {
  constructor(
    private readonly security: AccountSecurityService,
    private readonly auth: AuthService,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  read(@Req() request: Request) {
    return this.security.read(backupOperator(request));
  }
  @Put()
  update(@Req() request: Request, @Body() body: unknown) {
    const ownerId = backupOperator(request);
    const value = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const { password, totpCode, ...policy } = value;
    return this.security.update(ownerId, policy, () => {
      const credentials = backupCredentials({ password, ...(totpCode !== undefined ? { totpCode } : {}) });
      return this.auth.verifySensitiveAction(ownerId, credentials.password, credentials.totpCode);
    });
  }
}
