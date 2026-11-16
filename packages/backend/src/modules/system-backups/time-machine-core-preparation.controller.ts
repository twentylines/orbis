import { Body, Controller, Get, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { timeMachineHashSchema, timeMachineIdSchema } from '@runtipi/common/schemas/time-machine';
import { AuthGuard } from '../auth/auth.guard';
import { backupCredentials, backupOperator } from './backup-access';
import { TimeMachineCorePreparationService } from './time-machine-core-preparation.service';
import { timeMachineConflict } from './time-machine-policy';

function object(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw timeMachineConflict('invalid-request');
  return body as Record<string, unknown>;
}

@Controller('system-backups/time-machine')
@UseGuards(AuthGuard)
export class TimeMachineCorePreparationController {
  constructor(private readonly preparations: TimeMachineCorePreparationService) {}

  @Post('points/:id/core-preparations')
  @HttpCode(202)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  prepare(@Req() request: Request, @Param('id') id: string, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const owner = backupOperator(request);
    const value = object(body);
    if (Object.keys(value).join(',') !== 'requestId' || !timeMachineIdSchema.allows(value.requestId)) throw timeMachineConflict('invalid-request');
    response.setHeader('Cache-Control', 'no-store');
    return this.preparations.prepare(id, owner, request, value.requestId);
  }

  @Get('points/:id/core-preparations/:requestId')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  status(@Req() request: Request, @Param('id') id: string, @Param('requestId') requestId: string, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.preparations.status(id, backupOperator(request), request, requestId);
  }

  @Post('points/:id/core-preparations/:requestId/approve')
  @HttpCode(202)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  approve(
    @Req() request: Request,
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const owner = backupOperator(request);
    const { reviewSha256, approvalNonce, executionConsent, ...credentials } = object(body);
    if (!timeMachineHashSchema.allows(reviewSha256) || !timeMachineHashSchema.allows(approvalNonce)) throw timeMachineConflict('invalid-request');
    const checked = backupCredentials(credentials);
    response.setHeader('Cache-Control', 'no-store');
    return this.preparations.approve(id, owner, request, requestId, checked, { reviewSha256, approvalNonce, executionConsent });
  }

  @Post('points/:id/core-preparations/:requestId/target')
  @HttpCode(202)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  target(
    @Req() request: Request,
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const owner = backupOperator(request);
    const value = object(body);
    if (Object.keys(value).join(',') !== 'action' || value.action !== 'prepare-isolated-clean-target') throw timeMachineConflict('invalid-request');
    response.setHeader('Cache-Control', 'no-store');
    return this.preparations.prepareTarget(id, owner, request, requestId, value.action);
  }
}
