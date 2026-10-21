import { type } from 'arktype';
import type { ConsumerHandler } from 'rabbitmq-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { LoggerService } from '@/core/logger/logger.service';
import { QueueFactory } from './queue.factory';

const rabbit = vi.hoisted(() => ({
  createConsumer: vi.fn((_options: unknown, _callback: ConsumerHandler) => undefined),
  createPublisher: vi.fn(() => ({ close: vi.fn(), send: vi.fn() })),
  createRPCClient: vi.fn(() => ({ send: vi.fn() })),
  queueDeclare: vi.fn(),
  on: vi.fn((event: string, callback: () => void) => {
    if (event === 'connection') {
      callback();
    }
  }),
  ready: true,
}));

vi.mock('rabbitmq-client', () => ({
  Connection: vi.fn(function Connection() {
    return rabbit;
  }),
}));

describe('QueueFactory', () => {
  const configurationService = mock<ConfigurationService>();
  const loggerService = mock<LoggerService>();

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    rabbit.queueDeclare.mockReset().mockResolvedValue({ messageCount: 0, consumerCount: 0 });

    configurationService.get.calledWith('queue').mockReturnValue({
      host: 'localhost',
      password: 'guest',
      username: 'guest',
    });
  });

  it('declares durable RPC and consumer queues', async () => {
    const queueFactory = new QueueFactory(loggerService, configurationService);

    const queue = await queueFactory.createQueue({
      queueName: 'app-events-queue',
      eventSchema: type({ event: 'string' }),
    });

    expect(rabbit.createRPCClient).toHaveBeenCalledWith(
      expect.objectContaining({
        queues: [{ autoDelete: false, durable: true, queue: 'app-events-queue' }],
      }),
    );

    queue.onEvent(vi.fn());

    expect(rabbit.createConsumer).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: 'app-events-queue',
        queueOptions: { autoDelete: false, durable: true },
      }),
      expect.any(Function),
    );
  });

  it.each([true, false])('passes broker redelivery state (%s) independently of the request body', async (redelivered) => {
    const factory = new QueueFactory(loggerService, configurationService);
    const queue = await factory.createQueue({ queueName: 'app-events-queue', eventSchema: type({ event: 'string' }) });
    const callback = vi.fn().mockResolvedValue(undefined);
    queue.onEvent(callback);
    const consumer = rabbit.createConsumer.mock.calls[0]?.[1];
    if (!consumer) throw new Error('Consumer was not registered');
    const body = { event: 'restore', redelivered: !redelivered };
    const reply = vi.fn().mockResolvedValue(undefined);
    await consumer({ body, redelivered } as Parameters<ConsumerHandler>[0], reply);
    expect(callback).toHaveBeenCalledExactlyOnceWith(body, reply, { redelivered });
  });

  it('does not consume, enqueue, observe or schedule jobs during installer hold', async () => {
    vi.stubEnv('ORBIS_INSTALLER_TRANSACTION', 'f92e8862-38b5-4e81-bc84-f9131944872d');
    vi.stubEnv('ORBIS_INSTALLER_PHASE', 'hold');
    vi.useFakeTimers();
    const observer = { queued: vi.fn(), unconfirmed: vi.fn() };
    const factory = new QueueFactory(loggerService, configurationService);
    const queue = await factory.createQueue({ queueName: 'app-events-queue', eventSchema: type({ event: 'string' }), observer });
    const callback = vi.fn();
    queue.onEvent(callback);
    expect(await queue.publish({ event: 'start' })).toEqual({
      success: false,
      message: 'Installation is in progress. Wait for the installer to finish.',
    });
    queue.publishRepeatable({ event: 'start' }, '* * * * *');
    expect(rabbit.createConsumer).not.toHaveBeenCalled();
    expect(rabbit.createRPCClient.mock.results.at(-1)?.value.send).not.toHaveBeenCalled();
    expect(observer.queued).not.toHaveBeenCalled();
    expect(observer.unconfirmed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  const resumeQueues = async () => {
    vi.stubEnv('ORBIS_INSTALLER_TRANSACTION', 'f92e8862-38b5-4e81-bc84-f9131944872d');
    vi.stubEnv('ORBIS_INSTALLER_PHASE', 'resume');
    const factory = new QueueFactory(loggerService, configurationService);
    const queues = await Promise.all(
      ['app-events-queue', 'repo-queue', 'system-events-queue'].map(async (queueName) => {
        const queue = await factory.createQueue({ queueName, eventSchema: type({ event: 'string' }) });
        queue.onEvent(vi.fn());
        return queue;
      }),
    );
    return { factory, app: queues[0] as (typeof queues)[number] };
  };

  it('defers resume consumers until preflight and app consumers until bootstrap completes', async () => {
    const { factory, app } = await resumeQueues();
    expect(rabbit.createConsumer).not.toHaveBeenCalled();
    expect((await app.publish({ event: 'start' })).success).toBe(false);
    await factory.prepareInstallationResume();
    expect(rabbit.createConsumer.mock.calls.map(([options]) => (options as { queue: string }).queue)).toEqual(['repo-queue', 'system-events-queue']);
    expect((await app.publish({ event: 'start' })).success).toBe(false);
    await factory.completeInstallationResume();
    expect(rabbit.createConsumer.mock.calls.map(([options]) => (options as { queue: string }).queue)).toEqual([
      'repo-queue',
      'system-events-queue',
      'app-events-queue',
    ]);
    await factory.completeInstallationResume();
    expect(rabbit.createConsumer).toHaveBeenCalledTimes(3);
  });

  it.each([
    { messageCount: 1, consumerCount: 0 },
    { messageCount: 0, consumerCount: 1 },
  ])('refuses resume before any consumer when queued work or another controller remains: %j', async (state) => {
    const { factory, app } = await resumeQueues();
    rabbit.queueDeclare.mockResolvedValue(state);
    await expect(factory.prepareInstallationResume()).rejects.toThrow('app commands or another app consumer');
    expect(rabbit.createConsumer).not.toHaveBeenCalled();
    expect((await app.publish({ event: 'start' })).success).toBe(false);
  });

  it('rechecks pending work after bootstrap without consuming or discarding it', async () => {
    const { factory, app } = await resumeQueues();
    await factory.prepareInstallationResume();
    rabbit.queueDeclare.mockResolvedValue({ messageCount: 1, consumerCount: 0 });
    await expect(factory.completeInstallationResume()).rejects.toThrow('app commands or another app consumer');
    expect(rabbit.createConsumer).toHaveBeenCalledTimes(2);
    expect((await app.publish({ event: 'start' })).success).toBe(false);
  });

  it('fails closed when the broker cannot verify pending app work', async () => {
    const { factory } = await resumeQueues();
    rabbit.queueDeclare.mockRejectedValue(new Error('Queue unavailable'));
    await expect(factory.prepareInstallationResume()).rejects.toThrow('Queue unavailable');
    expect(rabbit.createConsumer).not.toHaveBeenCalled();
  });

  it('cannot enable app consumption before resume preflight', async () => {
    const { factory } = await resumeQueues();
    await expect(factory.completeInstallationResume()).rejects.toThrow('have not passed preflight');
    expect(rabbit.createConsumer).not.toHaveBeenCalled();
  });

  it('cannot release a held controller through queue activation', async () => {
    vi.stubEnv('ORBIS_INSTALLER_TRANSACTION', 'f92e8862-38b5-4e81-bc84-f9131944872d');
    vi.stubEnv('ORBIS_INSTALLER_PHASE', 'hold');
    const factory = new QueueFactory(loggerService, configurationService);
    const queue = await factory.createQueue({ queueName: 'app-events-queue', eventSchema: type({ event: 'string' }) });
    queue.onEvent(vi.fn());
    queue.resumeAfterInstallation();
    await factory.prepareInstallationResume();
    await factory.completeInstallationResume();
    expect(rabbit.queueDeclare).not.toHaveBeenCalled();
    expect(rabbit.createConsumer).not.toHaveBeenCalled();
    expect((await queue.publish({ event: 'start' })).success).toBe(false);
  });
});
