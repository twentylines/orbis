import { randomUUID } from 'node:crypto';
import type { QueueCaptureCheck } from '../system-backups/time-machine-capture-coherence';
import { setTimeout } from 'node:timers/promises';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';
import { type } from 'arktype';
import { Connection } from 'rabbitmq-client';
import { EventPublisher } from './event.publisher';
import { type ArkTypeSchema, Queue, QueueLifecycle, type QueueObserver, queueCaptureWasRefused } from './queue.entity';
import { installationMode } from '@/common/installation-mode';
import {
  backupMaintenanceActive,
  backupMaintenanceLeaseHeld,
  coreCaptureRecoveryRequired,
  setBackupRecoveryRequired,
} from '@/common/backup-maintenance';

type CapturePauseContinuation = {
  pauseId: string;
  queueGeneration: number;
  queues: { name: string; messages: 0; consumers: 1 }[];
  recheck: () => Promise<void>;
};
export type CaptureSetupUnwind = {
  pauseId: string;
  generation: number;
  queues: { name: string; messages: 0; consumers: 1 }[];
  recheck: () => Promise<void>;
};
declare const captureSetupScope: unique symbol;
export type CoreCaptureQueueSetup = Readonly<{ [captureSetupScope]: true; pauseForBackup: QueueFactory['pauseForBackup'] }>;
export type CaptureSetupRefusal = {
  setupId: string;
  outcome: 'not-entered' | 'queue-refused';
  generation: number;
  queues: readonly Readonly<{ name: string; messages: 0; consumers: 1 }>[];
  recheck: () => Promise<void>;
};

@Injectable()
export class QueueFactory {
  private rabbit: Connection;
  private connectionGeneration = 0;
  private isInitialized = false;
  private initializationPromise: Promise<void> | null = null;
  private queues = new Map<
    string,
    {
      resumeAfterInstallation: () => void;
      resumeAfterCoreCapture: () => void;
      stopRepeatables: () => void;
      closeConsumer: () => Promise<void>;
      closeResources: () => Promise<void>;
      pauseForBackup: () => { drain: (signal: AbortSignal) => Promise<void>; release: () => void };
      captureSetupIsIdle: () => boolean;
    }
  >();
  private captureHeld = false;
  private installationPrepared = false;
  private installationCompleted = false;
  private retainedBootstrapAttempted = false;
  private readonly lifecycle = new QueueLifecycle();
  private readonly shutdownSignal = new AbortController();
  private shutdownPromise?: Promise<void>;
  private readonly captureResumptions = new WeakMap<object, (signal: AbortSignal) => Promise<CapturePauseContinuation>>();
  private readonly captureRechecks = new WeakMap<object, (signal: AbortSignal) => Promise<QueueCaptureCheck>>();
  private captureGeneration = 0;
  private readonly captureUnwinds = new WeakMap<object, (signal: AbortSignal) => Promise<CaptureSetupUnwind>>();
  private readonly setupRefusals = new WeakSet<object>();
  private readonly setupScopes = new WeakMap<
    CoreCaptureQueueSetup,
    {
      id: string;
      sealed: boolean;
      phase: 'unused' | 'running' | 'owned' | 'refused' | 'unknown';
    }
  >();

  private refuseSetup(message: string) {
    const failure = new Error(message);
    this.setupRefusals.add(failure);
    return failure;
  }

  public createCoreCaptureQueueSetup(): CoreCaptureQueueSetup {
    const state = { id: randomUUID(), sealed: false, phase: 'unused' as 'unused' | 'running' | 'owned' | 'refused' | 'unknown' };
    const scope = Object.freeze({
      pauseForBackup: async (signal: AbortSignal) => {
        if (state.sealed || state.phase !== 'unused') throw new Error('Queue setup scope was already consumed.');
        state.phase = 'running';
        try {
          const pause = await this.pauseForBackup(signal);
          state.phase = 'owned';
          return pause;
        } catch (error) {
          state.phase = error && typeof error === 'object' && this.setupRefusals.has(error) ? 'refused' : 'unknown';
          throw error;
        }
      },
    }) as CoreCaptureQueueSetup;
    this.setupScopes.set(scope, state);
    return scope;
  }

