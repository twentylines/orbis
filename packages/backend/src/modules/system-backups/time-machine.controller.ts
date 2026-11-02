import { Body, Controller, Get, Header, HttpCode, Param, Post, Put, Req, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { timeMachineHashSchema, timeMachineIdSchema } from '@runtipi/common/schemas/time-machine';
import { timeMachineRestoreActivateSchema } from '@runtipi/common/schemas/time-machine-restore';
import { type } from 'arktype';
import { AuthGuard } from '../auth/auth.guard';
import { backupCredentials, backupOperator, optionalBackupCredentials } from './backup-access';
import { TimeMachineService } from './time-machine.service';
import { timeMachineConflict } from './time-machine-policy';

function object(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw timeMachineConflict('invalid-request');
  return body as Record<string, unknown>;
}
@Controller('system-backups/time-machine')
@UseGuards(AuthGuard)
export class TimeMachineController {
  constructor(private readonly timeMachine: TimeMachineService) {}
  @Get('capabilities')
  capabilities(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    backupOperator(request);
    response.setHeader('Cache-Control', 'no-store');
    return this.timeMachine.capabilities();
  }
  @Get('storage')
  storage(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    backupOperator(request);
    response.setHeader('Cache-Control', 'no-store');
    return this.timeMachine.storage();
  }
  @Get('preferences')
  preferences(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    backupOperator(request);
    response.setHeader('Cache-Control', 'no-store');
    return this.timeMachine.preferences();
  }
  @Put('preferences')
  updatePreferences(@Req() request: Request, @Body() body: unknown) {
    backupOperator(request);
    return this.timeMachine.updatePreferences(body);
  }
  @Get('activity')
  activity(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.timeMachine.activity(backupOperator(request));
  }
  @Get('points')
  list(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.timeMachine.list(backupOperator(request));
  }
  @Get('points/:id')
  inspect(@Req() request: Request, @Param('id') id: string, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.timeMachine.inspect(id, backupOperator(request));
  }
  @Get('points/:id/icons/:identity')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async appIcons(
    @Req() request: Request,
    @Param('id') id: string,
    @Param('identity') identity: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const data = await this.timeMachine.appIcons(id, backupOperator(request), identity);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    return new StreamableFile(data, { type: 'application/json', length: data.length, disposition: 'inline; filename="historical-app-icons"' });
  }
  @Get('points/:id/assets/:identity')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async wallpaper(
    @Req() request: Request,
    @Param('id') id: string,
    @Param('identity') identity: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.timeMachine.wallpaper(id, backupOperator(request), identity);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    return new StreamableFile(result.data, { type: result.mime, length: result.data.length, disposition: 'inline; filename="historical-wallpaper"' });
  }
  @Post('captures')
  @HttpCode(202)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async capture(@Req() request: Request, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const owner = backupOperator(request);
    const { label, experimentalAcknowledged, ...credentials } = object(body);
    if (Object.keys(credentials).some((key) => !['password', 'totpCode'].includes(key))) throw timeMachineConflict('invalid-request');
    const point = await this.timeMachine.capture(owner, credentials, {
      label,
      ...(experimentalAcknowledged !== undefined ? { experimentalAcknowledged } : {}),
    });
    this.launchAfterResponse(point.id, owner, response);
    return point;
  }
  private launchAfterResponse(id: string, owner: number, response: Response) {
    let launched = false;
    const launch = () => {
      if (launched) return;
      launched = true;
      response.removeListener('finish', launch);
      response.removeListener('close', launch);
      void this.timeMachine.launchCapture(id, owner);
    };
    response.once('finish', launch);
    response.once('close', launch);
    if (response.writableFinished || response.destroyed) launch();
  }
  @Post('onboarding-captures')
  @HttpCode(202)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async onboardingCapture(@Req() request: Request, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const owner = backupOperator(request);
    const input = object(body);
    const { attemptId, label } = input;
    if (Object.keys(input).some((key) => key !== 'attemptId' && key !== 'label')) throw timeMachineConflict('invalid-request');
    if (!timeMachineIdSchema.allows(attemptId)) throw timeMachineConflict('invalid-request');
    const point = await this.timeMachine.beginOnboardingCapture(owner, attemptId, label);
    this.launchAfterResponse(point.id, owner, response);
    return point;
  }
  @Get('onboarding-captures/:attemptId')
  @Header('Cache-Control', 'no-store')
  onboardingCaptureStatus(@Req() request: Request, @Param('attemptId') attemptId: string) {
    return this.timeMachine.onboardingCapture(attemptId, backupOperator(request));
  }
  @Post('points/:id/cancel')
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  cancel(@Req() request: Request, @Param('id') id: string, @Body() body: unknown = {}) {
    const owner = backupOperator(request);
    if (Object.keys(object(body)).length) throw timeMachineConflict('invalid-request');
    return this.timeMachine.cancelCapture(id, owner);
  }
  @Post('points/:id/remove')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  remove(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.timeMachine.removeForSession(id, backupOperator(request), request, optionalBackupCredentials(body));
  }
  @Post('points/:id/restore-review')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  review(@Req() request: Request, @Param('id') id: string, @Body() body: unknown = {}) {
    const owner = backupOperator(request);
    if (Object.keys(object(body)).length) throw timeMachineConflict('invalid-request');
    return this.timeMachine.restoreReview(id, owner);
  }
  @Get('points/:id/restore-review')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  reviewStatus(@Req() request: Request, @Param('id') id: string, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.timeMachine.readRestoreReview(id, backupOperator(request));
  }
  @Get('points/:id/restore-admission')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  admissionStatus(@Req() request: Request, @Param('id') id: string, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.timeMachine.restoreAdmissionStatus(id, backupOperator(request));
  }
  @Post('points/:id/restore-auth/options')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  authOptions(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const owner = backupOperator(request);
    const value = object(body);
    if (
      Object.keys(value).some((key) => !['reviewId', 'method'].includes(key)) ||
      !timeMachineIdSchema.allows(value.reviewId) ||
      value.method !== 'passkey'
    )
      throw timeMachineConflict('invalid-request');
    return this.timeMachine.restoreAuthOptions(id, owner, request, value.reviewId);
  }
  @Post('points/:id/restore-auth/verify')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  authVerify(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const owner = backupOperator(request);
    const { reviewId, method, ...proof } = object(body);
    if (!timeMachineIdSchema.allows(reviewId) || (method !== 'password' && method !== 'passkey')) throw timeMachineConflict('invalid-request');
    return this.timeMachine.restoreAuthVerify(id, owner, request, reviewId, method, proof);
  }
  @Post('points/:id/recover')
  @Header('Cache-Control', 'no-store')
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  recover(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const owner = backupOperator(request);
    const { restoreId, ...credentials } = object(body);
    if (!timeMachineIdSchema.allows(restoreId)) throw timeMachineConflict('invalid-request');
    return this.timeMachine.recoverAuthorized(id, owner, request, restoreId, backupCredentials(credentials));
  }
  @Post('points/:id/activate')
  @Header('Cache-Control', 'no-store')
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  activate(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const owner = backupOperator(request);
    const value = object(body);
    if ('reviewId' in value || 'grantId' in value) {
      const activation = timeMachineRestoreActivateSchema(value);
      if (activation instanceof type.errors) throw timeMachineConflict('invalid-request');
      return this.timeMachine.activateAuthorized(id, owner, request, activation.reviewId, activation.grantId, activation.manifestSha256);
    }
    const { manifestSha256, confirmation, ...credentials } = value;
    if (!timeMachineHashSchema.allows(manifestSha256) || confirmation !== 'replace-server') throw timeMachineConflict('invalid-request');
    return this.timeMachine.activate(id, owner, backupCredentials(credentials), manifestSha256);
  }
}
