import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { hash } from 'argon2';
import { PgDialect } from 'drizzle-orm/pg-core';
import { SELF_DECLARED_DEPS_METADATA } from '@nestjs/common/constants';
import { beforeEach, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { ConfigurationService } from '@/core/config/configuration.service';
import { EncryptionService } from '@/core/encryption/encryption.service';
import { PasskeyStore } from '../auth/passkey.store';
import { captureRecoverySource, recoverySourceCapability, type SourceChannel } from './source-exporter';
import { readRecoveryIdentity } from './identity';
const sha = (body: Buffer | string) => createHash('sha256').update(body).digest('hex');
let root: string;
let password: string;
let held: boolean;
let closed: boolean;
let frames: Array<Record<string, unknown>>;
let account: Record<string, unknown>;
let request: Record<string, unknown>;
let next: (frame: Record<string, unknown>) => Promise<unknown>;
const nonce = randomBytes(32).toString('base64url');
const facts = {
  systemIdentifier: '123',
  database: 'tipi',
  databaseOid: '16384',
  role: 'tipi',
  roleOid: '16385',
  postmasterEpochUs: '12345',
  serverVersionNum: 140010,
  relationOid: '16400',
  relationOwnerOid: '16385',
  relationKind: 'r',
  rowSecurity: false,
  forceRowSecurity: false,
  resolvedRelation: '16400',
  dataDirectory: '/var/lib/postgresql/data',
  serverAddress: '127.0.0.1',
  serverPort: 5432,
};
const types: Record<string, string> = {
  id: 'int4',
  username: 'varchar',
  password: 'varchar',
  created_at: 'int4',
  updated_at: 'int4',
  operator: 'bool',
  totp_secret: 'text',
  totp_enabled: 'bool',
  salt: 'text',
  locale: 'varchar',
  has_seen_welcome: 'bool',
};
let sqlFacts: Record<string, unknown>;
const channel: SourceChannel = {
  send: async (value) => {
    expect(held).toBe(true);
    frames.push(value as Record<string, unknown>);
  },
  receive: async () => {
    expect(held).toBe(true);
    const frame = frames.at(-1);
    if (!frame) throw new Error('Source frame expected');
    return next(frame);
  },
};
async function write(name: string, body: Buffer | string) {
  const file = path.join(root, name);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, body, { mode: 0o600 });
}
async function writeRequest() {
  await write('request.json', JSON.stringify(request));
}
function command(operation = 'release') {
  return { schema: 'orbis.sentinel-source-command.v1', operation, collectionNonce: nonce, challenge: randomBytes(32).toString('base64url') };
}
const database = {
  transaction: async (work: (tx: unknown) => Promise<unknown>, options: unknown) => {
    expect(options).toEqual({ isolationLevel: 'read committed', accessMode: 'read write' });
    const tx = {
      execute: async (query: Parameters<PgDialect['sqlToQuery']>[0]) => {
        expect(new PgDialect().sqlToQuery(query).sql).toBe('LOCK TABLE "user" IN SHARE MODE NOWAIT');
        held = true;
      },
      select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [structuredClone(account)] }) }) }) }),
    };
    try {
      return await work(tx);
    } finally {
      held = false;
    }
  },
};
const open = vi.fn(async (connection: unknown) => {
  expect(connection).toMatchObject({ host: '127.0.0.1', port: 5432, user: 'tipi', database: 'tipi', password: 'synthetic-db-password' });
  return {
    database: database as never,
    client: {
      query: vi.fn(async (sql: string) => ({
        rows: sql.includes('pg_attribute')
          ? Object.entries(types).map(([name, type]) => ({ name, type, required: !['salt', 'totp_secret'].includes(name) }))
          : [{ facts: structuredClone(sqlFacts) }],
      })),
    } as never,
    close: async () => {
      closed = true;
    },
  };
});
beforeAll(async () => {
  password = await hash('synthetic-export-password', { memoryCost: 4096, timeCost: 2, parallelism: 1 });
});
beforeEach(async () => {
  if (!process.env.TMPDIR) throw new Error('Project-scoped TMPDIR required');
  root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'source-export-')));
  frames = [];
  held = false;
  closed = false;
  sqlFacts = { ...facts };
  open.mockClear();
  account = { id: 1, username: 'operator', operator: true, password, totpEnabled: false, totpSecret: null, salt: null };
  const configuration = Buffer.from(
    [
      ['POSTGRES_HOST', 'runtipi-db'],
      ['POSTGRES_PORT', '5432'],
      ['POSTGRES_USERNAME', 'tipi'],
      ['POSTGRES_PASSWORD', 'synthetic-db-password'],
      ['POSTGRES_DBNAME', 'tipi'],
      ['JWT_SECRET', 'test-context'.repeat(4)],
      ['ORBIS_SENTINEL_RECOVERY_ORIGIN', 'https://recovery.example'],
    ]
      .map(([name, value]) => `${name}=${value}\n`)
      .join(''),
  );
  const controller = Buffer.from(JSON.stringify(['POSTGRES_PASSWORD=wrong-creation-value', 'ORBIS_SENTINEL_RECOVERY_ORIGIN=https://wrong.example']));
  const db = Buffer.from(JSON.stringify(['POSTGRES_USER=tipi', 'POSTGRES_DB=tipi', 'POSTGRES_PASSWORD=synthetic-db-password']));
  await write('data/.env', configuration);
  await write('controller-environment.json', controller);
  await write('database-environment.json', db);
  await fs.mkdir(path.join(root, 'data/state/auth'), { recursive: true, mode: 0o700 });
  request = {
    schema: 'orbis.sentinel-source-request.v1',
    operationId: 'a'.repeat(64),
    planSha256: 'b'.repeat(64),
    collectionNonce: nonce,
    phase: 'proposal',
    origin: 'https://recovery.example',
    installationId: 'c'.repeat(64),
    sourceBindingSha256: 'd'.repeat(64),
    publicationSha256: '4'.repeat(64),
    controllerId: 'e'.repeat(64),
    controllerImageId: `sha256:${'f'.repeat(64)}`,
    configurationSha256: sha(configuration),
    controllerEnvironmentSha256: sha(controller),
    databaseEnvironmentSha256: sha(db),
    passkeysSha256: null,
    database: {
      containerId: '1'.repeat(64),
      imageId: `sha256:${'2'.repeat(64)}`,
      networkId: '3'.repeat(64),
      allowedHosts: ['runtipi-db'],
      major: 14,
      dataDirectory: '/var/lib/postgresql/data',
    },
  };
  await writeRequest();
  next = async () => command();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
