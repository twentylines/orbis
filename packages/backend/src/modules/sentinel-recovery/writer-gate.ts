import { AsyncLocalStorage } from 'node:async_hooks';
import { ServiceUnavailableException } from '@nestjs/common';

type Lease = { active: boolean; children: Set<Promise<unknown>> };
type Scope = { active: boolean; mode: 'read' | 'write'; lease: Lease };
type Options = { signal?: AbortSignal };
type Waiter = { grant(): void; signal?: AbortSignal; abort?: () => void };

export class CredentialWriterError extends ServiceUnavailableException {
  constructor(readonly code: 'busy' | 'cancelled' | 'read-only' | 'stale') {
    super('Account credentials are changing. Try again shortly.');
  }
}

/** One Main-process lock order: credential gate, SQL transaction, passkey queue.
 * Host lifecycle/storage admission and other processes need their own fences.
 * This gate never treats an absent recovery service as an unmanaged installation.
 */
export class CredentialWriterGate {
  private readonly context = new AsyncLocalStorage<Scope>();
  private readonly waiting: Waiter[] = [];
  private busy = false;
  constructor(private readonly maximumWaiting = 128) {
    if (!Number.isSafeInteger(maximumWaiting) || maximumWaiting < 1 || maximumWaiting > 1024) throw new CredentialWriterError('busy');
  }

  assertWrite() {
    const scope = this.context.getStore();
    if (!scope?.active || !scope.lease.active) throw new CredentialWriterError('stale');
    if (scope.mode !== 'write') throw new CredentialWriterError('read-only');
  }

  run<T>(work: () => T | Promise<T>, options: Options = {}): Promise<T> {
    return this.execute('write', work, options);
  }

  read<T>(work: () => T | Promise<T>, options: Options = {}): Promise<T> {
    return this.execute('read', work, options);
  }

  wrap<A extends unknown[], R>(work: (...args: A) => R | Promise<R>): (...args: A) => Promise<R> {
    return (...args) => this.run(() => work(...args));
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new CredentialWriterError('cancelled'));
    if (!this.busy) {
      this.busy = true;
      return Promise.resolve();
    }
    if (this.waiting.length >= this.maximumWaiting) return Promise.reject(new CredentialWriterError('busy'));
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { grant: resolve, signal };
      if (signal) {
        waiter.abort = () => {
          const index = this.waiting.indexOf(waiter);
          if (index !== -1) {
            this.waiting.splice(index, 1);
            reject(new CredentialWriterError('cancelled'));
          }
        };
        signal.addEventListener('abort', waiter.abort, { once: true });
      }
      this.waiting.push(waiter);
      // Covers an abort between the first check and listener registration.
      if (signal?.aborted) waiter.abort?.();
    });
  }

  private release() {
    const next = this.waiting.shift();
    if (!next) {
      this.busy = false;
      return;
    }
    if (next.abort) next.signal?.removeEventListener('abort', next.abort);
    next.grant();
  }

  private invoke<T>(lease: Lease, mode: Scope['mode'], work: () => T | Promise<T>): Promise<T> {
    const scope: Scope = { active: true, mode, lease };
    return this.context.run(scope, async () => {
      try {
        if (!lease.active) throw new CredentialWriterError('stale');
        return await work();
      } finally {
        scope.active = false;
      }
    });
  }

  private async execute<T>(mode: Scope['mode'], work: () => T | Promise<T>, { signal }: Options): Promise<T> {
    if (signal?.aborted) throw new CredentialWriterError('cancelled');
    const parent = this.context.getStore();
    if (parent) {
      if (!parent.active || !parent.lease.active) throw new CredentialWriterError('stale');
      if (mode === 'write' && parent.mode === 'read') throw new CredentialWriterError('read-only');
      const child = this.invoke(parent.lease, mode, work);
      parent.lease.children.add(child);
      // Hold the outer lease for admitted nested work, even if a caller forgets
      // to await it. A later timer inherits a closed scope and cannot reenter.
      void child.then(
        () => parent.lease.children.delete(child),
        () => parent.lease.children.delete(child),
      );
      return child;
    }
    await this.acquire(signal);
    const lease: Lease = { active: true, children: new Set() };
    try {
      if (signal?.aborted) throw new CredentialWriterError('cancelled');
      return await this.invoke(lease, mode, work);
    } finally {
      while (lease.children.size) await Promise.allSettled([...lease.children]);
      lease.active = false;
      this.release();
    }
  }
}

export const credentialWriters = new CredentialWriterGate();
