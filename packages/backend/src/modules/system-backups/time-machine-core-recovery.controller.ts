import { BadRequestException, Body, Controller, Get, Header, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { timeMachineIdSchema } from '@runtipi/common/schemas/time-machine';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { backupOperator } from './backup-access';
import { CoreCaptureRecoveryService } from './time-machine-core-recovery.service';

@Controller('system-backups/time-machine/recovery')
@UseGuards(AuthGuard)
export class CoreCaptureRecoveryController {
  constructor(private readonly recovery: CoreCaptureRecoveryService) {}

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  status(@Req() request: Request, @Param('id') id: string) {
    const owner = backupOperator(request);
    if (!timeMachineIdSchema.allows(id)) throw new BadRequestException('Choose a valid snapshot.');
    return this.recovery.status(id, owner);
  }

  @Post(':id/continue')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  continue(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const owner = backupOperator(request);
    if (
      !timeMachineIdSchema.allows(id) ||
      (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0))
    )
      throw new BadRequestException('Choose a valid snapshot recovery.');
    return this.recovery.continue(id, owner);
  }
}
