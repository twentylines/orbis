import { castAppUrn } from '@/common/helpers/app-helpers';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { DesktopPreferencesService } from '@/modules/desktop-preferences/desktop-preferences.service';
import { BadRequestException, type CanActivate, Controller, type MessageEvent, Query, Req, Res, Sse, UseGuards } from '@nestjs/common';
import { type } from 'arktype';
import type { Request, Response } from 'express';
import { defer, EMPTY, finalize, map, merge, Observable } from 'rxjs';
import { StreamAppLogsQueryDto, StreamRuntipiLogsQueryDto, streamAppQuerySchema, streamRuntipiQuerySchema } from './dto/sse.dto';
import { SSEService } from './sse.service';
import { MonitoringActivityService } from '../monitoring/monitoring-activity.service';
import { observeClientStatusChanges } from '@/common/restoration-status';
import { TasksService } from '@/modules/tasks/tasks.service';
import { CacheService } from '../cache/cache.service';
import { SESSION_COOKIE_NAME } from '@/common/constants';
import { prepareStreamResponse, requestStream } from './session-stream';

// Pipes run inside interceptor observables; SSE would commit HTTP 200 before their errors.
const validateLogQuery = (validate: (query: unknown) => unknown): CanActivate => ({
  canActivate(context) {
    const result = validate(context.switchToHttp().getRequest<Request>().query);
    if (result instanceof type.errors) throw new BadRequestException(result.summary);
    return true;
  },
});

const prepareTransport: CanActivate = {
  canActivate(context) {
    prepareStreamResponse(context.switchToHttp().getResponse<Response>());
    return true;
  },
};

@UseGuards(AuthGuard, prepareTransport)
@Controller('sse')
export class SSEController {
  constructor(
    private readonly sseService: SSEService,
    private readonly preferences: DesktopPreferencesService,
    private readonly activity: MonitoringActivityService,
    private readonly tasks: TasksService,
    private readonly cache: CacheService,
  ) {}

  private liveSession(request: Request, source: Observable<MessageEvent>, response?: Response) {
    const session = request.cookies?.[SESSION_COOKIE_NAME];
    const userId = request.user?.id;
    const authorize =
      request.authMethod === 'session'
        ? () => typeof session === 'string' && Boolean(userId) && this.cache.get(`session:${session}`) === String(userId)
        : undefined;
    return requestStream(source, request, response, authorize, this.sseService.shutdownEvents());
  }

  @Sse('app')
  appEvents(@Req() request: Request, @Query('client') client?: string, @Res({ passthrough: true }) response?: Response): Observable<MessageEvent> {
    const observable = this.sseService.getTopicObservable('app');
    if (!request.user?.id) return observable;
    const stream = merge(
      observable,
      this.preferences.changesFor(request.user.id).pipe(map((event) => ({ ...event, type: 'desktop-preferences' }))),
      client === '1' ? observeClientStatusChanges().pipe(map(() => ({ data: { changed: true }, type: 'client-status' }))) : EMPTY,
      client === '1' ? this.tasks.changesForClient().pipe(map(() => ({ data: { changed: true }, type: 'tasks-changed' }))) : EMPTY,
    );
    return this.liveSession(
      request,
      defer(() => {
        const disconnect = this.activity.connect();
        return stream.pipe(finalize(disconnect));
      }),
      response,
    );
  }

  @Sse('app-logs')
  @UseGuards(validateLogQuery(streamAppQuerySchema))
  async appLogsEvents(
    @Req() request: Request,
    @Query() query: StreamAppLogsQueryDto,
    @Res({ passthrough: true }) response?: Response,
  ): Promise<Observable<MessageEvent>> {
    const { appUrn, maxLines = 300 } = query;

    return this.liveSession(request, await this.sseService.getLogStreamObservable('app-logs', maxLines, castAppUrn(appUrn)), response);
  }

  @Sse('runtipi-logs')
  @UseGuards(validateLogQuery(streamRuntipiQuerySchema))
  async runtipiLogsEvents(
    @Req() request: Request,
    @Query() query: StreamRuntipiLogsQueryDto,
    @Res({ passthrough: true }) response?: Response,
  ): Promise<Observable<MessageEvent>> {
    const { maxLines = 300 } = query;

    return this.liveSession(request, await this.sseService.getLogStreamObservable('runtipi-logs', maxLines), response);
  }
}
