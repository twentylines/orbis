import { AsyncLocalStorage } from 'node:async_hooks';
import type { LoggerService } from '@/core/logger/logger.service';
import * as Sentry from '@sentry/nestjs';
import { AMQPConnectionError, AMQPError, ConsumerStatus, type Connection, type RPCClient, type Consumer } from 'rabbitmq-client';
import { type } from 'arktype';
import { scheduleCron, validateCronPattern, type ScheduledCronTask } from './cron-scheduler';
import type { EventPublisher } from './event.publisher';
import { INSTALLATION_MESSAGE, installationHeld, installationMode } from '@/common/installation-mode';
import { backupMaintenanceActive, enterBackupMutation, waitForBackupMutation } from '@/common/backup-maintenance';

export type ArkTypeSchema<TOut = unknown, TIn = unknown> = {
  (data: TIn): TOut | type.errors;
  infer: TOut;
  inferIn?: TIn;
};

type Infer<T extends { infer: unknown }> = T['infer'];
type InferIn<T extends { infer: unknown; inferIn?: unknown }> = T extends { inferIn: infer I } ? I : T['infer'];
export type QueueObserver<T> = { queued: (event: T) => Promise<void>; unconfirmed: (event: T) => Promise<void> };

export class QueueLifecycle {
  public stopping = false;
  private sealed = false;
  private active = 0;
  private readonly idle = new Set<() => void>();
  private readonly worker = new AsyncLocalStorage<{ active: boolean }>();

  private enter() {
    this.active++;
    return () => {
      this.active--;
      if (!this.active) {
        for (const notify of this.idle) notify();
        this.idle.clear();
      }
    };
  }

  public admitPublication() {
    if (this.sealed || (this.stopping && !this.worker.getStore()?.active)) return;
    return this.enter();
  }

  public async runWorker(callback: () => Promise<void>) {
    if (this.sealed) return ConsumerStatus.REQUEUE;
    const leave = this.enter();
    const context = { active: true };
    try {
      await this.worker.run(context, callback);
    } finally {
      context.active = false;
      leave();
    }
  }

  public async drainAndSeal() {
    while (this.active) await new Promise<void>((resolve) => this.idle.add(resolve));
    // Seal synchronously with the idle check; late deliveries must be requeued.
    this.sealed = true;
  }
}

export class Queue<T extends ArkTypeSchema, R extends ArkTypeSchema<{ success: boolean; message: string }>> {
  private enabled = installationMode().phase === 'normal';
  private deferredConsumer?: () => void;
  private consumer?: Consumer;
  private backupPaused = false;
  private admittedPublications = 0;
  private readonly publicationsDrained = new Set<() => void>();
  private readonly repeatables = new Map<string, ScheduledCronTask>();
  private consumerClose?: Promise<void>;
  private resourcesClose?: Promise<void>;

