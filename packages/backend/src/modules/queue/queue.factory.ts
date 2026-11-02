import { randomUUID } from 'node:crypto';
import type { QueueCaptureCheck } from '../system-backups/time-machine-capture-coherence';
import { setTimeout } from 'node:timers/promises';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { type } from 'arktype';
import { Connection } from 'rabbitmq-client';
import { EventPublisher } from './event.publisher';
import { type ArkTypeSchema, Queue, type QueueObserver } from './queue.entity';
import { installationMode } from '@/common/installation-mode';
import { backupMaintenanceActive, setBackupRecoveryRequired } from '@/common/backup-maintenance';

@Injectable()
export class QueueFactory {
  private rabbit: Connection;
  private connectionAttempts = 0;
  private connectionGeneration = 0;
  private isInitialized = false;
  private initializationPromise: Promise<void> | null = null;
  private queues = new Map<
    string,
    {
      resumeAfterInstallation: () => void;
      stopRepeatables: () => void;
      pauseForBackup: () => { drain: (signal: AbortSignal) => Promise<void>; release: () => void };
    }
  >();
  private captureHeld = false;
  private installationPrepared = false;
  private installationCompleted = false;
  private retainedBootstrapAttempted = false;

  public async pauseForBackup(signal: AbortSignal) {
    if (this.captureHeld || installationMode().phase !== 'normal' || !this.isReady()) throw new Error('Queue capture is unavailable.');
    const required = ['app-events-queue', 'repo-queue', 'system-events-queue'];
    if (this.queues.size !== required.length || required.some((name) => !this.queues.has(name)))
      throw new Error('Queue capture coverage is incomplete.');
    const connection = this.rabbit;
    const generation = this.connectionGeneration;
    const pauseId = randomUUID();
    this.captureHeld = true;
    const paused: ReturnType<Queue<ArkTypeSchema, ArkTypeSchema<{ success: boolean; message: string }>>['pauseForBackup']>[] = [];
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const failures: unknown[] = [];
      for (const queue of [...paused].reverse()) {
        try {
          queue.release();
        } catch (error) {
          failures.push(error);
        }
      }
      this.captureHeld = false;
      if (failures.length) {
        setBackupRecoveryRequired(true);
        throw new AggregateError(failures, 'Queue capture resumption failed.');
      }
    };
    const verify = async () => {
      signal.throwIfAborted();
      if (released || !this.isReady() || this.rabbit !== connection || this.connectionGeneration !== generation)
        throw new Error('Queue connection changed during capture.');
      for (const name of required) {
        const state = await this.rabbit.queueDeclare({ queue: name, durable: true, autoDelete: false });
        signal.throwIfAborted();
        if (state.messageCount !== 0 || state.consumerCount !== 0)
          throw new Error('Queued commands or another consumer prevent a consistent capture. Retry after they finish.');
      }
      if (released || !this.isReady() || this.rabbit !== connection || this.connectionGeneration !== generation)
        throw new Error('Queue connection changed during capture.');
      return {
        pauseId,
        generation,
        checkedAt: Date.now(),
        queues: required.map((name) => ({ name: name as QueueCaptureCheck['queues'][number]['name'], messages: 0 as const, consumers: 0 as const })),
      };
    };
    try {
      // Close every publisher before awaiting any drain, so cross-queue jobs cannot add later work.
      for (const name of required) {
        signal.throwIfAborted();
        const queue = this.queues.get(name);
        if (!queue) throw new Error('Queue capture coverage changed.');
        paused.push(queue.pauseForBackup());
      }
      for (const queue of paused) {
        await queue.drain(signal);
        signal.throwIfAborted();
      }
      const initial = await verify();
      return { initial, verify, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  private async requireIdleApplicationQueue() {
    if (!this.queues.has('app-events-queue')) throw new Error('Application queue is not initialized.');
    const state = await this.rabbit.queueDeclare({ queue: 'app-events-queue', durable: true, autoDelete: false });
    if (state.messageCount !== 0 || state.consumerCount !== 0) {
      throw new Error('Installation cannot resume while app commands or another app consumer remain in the queue.');
    }
  }

  public async prepareInstallationResume() {
    if (installationMode().phase !== 'resume' || this.installationPrepared) return;
    await this.requireIdleApplicationQueue();
    for (const name of ['repo-queue', 'system-events-queue']) {
      if (!this.queues.has(name)) throw new Error('Installation queue coverage is incomplete.');
      const state = await this.rabbit.queueDeclare({ queue: name, durable: true, autoDelete: false });
      if (state.messageCount !== 0 || state.consumerCount !== 0) throw new Error('Installation cannot resume while other queue work remains.');
    }
    this.queues.get('repo-queue')?.resumeAfterInstallation();
    this.queues.get('system-events-queue')?.resumeAfterInstallation();
    this.installationPrepared = true;
  }

  public async completeInstallationResume() {
    if (installationMode().phase !== 'resume' || this.installationCompleted) return;
    if (!this.installationPrepared) throw new Error('Installation queues have not passed preflight.');
    await this.requireIdleApplicationQueue();
    this.queues.get('app-events-queue')?.resumeAfterInstallation();
    this.installationCompleted = true;
  }

  /** Starts only the known consumers while the caller retains the restore mutation hold. */
  public async prepareRetainedConsumers(signal: AbortSignal) {
    const names = ['app-events-queue', 'repo-queue', 'system-events-queue'] as const;
    if (
      this.retainedBootstrapAttempted ||
      installationMode().phase !== 'resume' ||
      !backupMaintenanceActive() ||
      !this.isReady() ||
      this.queues.size !== names.length ||
      names.some((name) => !this.queues.has(name)) ||
      !Number.isSafeInteger(this.connectionGeneration) ||
      this.connectionGeneration < 1
    )
      throw new Error('Retained queue bootstrap is unavailable.');
    this.retainedBootstrapAttempted = true;
    const connection = this.rabbit;
    const generation = this.connectionGeneration;
    const lifetime = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const verifyConnection = () => {
      lifetime.throwIfAborted();
      if (!backupMaintenanceActive() || !this.isReady() || this.rabbit !== connection || this.connectionGeneration !== generation)
        throw new Error('Retained queue bootstrap changed.');
    };
    const read = async (name: (typeof names)[number]) => {
      verifyConnection();
      const operation = connection.queueDeclare({ queue: name, durable: true, autoDelete: false });
      let cancelled: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        cancelled = () => reject(new Error('Retained queue bootstrap was cancelled.'));
        lifetime.addEventListener('abort', cancelled, { once: true });
        if (lifetime.aborted) cancelled();
      });
      let state: Awaited<typeof operation>;
      try {
        state = await Promise.race([operation, aborted]);
      } finally {
        if (cancelled) lifetime.removeEventListener('abort', cancelled);
      }
      verifyConnection();
      if (
        !Number.isSafeInteger(state.messageCount) ||
        !Number.isSafeInteger(state.consumerCount) ||
        state.messageCount !== 0 ||
        state.consumerCount < 0 ||
        state.consumerCount > 1
      )
        throw new Error('Retained queue bootstrap is not idle.');
      return state.consumerCount;
    };
    for (const name of names) if ((await read(name)) !== 0) throw new Error('Retained queue already has a consumer.');
    verifyConnection();
    for (const name of names) this.queues.get(name)?.resumeAfterInstallation();
    const deadline = Date.now() + 30_000;
    while (true) {
      const counts = await Promise.all(names.map(read));
      if (counts.every((count) => count === 1)) break;
      if (Date.now() >= deadline) throw new Error('Retained queue consumers did not become ready.');
      await setTimeout(100, undefined, { signal: lifetime });
    }
    verifyConnection();
    return {
      queueGeneration: generation,
      queues: names.map((name) => ({ name, messagesReady: 0 as const, consumers: 1 as const })),
      recheck: async () => {
        verifyConnection();
        if ((await Promise.all(names.map(read))).some((count) => count !== 1)) throw new Error('Retained queue consumers changed.');
        verifyConnection();
      },
    };
  }

