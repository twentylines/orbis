import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { hash } from 'argon2';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { EncryptionService } from '@/core/encryption/encryption.service';
import { PasskeyStore, type PasskeyState } from '../auth/passkey.store';
import { readRecoveryIdentity } from './identity';
import { withRecoveryIdentitySource } from './source';

let root: string;
let password: string;
let secret: string;
let config: { get: ReturnType<typeof vi.fn> };
let encryption: EncryptionService;
let passkeys: PasskeyStore;
let account: Record<string, unknown>;
let signal: AbortController;

beforeAll(async () => {
  password = await hash('synthetic-main-password', { memoryCost: 4096, timeCost: 2, parallelism: 1 });
});
beforeEach(async () => {
  if (!process.env.TMPDIR) throw new Error('Project-scoped TMPDIR required');
  root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'identity-')));
  secret = 'synthetic-main-encryption-key';
  config = { get: vi.fn((key: string) => (key === 'directories' ? { dataDir: root } : secret)) };
  encryption = new EncryptionService(config as never);
  passkeys = new PasskeyStore(config as never);
  signal = new AbortController();
  account = { id: 1, username: 'operator', operator: true, password, totpEnabled: false, totpSecret: null, salt: null };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

function database() {
  const events: string[] = [];
  let held = false;
  let rows = [account];
  let failure: unknown;
  const transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>, options: unknown) => {
    expect(options).toEqual({ isolationLevel: 'read committed', accessMode: 'read write' });
    const tx = {
      execute: async (query: Parameters<PgDialect['sqlToQuery']>[0]) => {
        expect(new PgDialect().sqlToQuery(query)).toEqual({ sql: 'LOCK TABLE "user" IN SHARE MODE NOWAIT', params: [] });
        if (failure) throw failure;
        held = true;
        events.push('locked');
      },
      select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => structuredClone(rows) }) }) }) }),
    };
    try {
      const value = await work(tx);
      events.push('committed');
      return value;
    } catch (error) {
      events.push('rolled-back');
      throw error;
    } finally {
      held = false;
      events.push('released');
    }
  });
  return {
    value: { transaction } as never,
    held: () => held,
    events,
    rows: (value: Record<string, unknown>[]) => {
      rows = value;
    },
    fail: (value: unknown) => {
      failure = value;
    },
  };
}

function options(db: ReturnType<typeof database>) {
  return { database: db.value, passkeys, encryption, config: config as never, origin: 'https://orbis.example', signal: signal.signal };
}

async function seed() {
  await passkeys.change((state) => {
    state.users[1] = {
      handle: 'aGFuZGxl',
      credentials: [
        { id: 'YQ', publicKey: 'a2V5', counter: 7, rpID: 'orbis.example', name: 'key', createdAt: 1, lastUsedAt: null, transports: [] },
        { id: 'Yg', publicKey: 'a2V5', counter: 9, rpID: 'other.example', name: 'other key', createdAt: 1, lastUsedAt: null, transports: [] },
      ],
    };
  });
}

it('collects the actual password and matching-realm passkeys under both fences, then clears its buffer', async () => {
  await seed();
  const db = database();
  let bytes: Buffer | undefined;
  const result = await withRecoveryIdentitySource(options(db), async (source) => {
    expect(db.held()).toBe(true);
    const value = readRecoveryIdentity(source.bytes, source.sha256);
    expect(value).toMatchObject({
      accountId: 1,
      passwordHash: password,
      userHandle: 'aGFuZGxl',
      realm: { origin: 'https://orbis.example', rpID: 'orbis.example' },
    });
    expect(value.credentials.map((key) => key.id)).toEqual(['YQ']);
    await expect(passkeys.change(() => undefined)).rejects.toThrow('snapshot');
    bytes = source.bytes;
    return source.revision;
  });
  expect(result).toMatch(/^[a-f0-9]{64}$/);
  expect(bytes?.every((byte) => byte === 0)).toBe(true);
  expect(db.events).toEqual(['locked', 'committed', 'released']);
});

