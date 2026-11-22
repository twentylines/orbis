import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@/core/database/database.module';
import { UserRepository } from './user.repository';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

function fixture() {
  const events: string[] = [];
  const tx = {
    execute: vi.fn(async () => undefined),
    query: {
      user: {
        findFirst: vi.fn(async () => {
          events.push('query');
          return { id: 1 };
        }),
      },
    },
  };
  const database = {
    transaction: async (work: (value: typeof tx) => Promise<unknown>) => {
      try {
        const value = await work(tx);
        events.push('commit');
        return value;
      } catch (error) {
        events.push('rollback');
        throw error;
      }
    },
  };
  return { repository: new UserRepository(database as unknown as Database), events, tx };
}

describe('credential SQL transaction lifetime', () => {
  it.each([false, true])('drains an admitted nested operation before commit or rollback (failure=%s)', async (failure) => {
    const { repository, events } = fixture();
    const entered = deferred();
    const release = deferred();
    const operation = repository.withCredentialTransaction(async () => {
      void repository.withCredentialTransaction(async (nested) => {
        entered.resolve();
        await release.promise;
        await nested.getUserById(1);
      });
      if (failure) throw new Error('synthetic rollback');
      return 'done';
    });
    const result = operation.then(
      (value) => value,
      (error: Error) => error.message,
    );
    await entered.promise;
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(events).toEqual([]);
    } finally {
      release.resolve();
    }
    expect(await result).toBe(failure ? 'synthetic rollback' : 'done');
    expect(events).toEqual(['query', failure ? 'rollback' : 'commit']);
  });

  it('refuses a detached query inherited from a closed SQL scope', async () => {
    const { repository, tx } = fixture();
    const start = deferred();
    let detached!: Promise<unknown>;
    await repository.withCredentialTransaction(async () => {
      detached = start.promise.then(() => repository.getUserById(1));
    });
    start.resolve();
    await expect(detached).rejects.toMatchObject({ code: 'stale' });
    expect(tx.query.user.findFirst).not.toHaveBeenCalled();
  });

  it('rolls back when an admitted unawaited child fails after the outer callback returns', async () => {
    const { repository, events } = fixture();
    const entered = deferred();
    const release = deferred();
    const operation = repository.withCredentialTransaction(async () => {
      void repository
        .withCredentialTransaction(async () => {
          entered.resolve();
          await release.promise;
          throw new Error('nested failure');
        })
        .catch(() => undefined);
      return 'must not commit';
    });
    const refused = expect(operation).rejects.toThrow('nested failure');
    await entered.promise;
    release.resolve();
    await refused;
    expect(events).toEqual(['rollback']);
  });
});
