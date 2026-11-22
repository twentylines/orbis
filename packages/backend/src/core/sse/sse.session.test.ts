import { DatabaseSync } from 'node:sqlite';
import { EventEmitter, once } from 'node:events';
import { Transform, Writable } from 'node:stream';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { type CanActivate, type MessageEvent, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RouterExecutionContext } from '@nestjs/core/router/router-execution-context';
import { RouteParamsFactory } from '@nestjs/core/router/route-params-factory';
import { GuardsConsumer } from '@nestjs/core/guards/guards-consumer';
import { PipesConsumer } from '@nestjs/core/pipes/pipes-consumer';
import { InterceptorsConsumer } from '@nestjs/core/interceptors/interceptors-consumer';
import { LoggerService } from '../logger/logger.service';
import { DockerService } from '@/modules/docker/docker.service';
import { SESSION_COOKIE_NAME } from '@/common/constants';
import { CacheService } from '@/core/cache/cache.service';
import { SessionManager } from '@/modules/auth/session.manager';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { BackupMaintenanceInterceptor } from '@/common/backup-maintenance';
import { DesktopPreferencesService } from '@/modules/desktop-preferences/desktop-preferences.service';
import { TasksService } from '@/modules/tasks/tasks.service';
import { EMPTY, Subject } from 'rxjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { MonitoringActivityService } from '../monitoring/monitoring-activity.service';
import { SSEController } from './sse.controller';
import { SSEService } from './sse.service';
import { prepareStreamResponse } from './session-stream';

let db: DatabaseSync;
let cache: CacheService;
let sessions: SessionManager;
let events: Subject<MessageEvent>;
let controller: SSEController;
let shutdown: Subject<void>;

beforeEach(() => {
  vi.useFakeTimers();
  db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE keyv (key TEXT PRIMARY KEY, value TEXT)');
  cache = Object.create(CacheService.prototype) as CacheService;
  Object.assign(cache, { db });
  sessions = new SessionManager(cache);
  events = new Subject();
  shutdown = new Subject();
  const service = mock<SSEService>();
  service.shutdownEvents.mockReturnValue(shutdown);
  service.getTopicObservable.mockReturnValue(events);
  const preferences = mock<DesktopPreferencesService>();
  preferences.changesFor.mockReturnValue(EMPTY);
  const tasks = mock<TasksService>();
  tasks.changesForClient.mockReturnValue(EMPTY);
  controller = new SSEController(service, preferences, new MonitoringActivityService(), tasks, cache);
});

afterEach(() => {
  events.complete();
  shutdown.complete();
  vi.restoreAllMocks();
  vi.useRealTimers();
  db.close();
});

it('stops delivery and closes the existing stream when its actual session is deleted', async () => {
  const sessionId = await sessions.createSession(1);
  const received: unknown[] = [];
  const complete = vi.fn();
  const subscription = controller
    .appEvents({ user: { id: 1 }, authMethod: 'session', cookies: { [SESSION_COOKIE_NAME]: sessionId } } as never)
    .subscribe({ next: (event) => received.push(event), complete });
  events.next({ data: { event: 'before' } });
  await sessions.deleteSession(sessionId);
  events.next({ data: { event: 'after' } });
  expect(received).toEqual([{ data: { event: 'before' } }]);
  expect(subscription.closed).toBe(true);
  expect(complete).toHaveBeenCalledOnce();
});

const browser = (sessionId: string, userId = 1) =>
  ({ user: { id: userId }, authMethod: 'session', cookies: { [SESSION_COOKIE_NAME]: sessionId } }) as never;

it('revokes all account streams without disconnecting a different account', async () => {
  const first = await sessions.createSession(1);
  const second = await sessions.createSession(1);
  const other = await sessions.createSession(2);
  const subscriptions = [first, second, other].map((session, index) => controller.appEvents(browser(session, index === 2 ? 2 : 1)).subscribe());
  await sessions.destroyAllSessionsByUserId(1);
  events.next({ data: { changed: true } });
  expect(subscriptions.map((subscription) => subscription.closed)).toEqual([true, true, false]);
  for (const subscription of subscriptions) subscription.unsubscribe();
});