  public pauseForBackup() {
    if (this.lifecycle.stopping) throw new Error('Queue is shutting down.');
    if (this.backupPaused) throw new Error('Queue capture is already in progress.');
    this.backupPaused = true;
    let released = false;
    return {
      drain: async (signal: AbortSignal) => {
        signal.throwIfAborted();
        while (this.admittedPublications) {
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
              this.publicationsDrained.delete(finished);
              signal.removeEventListener('abort', cancelled);
            };
            const finished = () => {
              cleanup();
              resolve();
            };
            const cancelled = () => {
              cleanup();
              reject(new Error('Queue capture cancelled.'));
            };
            this.publicationsDrained.add(finished);
            signal.addEventListener('abort', cancelled, { once: true });
          });
        }
        signal.throwIfAborted();
        if (!this.consumer) throw new Error('Queue consumer is unavailable for capture.');
        await this.closeConsumer();
      },
      release: () => {
        if (released) return;
        released = true;
        if (!this.lifecycle.stopping) {
          this.consumerClose = undefined;
          this.consumer?.start();
        }
        this.backupPaused = false;
      },
    };
  }

  constructor(
    private rabbit: Connection,
    private rpcClient: RPCClient,
    private publisher: EventPublisher,
    private queueName: string,
    private workers: number,
    private eventSchema: T,
    private resultSchema: R,
    private logger: LoggerService,
    private observer?: QueueObserver<Infer<T>>,
    private readonly lifecycle = new QueueLifecycle(),
  ) {}

  public resumeAfterInstallation() {
    if (this.lifecycle.stopping) return;
    if (installationMode().phase !== 'resume' || this.enabled) return;
    this.deferredConsumer?.();
    this.deferredConsumer = undefined;
    this.enabled = true;
  }

  private async observe(phase: 'queued' | 'unconfirmed', event: Infer<T>) {
    try {
      await this.observer?.[phase](event);
    } catch {
      this.logger.warn('Task history observer failed; the lifecycle queue remains available.');
    }
  }

  public onEvent(
    callback: (
      data: Infer<T> & { eventId: string },
      reply: (response: InferIn<R>) => Promise<void>,
      delivery?: { redelivered: boolean },
    ) => Promise<void>,
  ) {
    if (this.lifecycle.stopping) throw new Error('Queue is shutting down.');
    if (this.backupPaused) throw new Error('Queue consumers cannot be added during capture.');
    if (installationHeld()) return;
    if (!this.enabled) {
      this.deferredConsumer = () => this.createConsumer(callback);
      return;
    }
    this.createConsumer(callback);
  }

  private createConsumer(callback: Parameters<Queue<T, R>['onEvent']>[0]) {
    try {
      this.consumer = this.rabbit.createConsumer(
        {
          queue: this.queueName,
          concurrency: this.workers,
          queueOptions: { autoDelete: false, durable: true },
        },
        async (req, reply) =>
          this.lifecycle.runWorker(async () => {
            const release = await waitForBackupMutation();
            let rpcSuccess = false;
            let rpcResultMessage = '';

            try {
              await callback(req.body, reply, { redelivered: req.redelivered });
              rpcSuccess = true;
              rpcResultMessage = 'RPC processed successfully.';
            } catch (error) {
              this.logger.error('Error in consumer callback:', error);
              await reply({ success: false, message: (error as Error)?.message } as InferIn<R>);
              rpcSuccess = false;
              rpcResultMessage = error instanceof Error ? error.message : String(error);
            } finally {
              const eventToPublish = {
                queueName: this.queueName,
                requestData: req.body,
                rpcStatus: rpcSuccess ? 'success' : 'failure',
                rpcMessage: rpcResultMessage,
                requestId: req.body.requestId,
                timestamp: new Date().toISOString(),
              };

              const routingKey = `rpc.${rpcSuccess ? 'processed' : 'error'}.${this.queueName}`;
              try {
                await this.publisher.publish(routingKey, eventToPublish);
              } finally {
                release();
              }
            }
          }),
      );
    } catch (error) {
      this.logger.error(`Failed to create consumer for queue ${this.queueName}:`, error);
      Sentry.captureException(error, { tags: { queueName: this.queueName, action: 'onEvent' } });
      throw error;
    }
  }

  async publish(event: unknown): Promise<{ success: boolean; message: string } | Infer<R>> {
    const leave = this.lifecycle.admitPublication();
    if (!leave) return { success: false, message: 'Queue is shutting down. Retry after restart.' };
    try {
      return await this.publishWhileRunning(event);
    } finally {
      leave();
    }
  }

  private async publishWhileRunning(event: unknown): Promise<{ success: boolean; message: string } | Infer<R>> {
    if (!this.enabled) return { success: false, message: INSTALLATION_MESSAGE };
    if (this.backupPaused) return { success: false, message: 'A full backup is draining the queue. Retry when it finishes.' };
    const release = enterBackupMutation();
    if (!release) return { success: false, message: 'A full backup or app recovery is in progress. Retry when it finishes.' };
    this.admittedPublications++;
    try {
      return await this.publishAdmitted(event);
    } finally {
      this.admittedPublications--;
      if (!this.admittedPublications) {
        for (const notify of this.publicationsDrained) notify();
        this.publicationsDrained.clear();
      }
      release();
    }
  }

  private async publishAdmitted(event: unknown): Promise<{ success: boolean; message: string } | Infer<R>> {
    let accepted: Infer<T> | undefined;
    try {
      const eventData = this.eventSchema(event as never);
      if (eventData instanceof type.errors) {
        throw new Error(`Invalid event data: ${eventData.summary}`);
      }
      accepted = eventData;
      await this.observe('queued', eventData);

      const res = await this.rpcClient.send(this.queueName, eventData);
      const response = this.resultSchema(res.body as never);
      if (!(response instanceof type.errors)) {
        return response;
      }

      throw new Error(`Invalid response schema: ${response.summary}`);
    } catch (err) {
      if (accepted !== undefined) await this.observe('unconfirmed', accepted);
      if (err instanceof AMQPConnectionError) {
        this.logger.error('Connection to the queue was lost. Try restarting your instance before retrying.');
      }

      if (err instanceof AMQPError) {
        if (err.code === 'RPC_TIMEOUT') {
          this.logger.error('The queue timed out while processing the request. Try restarting your instance before retrying.');
        }
        return { success: false, message: err.message };
      }

      Sentry.captureException(err, { tags: { queueName: this.queueName } });
      return { success: false, message: String(err) };
    }
  }

  public publishRepeatable(data: unknown, cronPattern: string) {
    if (this.lifecycle.stopping) return;
    if (!this.enabled) return;
    if (!validateCronPattern(cronPattern)) {
      throw new Error('Invalid cron pattern');
    }

    const eventData = this.eventSchema(data as never);
    if (eventData instanceof type.errors) {
      throw new Error(`Invalid event data: ${eventData.summary}`);
    }

    const key = `${cronPattern}\0${JSON.stringify(eventData)}`;
    if (this.repeatables.has(key)) return;
    const scheduled = scheduleCron(cronPattern, async () => {
      if (backupMaintenanceActive()) return;
      try {
        await this.publish(eventData);
      } catch (e) {
        Sentry.captureException(e, { tags: { queueName: this.queueName } });
        this.logger.error('Error in cron job:', e);
      }
    });
    this.repeatables.set(key, scheduled);
  }

  public stopRepeatables() {
    for (const task of this.repeatables.values()) task.stop();
    this.repeatables.clear();
  }

  public closeConsumer() {
    this.consumerClose ??= this.consumer?.close() ?? Promise.resolve();
    return this.consumerClose;
  }

  public closeResources() {
    this.resourcesClose ??= Promise.all([this.rpcClient.close(), this.publisher.close()]).then(() => undefined);
    return this.resourcesClose;
  }
}
