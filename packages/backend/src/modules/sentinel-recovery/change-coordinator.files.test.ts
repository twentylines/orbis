import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { hash } from 'argon2';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/core/database/database.module';
import type { User } from '@/core/database/drizzle/types';
import { EncryptionService } from '@/core/encryption/encryption.service';
import { UserRepository } from '../user/user.repository';
import { PasskeyStore } from '../auth/passkey.store';
import { readRecoveryIdentity } from './identity';
import { CredentialWriterError } from './writer-gate';
import { RecoveryChangeCoordinator, RecoveryChangeError, type CredentialRecoveryBroker } from './change-coordinator';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const binding = 'b'.repeat(64);
const operationId = 'c'.repeat(64);
let root: string;
let passwordHash: string;
let account: User;
let config: { get: ReturnType<typeof vi.fn> };
let encryption: EncryptionService;
let passkeys: PasskeyStore;
let signal: AbortController;

beforeAll(async () => {
  passwordHash = await hash('synthetic-coordinator-password', { memoryCost: 4096, timeCost: 2, parallelism: 1 });
});

beforeEach(async () => {
  if (!process.env.TMPDIR) throw new Error('Project-scoped TMPDIR required.');
  root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'change-')));
  account = {
    id: 1,
    username: 'operator',
    password: passwordHash,
    operator: true,
    totpEnabled: false,
    totpSecret: null,
    salt: null,
    locale: 'en',
    hasSeenWelcome: true,
    createdAt: 1,
    updatedAt: 1,
  };
  config = { get: vi.fn((key: string) => (key === 'directories' ? { dataDir: root } : 'synthetic-cipher-context')) };
  encryption = new EncryptionService(config as never);
  passkeys = new PasskeyStore(config as never);
  signal = new AbortController();
  await passkeys.change((state) => {
    state.users[1] = {
      handle: 'aGFuZGxl',
      credentials: [
        { id: 'YQ', publicKey: 'a2V5', counter: 7, rpID: 'orbis.example', name: 'Synthetic key', createdAt: 1, lastUsedAt: null, transports: [] },
      ],
    };
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

/** SQL adapter fixture only. Native qualification must use actual PostgreSQL. */
function database() {
  let committed = structuredClone(account);
  const events: string[] = [];
  const behavior: { writeError?: boolean; commitError?: 'before' | 'after'; beforeFresh?: () => void; rewrite?: Partial<User> } = {};
  let calls = 0;
  const rows = () => (committed.operator ? [structuredClone(committed)] : []);
  const transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
    calls++;
    if (calls === 2) behavior.beforeFresh?.();
    const draft = { row: structuredClone(committed), written: false };
    events.push('sql-open');
    const operators = () => (draft.row.operator ? [structuredClone(draft.row)] : []);
    const selection = () => {
      const value = Object.assign(Promise.resolve().then(operators), {
        from: () => value,
        where: () => value,
        orderBy: () => value,
        limit: async () => operators(),
      });
      return value;
    };
    const tx = {
      execute: async () => {
        events.push('sql-lock');
      },
      query: { user: { findFirst: async () => structuredClone(draft.row) } },
      select: selection,
      update: () => ({
        set: (patch: Partial<User>) => ({
          where: () => ({
            returning: async () => {
              events.push('sql-write');
              if (behavior.writeError) throw new Error('Synthetic SQL failure');
              draft.written = true;
              draft.row = { ...draft.row, ...patch, ...behavior.rewrite };
              return [structuredClone(draft.row)];
            },
          }),
        }),
      }),
    };
    try {
      const value = await work(tx);
      if (draft.written && behavior.commitError === 'before') throw new Error('Synthetic commit response unavailable');
      committed = draft.row;
      events.push('sql-commit');
      if (draft.written && behavior.commitError === 'after') throw new Error('Synthetic commit response unavailable');
      return value;
    } catch (error) {
      events.push('sql-error');
      throw error;
    }
  });
  return {
    value: { transaction } as unknown as Database,
    events,
    behavior,
    transaction,
    row: () => structuredClone(committed),
    rows,
    replace: (value: User) => {
      committed = structuredClone(value);
    },
  };
}

