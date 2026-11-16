import { Body, Controller, Get, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { timeMachineIdSchema } from '@runtipi/common/schemas/time-machine';
import { AuthGuard } from '../auth/auth.guard';
import { backupCredentials, backupOperator } from './backup-access';
import { TimeMachineCoreReconciliationService } from './time-machine-core-reconciliation.service';
import { timeMachineConflict } from './time-machine-policy';

@Controller('system-backups/time-machine')
@UseGuards(AuthGuard)
export class TimeMachineCoreReconciliationController {
  constructor(private readonly reconciliations: TimeMachineCoreReconciliationService) {}

  @Post('points/:id/core-reconciliations')
  @HttpCode(202)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  prepare(@Req() request: Request, @Param('id') id: string, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const owner = backupOperator(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw timeMachineConflict('invalid-request');
    const { requestId, sourcePreparationRequestId, destinationPointId, destinationPreparationRequestId, action, ...credentials } = body as Record<
      string,
      unknown
    >;
    if (
      !timeMachineIdSchema.allows(requestId) ||
      !timeMachineIdSchema.allows(sourcePreparationRequestId) ||
      !timeMachineIdSchema.allows(destinationPointId) ||
      !timeMachineIdSchema.allows(destinationPreparationRequestId) ||
      action !== 'prepare-isolated-reconciled-target'
    )
      throw timeMachineConflict('invalid-request');
    const checked = backupCredentials(credentials);
    response.setHeader('Cache-Control', 'no-store');
    return this.reconciliations.prepare(id, owner, request, checked, {
      requestId,
      sourcePreparationRequestId,
      destinationPointId,
      destinationPreparationRequestId,
      action,
    });
  }

  @Get('points/:id/core-reconciliations/:requestId')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  status(@Req() request: Request, @Param('id') id: string, @Param('requestId') requestId: string, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.reconciliations.status(id, backupOperator(request), request, requestId);
  }

  @Post('points/:id/core-reconciliations/:requestId/reviews')
  @HttpCode(200)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  review(
    @Req() request: Request,
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const owner = backupOperator(request);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'action,reviewRequestId')
      throw timeMachineConflict('invalid-request');
    const { action, reviewRequestId } = body as Record<string, unknown>;
    if (action !== 'review-current-installation-core-restoration' || !timeMachineIdSchema.allows(reviewRequestId))
      throw timeMachineConflict('invalid-request');
    response.setHeader('Cache-Control', 'no-store');
    return this.reconciliations.restorationReview(id, owner, request, requestId, reviewRequestId, 'review');
  }

  @Get('points/:id/core-reconciliations/:requestId/reviews/:reviewRequestId')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  reviewStatus(
    @Req() request: Request,
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Param('reviewRequestId') reviewRequestId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.reconciliations.restorationReview(id, backupOperator(request), request, requestId, reviewRequestId, 'status');
  }
}
