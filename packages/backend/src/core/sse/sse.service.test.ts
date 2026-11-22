import { EventEmitter } from 'node:events';
import { DockerService } from '@/modules/docker/docker.service';
import { colorizeLogs } from '@/modules/docker/helpers/colorize-logs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { LoggerService } from '../logger/logger.service';
import { SSEService } from './sse.service';

vi.mock('@/modules/docker/helpers/colorize-logs', () => ({ colorizeLogs: vi.fn() }));

describe('SSEService lifecycle', () => {
  const docker = mock<DockerService>();
  const logger = mock<LoggerService>();
  let service: SSEService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    service = new SSEService(logger, docker);
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.useRealTimers();
  });

  it('completes topic subscriptions and releases its timer on shutdown', () => {
    const complete = vi.fn();
    const subscription = service.getTopicObservable('app').subscribe({ complete });
    expect(vi.getTimerCount()).toBe(1);
    service.onModuleDestroy();
    expect(complete).toHaveBeenCalledOnce();
    expect(subscription.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    service.onModuleDestroy();
    const lateComplete = vi.fn();
    service.getTopicObservable('app').subscribe({ complete: lateComplete });
    expect(lateComplete).toHaveBeenCalledOnce();
    service.emit('app', { event: 'status_change', appUrn: 'media:test' });
    expect((service as unknown as { topics: Map<unknown, unknown> }).topics.size).toBe(0);
  });

  it.each(['unsubscribe', 'shutdown'] as const)('kills a log reader once on %s and stops callbacks', async (action) => {
    const source = new EventEmitter();
    const kill = vi.fn();
    docker.getLogsStream.mockResolvedValue({ on: source.on.bind(source), kill } as never);
    vi.mocked(colorizeLogs).mockResolvedValue(['line']);
    const observable = await service.getLogStreamObservable('runtipi-logs', 10);
    const next = vi.fn();
    const complete = vi.fn();
    const subscription = observable.subscribe({ next, complete });
    await Promise.resolve();
    source.emit('data', Buffer.from('line'));
    await Promise.resolve();
    expect(next).toHaveBeenCalledOnce();
    if (action === 'unsubscribe') subscription.unsubscribe();
    else service.onModuleDestroy();
    source.emit('data', Buffer.from('later'));
    await Promise.resolve();
    expect(next).toHaveBeenCalledOnce();
    expect(colorizeLogs).toHaveBeenCalledOnce();
    service.onModuleDestroy();
    subscription.unsubscribe();
    expect(kill).toHaveBeenCalledOnce();
    if (action === 'shutdown') expect(complete).toHaveBeenCalledOnce();
  });

  it('does not acquire a reader before subscription or after shutdown', async () => {
    const observable = await service.getLogStreamObservable('runtipi-logs', 10);
    expect(docker.getLogsStream).not.toHaveBeenCalled();
    service.onModuleDestroy();
    const complete = vi.fn();
    observable.subscribe({ complete });
    expect(complete).toHaveBeenCalledOnce();
    expect(docker.getLogsStream).not.toHaveBeenCalled();
  });

  it('continues shutdown when one log reader cannot be signalled', async () => {
    const source = new EventEmitter();
    const failedKill = vi.fn(() => {
      throw new Error('Reader signalling failed.');
    });
    const otherKill = vi.fn();
    docker.getLogsStream
      .mockResolvedValueOnce({ on: source.on.bind(source), kill: failedKill } as never)
      .mockResolvedValueOnce({ on: source.on.bind(source), kill: otherKill } as never);
    (await service.getLogStreamObservable('runtipi-logs', 10)).subscribe();
    (await service.getLogStreamObservable('runtipi-logs', 10)).subscribe();
    await Promise.resolve();
    const complete = vi.fn();
    service.getTopicObservable('app').subscribe({ complete });
    service.onModuleDestroy();
    expect(failedKill).toHaveBeenCalledOnce();
    expect(otherKill).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(logger.error).toHaveBeenCalledWith('Unable to stop a log reader:', expect.any(Error));
  });

  it('kills a reader acquired after shutdown and returns a completed observable', async () => {
    const source = new EventEmitter();
    const kill = vi.fn();
    let resolve!: (value: Awaited<ReturnType<DockerService['getLogsStream']>>) => void;
    docker.getLogsStream.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const observable = await service.getLogStreamObservable('runtipi-logs', 10);
    const complete = vi.fn();
    observable.subscribe({ complete });
    service.onModuleDestroy();
    resolve({ on: source.on.bind(source), kill } as never);
    await Promise.resolve();
    expect(complete).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledOnce();
    await service.getLogStreamObservable('runtipi-logs', 10);
    expect(docker.getLogsStream).toHaveBeenCalledOnce();
  });

  it('does not emit or recreate topics when colorization finishes after shutdown', async () => {
    const source = new EventEmitter();
    const kill = vi.fn();
    docker.getLogsStream.mockResolvedValue({ on: source.on.bind(source), kill } as never);
    let resolve!: (lines: string[]) => void;
    vi.mocked(colorizeLogs).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const observable = await service.getLogStreamObservable('runtipi-logs', 10);
    const next = vi.fn();
    observable.subscribe({ next });
    await Promise.resolve();
    source.emit('data', Buffer.from('line'));
    service.onModuleDestroy();
    resolve(['line']);
    await Promise.resolve();
    expect(next).not.toHaveBeenCalled();
    expect((service as unknown as { topics: Map<unknown, unknown> }).topics.size).toBe(0);
    expect(kill).toHaveBeenCalledOnce();
  });

  it('keeps independent log readers from duplicating each other’s output', async () => {
    const first = new EventEmitter();
    const second = new EventEmitter();
    const killFirst = vi.fn();
    const killSecond = vi.fn();
    docker.getLogsStream
      .mockResolvedValueOnce({ on: first.on.bind(first), kill: killFirst } as never)
      .mockResolvedValueOnce({ on: second.on.bind(second), kill: killSecond } as never);
    vi.mocked(colorizeLogs).mockResolvedValue(['line']);
    const firstNext = vi.fn();
    const secondNext = vi.fn();
    const a = (await service.getLogStreamObservable('runtipi-logs', 10)).subscribe(firstNext);
    const b = (await service.getLogStreamObservable('runtipi-logs', 20)).subscribe(secondNext);
    await Promise.resolve();
    first.emit('data', Buffer.from('first'));
    await Promise.resolve();
    expect(firstNext).toHaveBeenCalledOnce();
    expect(secondNext).not.toHaveBeenCalled();
    second.emit('data', Buffer.from('second'));
    await Promise.resolve();
    expect(firstNext).toHaveBeenCalledOnce();
    expect(secondNext).toHaveBeenCalledOnce();
    a.unsubscribe();
    b.unsubscribe();
    expect(killFirst).toHaveBeenCalledOnce();
    expect(killSecond).toHaveBeenCalledOnce();
  });

  it('releases subscription ownership when reader startup fails', async () => {
    const failure = new Error('Reader unavailable');
    docker.getLogsStream.mockRejectedValue(failure);
    const error = vi.fn();
    const subscription = (await service.getLogStreamObservable('runtipi-logs', 10)).subscribe({ error });
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalledExactlyOnceWith(failure);
    expect(subscription.closed).toBe(true);
    expect((service as unknown as { logStreams: Set<unknown> }).logStreams.size).toBe(0);
  });

  it('drains the last formatted chunk before completing stdout EOF', async () => {
    const source = new EventEmitter();
    const kill = vi.fn();
    docker.getLogsStream.mockResolvedValue({ on: source.on.bind(source), kill } as never);
    let finish!: (lines: string[]) => void;
    vi.mocked(colorizeLogs).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const next = vi.fn();
    const complete = vi.fn();
    (await service.getLogStreamObservable('runtipi-logs', 10)).subscribe({ next, complete });
    await Promise.resolve();
    source.emit('data', Buffer.from('last'));
    source.emit('end');
    expect(complete).not.toHaveBeenCalled();
    finish(['last']);
    await Promise.resolve();
    expect(next).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    const completedAt = complete.mock.invocationCallOrder[0];
    if (completedAt === undefined) throw new Error('The stream did not complete.');
    expect(next.mock.invocationCallOrder[0]).toBeLessThan(completedAt);
    expect(kill).toHaveBeenCalledOnce();
  });
});
