import { type } from 'arktype';
import type { ConsumerHandler } from 'rabbitmq-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { LoggerService } from '@/core/logger/logger.service';
import { QueueFactory } from './queue.factory';

const rabbit = vi.hoisted(() => ({
  createConsumer: vi.fn((_options: unknown, _callback: ConsumerHandler) => undefined),
  createPublisher: vi.fn(() => ({ close: vi.fn(), send: vi.fn() })),
  createRPCClient: vi.fn(() => ({ send: vi.fn() })),
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

  beforeEach(() => {
    vi.clearAllMocks();

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
});
