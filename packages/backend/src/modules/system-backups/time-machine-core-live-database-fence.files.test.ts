import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  assertCoreLiveDatabaseHeld,
  holdCoreLiveDatabase,
  observeCoreLiveDatabase,
  restoreCoreLiveDatabaseAdmission,
  type CoreLiveDatabaseFenceIntent,
  type CoreLiveDatabaseObservation,
  type HeldCoreLiveDatabase,
} from './time-machine-core-live-database-fence';

const expected = {
  systemIdentifier: '7174151389403972607',
  database: 'orbis_current',
  databaseOid: '16384',
  role: 'orbis_owner',
  roleOid: '10',
  serverVersionNum: 170006,
};
function fixture() {
  let allowed = true;
  let foreign = false;
  let starting = false;
  let prepared = '0';
  let startedAt = '2026-11-12 10:00:00+00';
  let replacement = false;
  const calls: string[] = [];
  const query = (control: boolean) => async (sql: string) => {
    calls.push(sql);
    let rows: unknown[];
    if (sql.includes('pg_control_system()'))
      rows = [
        {
          ...expected,
          ...(control ? { database: 'postgres', databaseOid: '5' } : {}),
          pid: control ? '101' : '102',
          startedAt,
          allowConnections: control || allowed,
        },
      ];
    else if (sql.includes('pg_locks')) rows = starting ? [{ pid: '103' }] : [];
    else if (sql.includes('pg_stat_activity')) rows = [{ pid: '102' }, ...(foreign ? [{ pid: '103' }] : [])];
    else if (sql.includes('pg_prepared_xacts')) rows = [{ count: prepared }];
    else if (sql === 'ALTER DATABASE "orbis_current" ALLOW_CONNECTIONS false') {
      allowed = false;
      rows = [];
    } else if (sql === 'ALTER DATABASE "orbis_current" ALLOW_CONNECTIONS true') {
      allowed = true;
      rows = [];
    } else if (sql.includes('datname AS name')) rows = [{ oid: expected.databaseOid, name: replacement ? 'replaced' : expected.database, allowed }];
    else if (sql.startsWith('SELECT datallowconn')) rows = [{ allowed }];
    else throw new Error('Unexpected SQL');
    return { rows, rowCount: rows.length };
  };
  const live = { query: query(false) } as unknown as Pick<Client, 'query'>;
  const maintenance = { query: query(true) } as unknown as Pick<Client, 'query'>;
  const signal = new AbortController().signal;
  let saved: CoreLiveDatabaseFenceIntent | undefined;
  let denied = false;
  const journal = {
    persist: async (value: Readonly<CoreLiveDatabaseFenceIntent>) => {
      calls.push('persist');
      saved = structuredClone(value);
    },
    verify: async () => {
      calls.push('verify');
      if (denied) throw new Error('Root decision changed');
    },
  };
  const observe = () => observeCoreLiveDatabase({ live, maintenance, expected, signal });
  const hold = async (observation?: CoreLiveDatabaseObservation) =>
    holdCoreLiveDatabase({
      observation: observation ?? (await observe()),
      id: randomUUID(),
      nonce: randomUUID(),
      rootIntentSha256: 'a'.repeat(64),
      journal,
      signal,
    });
  return {
    live,
    maintenance,
    signal,
    journal,
    calls,
    observe,
    hold,
    intent: () => {
      if (!saved) throw new Error('Missing intent');
      return saved;
    },
    allowed: () => allowed,
    foreign: () => {
      foreign = true;
    },
    starting: () => {
      starting = true;
    },
    prepared: () => {
      prepared = '1';
    },
    deny: () => {
      denied = true;
    },
    restart: () => {
      startedAt = '2026-11-12 10:01:00+00';
    },
    replace: () => {
      replacement = true;
    },
  };
}

