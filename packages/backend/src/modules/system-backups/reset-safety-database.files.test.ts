import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { user } from '@/core/database/drizzle/schema';
import { withBackupMaintenanceLease } from '@/common/backup-maintenance-lease';
import { planResetSafetyExports } from './reset-safety-plan';
import { verifyResetExportProof, withResetExportAccess } from './settings-export-authorization';
import { withResetSafetyDatabaseCohort } from './reset-safety-database';

type Context = Omit<Parameters<typeof withResetSafetyDatabaseCohort>[0], 'database'>;
let security: string;
const auth = {
  operatorActionContext: vi.fn(async () => ({ userId: 1, sessionBinding: 'fixture-session', securityBinding: security })),
  verifySensitiveAction: vi.fn(async () => undefined),
};
beforeEach(() => {
  security = 'fixture-security';
  vi.clearAllMocks();
});

async function scope<T>(work: (context: Context, abort: AbortController) => Promise<T>, accounts: 'keep' | 'remove' = 'keep') {
  const plan = planResetSafetyExports({ resetId: randomUUID(), accounts, users: [1, 2], captures: [] }).plan;
  const abort = new AbortController();
  const proof = await verifyResetExportProof(auth as never, {} as never, {} as Request, accounts, {
    method: 'password',
    password: 'fixture-password',
  });
  return withBackupMaintenanceLease(abort.signal, (lease) =>
    withResetExportAccess(proof, plan, lease, abort.signal, (access) => work({ plan, access, lease, signal: abort.signal }, abort)),
  );
}

function database() {
  let held = false;
  const events: string[] = [];
  let rows = [1, 2];
  let lockFailure: unknown;
  let onRead = () => {};
  const execute = vi.fn(async (query: Parameters<PgDialect['sqlToQuery']>[0]) => {
    expect(new PgDialect().sqlToQuery(query)).toMatchObject({ sql: 'LOCK TABLE "user", "link" IN SHARE MODE NOWAIT', params: [] });
    events.push('lock');
    if (lockFailure) throw lockFailure;
    held = true;
  });
  const transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>, config: unknown) => {
    expect(config).toEqual({ isolationLevel: 'read committed', accessMode: 'read write' });
    events.push('begin');
    try {
      const value = await work({
        execute,
        select: (columns: Record<string, unknown>) => {
          expect(held).toBe(true);
          expect(columns).toEqual({ id: user.id });
          events.push('cohort');
          return {
            from: () => ({
              orderBy: () => ({
                limit: (maximum: number) => {
                  expect(maximum).toBe(257);
                  onRead();
                  return Promise.resolve(rows.map((id) => ({ id })));
                },
              }),
            }),
          };
        },
      });
      events.push('commit');
      return value;
    } catch (error) {
      events.push('rollback');
      throw error;
    } finally {
      held = false;
      events.push('released');
    }
  });
  return {
    value: { transaction } as never,
    transaction,
    execute,
    events,
    held: () => held,
    rows: (ids: number[]) => {
      rows = ids;
    },
    failLock: (error: unknown) => {
      lockFailure = error;
    },
    onRead: (callback: () => void) => {
      onRead = callback;
    },
  };
}

it.each(['keep', 'remove'] as const)('holds the verified database cohort through %s preparation and final authorization', async (accounts) => {
  await scope(async (context) => {
    const model = database();
    const result = await withResetSafetyDatabaseCohort({ ...context, database: model.value }, async () => {
      expect(model.held()).toBe(true);
      expect(model.events).toEqual(['begin', 'lock', 'cohort']);
      return 'prepared';
    });
    expect(result).toBe('prepared');
    expect(model.events).toEqual(['begin', 'lock', 'cohort', 'commit', 'released']);
  }, accounts);
});

it.each([{ code: '55P03' }, { cause: { code: '55P03' } }])(
  'refuses active writers before reading the cohort or starting preparation',
  async (failure) => {
    await scope(async (context) => {
      const model = database();
      model.failLock(failure);
      const work = vi.fn();
      await expect(withResetSafetyDatabaseCohort({ ...context, database: model.value }, work)).rejects.toMatchObject({ code: 'busy' });
      expect(work).not.toHaveBeenCalled();
      expect(model.events).toEqual(['begin', 'lock', 'rollback', 'released']);
    });
  },
);

it.each([[1], [1, 2, 3], [2, 3], Array.from({ length: 257 }, (_, index) => index + 1)])(
  'refuses a different or oversized account cohort',
  async (...ids) => {
    await scope(async (context) => {
      const model = database();
      model.rows(ids as number[]);
      const work = vi.fn();
      await expect(withResetSafetyDatabaseCohort({ ...context, database: model.value }, work)).rejects.toMatchObject({ code: 'cohort' });
      expect(work).not.toHaveBeenCalled();
      expect(model.held()).toBe(false);
    });
  },
);

it('rejects forged authorization before opening a database transaction', async () => {
  await scope(async (context) => {
    const model = database();
    await expect(withResetSafetyDatabaseCohort({ ...context, access: {} as never, database: model.value }, vi.fn())).rejects.toThrow('authorization');
    expect(model.transaction).not.toHaveBeenCalled();
  });
});

it('rechecks security after acquiring the lock and before invoking preparation', async () => {
  await expect(
    scope(async (context) => {
      const model = database();
      model.onRead(() => {
        security = 'changed';
      });
      const work = vi.fn();
      await expect(withResetSafetyDatabaseCohort({ ...context, database: model.value }, work)).rejects.toThrow('authorization');
      expect(work).not.toHaveBeenCalled();
      expect(model.events.at(-2)).toBe('rollback');
    }),
  ).rejects.toThrow('authorization');
});

it('withholds the result if authorization changes during preparation', async () => {
  await expect(
    scope(async (context) => {
      const model = database();
      await expect(
        withResetSafetyDatabaseCohort({ ...context, database: model.value }, async () => {
          security = 'changed';
        }),
      ).rejects.toThrow('authorization');
      expect(model.events.at(-2)).toBe('rollback');
    }),
  ).rejects.toThrow('authorization');
});

it('keeps the fence until cancelled preparation actually settles', async () => {
  await expect(
    scope(async (context, abort) => {
      const model = database();
      let started!: () => void;
      let finish!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const pendingWork = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const operation = withResetSafetyDatabaseCohort({ ...context, database: model.value }, async () => {
        started();
        await pendingWork;
      });
      await entered;
      abort.abort();
      await Promise.resolve();
      expect(model.held()).toBe(true);
      expect(model.events).not.toContain('released');
      finish();
      await expect(operation).rejects.toThrow();
      expect(model.held()).toBe(false);
      expect(model.events.at(-2)).toBe('rollback');
    }),
  ).rejects.toThrow();
});