function run() {
  return captureRecoverySource({ input: root, channel, signal: AbortSignal.timeout(10000), openDatabase: open });
}
it('uses actual source builder and holds its SQL/file fence through checked release', async () => {
  let count = 0;
  next = async () => command(count++ ? 'release' : 'check');
  await run();
  expect(frames.map((f) => f.phase)).toEqual(['source', 'checked', 'released']);
  expect(closed).toBe(true);
  expect(held).toBe(false);
  const first = frames[0];
  if (!first) throw new Error('Source frame expected');
  const bytes = Buffer.from(String(first.identityBase64), 'base64');
  expect(readRecoveryIdentity(bytes, String(first.sourceSha256))).toMatchObject({
    accountId: 1,
    passwordHash: password,
    realm: { origin: request.origin },
  });
  expect(JSON.stringify(frames[0]?.descriptor)).not.toMatch(/synthetic-db-password|synthetic-encryption-secret/);
});
it('exports real decrypted TOTP and only matching-realm physical passkey counters', async () => {
  const encryption = new EncryptionService({ get: () => 'test-context'.repeat(4) });
  const salt = 'synthetic-export-salt';
  const secret = encryption.encrypt('JBSWY3DPEHPK3PXP', salt);
  Object.assign(account, { totpEnabled: true, totpSecret: secret, salt });
  const passkeys = {
    version: 1,
    users: {
      1: {
        handle: 'aGFuZGxl',
        totpAfterPasskey: sha(`${secret}/${salt}`),
        credentials: [
          { id: 'YQ', publicKey: 'a2V5', counter: 7, rpID: 'recovery.example', name: 'key', createdAt: 1, lastUsedAt: null, transports: [] },
          { id: 'Yg', publicKey: 'a2V5', counter: 9, rpID: 'other.example', name: 'other', createdAt: 1, lastUsedAt: null, transports: [] },
        ],
      },
    },
  };
  const body = Buffer.from(JSON.stringify(passkeys));
  await write('data/state/auth/passkeys.json', body);
  request.passkeysSha256 = sha(body);
  await writeRequest();
  await run();
  const first = frames[0];
  if (!first) throw new Error('Source frame expected');
  const identity = readRecoveryIdentity(Buffer.from(String(first.identityBase64), 'base64'), String(first.sourceSha256));
  expect(identity.totpSecret).toBe('JBSWY3DPEHPK3PXP');
  expect(identity.requireTotpAfterPasskey).toBe(true);
  expect(identity.credentials).toEqual([{ id: 'YQ', publicKey: 'a2V5', counter: 7, rpID: 'recovery.example' }]);
  expect(await fs.readFile(path.join(root, 'data/state/auth/passkeys.json'))).toEqual(body);
  expect(JSON.stringify(first.descriptor)).not.toContain('JBSWY3DPEHPK3PXP');
});