describe('Root-worker current database connection fence', () => {
  it('observes without mutation and persists recovery intent before closing new connections', async () => {
    const f = fixture();
    const observation = await f.observe();
    expect(f.allowed()).toBe(true);
    expect(f.calls.some((sql) => sql.startsWith('ALTER'))).toBe(false);
    const token = await f.hold(observation);
    expect(f.allowed()).toBe(false);
    expect(f.calls.indexOf('persist')).toBeLessThan(f.calls.findIndex((sql) => sql.startsWith('ALTER')));
    await assertCoreLiveDatabaseHeld(token, f.signal);
    expect(f.intent().identity).toEqual(expected);
    await expect(f.hold(observation)).rejects.toThrow();
  });

  it.each(['foreign', 'starting', 'prepared'] as const)('rejects an existing %s writer before admission changes', async (kind) => {
    const f = fixture();
    f[kind]();
    await expect(f.observe()).rejects.toThrow();
    expect(f.allowed()).toBe(true);
    expect(f.calls.some((sql) => sql.startsWith('ALTER'))).toBe(false);
  });

  it('rechecks for a writer arriving before the durable intent', async () => {
    const f = fixture();
    const observation = await f.observe();
    f.foreign();
    await expect(f.hold(observation)).rejects.toThrow();
    expect(f.calls).not.toContain('persist');
    expect(f.allowed()).toBe(true);
  });

  it('rechecks for a writer arriving while intent is persisted', async () => {
    const f = fixture();
    const original = f.journal.persist;
    f.journal.persist = async (intent) => {
      await original(intent);
      f.foreign();
    };
    await expect(f.hold()).rejects.toThrow();
    expect(f.allowed()).toBe(true);
  });

  it('does not close admission when durable persistence fails', async () => {
    const f = fixture();
    f.journal.persist = async () => {
      throw new Error('Disk failed');
    };
    await expect(f.hold()).rejects.toThrow();
    expect(f.allowed()).toBe(true);
  });

  it('does not close admission after Root revokes the undecided operation', async () => {
    const f = fixture();
    f.deny();
    await expect(f.hold()).rejects.toThrow();
    expect(f.allowed()).toBe(true);
  });

  it('keeps admission closed after post-command verification fails', async () => {
    const f = fixture();
    let count = 0;
    f.journal.verify = async () => {
      if (++count === 2) throw new Error('Lost decision reply');
    };
    await expect(f.hold()).rejects.toThrow();
    expect(f.allowed()).toBe(false);
    expect(f.calls.filter((sql) => sql.endsWith('ALLOW_CONNECTIONS true'))).toHaveLength(0);
    expect(f.intent().originalAllowConnections).toBe(true);
  });

  it.each(['foreign', 'starting', 'prepared', 'restart', 'deny'] as const)(
    'refuses a held snapshot after %s drift without reopening',
    async (kind) => {
      const f = fixture();
      const token = await f.hold();
      f[kind]();
      await expect(assertCoreLiveDatabaseHeld(token, f.signal)).rejects.toThrow();
      expect(f.allowed()).toBe(false);
    },
  );

  it('reopens only under a fresh explicit rollback decision, even after worker connection loss/restart', async () => {
    const f = fixture();
    await f.hold();
    f.restart();
    let checks = 0;
    await restoreCoreLiveDatabaseAdmission({
      maintenance: f.maintenance,
      intent: f.intent(),
      decision: 'rollback',
      verify: async (intent) => {
        checks++;
        expect(intent).toEqual(f.intent());
      },
    });
    expect(checks).toBe(2);
    expect(f.allowed()).toBe(true);
  });

  it('does not reopen after Root refuses recovery or the database identity changed', async () => {
    const f = fixture();
    await f.hold();
    await expect(
      restoreCoreLiveDatabaseAdmission({
        maintenance: f.maintenance,
        intent: f.intent(),
        decision: 'rollback',
        verify: async () => {
          throw new Error('Committed');
        },
      }),
    ).rejects.toThrow();
    f.replace();
    await expect(
      restoreCoreLiveDatabaseAdmission({
        maintenance: f.maintenance,
        intent: f.intent(),
        decision: 'abort-before-activation',
        verify: async () => {},
      }),
    ).rejects.toThrow();
    expect(f.allowed()).toBe(false);
  });

  it('refuses serialized or fabricated observation and hold handles', async () => {
    const f = fixture();
    await expect(f.hold({} as CoreLiveDatabaseObservation)).rejects.toThrow();
    await expect(assertCoreLiveDatabaseHeld({} as HeldCoreLiveDatabase, f.signal)).rejects.toThrow();
    expect(f.allowed()).toBe(true);
  });

  it('checks cancellation before any admission change', async () => {
    const f = fixture();
    const cancelled = AbortSignal.abort();
    await expect(observeCoreLiveDatabase({ live: f.live, maintenance: f.maintenance, expected, signal: cancelled })).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });

  it.each(['identity', 'id', 'nonce', 'rootIntentSha256', 'originalAllowConnections', 'livePid', 'maintenancePid', 'startedAt', 'schema'] as const)(
    'rejects malformed persisted %s before recovery SQL',
    async (key) => {
      const f = fixture();
      await f.hold();
      const count = f.calls.length;
      await expect(
        restoreCoreLiveDatabaseAdmission({
          maintenance: f.maintenance,
          intent: { ...f.intent(), [key]: null } as unknown as CoreLiveDatabaseFenceIntent,
          decision: 'rollback',
          verify: async () => {},
        }),
      ).rejects.toThrow();
      expect(f.calls).toHaveLength(count);
      expect(f.allowed()).toBe(false);
    },
  );
});
