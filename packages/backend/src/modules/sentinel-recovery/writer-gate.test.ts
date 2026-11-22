import { describe, expect, it } from 'vitest';
import { CredentialWriterError, CredentialWriterGate } from './writer-gate';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('Main credential writer gate', () => {
  it('serializes proof, mutation and postcommit work in FIFO order', async () => {
    const gate = new CredentialWriterGate();
    const entered = deferred();
    const release = deferred();
    const order: string[] = [];
    const first = gate.run(async () => {
      order.push('first-proof');
      entered.resolve();
      await release.promise;
      order.push('first-write');
      await Promise.resolve();
      order.push('first-postcommit');
    });
    await entered.promise;
    const second = gate.run(() => {
      order.push('second');
    });
    const third = gate.read(() => {
      order.push('snapshot');
    });
    expect(order).toEqual(['first-proof']);
    release.resolve();
    await Promise.all([first, second, third]);
    expect(order).toEqual(['first-proof', 'first-write', 'first-postcommit', 'second', 'snapshot']);
  });

  it('permits awaited nested writers while a nested source view is read-only', async () => {
    const gate = new CredentialWriterGate();
    await gate.run(async () => {
      await gate.run(() => gate.assertWrite());
      await gate.read(async () => {
        await expect(gate.run(() => 'mutation')).rejects.toMatchObject({ code: 'read-only' });
        expect(() => gate.assertWrite()).toThrow(CredentialWriterError);
        await gate.read(() => 'nested source');
      });
      gate.assertWrite();
    });
    expect(() => gate.assertWrite()).toThrow(CredentialWriterError);
  });

  it('does not release the writer while an admitted unawaited child is still active', async () => {
    const gate = new CredentialWriterGate();
    const entered = deferred();
    const release = deferred();
    const order: string[] = [];
    const first = gate.run(() => {
      void gate.run(async () => {
        entered.resolve();
        await release.promise;
        gate.assertWrite();
        order.push('child');
      });
    });
    await entered.promise;
    const second = gate.run(() => {
      order.push('next');
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    release.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['child', 'next']);
  });

  it('rejects detached stale contexts even during a later writer lease', async () => {
    const gate = new CredentialWriterGate();
    const start = deferred();
    let detached!: Promise<unknown>;
    await gate.run(() => {
      detached = start.promise.then(() => gate.run(() => 'stale mutation'));
    });
    await gate.run(async () => {
      start.resolve();
      await expect(detached).rejects.toMatchObject({ code: 'stale' });
    });
  });

  it('rejects cancelled queued work without invoking it and releases remaining work', async () => {
    const gate = new CredentialWriterGate();
    const entered = deferred();
    const release = deferred();
    const controller = new AbortController();
    let invoked = false;
    const first = gate.run(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const cancelled = gate.run(
      () => {
        invoked = true;
      },
      { signal: controller.signal },
    );
    const refusal = expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });
    const next = gate.run(() => 'next');
    controller.abort();
    await refusal;
    release.resolve();
    expect(await next).toBe('next');
    await first;
    expect(invoked).toBe(false);
  });

  it('holds active cancellation until its operation settles', async () => {
    const gate = new CredentialWriterGate();
    const controller = new AbortController();
    const entered = deferred();
    const release = deferred();
    let second = false;
    const first = gate.run(
      async () => {
        entered.resolve();
        await release.promise;
      },
      { signal: controller.signal },
    );
    await entered.promise;
    controller.abort();
    const next = gate.run(() => {
      second = true;
    });
    await Promise.resolve();
    expect(second).toBe(false);
    release.resolve();
    await Promise.all([first, next]);
    expect(second).toBe(true);
  });

  it('bounds pending admission and recovers from callback failures', async () => {
    const gate = new CredentialWriterGate(1);
    const entered = deferred();
    const release = deferred();
    const first = gate.run(async () => {
      entered.resolve();
      await release.promise;
      throw new Error('fixture');
    });
    const failure = expect(first).rejects.toThrow('fixture');
    await entered.promise;
    const second = gate.run(() => 'second');
    await expect(gate.run(() => 'third')).rejects.toMatchObject({ code: 'busy' });
    release.resolve();
    await failure;
    expect(await second).toBe('second');
    expect(await gate.run(() => 'after')).toBe('after');
  });

  it('wraps typed service operations and refuses pre-aborted admission', async () => {
    const gate = new CredentialWriterGate();
    const wrapped = gate.wrap(async (id: number, label: string) => {
      gate.assertWrite();
      return `${id}:${label}`;
    });
    expect(await wrapped(2, 'account')).toBe('2:account');
    await expect(gate.read(() => wrapped(2, 'account'))).rejects.toMatchObject({ code: 'read-only' });
    const controller = new AbortController();
    controller.abort();
    await expect(gate.run(() => 'never', { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
  });
});
