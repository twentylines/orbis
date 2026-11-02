import { afterEach, expect, it, vi } from 'vitest';
import { type } from 'arktype';
import { Queue } from '../queue/queue.entity';
import { QueueFactory } from '../queue/queue.factory';
import { setBackupRecoveryRequired } from '@/common/backup-maintenance';

afterEach(() => setBackupRecoveryRequired(false));
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('Missing queue fixture');
  return value;
};
const names = ['app-events-queue', 'repo-queue', 'system-events-queue'];
function fixture() {
  const consumers: { close: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> }[] = [];
  const rpc = { send: vi.fn(async () => ({ body: { success: true, message: 'done' } })) };
  const rabbit = {
    ready: true,
    queueDeclare: vi.fn().mockResolvedValue({ messageCount: 0, consumerCount: 0 }),
    createConsumer: vi.fn(() => {
      const consumer = { close: vi.fn().mockResolvedValue(undefined), start: vi.fn() };
      consumers.push(consumer);
      return consumer;
    }),
  };
  const queues = names.map((name) => {
    const queue = new Queue(
      rabbit as never,
      rpc as never,
      { publish: vi.fn() } as never,
      name,
      1,
      type({ command: 'string' }),
      type({ success: 'boolean', message: 'string' }),
      { warn: vi.fn(), error: vi.fn() } as never,
    );
    queue.onEvent(vi.fn());
    return queue;
  });
  const factory = Object.create(QueueFactory.prototype) as QueueFactory;
  Object.assign(factory, {
    rabbit,
    isInitialized: true,
    connectionGeneration: 1,
    captureHeld: false,
    queues: new Map(names.map((name, index) => [name, queues[index]])),
  });
  return { factory, queues, consumers, rpc, rabbit };
}
it('closes every publisher before draining accepted work, then resumes consumers exactly once', async () => {
  const { factory, queues, consumers, rpc } = fixture();
  let finish!: (value: { body: { success: boolean; message: string } }) => void;
  rpc.send.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const accepted = required(queues[0]).publish({ command: 'accepted' });
  await vi.waitFor(() => expect(rpc.send).toHaveBeenCalledTimes(1));
  const pausing = factory.pauseForBackup(new AbortController().signal);
  for (const queue of queues) expect(await queue.publish({ command: 'later' })).toMatchObject({ success: false });
  expect(required(consumers[0]).close).not.toHaveBeenCalled();
  finish({ body: { success: true, message: 'done' } });
  expect(await accepted).toMatchObject({ success: true });
  const pause = await pausing;
  expect(rpc.send).toHaveBeenCalledTimes(1);
  for (const consumer of consumers) {
    expect(consumer.close).toHaveBeenCalledTimes(1);
    expect(consumer.start).not.toHaveBeenCalled();
  }
  await pause.verify();
  pause.release();
  pause.release();
  for (const consumer of consumers) expect(consumer.start).toHaveBeenCalledTimes(1);
  expect(await required(queues[0]).publish({ command: 'after' })).toMatchObject({ success: true });
});
it.each([
  { messageCount: 1, consumerCount: 0 },
  { messageCount: 0, consumerCount: 1 },
])('rejects pending commands or other consumers without purging (%j)', async (state) => {
  const { factory, consumers, rabbit, queues } = fixture();
  rabbit.queueDeclare.mockResolvedValueOnce(state);
  await expect(factory.pauseForBackup(new AbortController().signal)).rejects.toThrow('Queued commands');
  for (const consumer of consumers) expect(consumer.start).toHaveBeenCalledTimes(1);
  expect(await required(queues[0]).publish({ command: 'preserved' })).toMatchObject({ success: true });
  expect(Object.keys(rabbit).some((name) => /purge|delete/i.test(name))).toBe(false);
});
it('releases all paused consumers after a drain failure and permits retry', async () => {
  const { factory, consumers } = fixture();
  required(consumers[1]).close.mockRejectedValueOnce(new Error('connection failed'));
  await expect(factory.pauseForBackup(new AbortController().signal)).rejects.toThrow('connection failed');
  for (const consumer of consumers) expect(consumer.start).toHaveBeenCalledTimes(1);
  (await factory.pauseForBackup(new AbortController().signal)).release();
});
it('cancels a publication drain without discarding admitted work or stranding publishers', async () => {
  const { factory, queues, rpc, consumers } = fixture();
  let finish!: (value: { body: { success: boolean; message: string } }) => void;
  rpc.send.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const accepted = required(queues[0]).publish({ command: 'accepted' });
  await vi.waitFor(() => expect(rpc.send).toHaveBeenCalledTimes(1));
  const abort = new AbortController();
  const pending = factory.pauseForBackup(abort.signal);
  const rejection = expect(pending).rejects.toThrow();
  abort.abort();
  await rejection;
  finish({ body: { success: true, message: 'done' } });
  expect(await accepted).toMatchObject({ success: true });
  for (const consumer of consumers) expect(consumer.start).toHaveBeenCalledTimes(1);
  expect(await required(queues[0]).publish({ command: 'after' })).toMatchObject({ success: true });
});
it('fails the final queue check if work arrives while paused and retains it for resumption', async () => {
  const { factory, consumers, rabbit } = fixture();
  const pause = await factory.pauseForBackup(new AbortController().signal);
  rabbit.queueDeclare.mockResolvedValueOnce({ messageCount: 1, consumerCount: 0 });
  await expect(pause.verify()).rejects.toThrow('Queued commands');
  for (const consumer of consumers) expect(consumer.start).not.toHaveBeenCalled();
  pause.release();
  for (const consumer of consumers) expect(consumer.start).toHaveBeenCalledTimes(1);
});
it('rejects incomplete queue coverage before changing any consumer', async () => {
  const { factory, consumers } = fixture();
  Reflect.get(factory, 'queues').delete('repo-queue');
  await expect(factory.pauseForBackup(new AbortController().signal)).rejects.toThrow('coverage');
  for (const consumer of consumers) expect(consumer.close).not.toHaveBeenCalled();
});
it('rejects a replacement broker connection during capture', async () => {
  const { factory, rabbit } = fixture();
  const pause = await factory.pauseForBackup(new AbortController().signal);
  Reflect.set(factory, 'rabbit', { ...rabbit });
  await expect(pause.verify()).rejects.toThrow('connection changed');
  pause.release();
});
it('attempts every consumer resumption even if one fails and retains the recovery write barrier', async () => {
  const { factory, consumers, queues } = fixture();
  const pause = await factory.pauseForBackup(new AbortController().signal);
  required(consumers[1]).start.mockImplementationOnce(() => {
    throw new Error('fixture restart failure');
  });
  expect(() => pause.release()).toThrow('resumption failed');
  for (const consumer of consumers) expect(consumer.start).toHaveBeenCalledTimes(1);
  expect(await required(queues[0]).publish({ command: 'blocked until recovery' })).toMatchObject({ success: false });
});
it('rejects a reconnect of the same broker object during the write-barrier cut', async () => {
  const { factory } = fixture();
  const pause = await factory.pauseForBackup(new AbortController().signal);
  Reflect.set(factory, 'connectionGeneration', 2);
  await expect(pause.verify()).rejects.toThrow('connection changed');
  pause.release();
});