function broker(db: ReturnType<typeof database>, mode: 'managed' | 'unmanaged' = 'managed') {
  let baselineSha256 = '';
  let plannedSha256 = '';
  const buffers: Buffer[] = [];
  const port = {
    admission: vi.fn(async () => ({ mode, binding })),
    prepare: vi.fn(async (options: Parameters<CredentialRecoveryBroker['prepare']>[0]) => {
      db.events.push('prepare');
      expect(db.row().username).toBe('operator');
      baselineSha256 = sha256(options.baselineIdentity);
      plannedSha256 = sha256(options.plannedIdentity);
      expect(readRecoveryIdentity(options.baselineIdentity, baselineSha256).username).toBe('operator');
      expect(options.admissionBinding).toBe(binding);
      expect(options.requestId).toMatch(/^[a-f0-9]{64}$/);
      buffers.push(options.baselineIdentity, options.plannedIdentity);
      return { operationId, state: 'pending' as const, admissionBinding: binding, baselineSha256, plannedSha256 };
    }),
    complete: vi.fn(async (options: Parameters<CredentialRecoveryBroker['complete']>[0]) => {
      db.events.push('complete');
      expect(options.operationId).toBe(operationId);
      expect(options.admissionBinding).toBe(binding);
      expect(sha256(options.currentIdentity)).toBe(plannedSha256);
      buffers.push(options.currentIdentity);
      return { operationId, state: 'completed' as const, admissionBinding: binding, plannedSha256 };
    }),
  } satisfies CredentialRecoveryBroker;
  return { port, buffers, planned: () => plannedSha256, baseline: () => baselineSha256 };
}

function coordinator(db: ReturnType<typeof database>, port: CredentialRecoveryBroker) {
  const users = new UserRepository(db.value);
  return {
    users,
    change: new RecoveryChangeCoordinator({
      users,
      database: db.value,
      passkeys,
      config: config as never,
      encryption,
      broker: port,
      origin: 'https://orbis.example',
    }),
  };
}

function request() {
  return {
    accountId: 1,
    signal: signal.signal,
    authorize: vi.fn(async (value: Readonly<User>) => {
      expect(value.username).toBe('operator');
    }),
    plan: vi.fn(async (_value: Readonly<User>, keys: Parameters<PasskeyStore['change']>[0] extends (state: infer S) => unknown ? S : never) => {
      const current = keys.users[1];
      if (!current) throw new Error('Missing synthetic key');
      current.credentials = [];
      return { patch: { username: 'updated-operator' }, value: 'changed' };
    }),
    afterSuccess: vi.fn(async (value: string) => `session:${value}`),
  };
}