  public resumeRetainedAfterSettlement() {
    const names = ['app-events-queue', 'repo-queue', 'system-events-queue'];
    if (
      installationMode().phase !== 'resume' ||
      !backupMaintenanceActive() ||
      !this.isReady() ||
      this.queues.size !== names.length ||
      names.some((name) => !this.queues.has(name))
    )
      throw new Error('Retained queue continuation is unavailable.');
    for (const name of names) this.queues.get(name)?.resumeAfterInstallation();
  }

  public onModuleDestroy() {
    for (const queue of this.queues.values()) queue.stopRepeatables();
  }

  public constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigurationService,
  ) {
    this.initializeConnection();
  }

  public async initializeConnection() {
    // Prevent multiple simultaneous initialization attempts
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = this.doInitialize();
    return this.initializationPromise;
  }

  private async doInitialize() {
    const { host, password, username } = this.config.get('queue');

    this.rabbit = new Connection({
      hostname: host,
      username,
      password,
      connectionTimeout: 30000,
      heartbeat: 60,
    });

    this.rabbit.on('connection', () => {
      this.connectionGeneration++;
      this.connectionAttempts = 0;
      this.isInitialized = true;
      this.logger.info('Connected to the queue');
    });

    this.rabbit.on('error', async (error) => {
      this.logger.error('Queue connection error', error);
      this.isInitialized = false;
      this.reconnect(error);
    });

    // Wait for the connection to be ready
    await this.waitForConnection();
  }

  private async waitForConnection(maxWaitTime = 30000) {
    const startTime = Date.now();

    while (!this.rabbit.ready && Date.now() - startTime < maxWaitTime) {
      await setTimeout(1000);
    }

    if (!this.rabbit.ready) {
      throw new Error('Failed to connect to RabbitMQ within timeout period');
    }
  }

  public getConnection() {
    return this.rabbit;
  }

  public isReady() {
    return this.isInitialized && this.rabbit?.ready;
  }

  // Re-establish connection to Queue with exponential backoff
  public async reconnect(error: Error) {
    if (this.connectionAttempts > 5) {
      this.logger.error('Queue connection lost, exceeded maximum reconnection attempts');
      Sentry.captureException(error, { tags: { source: 'rabbitmq' } });

      return error;
    }

    this.connectionAttempts++;
    this.logger.warn(`Queue connection lost, attempting to reconnect... (attempt ${this.connectionAttempts}/5)`);

    const timeout = 2 ** this.connectionAttempts * 1000;
    await setTimeout(timeout);

    // Reset the initialization promise to allow re-initialization
    this.initializationPromise = null;
    this.isInitialized = false;

    await this.initializeConnection();
  }

  public async createQueue<T extends ArkTypeSchema>(params: {
    queueName: string;
    workers?: number;
    eventSchema: T;
    timeout?: number;
    observer?: QueueObserver<T['infer']>;
  }) {
    if (this.captureHeld) throw new Error('Queues cannot be added during capture.');
    // Ensure connection is ready before creating queue
    if (!this.isReady()) {
      this.logger.warn('Queue connection not ready, waiting for initialization...');
      await this.initializeConnection();
    }

    const publisher = new EventPublisher(this.rabbit, this.logger, params.queueName);
    const resultSchema = type({ success: 'boolean', message: 'string' });
    publisher.initialize();

    const { queueName, workers = 3, eventSchema, timeout } = params;

    const rpcClient = this.rabbit.createRPCClient({
      timeout,
      confirm: true,
      maxAttempts: 3,
      queues: [{ autoDelete: false, durable: true, queue: queueName }],
    });

    const queue = new Queue(this.rabbit, rpcClient, publisher, queueName, workers, eventSchema, resultSchema, this.logger, params.observer);
    this.queues.set(queueName, queue);
    return queue;
  }
}
