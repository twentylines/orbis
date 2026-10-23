import { castAppUrn } from '@/common/helpers/app-helpers';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { DesktopPreferencesService } from '@/modules/desktop-preferences/desktop-preferences.service';
import { BadRequestException, type CanActivate, Controller, type MessageEvent, Query, Req, Sse, UseGuards } from '@nestjs/common';
import { type } from 'arktype';
import type { Request } from 'express';
import { map, merge, Observable } from 'rxjs';
import { StreamAppLogsQueryDto, StreamRuntipiLogsQueryDto, streamAppQuerySchema, streamRuntipiQuerySchema } from './dto/sse.dto';
import { SSEService } from './sse.service';

// Pipes run inside interceptor observables; SSE would commit HTTP 200 before their errors.
const validateLogQuery = (validate: (query: unknown) => unknown): CanActivate => ({
  canActivate(context) {
    const result = validate(context.switchToHttp().getRequest<Request>().query);
    if (result instanceof type.errors) throw new BadRequestException(result.summary);
    return true;
  },
});

@UseGuards(AuthGuard)
@Controller('sse')
export class SSEController {
  constructor(
    private readonly sseService: SSEService,
    private readonly preferences: DesktopPreferencesService,
  ) {}

  @Sse('app')
  appEvents(@Req() request: Request): Observable<MessageEvent> {
    const observable = this.sseService.getTopicObservable('app');
    if (!request.user?.id) return observable;
    return merge(observable, this.preferences.changesFor(request.user.id).pipe(map((event) => ({ ...event, type: 'desktop-preferences' }))));
  }

  @Sse('app-logs')
  @UseGuards(validateLogQuery(streamAppQuerySchema))
  async appLogsEvents(@Query() query: StreamAppLogsQueryDto): Promise<Observable<MessageEvent>> {
    const { appUrn, maxLines = 300 } = query;

    return this.sseService.getLogStreamObservable('app-logs', maxLines, castAppUrn(appUrn));
  }

  @Sse('runtipi-logs')
  @UseGuards(validateLogQuery(streamRuntipiQuerySchema))
  async runtipiLogsEvents(@Query() query: StreamRuntipiLogsQueryDto): Promise<Observable<MessageEvent>> {
    const { maxLines = 300 } = query;

    return this.sseService.getLogStreamObservable('runtipi-logs', maxLines);
  }
}