describe('prepared Main credential change', () => {
  it.each(['managed', 'unmanaged'] as const)('requires the bound durable host lease in %s mode before any writes', async (mode) => {
    const db = database();
    const host = broker(db, mode);
    const { change } = coordinator(db, host.port);
    const input = request();
    input.afterSuccess.mockImplementation(async (value) => {
      expect(host.port.complete).toHaveBeenCalledTimes(1);
      expect(db.row().username).toBe('updated-operator');
      expect((await passkeys.snapshot()).users[1]?.credentials).toEqual([]);
      return `session:${value}`;
    });
    expect(await change.change(input)).toBe('session:changed');
    expect(db.events.indexOf('prepare')).toBeLessThan(db.events.indexOf('sql-write'));
    expect(db.events.indexOf('sql-commit')).toBeLessThan(db.events.indexOf('complete'));
    expect(input.authorize).toHaveBeenCalledTimes(1);
    expect(host.port.prepare).toHaveBeenCalledTimes(1);
    expect(host.port.complete).toHaveBeenCalledTimes(1);
    expect(host.buffers).toHaveLength(3);
    expect(host.buffers.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
    expect((await fs.stat(path.join(root, 'state/auth/passkeys.json'))).mode & 0o777).toBe(0o600);
  });

  it.each(['unknown', 'missing', 'bad-binding', 'malformed'] as const)('holds before proof or SQL on %s admission', async (kind) => {
    const db = database();
    const host = broker(db);
    host.port.admission.mockImplementation(async () => {
      if (kind === 'missing') throw new Error('Synthetic private service failure');
      return (
        kind === 'unknown'
          ? { mode: 'unknown', binding }
          : kind === 'bad-binding'
            ? { mode: 'managed', binding: 'B'.repeat(64) }
            : { mode: 'managed', binding, extra: true }
      ) as never;
    });
    const { change } = coordinator(db, host.port);
    const input = request();
    await expect(change.change(input)).rejects.toMatchObject({
      code: 'unavailable',
      outcome: { phase: 'admission', sql: 'not-written', recovery: 'not-started' },
    });
    expect(input.authorize).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(host.port.prepare).not.toHaveBeenCalled();
    expect((await passkeys.snapshot()).users[1]?.credentials).toHaveLength(1);
  });

  it('preserves a proof rejection before Root preparation and blocks a proof callback from writing', async () => {
    const db = database();
    const host = broker(db);
    const { change, users } = coordinator(db, host.port);
    const input = request();
    const refusal = new Error('Existing authorization refusal');
    input.authorize.mockRejectedValueOnce(refusal);
    await expect(change.change(input)).rejects.toBe(refusal);
    input.authorize.mockImplementationOnce(async () => {
      await users.updateUser(1, { username: 'must-not-write' });
    });
    await expect(change.change(input)).rejects.toBeInstanceOf(CredentialWriterError);
    expect(db.events).not.toContain('sql-write');
    expect(host.port.prepare).not.toHaveBeenCalled();
  });

  it.each(['id', 'operator', 'locale', 'accessor'] as const)(
    'refuses an unplanned %s account field before Root or file persistence',
    async (field) => {
      const db = database();
      const host = broker(db);
      const { change } = coordinator(db, host.port);
      const input = request();
      input.plan.mockImplementationOnce(
        async () =>
          ({
            patch:
              field === 'accessor'
                ? Object.defineProperty({}, 'username', { enumerable: true, get: () => 'hidden' })
                : { [field]: field === 'operator' ? false : 2 },
            value: 'bad',
          }) as never,
      );
      await expect(change.change(input)).rejects.toMatchObject({ code: 'invalid-plan' });
      expect(host.port.prepare).not.toHaveBeenCalled();
      expect(db.events).not.toContain('sql-write');
    },
  );

  it('does not turn a counter update into enrollment on every passkey use', async () => {
    const db = database();
    const host = broker(db);
    const { change } = coordinator(db, host.port);
    const input = request();
    input.plan.mockImplementationOnce(async (_value, keys) => {
      const key = keys.users[1]?.credentials[0];
      if (!key) throw new Error('Missing synthetic key');
      key.counter++;
      return { patch: {}, value: 'counter' } as never;
    });
    await expect(change.change(input)).rejects.toMatchObject({ code: 'counter-sync-required' });
    expect(host.port.prepare).not.toHaveBeenCalled();
    expect((await passkeys.snapshot()).users[1]?.credentials[0]?.counter).toBe(7);
  });

  it('does not mutate another account under the operator proof', async () => {
    const db = database();
    const host = broker(db);
    const { change } = coordinator(db, host.port);
    const input = request();
    input.plan.mockImplementationOnce(async (_value, keys) => {
      keys.users[2] = { handle: 'b3RoZXI', credentials: [] };
      return { patch: {}, value: 'other-account' } as never;
    });
    await expect(change.change(input)).rejects.toMatchObject({ code: 'invalid-plan' });
    expect(host.port.prepare).not.toHaveBeenCalled();
    expect((await passkeys.snapshot()).users[2]).toBeUndefined();
  });

  it('also refuses surviving counter changes outside the recovery realm', async () => {
    await passkeys.change((keys) => {
      const current = keys.users[1];
      if (!current) throw new Error('Missing synthetic key');
      current.credentials.push({
        id: 'Yg',
        publicKey: 'a2V5',
        counter: 2,
        rpID: 'other.example',
        name: 'Other realm',
        createdAt: 1,
        lastUsedAt: null,
        transports: [],
      });
    });
    const db = database();
    const host = broker(db);
    const { change } = coordinator(db, host.port);
    const input = request();
    input.plan.mockImplementationOnce(async (_value, keys) => {
      const current = keys.users[1]?.credentials.find((key) => key.id === 'Yg');
      if (!current) throw new Error('Missing synthetic other-realm key');
      current.counter++;
      return { patch: {}, value: 'other-counter' } as never;
    });
    await expect(change.change(input)).rejects.toMatchObject({ code: 'counter-sync-required' });
    expect(host.port.prepare).not.toHaveBeenCalled();
  });

  it.each(['operation', 'binding', 'baseline', 'planned', 'state', 'extra'] as const)(
    'rejects a crossed %s prepare receipt before writes',
    async (field) => {
      const db = database();
      const host = broker(db);
      host.port.prepare.mockImplementationOnce(
        async (options) =>
          ({
            operationId: field === 'operation' ? 'bad' : operationId,
            state: field === 'state' ? 'completed' : 'pending',
            admissionBinding: field === 'binding' ? 'd'.repeat(64) : binding,
            baselineSha256: field === 'baseline' ? 'd'.repeat(64) : sha256(options.baselineIdentity),
            plannedSha256: field === 'planned' ? 'd'.repeat(64) : sha256(options.plannedIdentity),
            ...(field === 'extra' ? { extra: true } : {}),
          }) as never,
      );
      const { change } = coordinator(db, host.port);
      await expect(change.change(request())).rejects.toMatchObject({
        outcome: { phase: 'prepare', sql: 'not-written', passkeys: 'uncommitted', recovery: 'unknown' },
      });
      expect(db.events).not.toContain('sql-write');
      expect(host.port.complete).not.toHaveBeenCalled();
    },
  );

  it('does not write or retry when the prepare reply is lost, and never forwards private failure text', async () => {
    const db = database();
    const host = broker(db);
    host.port.prepare.mockRejectedValueOnce(new Error('SYNTHETIC_PRIVATE_MATERIAL'));
    const { change } = coordinator(db, host.port);
    const input = request();
    const error = await change.change(input).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(RecoveryChangeError);
    expect(error).toMatchObject({ outcome: { recovery: 'unknown', sql: 'not-written', passkeys: 'uncommitted' } });
    expect(String(error)).not.toContain('SYNTHETIC_PRIVATE_MATERIAL');
    expect(host.port.prepare).toHaveBeenCalledTimes(1);
    expect(input.afterSuccess).not.toHaveBeenCalled();
    expect(db.row().username).toBe('operator');
  });

  it('keeps pending recovery when SQL rejects before the file commit', async () => {
    const db = database();
    db.behavior.writeError = true;
    const host = broker(db);
    const { change } = coordinator(db, host.port);
    await expect(change.change(request())).rejects.toMatchObject({
      outcome: { phase: 'write', sql: 'uncertain', passkeys: 'uncommitted', recovery: 'pending' },
    });
    expect(db.row().username).toBe('operator');
    expect((await passkeys.snapshot()).users[1]?.credentials).toHaveLength(1);
    expect(host.port.complete).not.toHaveBeenCalled();
  });

  it('refuses a database result that differs from the candidate before publishing the file', async () => {
    const db = database();
    db.behavior.rewrite = { username: 'unexpected-trigger-value' };
    const host = broker(db);
    const { change } = coordinator(db, host.port);
    await expect(change.change(request())).rejects.toMatchObject({ outcome: { phase: 'write', passkeys: 'uncommitted', recovery: 'pending' } });
    expect((await passkeys.snapshot()).users[1]?.credentials).toHaveLength(1);
    expect(host.port.complete).not.toHaveBeenCalled();
  });

  it('reports file uncertainty without claiming SQL or file rollback', async () => {
    const db = database();
    const host = broker(db);
    const { change } = coordinator(db, host.port);
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Synthetic file failure'));
    await expect(change.change(request())).rejects.toMatchObject({ outcome: { sql: 'uncertain', passkeys: 'uncertain', recovery: 'pending' } });
    expect(db.row().username).toBe('operator');
    await expect(passkeys.snapshot()).rejects.toThrow('safely');
    expect(host.port.complete).not.toHaveBeenCalled();
  });

  it.each(['before', 'after'] as const)('treats a %s-commit lost reply as uncertain even when its file is committed', async (timing) => {
    const db = database();
    db.behavior.commitError = timing;
    const host = broker(db);
    const { change } = coordinator(db, host.port);
    const input = request();
    await expect(change.change(input)).rejects.toMatchObject({
      outcome: { phase: 'write', sql: 'uncertain', passkeys: 'committed', recovery: 'pending' },
    });
    expect(db.row().username).toBe(timing === 'before' ? 'operator' : 'updated-operator');
    expect((await passkeys.snapshot()).users[1]?.credentials).toEqual([]);
    expect(host.port.complete).not.toHaveBeenCalled();
    expect(input.afterSuccess).not.toHaveBeenCalled();
  });

  it('requires a fresh committed source instead of trusting the planned digest', async () => {
    const db = database();
    db.behavior.beforeFresh = () => {
      db.replace({ ...db.row(), username: 'external-change' });
    };
    const host = broker(db);
    const { change } = coordinator(db, host.port);
    await expect(change.change(request())).rejects.toMatchObject({
      outcome: { phase: 'source', sql: 'committed', passkeys: 'committed', recovery: 'pending' },
    });
    expect(host.port.complete).not.toHaveBeenCalled();
  });

  it.each(['lost', 'operation', 'binding', 'planned', 'extra'] as const)('does not grant a session after a %s completion receipt', async (kind) => {
    const db = database();
    const host = broker(db);
    host.port.complete.mockImplementationOnce(async () => {
      if (kind === 'lost') throw new Error('Synthetic complete reply unavailable');
      return {
        operationId: kind === 'operation' ? 'd'.repeat(64) : operationId,
        state: 'completed',
        admissionBinding: kind === 'binding' ? 'd'.repeat(64) : binding,
        plannedSha256: kind === 'planned' ? 'd'.repeat(64) : host.planned(),
        ...(kind === 'extra' ? { extra: true } : {}),
      } as never;
    });
    const { change } = coordinator(db, host.port);
    const input = request();
    await expect(change.change(input)).rejects.toMatchObject({
      outcome: { phase: 'complete', sql: 'committed', passkeys: 'committed', recovery: 'unknown' },
    });
    expect(input.afterSuccess).not.toHaveBeenCalled();
    expect(host.port.complete).toHaveBeenCalledTimes(1);
  });

  it('retains completed outcome if post-success session/cache work fails', async () => {
    const db = database();
    const host = broker(db);
    const { change } = coordinator(db, host.port);
    const input = request();
    input.afterSuccess.mockRejectedValueOnce(new Error('Synthetic session/cache failure'));
    await expect(change.change(input)).rejects.toMatchObject({
      outcome: { phase: 'after-success', sql: 'committed', passkeys: 'committed', recovery: 'completed' },
    });
    expect(db.row().username).toBe('updated-operator');
  });

  it('still leases an exact no-op so recovery installation cannot race an unmanaged change', async () => {
    const db = database();
    const host = broker(db, 'unmanaged');
    const { change } = coordinator(db, host.port);
    expect(await change.change({ accountId: 1, authorize: async () => undefined, plan: async () => ({ patch: {}, value: 'unchanged' }) })).toBe(
      'unchanged',
    );
    expect(host.port.prepare).toHaveBeenCalledTimes(1);
    expect(host.port.complete).toHaveBeenCalledTimes(1);
    expect(host.baseline()).toBe(host.planned());
    expect(db.events).not.toContain('sql-write');
  });

  it('holds after an abort acknowledged by Root before allowing any Main write', async () => {
    const db = database();
    const host = broker(db);
    const prepare = host.port.prepare.getMockImplementation();
    host.port.prepare.mockImplementationOnce(async (options) => {
      if (!prepare) throw new Error('Missing prepare fixture');
      const value = await prepare(options);
      signal.abort();
      return value;
    });
    const { change } = coordinator(db, host.port);
    const input = request();
    await expect(change.change(input)).rejects.toMatchObject({
      outcome: { phase: 'write', sql: 'not-written', passkeys: 'uncommitted', recovery: 'pending' },
    });
    expect(db.events).not.toContain('sql-write');
    expect(host.port.complete).not.toHaveBeenCalled();
    expect(input.afterSuccess).not.toHaveBeenCalled();
  });
});
