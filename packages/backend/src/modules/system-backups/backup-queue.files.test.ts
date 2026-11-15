import { afterEach, expect, it, vi } from 'vitest';
import { type } from 'arktype';
import { Queue } from '../queue/queue.entity';
import { acquireBackupMaintenance, backupMaintenanceActive, setBackupRecoveryRequired } from '@/common/backup-maintenance';

afterEach(() => setBackupRecoveryRequired(false));
function queueFixture(observe: () => Promise<void> = async () => undefined) {
  let consumer: (
    request: { body: unknown; redelivered: boolean; headers?: Record<string, unknown> },
    reply: (response: unknown) => Promise<void>,
  ) => Promise<void>;
  const rabbit = {
    createConsumer: vi.fn((_options, handler) => {
      consumer = handler;
    }),
  };
  const callback = vi.fn(async (_data, reply) => reply({ success: true, message: 'completed' }));
  const rpc = {
    send: vi.fn(async (envelope: string | { headers?: Record<string, unknown> }, body) => {
      let result: unknown;
      await consumer({ body, redelivered: false, ...(typeof envelope === 'string' ? {} : { headers: envelope.headers }) }, async (value) => {
        result = value;
      });
      return { body: result };
    }),
  };
  const event = type({ command: "'fixture'", requestId: 'string' });
  const result = type({ success: 'boolean', message: 'string' });
  const queue = new Queue(
    rabbit as never,
    rpc as never,
    { publish: vi.fn().mockResolvedValue(undefined) } as never,
    'fixture',
    1,
    event,
    result,
    { error: vi.fn(), warn: vi.fn() } as never,
    { queued: observe, unconfirmed: vi.fn() },
  );
  queue.onEvent(callback);
  return { queue, callback, deliver: async () => consumer({ body: { command: 'fixture', requestId: 'old' }, redelivered: true }, vi.fn()) };
}
it('drains a publication admitted before snapshot acquisition even when its task observer is suspended', async () => {
  let observed: () => void = () => undefined;
  const fixture = queueFixture(
    () =>
      new Promise<void>((resolve) => {
        observed = resolve;
      }),
  );
  const publishing = fixture.queue.publish({ command: 'fixture', requestId: 'fixture' });
  const abort = new AbortController();
  let acquired = false;
  const waiting = acquireBackupMaintenance(abort.signal).then((release) => {
    acquired = true;
    return release;
  });
  let release: (() => void) | undefined;
  try {
    await Promise.resolve();
    expect(acquired).toBe(false);
    expect(backupMaintenanceActive()).toBe(true);
    expect(await fixture.queue.publish({ command: 'fixture', requestId: 'late' })).toMatchObject({ success: false });
    observed();
    expect(await publishing).toMatchObject({ success: true });
    release = await waiting;
    expect(fixture.callback).toHaveBeenCalledTimes(1);
    expect(acquired).toBe(true);
  } finally {
    observed();
    abort.abort();
    (release ?? (await waiting.catch(() => undefined)))?.();
    await publishing;
  }
});
it('defers a redelivered command during startup recovery instead of acknowledging it as failed', async () => {
  setBackupRecoveryRequired(true);
  const fixture = queueFixture();
  const delivery = fixture.deliver();
  await Promise.resolve();
  expect(fixture.callback).not.toHaveBeenCalled();
  setBackupRecoveryRequired(false);
  await delivery;
  expect(fixture.callback).toHaveBeenCalledTimes(1);
});