it.each(['delete', 'clear', 'expiry'] as const)('releases an idle revoked stream within one second after %s', async (action) => {
  const session = await sessions.createSession(1);
  const complete = vi.fn();
  const subscription = controller.appEvents(browser(session)).subscribe({ complete });
  if (action === 'delete') await sessions.deleteSession(session);
  if (action === 'clear') cache.clear();
  if (action === 'expiry') cache.set(`session:${session}`, '1', 0.5);
  await vi.advanceTimersByTimeAsync(1000);
  expect(subscription.closed).toBe(true);
  expect(complete).toHaveBeenCalledOnce();
  expect(events.observed).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it('does not subscribe a replaced-account or already-revoked session', async () => {
  const session = await sessions.createSession(2);
  const complete = vi.fn();
  controller.appEvents(browser(session)).subscribe({ complete });
  expect(complete).toHaveBeenCalledOnce();
  expect(events.observed).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it('stops silently when the session store becomes unreadable', async () => {
  const session = await sessions.createSession(1);
  const next = vi.fn();
  const subscription = controller.appEvents(browser(session)).subscribe({ next });
  vi.spyOn(cache, 'get').mockImplementation(() => {
    throw new Error('unreadable');
  });
  events.next({ data: { private: true } });
  expect(next).not.toHaveBeenCalled();
  expect(subscription.closed).toBe(true);
});

it('releases its check timer and monitoring demand on normal unsubscribe', async () => {
  const session = await sessions.createSession(1);
  const subscription = controller.appEvents(browser(session)).subscribe();
  expect(vi.getTimerCount()).toBe(1);
  subscription.unsubscribe();
  expect(events.observed).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['app', 'system'] as const)('does not acquire %s logs when revoked before subscription', async (kind) => {
  const session = await sessions.createSession(1);
  const docker = mock<DockerService>();
  const service = new SSEService(mock<LoggerService>(), docker);
  const preferences = mock<DesktopPreferencesService>();
  const live = new SSEController(service, preferences, new MonitoringActivityService(), mock<TasksService>(), cache);
  try {
    const observable =
      kind === 'app'
        ? await live.appLogsEvents(browser(session), { appUrn: 'media:test', maxLines: 10 } as never)
        : await live.runtipiLogsEvents(browser(session), { maxLines: 10 });
    await sessions.deleteSession(session);
    const complete = vi.fn();
    observable.subscribe({ complete });
    expect(complete).toHaveBeenCalledOnce();
    expect(docker.getLogsStream).not.toHaveBeenCalled();
  } finally {
    service.onModuleDestroy();
  }
});

it.each(['ready', 'pending'] as const)('releases a %s log reader after actual session revocation', async (state) => {
  const session = await sessions.createSession(1);
  const docker = mock<DockerService>();
  const source = new EventEmitter();
  const kill = vi.fn();
  const reader = { on: source.on.bind(source), kill } as never;
  let resolve!: (reader: Awaited<ReturnType<DockerService['getLogsStream']>>) => void;
  if (state === 'ready') docker.getLogsStream.mockResolvedValue(reader);
  else
    docker.getLogsStream.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
  const service = new SSEService(mock<LoggerService>(), docker);
  const live = new SSEController(service, mock<DesktopPreferencesService>(), new MonitoringActivityService(), mock<TasksService>(), cache);
  try {
    const observable = await live.runtipiLogsEvents(browser(session), { maxLines: 10 });
    const subscription = observable.subscribe();
    await Promise.resolve();
    await sessions.deleteSession(session);
    await vi.advanceTimersByTimeAsync(1000);
    expect(subscription.closed).toBe(true);
    if (state === 'pending') {
      resolve(reader);
      await Promise.resolve();
    }
    expect(kill).toHaveBeenCalledOnce();
    service.onModuleDestroy();
    expect(kill).toHaveBeenCalledOnce();
  } finally {
    service.onModuleDestroy();
  }
});

class SlowResponse extends Writable {
  body = '';
  statusCode = 200;
  stalled = false;
  release?: () => void;
  constructor(highWaterMark: number) {
    super({ highWaterMark });
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) {
    this.body += chunk.toString();
    if (this.stalled) this.release = done;
    else done();
  }
  unblock() {
    this.stalled = false;
    this.release?.();
    this.release = undefined;
  }
}

async function stalledTransport(session: string, highWaterMark = 1, authMethod: 'session' | 'cli' = 'session') {
  const response = new SlowResponse(highWaterMark);
  let framing: Transform | undefined;
  response.once('pipe', (stream) => {
    if (stream instanceof Transform) framing = stream;
  });
  const request = Object.assign(new EventEmitter(), {
    method: 'GET',
    url: '/sse/app',
    query: {},
    user: { id: 1 },
    authMethod,
    cookies: { [SESSION_COOKIE_NAME]: session },
    destroyed: false,
    destroy(this: EventEmitter & { destroyed: boolean }) {
      if (!this.destroyed) {
        this.destroyed = true;
        this.emit('close');
      }
      return this;
    },
  });
  const write = response.write;
  const end = response.end;
  const guards = (Reflect.getMetadata(GUARDS_METADATA, SSEController) as (CanActivate | typeof AuthGuard)[]).map((guard) =>
    guard === AuthGuard ? new AuthGuard(mock<LoggerService>()) : guard,
  );
  const execution = new RouterExecutionContext(
    new RouteParamsFactory(),
    { create: () => [], setModuleContext() {}, createConcreteContext: () => [] } as never,
    new PipesConsumer(),
    { create: () => guards } as never,
    new GuardsConsumer(),
    { create: () => [new BackupMaintenanceInterceptor()] } as never,
    new InterceptorsConsumer(),
    {
      status: (res: SlowResponse, code: number) => {
        res.statusCode = code;
      },
    } as never,
  );
  const running = execution.create(controller, controller.appEvents, 'appEvents', 'fixture', RequestMethod.GET)(request, response, () => undefined);
  // Current Nest keeps the route promise open for the stream's lifetime.
  // Wait for the actual pipe, not completion of a still-live response.
  let failure: unknown;
  void Promise.resolve(running).catch((error) => {
    failure = error;
  });
  await vi.waitFor(() => {
    if (failure) throw failure;
    expect(framing).toBeInstanceOf(Transform);
  });
  return { request, response, write, end, framing };
}

it('drains every authorized frame through Nest before ending a backpressured response', async () => {
  vi.useRealTimers();
  const session = await sessions.createSession(1);
  const { request, response, write, end } = await stalledTransport(session);
  try {
    await nextTurn();
    response.stalled = true;
    for (const line of ['first', 'second', 'third']) events.next({ data: line });
    events.complete();
    await nextTurn();
    expect(response.writableEnded).toBe(false);
    const finished = once(response, 'finish', { signal: AbortSignal.timeout(3000) });
    response.unblock();
    await finished;
    expect(response.body.match(/data: \w+/g)).toEqual(['data: first', 'data: second', 'data: third']);
    expect(response.write).toBe(write);
    expect(response.end).toBe(end);
  } finally {
    request.destroy();
    response.destroy();
    response.unblock();
  }
});

it.each([false, true])('closes a stalled revoked transport without drain, including completed source=%s', async (complete) => {
  vi.useRealTimers();
  const session = await sessions.createSession(1);
  const { request, response, write, end, framing } = await stalledTransport(session);
  try {
    await nextTurn();
    response.stalled = true;
    for (let index = 0; index < 80; index++) events.next({ data: `line-${index}` });
    if (complete) events.complete();
    await nextTurn();
    const before = response.body;
    const closed = once(response, 'close', { signal: AbortSignal.timeout(3000) });
    await sessions.deleteSession(session);
    await closed;
    expect(response.destroyed).toBe(true);
    expect(request.destroyed).toBe(true);
    expect(framing?.destroyed).toBe(true);
    expect(response.body).toBe(before);
    expect(response.write).toBe(write);
    expect(response.end).toBe(end);
    expect(events.observed).toBe(false);
  } finally {
    request.destroy();
    response.destroy();
    response.unblock();
  }
});

it('keeps an authorized final response flushing beyond the transport watch interval', async () => {
  vi.useRealTimers();
  const session = await sessions.createSession(1);
  const { request, response, write, end } = await stalledTransport(session, 64 * 1024);
  try {
    await nextTurn();
    response.stalled = true;
    events.next({ data: 'last line' });
    events.complete();
    await nextTurn();
    expect(response.writableEnded).toBe(true);
    expect(response.writableFinished).toBe(false);
    await delay(1150);
    expect(sessions.isSessionForUser(session, 1)).toBe(true);
    expect(response.destroyed).toBe(false);
    const finished = once(response, 'finish', { signal: AbortSignal.timeout(3000) });
    response.unblock();
    await finished;
    expect(response.body).toContain('data: last line');
    expect(response.write).toBe(write);
    expect(response.end).toBe(end);
  } finally {
    request.destroy();
    response.destroy();
    response.unblock();
  }
});

it.each([
  ['session', false],
  ['session', true],
  ['cli', false],
  ['cli', true],
] as const)('closes stalled %s transport on shutdown after upstream EOF=%s', async (authMethod, eof) => {
  vi.useRealTimers();
  const session = await sessions.createSession(1);
  const { request, response, write, end, framing } = await stalledTransport(session, 1, authMethod);
  try {
    await nextTurn();
    response.stalled = true;
    for (let index = 0; index < 80; index++) events.next({ data: `queued-${index}` });
    if (eof) events.complete();
    await nextTurn();
    const body = response.body;
    const closed = once(response, 'close', { signal: AbortSignal.timeout(1000) });
    shutdown.next();
    await closed;
    expect(request.destroyed).toBe(true);
    expect(framing?.destroyed).toBe(true);
    expect(response.body).toBe(body);
    expect(response.write).toBe(write);
    expect(response.end).toBe(end);
    expect(shutdown.observed).toBe(false);
  } finally {
    request.destroy();
    response.destroy();
    response.unblock();
  }
});

it('does not attach framing hooks after a response has already finished and closed', async () => {
  vi.useRealTimers();
  const response = new SlowResponse(1);
  const closed = once(response, 'close', { signal: AbortSignal.timeout(1000) });
  response.end();
  await closed;
  const count = () => ['pipe', 'close', 'finish'].map((event) => response.listenerCount(event));
  const before = count();
  prepareStreamResponse(response as never);
  expect(count()).toEqual(before);
});