it('makes database requirement explicit without changing authentication capability', () => {
  expect(recoverySourceCapability.databaseRequired).toBe(true);
  expect(recoverySourceCapability.sqlMutations).toBe('none');
  for (const service of [EncryptionService, PasskeyStore])
    expect(Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, service)).toContainEqual({ index: 0, param: ConfigurationService });
});
it('rejects nonce mismatch and unknown operations before release', async () => {
  for (const mutate of [
    (v: Record<string, unknown>) => ({ ...v, collectionNonce: 'wrong' }),
    (v: Record<string, unknown>) => ({ ...v, operation: 'sql' }),
  ]) {
    next = async () => mutate(command());
    await expect(run()).rejects.toThrow('could not be verified');
    expect(closed).toBe(true);
    expect(held).toBe(false);
  }
});
it('detects pinned input replacement while the source frame is live', async () => {
  next = async () => {
    const file = path.join(root, 'data/.env');
    const body = await fs.readFile(file);
    await fs.rename(file, `${file}.old`);
    await fs.writeFile(file, body, { mode: 0o600 });
    return command();
  };
  await expect(run()).rejects.toThrow('could not be verified');
  expect(frames).toHaveLength(1);
  expect(held).toBe(false);
});
it('detects passkey absence changing during the live fence', async () => {
  next = async () => {
    await write('data/state/auth/passkeys.json', '{"version":1,"users":{}}');
    return command();
  };
  await expect(run()).rejects.toThrow('could not be verified');
  expect(held).toBe(false);
});
it('refuses remote or mismatched realm candidates before opening SQL', async () => {
  request.origin = 'https://different.example';
  await writeRequest();
  await expect(run()).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();
  request.origin = 'https://recovery.example';
  request.database = { ...(request.database as object), allowedHosts: ['remote.example'] };
  await writeRequest();
  await expect(run()).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();
});
it('refuses wrong schema/server/source bindings without exposing credentials', async () => {
  for (const patch of [{ rowSecurity: true }, { serverAddress: '10.0.0.1' }, { resolvedRelation: '9999' }, { serverVersionNum: 170000 }]) {
    sqlFacts = { ...facts, ...patch };
    await expect(run()).rejects.toThrow(/^The stopped credential source could not be verified.$/);
    expect(closed).toBe(true);
  }
  request.configurationSha256 = '0'.repeat(64);
  await writeRequest();
  open.mockClear();
  await expect(run()).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();
});
it('refuses inherited connection overrides instead of querying a different Main source', async () => {
  const original = await fs.readFile(path.join(root, 'data/.env'));
  for (const suffix of ['PGOPTIONS=-c search_path=other\n', 'PGCLIENTENCODING=LATIN1\n', 'PGSSLMODE=require\n']) {
    const body = Buffer.concat([original, Buffer.from(suffix)]);
    await write('data/.env', body);
    request.configurationSha256 = sha(body);
    await writeRequest();
    await expect(run()).rejects.toThrow('could not be verified');
    expect(open).not.toHaveBeenCalled();
  }
});

it('does not accept a source receipt when its final fence check fails', async () => {
  next = async () => command();
  let sends = 0;
  const broken: SourceChannel = {
    ...channel,
    send: async (value) => {
      await channel.send(value);
      if (++sends === 2) await write('data/state/auth/passkeys.json', '{"version":1,"users":{}}');
    },
  };
  await expect(captureRecoverySource({ input: root, channel: broken, signal: AbortSignal.timeout(10000), openDatabase: open })).rejects.toThrow();
  expect(frames.at(-1)?.phase).toBe('released');
  expect(held).toBe(false);
  expect(closed).toBe(true);
});