  public async verifyCoreCaptureSetupRefusal(scope: CoreCaptureQueueSetup, signal: AbortSignal): Promise<CaptureSetupRefusal | undefined> {
    const state = this.setupScopes.get(scope);
    if (!state) throw new Error('Queue setup scope does not belong to this factory.');
    state.sealed = true;
    if (state.phase !== 'unused' && state.phase !== 'refused') return;
    const phase = state.phase;
    const required = ['app-events-queue', 'repo-queue', 'system-events-queue'];
    const connection = this.rabbit;
    const generation = this.connectionGeneration;
    const serial = this.captureGeneration;
    const registrations = required.map((name) => this.queues.get(name));
    const lifetime = AbortSignal.any([signal, this.shutdownSignal.signal]);
    const check = () => {
      lifetime.throwIfAborted();
      if (
        !state.sealed ||
        state.phase !== phase ||
        this.captureHeld ||
        this.captureGeneration !== serial ||
        installationMode().phase !== 'normal' ||
        !this.isReady() ||
        this.rabbit !== connection ||
        this.connectionGeneration !== generation ||
        !Number.isSafeInteger(generation) ||
        generation < 1 ||
        this.queues.size !== required.length ||
        required.some((name, index) => this.queues.get(name) !== registrations[index]) ||
        registrations.some((queue) => !queue || queue.captureSetupIsIdle() !== true)
      )
        throw new Error('Queue setup refusal cannot be verified.');
    };
    const read = async () => {
      const checking = AbortSignal.any([lifetime, AbortSignal.timeout(30_000)]);
      for (const name of required) {
        check();
        checking.throwIfAborted();
        let cancelled: (() => void) | undefined;
        const aborted = new Promise<never>((_resolve, reject) => {
          cancelled = () => reject(new Error('Queue refusal verification was cancelled.'));
          checking.addEventListener('abort', cancelled, { once: true });
          if (checking.aborted) cancelled();
        });
        let observed: Awaited<ReturnType<Connection['queueDeclare']>>;
        try {
          observed = await Promise.race([
            Promise.resolve().then(() => connection.queueDeclare({ queue: name, durable: true, autoDelete: false })),
            aborted,
          ]);
        } finally {
          if (cancelled) checking.removeEventListener('abort', cancelled);
        }
        check();
        checking.throwIfAborted();
        if (observed.messageCount !== 0 || observed.consumerCount !== 1) throw new Error('Queue refusal requires idle original consumers.');
      }
      check();
    };
    await read();
    return {
      setupId: state.id,
      outcome: phase === 'unused' ? 'not-entered' : 'queue-refused',
      generation,
      queues: required.map((name) => ({ name, messages: 0, consumers: 1 })),
      recheck: read,
    };
  }

