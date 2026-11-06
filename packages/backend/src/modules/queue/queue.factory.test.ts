import { setRestoreRecoveryRequired } from '@/common/backup-maintenance';
import * as maintenance from '@/common/backup-maintenance';
import { type } from 'arktype';
import { Connection, type ConsumerHandler } from 'rabbitmq-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { LoggerService } from '@/core/logger/logger.service';
import { QueueFactory } from './queue.factory';
import * as restoreStartup from '../system-backups/backup-restore-startup';

const rabbit = vi.hoisted(() => ({
  createConsumer: vi.fn((_options: unknown, _callback: ConsumerHandler) => ({ close: vi.fn().mockResolvedValue(undefined), start: vi.fn() })),
  createPublisher: vi.fn(() => ({ close: vi.fn(), send: vi.fn() })),
  createRPCClient: vi.fn(() => ({ send: vi.fn(), close: vi.fn().mockResolvedValue(undefined) })),
  close: vi.fn().mockResolvedValue(undefined),
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
  ConsumerStatus: { REQUEUE: 1 },
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
    rabbit.ready = true;

    configurationService.get.calledWith('queue').mockReturnValue({
      host: 'localhost',
      password: 'guest',
      username: 'guest',
    });
  });

  async function pausedCapture(signal = new AbortController().signal) {
    const held = vi.spyOn(maintenance, 'coreCaptureRecoveryRequired').mockReturnValue(false);
    const factory = new QueueFactory(loggerService, configurationService);
    const queues = [];
    for (const queueName of ['app-events-queue', 'repo-queue', 'system-events-queue']) {
      const queue = await factory.createQueue({ queueName, eventSchema: type({ event: 'string' }) });
      queue.onEvent(vi.fn());
      queues.push(queue);
    }
    const pause = await factory.pauseForBackup(signal);
    const release = await maintenance.acquireBackupMaintenance(new AbortController().signal);
    held.mockReturnValue(true);
    const started = new Set<string>();
    for (const [index, result] of rabbit.createConsumer.mock.results.entries()) {
      const name = (rabbit.createConsumer.mock.calls[index]?.[0] as { queue: string }).queue;
      result.value.start.mockImplementation(() => started.add(name));
    }
    rabbit.queueDeclare.mockImplementation(async ({ queue }: { queue: string }) => ({
      messageCount: 0,
      consumerCount: started.has(queue) ? 1 : 0,
    }));
    return {
      factory,
      pause,
      queues,
      held,
      releaseMaintenance: release,
      starts: () => rabbit.createConsumer.mock.results.reduce((total, result) => total + result.value.start.mock.calls.length, 0),
      close: async () => {
        pause.release();
        release();
        held.mockRestore();
        maintenance.setBackupRecoveryRequired(false);
        await factory.onModuleDestroy();
      },
    };
  }

  async function failedCaptureSetup() {
    const held = vi.spyOn(maintenance, 'coreCaptureRecoveryRequired').mockReturnValue(false);
    const factory = new QueueFactory(loggerService, configurationService);
    const live = new Set<string>();
    for (const queueName of ['app-events-queue', 'repo-queue', 'system-events-queue']) {
      const queue = await factory.createQueue({ queueName, eventSchema: type({ event: 'string' }) });
      queue.onEvent(vi.fn());
    }
    for (const [index, result] of rabbit.createConsumer.mock.results.entries()) {
      const name = (rabbit.createConsumer.mock.calls[index]?.[0] as { queue: string }).queue;
      live.add(name);
      result.value.close.mockImplementation(async () => {
        live.delete(name);
      });
      result.value.start.mockImplementation(() => {
        live.add(name);
      });
    }
    const reads = async ({ queue }: { queue: string }) => ({ messageCount: 0, consumerCount: live.has(queue) ? 1 : 0 });
    rabbit.queueDeclare.mockImplementation(reads);
    const cause = new Error('broker check failed');
    rabbit.queueDeclare.mockRejectedValueOnce(cause);
    const failure = await factory.pauseForBackup(new AbortController().signal).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    return {
      factory,
      failure,
      cause,
      live,
      reads,
      close: async () => {
        await factory.onModuleDestroy();
        held.mockRestore();
        maintenance.setBackupRecoveryRequired(false);
      },
    };
  }

  it('seals a genuine unused setup without changing another maintenance lease', async () => {
    const f = await failedCaptureSetup();
    const other = await maintenance.acquireBackupMaintenance(new AbortController().signal);
    try {
      const scope = f.factory.createCoreCaptureQueueSetup();
      const proof = await f.factory.verifyCoreCaptureSetupRefusal(scope, new AbortController().signal);
      expect(proof).toMatchObject({
        outcome: 'not-entered',
        queues: expect.arrayContaining([{ name: 'app-events-queue', messages: 0, consumers: 1 }]),
      });
      await proof?.recheck();
      await expect(scope.pauseForBackup(new AbortController().signal)).rejects.toThrow('consumed');
      expect(maintenance.backupMaintenanceLeaseHeld()).toBe(true);
      const stranger = new QueueFactory(loggerService, configurationService);
      await expect(stranger.verifyCoreCaptureSetupRefusal(scope, new AbortController().signal)).rejects.toThrow('does not belong');
      await expect(f.factory.verifyCoreCaptureSetupRefusal({ ...scope }, new AbortController().signal)).rejects.toThrow('does not belong');
      await stranger.onModuleDestroy();
    } finally {
      other();
      await f.close();
    }
  });

  it('preserves a foreign entity pause even when broker consumer coverage is complete', async () => {
    const f = await failedCaptureSetup();
    const registrations = Reflect.get(f.factory, 'queues') as Map<
      string,
      { pauseForBackup: () => { release: () => void }; captureSetupIsIdle: () => boolean }
    >;
    const app = registrations.get('app-events-queue');
    if (!app) throw new Error('Missing app queue fixture');
    const foreign = app.pauseForBackup();
    try {
      const scope = f.factory.createCoreCaptureQueueSetup();
      await expect(scope.pauseForBackup(new AbortController().signal)).rejects.toThrow('already in progress');
      await expect(f.factory.verifyCoreCaptureSetupRefusal(scope, new AbortController().signal)).rejects.toThrow('cannot be verified');
      expect(app.captureSetupIsIdle()).toBe(false);
      expect(f.live.size).toBe(3);
      foreign.release();
      expect(await f.factory.verifyCoreCaptureSetupRefusal(scope, new AbortController().signal)).toMatchObject({ outcome: 'queue-refused' });
    } finally {
      foreign.release();
      await f.close();
    }
  });

  it('verifies cancellation before the first queue call without fabricating an owned pause', async () => {
    const f = await failedCaptureSetup();
    try {
      const scope = f.factory.createCoreCaptureQueueSetup();
      await expect(scope.pauseForBackup(AbortSignal.abort())).rejects.toThrow();
      expect(await f.factory.verifyCoreCaptureSetupRefusal(scope, new AbortController().signal)).toMatchObject({ outcome: 'queue-refused' });
      expect(f.live.size).toBe(3);
    } finally {
      await f.close();
    }
  });

  it('does not turn an arbitrary failure or an owned returned handle into refusal authority', async () => {
    const f = await failedCaptureSetup();
    try {
      const unknown = f.factory.createCoreCaptureQueueSetup();
      vi.spyOn(f.factory, 'pauseForBackup').mockRejectedValueOnce(new Error('unbranded failure'));
      await expect(unknown.pauseForBackup(new AbortController().signal)).rejects.toThrow('unbranded');
      expect(await f.factory.verifyCoreCaptureSetupRefusal(unknown, new AbortController().signal)).toBeUndefined();
      const owned = f.factory.createCoreCaptureQueueSetup();
      const pause = await owned.pauseForBackup(new AbortController().signal);
      expect(await f.factory.verifyCoreCaptureSetupRefusal(owned, new AbortController().signal)).toBeUndefined();
      pause.release();
      expect(await f.factory.verifyCoreCaptureSetupRefusal(owned, new AbortController().signal)).toBeUndefined();
    } finally {
      await f.close();
    }
  });

  it('pins a selected refusal proof but can inspect a fresh generation before selection', async () => {
    const f = await failedCaptureSetup();
    try {
      const scope = f.factory.createCoreCaptureQueueSetup();
      Reflect.set(f.factory, 'connectionGeneration', Number(Reflect.get(f.factory, 'connectionGeneration')) + 1);
      const proof = await f.factory.verifyCoreCaptureSetupRefusal(scope, new AbortController().signal);
      if (!proof) throw new Error('Missing refusal fixture proof');
      expect(proof?.generation).toBe(Reflect.get(f.factory, 'connectionGeneration'));
      Reflect.set(f.factory, 'connectionGeneration', Number(Reflect.get(f.factory, 'connectionGeneration')) + 1);
      await expect(proof.recheck()).rejects.toThrow('cannot be verified');
    } finally {
      await f.close();
    }
  });

  it('bounds refusal checks and rejects new work or additional consumers', async () => {
    const f = await failedCaptureSetup();
    try {
      const scope = f.factory.createCoreCaptureQueueSetup();
      for (const row of [
        { messageCount: 1, consumerCount: 1 },
        { messageCount: 0, consumerCount: 2 },
      ]) {
        rabbit.queueDeclare.mockResolvedValueOnce(row);
        await expect(f.factory.verifyCoreCaptureSetupRefusal(scope, new AbortController().signal)).rejects.toThrow('idle original');
      }
      const checking = new AbortController();
      const entered = Promise.withResolvers<void>();
      rabbit.queueDeclare.mockImplementationOnce(() => {
        entered.resolve();
        return new Promise(() => {});
      });
      const pending = f.factory.verifyCoreCaptureSetupRefusal(scope, checking.signal);
      const failure = expect(pending).rejects.toThrow();
      await entered.promise;
      checking.abort();
      await failure;
      expect(f.live.size).toBe(3);
    } finally {
      await f.close();
    }
  });

  it('positively verifies only its own unwound failed setup without changing foreign maintenance', async () => {
    const f = await failedCaptureSetup();
    const releaseOther = await maintenance.acquireBackupMaintenance(new AbortController().signal);
    try {
      const proof = await f.factory.verifyCoreCaptureSetupUnwind(f.failure, new AbortController().signal);
      expect(proof.generation).toBeGreaterThan(0);
      expect(proof.queues).toEqual(['app-events-queue', 'repo-queue', 'system-events-queue'].map((name) => ({ name, messages: 0, consumers: 1 })));
      await proof.recheck();
      expect(maintenance.backupMaintenanceLeaseHeld()).toBe(true);
      expect(maintenance.coreCaptureRecoveryRequired()).toBe(false);
      await expect(f.factory.verifyCoreCaptureSetupUnwind(f.cause, new AbortController().signal)).rejects.toThrow('does not belong');
      await expect(f.factory.verifyCoreCaptureSetupUnwind({ ...(f.failure as object) }, new AbortController().signal)).rejects.toThrow(
        'does not belong',
      );
      const other = new QueueFactory(loggerService, configurationService);
      try {
        await expect(other.verifyCoreCaptureSetupUnwind(f.failure, new AbortController().signal)).rejects.toThrow('does not belong');
      } finally {
        await other.onModuleDestroy();
      }
    } finally {
      releaseOther();
      await f.close();
    }
  });

  it('verifies a returned drained handle only after its own successful release', async () => {
    const f = await failedCaptureSetup();
    try {
      const pause = await f.factory.pauseForBackup(new AbortController().signal);
      await expect(f.factory.verifyCoreCaptureSetupUnwind(pause, new AbortController().signal)).rejects.toThrow();
      pause.release();
      await expect(f.factory.verifyCoreCaptureSetupUnwind(pause, new AbortController().signal)).resolves.toMatchObject({
        pauseId: pause.initial.pauseId,
        generation: pause.initial.generation,
      });
      await expect(f.factory.verifyCoreCaptureSetupUnwind(f.failure, new AbortController().signal)).rejects.toThrow();
    } finally {
      await f.close();
    }
  });

  it('does not let a reused broker error transfer ownership between capture attempts', async () => {
    const f = await failedCaptureSetup();
    try {
      rabbit.queueDeclare.mockRejectedValueOnce(f.cause);
      const next = await f.factory.pauseForBackup(new AbortController().signal).catch((error: unknown) => error);
      expect(next).not.toBe(f.failure);
      await expect(f.factory.verifyCoreCaptureSetupUnwind(next, new AbortController().signal)).resolves.toHaveProperty('pauseId');
      await expect(f.factory.verifyCoreCaptureSetupUnwind(f.failure, new AbortController().signal)).rejects.toThrow();
    } finally {
      await f.close();
    }
  });

  it('rejects changed queues, extra consumers or messages before certifying an unwind', async () => {
    const f = await failedCaptureSetup();
    try {
      for (const state of [
        { messageCount: 1, consumerCount: 1 },
        { messageCount: 0, consumerCount: 2 },
      ]) {
        rabbit.queueDeclare.mockResolvedValueOnce(state);
        await expect(f.factory.verifyCoreCaptureSetupUnwind(f.failure, new AbortController().signal)).rejects.toThrow('idle consumer coverage');
      }
      const proof = await f.factory.verifyCoreCaptureSetupUnwind(f.failure, new AbortController().signal);
      const declarations = rabbit.queueDeclare.mock.calls.length;
      const reconnect = rabbit.on.mock.calls.find(([name]) => name === 'connection')?.[1];
      reconnect?.();
      await expect(proof.recheck()).rejects.toThrow();
      expect(rabbit.queueDeclare.mock.calls.length).toBe(declarations);
    } finally {
      await f.close();
    }
  });

  it('cancels a stalled unwind broker check and rejects shutdown without restarting consumers', async () => {
    const f = await failedCaptureSetup();
    try {
      rabbit.queueDeclare.mockImplementationOnce(() => new Promise(() => {}));
      const cancellation = new AbortController();
      const pending = f.factory.verifyCoreCaptureSetupUnwind(f.failure, cancellation.signal);
      await vi.waitFor(() => expect(rabbit.queueDeclare).toHaveBeenCalled());
      cancellation.abort();
      await expect(pending).rejects.toThrow();
      await f.factory.onModuleDestroy();
      await expect(f.factory.verifyCoreCaptureSetupUnwind(f.failure, new AbortController().signal)).rejects.toThrow();
    } finally {
      await f.close();
    }
  });

  it('keeps failed consumer restart in recovery without issuing an unwind receipt', async () => {
    const f = await failedCaptureSetup();
    try {
      rabbit.createConsumer.mock.results[0]?.value.start.mockImplementationOnce(() => {
        throw new Error('restart failed');
      });
      rabbit.queueDeclare.mockRejectedValueOnce(new Error('setup failed'));
      const failure = await f.factory.pauseForBackup(new AbortController().signal).catch((error: unknown) => error);
      expect(maintenance.backupMaintenanceActive()).toBe(true);
      await expect(f.factory.verifyCoreCaptureSetupUnwind(failure, new AbortController().signal)).rejects.toThrow('does not belong');
    } finally {
      await f.close();
    }
  });

  it('refuses a changed queue registration even if broker counts look ready', async () => {
    const f = await failedCaptureSetup();
    const queues = Reflect.get(f.factory, 'queues') as Map<string, unknown>;
    const original = queues.get('app-events-queue');
    try {
      queues.set('app-events-queue', {});
      await expect(f.factory.verifyCoreCaptureSetupUnwind(f.failure, new AbortController().signal)).rejects.toThrow();
    } finally {
      queues.set('app-events-queue', original);
      await f.close();
    }
  });

  it('rechecks only its original pause using a live recovery signal after the producer was cancelled', async () => {
    const producer = new AbortController();
    const f = await pausedCapture(producer.signal);
    try {
      producer.abort();
      await expect(f.pause.verify()).rejects.toThrow();
      await expect(f.factory.recheckCoreCapturePause(f.pause, new AbortController().signal)).resolves.toMatchObject({
        pauseId: f.pause.initial.pauseId,
        generation: f.pause.initial.generation,
      });
      expect(f.starts()).toBe(0);
      expect(maintenance.backupMaintenanceLeaseHeld()).toBe(true);
    } finally {
      await f.close();
    }
  });

  it('refuses forged, released, cancelled or unheld pause rechecks without restarting consumers', async () => {
    const f = await pausedCapture();
    try {
      await expect(f.factory.recheckCoreCapturePause({ ...f.pause }, new AbortController().signal)).rejects.toThrow('belong');
      const aborted = new AbortController();
      aborted.abort();
      await expect(f.factory.recheckCoreCapturePause(f.pause, aborted.signal)).rejects.toThrow();
      f.held.mockReturnValue(false);
      await expect(f.factory.recheckCoreCapturePause(f.pause, new AbortController().signal)).rejects.toThrow('unavailable');
      f.held.mockReturnValue(true);
      f.pause.release();
      await expect(f.factory.recheckCoreCapturePause(f.pause, new AbortController().signal)).rejects.toThrow('changed');
    } finally {
      await f.close();
    }
  });

  it('refuses pending messages and changed registrations during recovery verification', async () => {
    const f = await pausedCapture();
    try {
      rabbit.queueDeclare.mockResolvedValue({ messageCount: 1, consumerCount: 0 });
      await expect(f.factory.recheckCoreCapturePause(f.pause, new AbortController().signal)).rejects.toThrow('Queued');
      rabbit.queueDeclare.mockResolvedValue({ messageCount: 0, consumerCount: 0 });
      Reflect.get(f.factory, 'queues').delete('repo-queue');
      await expect(f.factory.recheckCoreCapturePause(f.pause, new AbortController().signal)).rejects.toThrow('changed');
      expect(f.starts()).toBe(0);
    } finally {
      await f.close();
    }
  });

  it('cancels a recovery verification even when the broker declaration never settles', async () => {
    const f = await pausedCapture();
    try {
      const entered = Promise.withResolvers<void>();
      rabbit.queueDeclare.mockImplementationOnce(() => {
        entered.resolve();
        return new Promise(() => {});
      });
      const controller = new AbortController();
      const pending = f.factory.recheckCoreCapturePause(f.pause, controller.signal);
      await entered.promise;
      controller.abort();
      await expect(pending).rejects.toThrow('cancelled');
      expect(maintenance.backupMaintenanceLeaseHeld()).toBe(true);
      expect(f.starts()).toBe(0);
    } finally {
      await f.close();
    }
  });

  it('resumes an exact live capture pause once and proves three consumers without clearing either hold', async () => {
    const f = await pausedCapture();
    try {
      const first = f.factory.resumeCoreCapturePause(f.pause, new AbortController().signal);
      expect(f.factory.resumeCoreCapturePause(f.pause, new AbortController().signal)).toBe(first);
      const proof = await first;
      expect(proof.pauseId).toBe(f.pause.initial.pauseId);
      expect(proof.queueGeneration).toBe(f.pause.initial.generation);
      expect(proof.queues).toEqual(['app-events-queue', 'repo-queue', 'system-events-queue'].map((name) => ({ name, messages: 0, consumers: 1 })));
      expect(f.starts()).toBe(3);
      await proof.recheck();
      expect(maintenance.backupMaintenanceActive()).toBe(true);
      expect(maintenance.coreCaptureRecoveryRequired()).toBe(true);
      expect((await f.queues[0]?.publish({ event: 'outside' }))?.success).toBe(false);
      await f.factory.resumeCoreCapturePause(f.pause, new AbortController().signal);
      expect(f.starts()).toBe(3);
    } finally {
      await f.close();
    }
  });

  it('refuses a copied pause handle and a pause released through the ordinary backup path', async () => {
    const f = await pausedCapture();
    try {
      await expect(f.factory.resumeCoreCapturePause({ ...f.pause }, new AbortController().signal)).rejects.toThrow('belong');
      expect(f.starts()).toBe(0);
      f.pause.release();
      await expect(f.factory.resumeCoreCapturePause(f.pause, new AbortController().signal)).rejects.toThrow('already released');
      expect(f.starts()).toBe(3);
    } finally {
      await f.close();
    }
  });

  it.each([
    { messageCount: 1, consumerCount: 0 },
    { messageCount: 0, consumerCount: 2 },
    { messageCount: 0, consumerCount: 1 },
  ])('does not resume paused consumers with unexpected broker state %j', async (state) => {
    const f = await pausedCapture();
    try {
      rabbit.queueDeclare.mockResolvedValue(state);
      await expect(f.factory.resumeCoreCapturePause(f.pause, new AbortController().signal)).rejects.toThrow();
      expect(f.starts()).toBe(0);
      expect(maintenance.backupMaintenanceActive()).toBe(true);
    } finally {
      await f.close();
    }
  });

  it('refuses a connection generation change after readiness', async () => {
    const f = await pausedCapture();
    try {
      const proof = await f.factory.resumeCoreCapturePause(f.pause, new AbortController().signal);
      Object.assign(f.factory, { connectionGeneration: f.pause.initial.generation + 1 });
      await expect(proof.recheck()).rejects.toThrow('changed');
      expect(f.starts()).toBe(3);
      expect(maintenance.backupMaintenanceActive()).toBe(true);
    } finally {
      await f.close();
    }
  });

  it('refuses a connection generation change before resuming', async () => {
    const g = await pausedCapture();
    try {
      Object.assign(g.factory, { connectionGeneration: g.pause.initial.generation + 1 });
      await expect(g.factory.resumeCoreCapturePause(g.pause, new AbortController().signal)).rejects.toThrow('changed');
      expect(g.starts()).toBe(0);
    } finally {
      await g.close();
    }
  });

  it('requires the actual mutation lease as well as the recovery flag throughout resumption', async () => {
    const f = await pausedCapture();
    try {
      const proof = await f.factory.resumeCoreCapturePause(f.pause, new AbortController().signal);
      f.releaseMaintenance();
      maintenance.setRestoreRecoveryRequired(true);
      expect(maintenance.coreCaptureRecoveryRequired()).toBe(true);
      expect(maintenance.backupMaintenanceActive()).toBe(true);
      await expect(proof.recheck()).rejects.toThrow('changed');
    } finally {
      maintenance.setRestoreRecoveryRequired(false);
      await f.close();
    }
  });

  it('keeps a partial consumer restart failed and never retries those starts', async () => {
    const f = await pausedCapture();
    try {
      rabbit.createConsumer.mock.results[1]?.value.start.mockImplementationOnce(() => {
        throw new Error('fixture start failed');
      });
      const running = f.factory.resumeCoreCapturePause(f.pause, new AbortController().signal);
      await expect(running).rejects.toThrow('resumption failed');
      expect(f.factory.resumeCoreCapturePause(f.pause, new AbortController().signal)).toBe(running);
      await expect(running).rejects.toThrow();
      expect(f.starts()).toBe(3);
      expect(maintenance.backupMaintenanceActive()).toBe(true);
      expect(maintenance.coreCaptureRecoveryRequired()).toBe(true);
    } finally {
      await f.close();
    }
  });

  it('cancels stalled broker observations and never restarts consumers during shutdown', async () => {
    const f = await pausedCapture();
    try {
      rabbit.queueDeclare.mockImplementation(() => new Promise(() => undefined));
      const abort = new AbortController();
      const running = f.factory.resumeCoreCapturePause(f.pause, abort.signal);
      const rejected = expect(running).rejects.toThrow();
      await f.factory.onModuleDestroy();
      await rejected;
      expect(f.starts()).toBe(0);
      expect(maintenance.backupMaintenanceActive()).toBe(true);
    } finally {
      await f.close();
    }
  });

  it('retains capture-held registrations and resumes only those consumers once after clearance', async () => {
    const held = vi.spyOn(maintenance, 'coreCaptureRecoveryRequired').mockReturnValue(true);
    try {
      const factory = new QueueFactory(loggerService, configurationService);
      for (const name of ['app-events-queue', 'repo-queue', 'system-events-queue']) {
        const queue = await factory.createQueue({ queueName: name, eventSchema: type({ event: 'string' }) });
        queue.onEvent(vi.fn());
      }
      expect(rabbit.createConsumer).not.toHaveBeenCalled();
      expect(() => factory.resumeCoreCaptureConsumers()).toThrow('unavailable');
      expect(rabbit.createConsumer).not.toHaveBeenCalled();
      held.mockReturnValue(false);
      factory.resumeCoreCaptureConsumers();
      factory.resumeCoreCaptureConsumers();
      expect(rabbit.createConsumer).toHaveBeenCalledTimes(3);
      expect(rabbit.createConsumer.mock.calls.map(([options]) => (options as { queue: string }).queue)).toEqual([
        'app-events-queue',
        'repo-queue',
        'system-events-queue',
      ]);
      await factory.onModuleDestroy();
      expect(() => factory.resumeCoreCaptureConsumers()).toThrow('unavailable');
    } finally {
      held.mockRestore();
    }
  });

  it('verifies exact capture consumers under the held connection and refuses a lost hold or generation', async () => {
    const factory = new QueueFactory(loggerService, configurationService);
    for (const name of ['app-events-queue', 'repo-queue', 'system-events-queue'])
      await factory.createQueue({ queueName: name, eventSchema: type({ event: 'string' }) });
    const release = await maintenance.acquireBackupMaintenance(new AbortController().signal);
    try {
      rabbit.queueDeclare.mockResolvedValue({ messageCount: 0, consumerCount: 1 });
      const proof = await factory.verifyCoreCaptureConsumers(new AbortController().signal);
      expect(proof.queueGeneration).toBe(1);
      expect(proof.queues).toEqual(['app-events-queue', 'repo-queue', 'system-events-queue'].map((name) => ({ name, messages: 0, consumers: 1 })));
      await proof.recheck();
      Object.assign(factory, { connectionGeneration: 2 });
      await expect(proof.recheck()).rejects.toThrow('changed');
      Object.assign(factory, { connectionGeneration: 1 });
      release();
      await expect(proof.recheck()).rejects.toThrow('changed');
    } finally {
      release();
      await factory.onModuleDestroy();
    }
  });

  it('rejects unexpected capture queue work, duplicate consumers and cancellation without releasing maintenance', async () => {
    const factory = new QueueFactory(loggerService, configurationService);
    for (const name of ['app-events-queue', 'repo-queue', 'system-events-queue'])
      await factory.createQueue({ queueName: name, eventSchema: type({ event: 'string' }) });
    const release = await maintenance.acquireBackupMaintenance(new AbortController().signal);
    try {
      for (const state of [
        { messageCount: 1, consumerCount: 1 },
        { messageCount: 0, consumerCount: 2 },
        { messageCount: 0, consumerCount: true },
      ]) {
        rabbit.queueDeclare.mockResolvedValue(state);
        await expect(factory.verifyCoreCaptureConsumers(new AbortController().signal)).rejects.toThrow('not idle');
      }
      const abort = new AbortController();
      abort.abort();
      await expect(factory.verifyCoreCaptureConsumers(abort.signal)).rejects.toThrow();
      expect(maintenance.backupMaintenanceActive()).toBe(true);
    } finally {
      release();
      await factory.onModuleDestroy();
    }
  });

  it('waits for an active worker and its confirmed event before closing resources exactly once', async () => {
    const factory = new QueueFactory(loggerService, configurationService);
    const queue = await factory.createQueue({ queueName: 'active', eventSchema: type({ event: 'string' }) });
    const worker = Promise.withResolvers<void>();
    const confirmation = Promise.withResolvers<void>();
    const callback = vi.fn(async () => worker.promise);
    queue.onEvent(callback);
    const consumer = rabbit.createConsumer.mock.results[0]?.value;
    const handler = rabbit.createConsumer.mock.calls[0]?.[1];
    const publisher = rabbit.createPublisher.mock.results[0]?.value;
    const rpc = rabbit.createRPCClient.mock.results[0]?.value;
    if (!consumer || !handler || !publisher || !rpc) throw new Error('Missing fixture');
    publisher.send.mockImplementationOnce(() => confirmation.promise);
    const running = handler({ body: { event: 'active' } } as Parameters<ConsumerHandler>[0], vi.fn());
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
    const shutdown = factory.onModuleDestroy();
    expect(factory.onModuleDestroy()).toBe(shutdown);
    expect(await queue.publish({ event: 'later' })).toMatchObject({ success: false, message: expect.stringContaining('shutting down') });
    expect(consumer.close).not.toHaveBeenCalled();
    expect(rpc.close).not.toHaveBeenCalled();
    worker.resolve();
    await vi.waitFor(() => expect(publisher.send).toHaveBeenCalledOnce());
    expect(consumer.close).not.toHaveBeenCalled();
    confirmation.resolve();
    await running;
    await shutdown;
    expect(consumer.close).toHaveBeenCalledOnce();
    expect(rpc.close).toHaveBeenCalledOnce();
    expect(publisher.close).toHaveBeenCalledOnce();
    expect(rabbit.close).toHaveBeenCalledOnce();
    expect(consumer.close.mock.invocationCallOrder[0]).toBeLessThan(rpc.close.mock.invocationCallOrder[0] as number);
    expect(publisher.close.mock.invocationCallOrder[0]).toBeLessThan(rabbit.close.mock.invocationCallOrder[0] as number);
    expect(await handler({ body: { event: 'late' } } as Parameters<ConsumerHandler>[0], vi.fn())).toBe(1);
    expect(callback).toHaveBeenCalledOnce();
    expect(() => queue.onEvent(vi.fn())).toThrow('shutting down');
    await expect(factory.createQueue({ queueName: 'late', eventSchema: type({ event: 'string' }) })).rejects.toThrow('shutting down');
  });

  it('keeps cross-queue RPC available to an admitted worker while rejecting outside dispatch', async () => {
    const factory = new QueueFactory(loggerService, configurationService);
    const source = await factory.createQueue({ queueName: 'source', eventSchema: type({ event: 'string' }) });
    const target = await factory.createQueue({ queueName: 'target', eventSchema: type({ event: 'string' }) });
    const continueWorker = Promise.withResolvers<void>();
    let childResult: unknown;
    source.onEvent(async () => {
      await continueWorker.promise;
      childResult = await target.publish({ event: 'child' });
    });
    const child = vi.fn(async (_data, reply) => reply({ success: true, message: 'child finished' }));
    target.onEvent(child);
    const sourceHandler = rabbit.createConsumer.mock.calls[0]?.[1];
    const targetHandler = rabbit.createConsumer.mock.calls[1]?.[1];
    const targetRPC = rabbit.createRPCClient.mock.results[1]?.value;
    if (!sourceHandler || !targetHandler || !targetRPC) throw new Error('Missing fixture');
    targetRPC.send.mockImplementation(async (_queue: string, body: unknown) => {
      let result: unknown;
      await targetHandler({ body } as Parameters<ConsumerHandler>[0], async (value) => {
        result = value;
      });
      return { body: result };
    });
    const running = sourceHandler({ body: { event: 'parent' } } as Parameters<ConsumerHandler>[0], vi.fn());
    await Promise.resolve();
    const stopping = factory.onModuleDestroy();
    expect(await target.publish({ event: 'outside' })).toMatchObject({ success: false });
    continueWorker.resolve();
    await running;
    await stopping;
    expect(childResult).toEqual({ success: true, message: 'child finished' });
    expect(child).toHaveBeenCalledOnce();
    expect(targetRPC.send).toHaveBeenCalledOnce();
    expect(targetRPC.close).toHaveBeenCalledOnce();
  });

  it('awaits an admitted RPC and the consumer close promise before closing the connection', async () => {
    const factory = new QueueFactory(loggerService, configurationService);
    const queue = await factory.createQueue({ queueName: 'pending', eventSchema: type({ event: 'string' }) });
    queue.onEvent(vi.fn());
    const rpc = rabbit.createRPCClient.mock.results[0]?.value;
    const consumer = rabbit.createConsumer.mock.results[0]?.value;
    if (!rpc || !consumer) throw new Error('Missing fixture');
    const response = Promise.withResolvers<{ body: { success: boolean; message: string } }>();
    const consumerClosed = Promise.withResolvers<void>();
    rpc.send.mockImplementationOnce(() => response.promise);
    consumer.close.mockImplementationOnce(() => consumerClosed.promise);
    const publishing = queue.publish({ event: 'admitted' });
    await vi.waitFor(() => expect(rpc.send).toHaveBeenCalledOnce());
    const stopping = factory.onModuleDestroy();
    expect(consumer.close).not.toHaveBeenCalled();
    response.resolve({ body: { success: true, message: 'finished' } });
    expect(await publishing).toMatchObject({ success: true });
    await vi.waitFor(() => expect(consumer.close).toHaveBeenCalledOnce());
    expect(rpc.close).not.toHaveBeenCalled();
    expect(rabbit.close).not.toHaveBeenCalled();
    consumerClosed.resolve();
    await stopping;
    expect(rpc.close).toHaveBeenCalledOnce();
    expect(rabbit.close).toHaveBeenCalledOnce();
  });

  it('does not report shutdown settled or close the connection when consumer closure fails', async () => {
    const factory = new QueueFactory(loggerService, configurationService);
    const queue = await factory.createQueue({ queueName: 'failure', eventSchema: type({ event: 'string' }) });
    queue.onEvent(vi.fn());
    const consumer = rabbit.createConsumer.mock.results[0]?.value;
    if (!consumer) throw new Error('Missing consumer');
    consumer.close.mockRejectedValueOnce(new Error('fixture consumer close failed'));
    await expect(factory.onModuleDestroy()).rejects.toThrow('consumer close failed');
    expect(rabbit.close).not.toHaveBeenCalled();
    expect(await queue.publish({ event: 'later' })).toMatchObject({ success: false });
  });

  it('does not reopen capture-paused consumers when their hold is released during shutdown', async () => {
    const factory = new QueueFactory(loggerService, configurationService);
    for (const queueName of ['app-events-queue', 'repo-queue', 'system-events-queue']) {
      const queue = await factory.createQueue({ queueName, eventSchema: type({ event: 'string' }) });
      queue.onEvent(vi.fn());
    }
    const capture = await factory.pauseForBackup(new AbortController().signal);
    const stopping = factory.onModuleDestroy();
    capture.release();
    await stopping;
    for (const result of rabbit.createConsumer.mock.results) {
      expect(result.value.close).toHaveBeenCalledOnce();
      expect(result.value.start).not.toHaveBeenCalled();
    }
  });

  it('cancels pending initialization and rejects queue creation without later resurrection', async () => {
    rabbit.ready = false;
    const factory = new QueueFactory(loggerService, configurationService);
    const pending = factory.createQueue({ queueName: 'pending', eventSchema: type({ event: 'string' }) });
    const rejection = expect(pending).rejects.toThrow();
    await factory.onModuleDestroy();
    await rejection;
    rabbit.ready = true;
    const connected = rabbit.on.mock.calls.find(([event]) => event === 'connection')?.[1];
    if (!connected) throw new Error('Missing connection listener');
    connected();
    expect(factory.isReady()).toBe(false);
    await expect(factory.initializeConnection()).rejects.toThrow('shutting down');
    expect(Connection).toHaveBeenCalledOnce();
    expect(rabbit.close).toHaveBeenCalledOnce();
    expect(rabbit.createRPCClient).not.toHaveBeenCalled();
    expect(rabbit.createConsumer).not.toHaveBeenCalled();
  });

  it('uses the existing reconnecting connection and ignores connection events after shutdown', async () => {
    const factory = new QueueFactory(loggerService, configurationService);
    const disconnected = rabbit.on.mock.calls.find(([event]) => event === 'error')?.[1];
    const connected = rabbit.on.mock.calls.find(([event]) => event === 'connection')?.[1];
    if (!disconnected || !connected) throw new Error('Missing listeners');
    disconnected();
    expect(factory.isReady()).toBe(false);
    connected();
    expect(factory.isReady()).toBe(true);
    await factory.onModuleDestroy();
    disconnected();
    connected();
    expect(factory.isReady()).toBe(false);
    expect(Connection).toHaveBeenCalledOnce();
    expect(rabbit.close).toHaveBeenCalledOnce();
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

  it('allows normal startup with queued work without a retained empty-queue preflight', async () => {
    rabbit.queueDeclare.mockResolvedValue({ messageCount: 9, consumerCount: 0 });
    const factory = new QueueFactory(loggerService, configurationService);
    const queue = await factory.createQueue({ queueName: 'app-events-queue', eventSchema: type({ event: 'string' }) });
    queue.onEvent(vi.fn());
    expect(rabbit.createConsumer).toHaveBeenCalledOnce();
    expect(rabbit.queueDeclare).not.toHaveBeenCalled();
    await factory.onModuleDestroy();
  });

  it('registers a repeatable event only once per queue and stops timers on shutdown', async () => {
    vi.useFakeTimers();
    const factory = new QueueFactory(loggerService, configurationService);
    const queue = await factory.createQueue({ queueName: 'repeat-fixture', eventSchema: type({ event: 'string' }) });
    queue.publishRepeatable({ event: 'refresh' }, '*/15 * * * *');
    queue.publishRepeatable({ event: 'refresh' }, '*/15 * * * *');
    expect(vi.getTimerCount()).toBe(1);
    const stopping = factory.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
    await stopping;
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

  it('resumes deferred consumers after settlement without an empty-queue check', async () => {
    const { factory, app } = await resumeQueues();
    setRestoreRecoveryRequired(true);
    try {
      rabbit.queueDeclare.mockClear();
      factory.resumeRetainedAfterSettlement();
      factory.resumeRetainedAfterSettlement();
      expect(rabbit.queueDeclare).not.toHaveBeenCalled();
      expect(rabbit.createConsumer).toHaveBeenCalledTimes(3);
      expect((await app.publish({ event: 'start' })).success).toBe(false);
    } finally {
      setRestoreRecoveryRequired(false);
    }
  });

  it('prepares exactly three retained consumers under a mutation hold with a stable broker generation', async () => {
    const { factory, app } = await resumeQueues();
    setRestoreRecoveryRequired(true);
    try {
      rabbit.queueDeclare.mockImplementation(async ({ queue }: { queue: string }) => ({
        messageCount: 0,
        consumerCount: rabbit.createConsumer.mock.calls.filter(([options]) => (options as { queue: string }).queue === queue).length,
      }));
      const result = await factory.prepareRetainedConsumers(new AbortController().signal);
      expect(result.queueGeneration).toBeGreaterThan(0);
      expect(result.queues.map((item) => item.name)).toEqual(['app-events-queue', 'repo-queue', 'system-events-queue']);
      expect(rabbit.createConsumer).toHaveBeenCalledTimes(3);
      await result.recheck();
      expect((await app.publish({ event: 'start' })).success).toBe(false);
      const handler = rabbit.createConsumer.mock.calls[0]?.[1] as unknown as (
        request: { body: { requestId: string } },
        reply: () => Promise<void>,
      ) => Promise<void>;
      if (!handler) throw new Error('Missing retained consumer');
      let finished = false;
      const pending = handler({ body: { requestId: 'fixture' } }, async () => undefined).then(() => {
        finished = true;
      });
      await Promise.resolve();
      expect(finished).toBe(false);
      await expect(factory.prepareRetainedConsumers(new AbortController().signal)).rejects.toThrow();
      setRestoreRecoveryRequired(false);
      await pending;
      expect(finished).toBe(true);
    } finally {
      setRestoreRecoveryRequired(false);
    }
  });
  it('refuses retained consumers without the hold or with queued work', async () => {
    const { factory } = await resumeQueues();
    await expect(factory.prepareRetainedConsumers(new AbortController().signal)).rejects.toThrow();
    setRestoreRecoveryRequired(true);
    try {
      rabbit.queueDeclare.mockResolvedValue({ messageCount: 1, consumerCount: 0 });
      await expect(factory.prepareRetainedConsumers(new AbortController().signal)).rejects.toThrow();
      expect(rabbit.createConsumer).not.toHaveBeenCalled();
    } finally {
      setRestoreRecoveryRequired(false);
    }
  });
  it('fails closed if the broker reconnects during retained preparation', async () => {
    const { factory } = await resumeQueues();
    setRestoreRecoveryRequired(true);
    try {
      rabbit.queueDeclare.mockImplementationOnce(async () => {
        const listener = rabbit.on.mock.calls.find(([event]) => event === 'connection')?.[1];
        if (!listener) throw new Error('Missing connection listener');
        listener();
        return { messageCount: 0, consumerCount: 0 };
      });
      await expect(factory.prepareRetainedConsumers(new AbortController().signal)).rejects.toThrow();
      expect(rabbit.createConsumer).not.toHaveBeenCalled();
      await expect(factory.prepareRetainedConsumers(new AbortController().signal)).rejects.toThrow();
    } finally {
      setRestoreRecoveryRequired(false);
    }
  });
  it('rejects a retained readiness recheck after a broker reconnect', async () => {
    const { factory } = await resumeQueues();
    setRestoreRecoveryRequired(true);
    try {
      rabbit.queueDeclare.mockImplementation(async ({ queue }: { queue: string }) => ({
        messageCount: 0,
        consumerCount: rabbit.createConsumer.mock.calls.filter(([options]) => (options as { queue: string }).queue === queue).length,
      }));
      const result = await factory.prepareRetainedConsumers(new AbortController().signal);
      const listener = rabbit.on.mock.calls.find(([event]) => event === 'connection')?.[1];
      if (!listener) throw new Error('Missing connection listener');
      listener();
      await expect(result.recheck()).rejects.toThrow();
    } finally {
      setRestoreRecoveryRequired(false);
    }
  });
  it('cancels a stalled broker declaration without starting consumers', async () => {
    const { factory } = await resumeQueues();
    setRestoreRecoveryRequired(true);
    try {
      rabbit.queueDeclare.mockImplementationOnce(() => new Promise(() => undefined));
      const abort = new AbortController();
      const running = factory.prepareRetainedConsumers(abort.signal);
      abort.abort();
      await expect(running).rejects.toThrow();
      expect(rabbit.createConsumer).not.toHaveBeenCalled();
    } finally {
      setRestoreRecoveryRequired(false);
    }
  });
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

  it.each([
    { pending: 'repo-queue', messageCount: 1, consumerCount: 0 },
    { pending: 'repo-queue', messageCount: 0, consumerCount: 1 },
    { pending: 'system-events-queue', messageCount: 1, consumerCount: 0 },
    { pending: 'system-events-queue', messageCount: 0, consumerCount: 1 },
  ])('refuses $pending work or another consumer before resume', async ({ pending, messageCount, consumerCount }) => {
    const { factory, app } = await resumeQueues();
    rabbit.queueDeclare.mockImplementation(async ({ queue }: { queue: string }) => ({
      messageCount: queue === pending ? messageCount : 0,
      consumerCount: queue === pending ? consumerCount : 0,
    }));
    await expect(factory.prepareInstallationResume()).rejects.toThrow('other queue work');
    expect(rabbit.createConsumer).not.toHaveBeenCalled();
    expect((await app.publish({ event: 'update' })).success).toBe(false);
  });

  it('does not consume historical app commands when resuming a restored candidate', async () => {
    vi.spyOn(restoreStartup, 'restoreStartupRole').mockReturnValue('candidate');
    const { factory, app } = await resumeQueues();
    rabbit.queueDeclare.mockResolvedValue({ messageCount: 1, consumerCount: 0 });
    await expect(factory.prepareInstallationResume()).rejects.toThrow('app commands or another app consumer');
    expect(rabbit.createConsumer).not.toHaveBeenCalled();
    expect((await app.publish({ event: 'update' })).success).toBe(false);
    vi.restoreAllMocks();
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
