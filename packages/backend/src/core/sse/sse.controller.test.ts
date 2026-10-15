import { AuthGuard } from '@/modules/auth/auth.guard';
import { type CallHandler, type ExecutionContext, type INestApplication, type NestMiddleware } from '@nestjs/common';
import { APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ArkValidationPipe } from 'nestjs-arktype';
import { of } from 'rxjs';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { LoggerService } from '../logger/logger.service';
import { SSEController } from './sse.controller';
import { SSEService } from './sse.service';

describe('SSEController log query validation', () => {
  let app: INestApplication;
  const service = mock<SSEService>();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SSEController],
      providers: [
        AuthGuard,
        { provide: APP_PIPE, useClass: ArkValidationPipe },
        // Production's Sentry interceptor defers pipes into the SSE observable.
        { provide: APP_INTERCEPTOR, useValue: { intercept: (_context: ExecutionContext, next: CallHandler) => next.handle() } },
        { provide: LoggerService, useValue: mock<LoggerService>() },
        { provide: SSEService, useValue: service },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(((req, _res, next) => {
      if (req.headers.authorization === 'Bearer test') req.user = { id: 1 };
      next();
    }) as NestMiddleware['use']);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    service.getLogStreamObservable.mockReset();
    service.getLogStreamObservable.mockResolvedValue(of({ data: { lines: ['fixture log'] } }));
    service.getTopicObservable.mockReset();
    service.getTopicObservable.mockReturnValue(of({ data: { event: 'status_change', appUrn: 'media:test' } }));
  });

  const get = (path: string) => request(app.getHttpServer()).get(path).set('Authorization', 'Bearer test').timeout(3000);

  it.each(['/sse/app', '/sse/app-logs?appUrn=media:test', '/sse/runtipi-logs'])('requires authentication before accessing %s', async (path) => {
    const response = await request(app.getHttpServer()).get(path).timeout(3000);
    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toContain('application/json');
    expect(service.getLogStreamObservable).not.toHaveBeenCalled();
    expect(service.getTopicObservable).not.toHaveBeenCalled();
  });

  it.each([
    { path: '/sse/app-logs?appUrn=media:test', args: ['app-logs', 300, 'media:test'] },
    { path: '/sse/runtipi-logs', args: ['runtipi-logs', 300] },
  ])('defaults to 300 lines for $path', async ({ path, args }) => {
    const response = await get(path);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.text).toContain('data: {"lines":["fixture log"]}');
    expect(service.getLogStreamObservable).toHaveBeenCalledExactlyOnceWith(...args);
  });

  it.each([
    { path: '/sse/app-logs?appUrn=media:test', topic: 'app-logs', urn: 'media:test', maxLines: 1 },
    { path: '/sse/app-logs?appUrn=media:test', topic: 'app-logs', urn: 'media:test', maxLines: 1000 },
    { path: '/sse/runtipi-logs', topic: 'runtipi-logs', maxLines: 1 },
    { path: '/sse/runtipi-logs', topic: 'runtipi-logs', maxLines: 1000 },
  ])('converts maxLines=$maxLines to a number for $topic', async ({ path, topic, urn, maxLines }) => {
    const response = await get(`${path}${path.includes('?') ? '&' : '?'}maxLines=${maxLines}`);
    expect(response.status).toBe(200);
    const args = urn ? [topic, maxLines, urn] : [topic, maxLines];
    expect(service.getLogStreamObservable).toHaveBeenCalledExactlyOnceWith(...args);
    expect(typeof service.getLogStreamObservable.mock.calls[0]?.[1]).toBe('number');
  });

  for (const path of ['/sse/app-logs?appUrn=media:test', '/sse/runtipi-logs']) {
    it.each(['0', '-1', '1001', '1.5', 'NaN', '1&maxLines=1000'])(`rejects maxLines=%s before opening ${path}`, async (value) => {
      const response = await get(`${path}${path.includes('?') ? '&' : '?'}maxLines=${value}`);
      expect(service.getLogStreamObservable).not.toHaveBeenCalled();
      expect(response.status, `${response.headers['content-type']}: ${response.text}`).toBe(400);
      expect(response.headers['content-type']).toContain('application/json');
    });
  }

  it.each(['media:_user', 'My-App_1:store-2_test'])('accepts a valid namespaced app URN %s', async (urn) => {
    const response = await get(`/sse/app-logs?appUrn=${encodeURIComponent(urn)}`);
    expect(response.status).toBe(200);
    expect(service.getLogStreamObservable).toHaveBeenCalledExactlyOnceWith('app-logs', 300, urn);
  });

  it.each([
    '',
    '?maxLines=300',
    '?appUrn=',
    '?appUrn=media',
    '?appUrn=media:',
    '?appUrn=:test',
    '?appUrn=media:test:extra',
    '?appUrn=..%2Fmedia:test',
    '?appUrn=media:test&appUrn=other:test',
  ])('rejects missing or malformed app URNs %s before opening a log reader', async (query) => {
    const response = await get(`/sse/app-logs${query}`);
    expect(service.getLogStreamObservable).not.toHaveBeenCalled();
    expect(response.status, `${response.headers['content-type']}: ${response.text}`).toBe(400);
    expect(response.headers['content-type']).toContain('application/json');
  });
});