  public async pauseForBackup(signal: AbortSignal) {
    if (this.captureHeld || installationMode().phase !== 'normal' || !this.isReady()) throw this.refuseSetup('Queue capture is unavailable.');
    const required = ['app-events-queue', 'repo-queue', 'system-events-queue'];
    if (this.queues.size !== required.length || required.some((name) => !this.queues.has(name)))
      throw this.refuseSetup('Queue capture coverage is incomplete.');
    const connection = this.rabbit;
    const generation = this.connectionGeneration;
    const registrations = required.map((name) => this.queues.get(name));
    const pauseId = randomUUID();
    const captureGeneration = this.captureGeneration + 1;
    if (!Number.isSafeInteger(captureGeneration)) throw this.refuseSetup('Queue capture generation is unavailable.');
    this.captureGeneration = captureGeneration;
    this.captureHeld = true;
    const paused: ReturnType<Queue<ArkTypeSchema, ArkTypeSchema<{ success: boolean; message: string }>>['pauseForBackup']>[] = [];
    let pauseInvoked = false;
    let released = false;
    let releaseFailed = false;
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
        releaseFailed = true;
        setBackupRecoveryRequired(true);
        throw new AggregateError(failures, 'Queue capture resumption failed.');
      }
    };
    const unwind = async (signal: AbortSignal): Promise<CaptureSetupUnwind> => {
      const lifetime = AbortSignal.any([signal, this.shutdownSignal.signal]);
      const check = () => {
        lifetime.throwIfAborted();
        if (
          !released ||
          releaseFailed ||
          paused.length === 0 ||
          this.captureHeld ||
          this.captureGeneration !== captureGeneration ||
          installationMode().phase !== 'normal' ||
          !this.isReady() ||
          this.rabbit !== connection ||
          this.connectionGeneration !== generation ||
          this.queues.size !== required.length ||
          required.some((name, index) => this.queues.get(name) !== registrations[index])
        )
          throw new Error('Queue setup unwind cannot be verified.');
      };
      const read = async (cancellation: AbortSignal) => {
        const counts: number[] = [];
        for (const name of required) {
          check();
          cancellation.throwIfAborted();
          let cancelled: (() => void) | undefined;
          const aborted = new Promise<never>((_resolve, reject) => {
            cancelled = () => reject(new Error('Queue setup unwind verification was cancelled.'));
            cancellation.addEventListener('abort', cancelled, { once: true });
            if (cancellation.aborted) cancelled();
          });
          let observed: Awaited<ReturnType<Connection['queueDeclare']>>;
          try {
            observed = await Promise.race([
              Promise.resolve().then(() => connection.queueDeclare({ queue: name, durable: true, autoDelete: false })),
              aborted,
            ]);
          } finally {
            if (cancelled) cancellation.removeEventListener('abort', cancelled);
          }
          check();
          cancellation.throwIfAborted();
          if (
            observed.messageCount !== 0 ||
            !Number.isSafeInteger(observed.consumerCount) ||
            observed.consumerCount < 0 ||
            observed.consumerCount > 1
          )
            throw new Error('Queue setup did not return to idle consumer coverage.');
          counts.push(observed.consumerCount);
        }
        return counts;
      };
      const checking = AbortSignal.any([lifetime, AbortSignal.timeout(30_000)]);
      while ((await read(checking)).some((count) => count !== 1)) await setTimeout(100, undefined, { signal: checking });
      const recheck = async () => {
        const checking = AbortSignal.any([lifetime, AbortSignal.timeout(30_000)]);
        if ((await read(checking)).some((count) => count !== 1)) throw new Error('Queue setup consumer coverage changed.');
        check();
      };
      await recheck();
      return { pauseId, generation, queues: required.map((name) => ({ name, messages: 0, consumers: 1 })), recheck };
    };
    const verify = async (checking: AbortSignal = signal) => {
      checking.throwIfAborted();
      if (
        released ||
        !this.captureHeld ||
        !this.isReady() ||
        this.rabbit !== connection ||
        this.connectionGeneration !== generation ||
        this.queues.size !== required.length ||
        required.some((name, index) => this.queues.get(name) !== registrations[index])
      )
        throw new Error('Queue connection changed during capture.');
      for (const name of required) {
        let cancel: (() => void) | undefined;
        const aborted = new Promise<never>((_resolve, reject) => {
          cancel = () => reject(new Error('Paused capture verification was cancelled.'));
          checking.addEventListener('abort', cancel, { once: true });
          if (checking.aborted) cancel();
        });
        let state: Awaited<ReturnType<Connection['queueDeclare']>>;
        try {
          state = await Promise.race([
            Promise.resolve().then(() => connection.queueDeclare({ queue: name, durable: true, autoDelete: false })),
            aborted,
          ]);
        } finally {
          if (cancel) checking.removeEventListener('abort', cancel);
        }
        checking.throwIfAborted();
        if (state.messageCount !== 0 || state.consumerCount !== 0)
          throw new Error('Queued commands or another consumer prevent a consistent capture. Retry after they finish.');
      }
      if (
        released ||
        !this.captureHeld ||
        !this.isReady() ||
        this.rabbit !== connection ||
        this.connectionGeneration !== generation ||
        this.queues.size !== required.length ||
        required.some((name, index) => this.queues.get(name) !== registrations[index])
      )
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
        pauseInvoked = true;
        paused.push(queue.pauseForBackup());
        pauseInvoked = false;
      }
      for (const queue of paused) {
        await queue.drain(signal);
        signal.throwIfAborted();
      }
      const initial = await verify();
      const handle = { initial, verify: () => verify(), release };
      this.captureUnwinds.set(handle, unwind);
      this.captureRechecks.set(handle, async (recoverySignal) => {
        const checking = AbortSignal.any([recoverySignal, this.shutdownSignal.signal, AbortSignal.timeout(30_000)]);
        const held = () => {
          checking.throwIfAborted();
          if (installationMode().phase !== 'normal' || !backupMaintenanceLeaseHeld() || !coreCaptureRecoveryRequired())
            throw new Error('Paused capture verification is unavailable.');
        };
        held();
        const result = await verify(checking);
        held();
        return result;
      });
      let resumption: Promise<CapturePauseContinuation> | undefined;
      const resume = async (signal: AbortSignal): Promise<CapturePauseContinuation> => {
        const lifetime = AbortSignal.any([signal, this.shutdownSignal.signal]);
        const check = () => {
          lifetime.throwIfAborted();
          if (
            installationMode().phase !== 'normal' ||
            !backupMaintenanceLeaseHeld() ||
            !coreCaptureRecoveryRequired() ||
            !this.isReady() ||
            this.rabbit !== connection ||
            this.connectionGeneration !== generation ||
            this.queues.size !== required.length ||
            required.some((name, index) => this.queues.get(name) !== registrations[index])
          )
            throw new Error('Paused capture continuation changed.');
        };
        const read = async (name: string, cancellation: AbortSignal) => {
          check();
          cancellation.throwIfAborted();
          let cancelled: (() => void) | undefined;
          const aborted = new Promise<never>((_resolve, reject) => {
            cancelled = () => reject(new Error('Paused capture continuation was cancelled.'));
            cancellation.addEventListener('abort', cancelled, { once: true });
            if (cancellation.aborted) cancelled();
          });
          let state: Awaited<ReturnType<Connection['queueDeclare']>>;
          try {
            state = await Promise.race([connection.queueDeclare({ queue: name, durable: true, autoDelete: false }), aborted]);
          } finally {
            if (cancelled) cancellation.removeEventListener('abort', cancelled);
          }
          check();
          if (
            !Number.isSafeInteger(state.messageCount) ||
            state.messageCount !== 0 ||
            !Number.isSafeInteger(state.consumerCount) ||
            state.consumerCount < 0 ||
            state.consumerCount > 1
          )
            throw new Error('Paused capture queues are not idle.');
          return state.consumerCount;
        };
        check();
        if (released || !this.captureHeld) throw new Error('The capture pause was already released.');
        const warming = AbortSignal.any([lifetime, AbortSignal.timeout(30_000)]);
        if ((await Promise.all(required.map((name) => read(name, warming)))).some((count) => count !== 0))
          throw new Error('Paused capture queues already have consumers.');
        check();
        if (released || !this.captureHeld) throw new Error('The capture pause was already released.');
        release();
        while ((await Promise.all(required.map((name) => read(name, warming)))).some((count) => count !== 1))
          await setTimeout(100, undefined, { signal: warming });
        const recheck = async () => {
          check();
          if (!released || this.captureHeld) throw new Error('Paused capture continuation changed.');
          const checking = AbortSignal.any([lifetime, AbortSignal.timeout(30_000)]);
          if ((await Promise.all(required.map((name) => read(name, checking)))).some((count) => count !== 1))
            throw new Error('Paused capture consumer coverage changed.');
          check();
        };
        await recheck();
        return {
          pauseId,
          queueGeneration: generation,
          queues: required.map((name) => ({ name, messages: 0, consumers: 1 })),
          recheck,
        };
      };
      this.captureResumptions.set(handle, (signal) => {
        resumption ??= resume(signal);
        return resumption;
      });
      return handle;
    } catch (error) {
      release();
      if (!paused.length) {
        if (!pauseInvoked || queueCaptureWasRefused(error))
          throw this.refuseSetup(error instanceof Error ? error.message : 'Queue setup was refused.');
        throw error;
      }
      const failure = new Error(error instanceof Error ? error.message : 'Queue capture setup failed.', { cause: error });
      this.captureUnwinds.set(failure, unwind);
      throw failure;
    }
  }

  /** Verifies only an original failed setup or released pause issued by this factory. */
  public verifyCoreCaptureSetupUnwind(reference: unknown, signal: AbortSignal) {
    const verify = reference && typeof reference === 'object' ? this.captureUnwinds.get(reference) : undefined;
    if (!verify) return Promise.reject(new Error('Queue setup unwind does not belong to this connection.'));
    return verify(signal);
  }

  /** Resumes only this factory's original drained consumers; recovery and mutation holds remain set. */
  public resumeCoreCapturePause(pause: Awaited<ReturnType<QueueFactory['pauseForBackup']>>, signal: AbortSignal) {
    const resume = this.captureResumptions.get(pause);
    if (!resume) return Promise.reject(new Error('The capture pause does not belong to this connection.'));
    return resume(signal);
  }

  public recheckCoreCapturePause(pause: Awaited<ReturnType<QueueFactory['pauseForBackup']>>, signal: AbortSignal) {
    const verify = this.captureRechecks.get(pause);
    if (!verify) return Promise.reject(new Error('The capture pause does not belong to this connection.'));
    return verify(signal);
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

  public resumeCoreCaptureConsumers() {
    const names = ['app-events-queue', 'repo-queue', 'system-events-queue'];
    if (
      installationMode().phase !== 'normal' ||
      !this.isReady() ||
      this.captureHeld ||
      this.queues.size !== names.length ||
      names.some((name) => !this.queues.has(name))
    )
      throw new Error('Capture queue continuation is unavailable.');
    for (const name of names) this.queues.get(name)?.resumeAfterCoreCapture();
  }

  public async verifyCoreCaptureConsumers(signal: AbortSignal) {
    const names = ['app-events-queue', 'repo-queue', 'system-events-queue'];
    const connection = this.rabbit;
    const generation = this.connectionGeneration;
    const lifetime = AbortSignal.any([signal, this.shutdownSignal.signal]);
    const verify = () => {
      lifetime.throwIfAborted();
      if (
        installationMode().phase !== 'normal' ||
        coreCaptureRecoveryRequired() ||
        !backupMaintenanceActive() ||
        !this.isReady() ||
        this.captureHeld ||
        this.rabbit !== connection ||
        this.connectionGeneration !== generation ||
        !Number.isSafeInteger(generation) ||
        generation < 1 ||
        this.queues.size !== names.length ||
        names.some((name) => !this.queues.has(name))
      )
        throw new Error('Capture consumer verification changed.');
    };
    const read = async (name: string, cancellation: AbortSignal) => {
      verify();
      cancellation.throwIfAborted();
      let cancelled: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        cancelled = () => reject(new Error('Capture consumer verification was cancelled.'));
        cancellation.addEventListener('abort', cancelled, { once: true });
        if (cancellation.aborted) cancelled();
      });
      let state: Awaited<ReturnType<Connection['queueDeclare']>>;
      try {
        state = await Promise.race([connection.queueDeclare({ queue: name, durable: true, autoDelete: false }), aborted]);
      } finally {
        if (cancelled) cancellation.removeEventListener('abort', cancelled);
      }
      verify();
      if (
        !Number.isSafeInteger(state.messageCount) ||
        state.messageCount !== 0 ||
        !Number.isSafeInteger(state.consumerCount) ||
        state.consumerCount < 0 ||
        state.consumerCount > 1
      )
        throw new Error('Capture consumers are not idle.');
      return state.consumerCount;
    };
    const warming = AbortSignal.any([lifetime, AbortSignal.timeout(30_000)]);
    while ((await Promise.all(names.map((name) => read(name, warming)))).some((count) => count !== 1))
      await setTimeout(100, undefined, { signal: warming });
    verify();
    return {
      queueGeneration: generation,
      queues: names.map((name) => ({ name, messages: 0 as const, consumers: 1 as const })),
      recheck: async () => {
        verify();
        const checking = AbortSignal.any([lifetime, AbortSignal.timeout(30_000)]);
        if ((await Promise.all(names.map((name) => read(name, checking)))).some((count) => count !== 1))
          throw new Error('Capture consumer coverage changed.');
        verify();
      },
    };
  }

  public onModuleDestroy() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.lifecycle.stopping = true;
    this.isInitialized = false;
    this.shutdownSignal.abort();
    for (const queue of this.queues.values()) queue.stopRepeatables();
    this.shutdownPromise = this.shutdown();
    return this.shutdownPromise;
  }

  private async shutdown() {
    if (this.initializationPromise) await Promise.allSettled([this.initializationPromise]);
    // Keep every consumer available until workers and their cross-queue RPCs finish.
    await this.lifecycle.drainAndSeal();
    await Promise.all([...this.queues.values()].map((queue) => queue.closeConsumer()));
    await Promise.all([...this.queues.values()].map((queue) => queue.closeResources()));
    await this.rabbit?.close();
  }

  public constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigurationService,
  ) {
    void this.initializeConnection().catch((error) => {
      if (!this.lifecycle.stopping) this.logger.error('Queue initialization failed', error);
    });
  }

  public async initializeConnection() {
    if (this.lifecycle.stopping) throw new Error('Queue is shutting down.');
    // Prevent multiple simultaneous initialization attempts
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = this.doInitialize();
    return this.initializationPromise;
  }

  private async doInitialize() {
    const { host, password, username } = this.config.get('queue');

    this.rabbit ??= new Connection({
      hostname: host,
      username,
      password,
      connectionTimeout: 30000,
      heartbeat: 60,
    });

    this.rabbit.on('connection', () => {
      if (this.lifecycle.stopping) return;
      this.connectionGeneration++;
      this.isInitialized = true;
      this.logger.info('Connected to the queue');
    });

    this.rabbit.on('error', (error) => {
      if (this.lifecycle.stopping) return;
      this.logger.error('Queue connection error', error);
      this.isInitialized = false;
    });

    // Wait for the connection to be ready
    await this.waitForConnection();
  }

  private async waitForConnection(maxWaitTime = 30000) {
    const startTime = Date.now();

    while (!this.rabbit.ready && Date.now() - startTime < maxWaitTime) {
      await setTimeout(1000, undefined, { signal: this.shutdownSignal.signal });
    }

    if (!this.rabbit.ready) {
      throw new Error('Failed to connect to RabbitMQ within timeout period');
    }
  }

  public getConnection() {
    return this.rabbit;
  }

  public isReady() {
    return !this.lifecycle.stopping && this.isInitialized && this.rabbit?.ready;
  }

  public async createQueue<T extends ArkTypeSchema>(params: {
    queueName: string;
    workers?: number;
    eventSchema: T;
    timeout?: number;
    observer?: QueueObserver<T['infer']>;
  }) {
    if (this.lifecycle.stopping) throw new Error('Queue is shutting down.');
    if (this.captureHeld) throw new Error('Queues cannot be added during capture.');
    // Ensure connection is ready before creating queue
    if (!this.isReady()) {
      this.logger.warn('Queue connection not ready, waiting for initialization...');
      await this.initializeConnection();
    }
    if (this.lifecycle.stopping) throw new Error('Queue is shutting down.');

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

    const queue = new Queue(
      this.rabbit,
      rpcClient,
      publisher,
      queueName,
      workers,
      eventSchema,
      resultSchema,
      this.logger,
      params.observer,
      this.lifecycle,
    );
    this.queues.set(queueName, queue);
    return queue;
  }
}