it('decrypts enabled TOTP with the real cipher and preserves the Main passkey TOTP policy', async () => {
  await seed();
  const salt = 'synthetic-totp-salt';
  const totpSecret = encryption.encrypt('JBSWY3DPEHPK3PXP', salt);
  Object.assign(account, { totpEnabled: true, totpSecret, salt });
  await passkeys.change((state) => {
    const keys = state.users[1];
    if (!keys) throw new Error('Missing seeded passkeys');
    keys.totpAfterPasskey = createHash('sha256').update(`${totpSecret}/${salt}`).digest('hex');
  });
  await withRecoveryIdentitySource(options(database()), async (source) => {
    const value = readRecoveryIdentity(source.bytes, source.sha256);
    expect(value.totpSecret).toBe('JBSWY3DPEHPK3PXP');
    expect(value.requireTotpAfterPasskey).toBe(true);
  });
});

it('does not export staged disabled TOTP or enable an obsolete passkey TOTP policy', async () => {
  await seed();
  Object.assign(account, { totpSecret: 'unreadable-staged-secret', salt: 'staged-salt' });
  await passkeys.change((state) => {
    const keys = state.users[1];
    if (!keys) throw new Error('Missing seeded passkeys');
    keys.totpAfterPasskey = 'a'.repeat(64);
  });
  const decrypt = vi.spyOn(encryption, 'decrypt');
  await withRecoveryIdentitySource(options(database()), async (source) => {
    expect(readRecoveryIdentity(source.bytes, source.sha256)).toMatchObject({ totpSecret: null, requireTotpAfterPasskey: false });
  });
  expect(decrypt).not.toHaveBeenCalled();
});

it('refuses zero or multiple operators, invalid credentials and unreadable enabled TOTP before handoff', async () => {
  for (const rows of [
    [],
    [account, { ...account, id: 2 }],
    [{ ...account, operator: false }],
    [{ ...account, password: 'invalid' }],
    [{ ...account, totpEnabled: true, salt: null }],
  ]) {
    const db = database();
    db.rows(rows);
    const work = vi.fn();
    await expect(withRecoveryIdentitySource(options(db), work)).rejects.toThrow('could not be verified');
    expect(work).not.toHaveBeenCalled();
    expect(db.held()).toBe(false);
  }
});

it('returns busy for database writer contention without entering the passkey fence', async () => {
  const db = database();
  db.fail({ code: '55P03' });
  const fence = vi.spyOn(passkeys, 'withReadFence');
  await expect(withRecoveryIdentitySource(options(db), vi.fn())).rejects.toMatchObject({ code: 'busy' });
  expect(fence).not.toHaveBeenCalled();
});

it('waits for a cancelled handoff to settle before releasing source fences', async () => {
  const db = database();
  let finish = () => {};
  let entered = () => {};
  const active = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const work = withRecoveryIdentitySource(options(db), async () => {
    entered();
    await gate;
  });
  await active;
  const rejected = expect(work).rejects.toMatchObject({ code: 'cancelled' });
  signal.abort();
  expect(db.held()).toBe(true);
  await expect(passkeys.change(() => undefined)).rejects.toThrow('snapshot');
  finish();
  await rejected;
  expect(db.held()).toBe(false);
});

it('rejects key/context drift and callback byte mutation without reporting a ready identity', async () => {
  for (const mutate of [
    (bytes: Buffer) => {
      bytes[0] = 0;
    },
    () => {
      secret = 'changed-key';
    },
  ]) {
    secret = 'synthetic-main-encryption-key';
    await expect(
      withRecoveryIdentitySource(options(database()), async (source) => {
        mutate(source.bytes);
      }),
    ).rejects.toMatchObject({ code: 'source' });
  }
});

it('detects external passkey replacement during the protected handoff', async () => {
  await seed();
  const db = database();
  const file = path.join(root, 'state/auth/passkeys.json');
  await expect(
    withRecoveryIdentitySource(options(db), async () => {
      const state = JSON.parse(await fs.readFile(file, 'utf8')) as PasskeyState;
      const key = state.users[1]?.credentials[0];
      if (!key) throw new Error('Missing seeded passkey');
      key.counter++;
      await fs.writeFile(file, JSON.stringify(state));
    }),
  ).rejects.toMatchObject({ code: 'source' });
  expect(db.events).toContain('rolled-back');
});
