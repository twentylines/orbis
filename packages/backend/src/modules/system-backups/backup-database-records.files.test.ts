import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  BackupDatabaseRecordError,
  BackupDatabaseRecords,
  backupDatabaseColumns,
  backupDatabaseLimits,
  boundedPasswordHash,
  type BackupDatabaseTable,
} from './backup-database-records';

type Row = Record<string, unknown>;
let directory: string;
let fileNumber = 0;
let passwordHash: string;
let sourceKey: string;
let encryptedTotp: string;
let totpSalt: string;
const signal = () => new AbortController().signal;

beforeAll(async () => {
  passwordHash = await argon2.hash('disposable account verification fixture');
  sourceKey = randomBytes(32).toString('hex');
  totpSalt = randomBytes(16).toString('hex');
  const key = pbkdf2Sync(sourceKey, totpSalt, 100_000, 32, 'sha256');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update('JBSWY3DPEHPK3PXP'), cipher.final()]);
  encryptedTotp = [iv.toString('hex'), ciphertext.toString('hex'), cipher.getAuthTag().toString('hex')].join(':');
  key.fill(0);
});
beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-database-records-')));
  await fs.chmod(directory, 0o700);
  fileNumber = 0;
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

async function onDisk(value: unknown): Promise<unknown> {
  const file = path.join(directory, `${fileNumber++}.json`);
  await fs.writeFile(file, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function accept(records: BackupDatabaseRecords, table: BackupDatabaseTable, row: Row) {
  return records.accept(table, await onDisk(row));
}
function account(overrides: Row = {}): Row {
  return {
    id: 1,
    username: 'fixture@example.invalid',
    password: passwordHash,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_001,
    operator: true,
    totp_secret: null,
    totp_enabled: false,
    salt: null,
    locale: 'en',
    has_seen_welcome: true,
    ...overrides,
  };
}
function app(overrides: Row = {}): Row {
  return {
    id: 1,
    status: 'stopped',
    config: { port: 8080, environment: { EXAMPLE_MESSAGE: 'fixture content' }, nested: [true, null, 1.5] },
    created_at: 1_700_000_000,
    updated_at: 1_700_000_001,
    version: 3,
    ignored_version: 4,
    exposed: false,
    domain: null,
    is_visible_on_guest_dashboard: true,
    open_port: true,
    port: 8080,
    exposed_local: true,
    app_store_slug: '_user',
    app_name: 'custom-app',
    enable_auth: true,
    subnet: '10.50.1.0/24',
    local_subdomain: 'custom',
    pending_restart: true,
    user_config_enabled: true,
    max_backups: 7,
    template_urn: 'template:catalogue',
    last_template_sync_at: 1_700_000_002,
    template_version: 2,
    ...overrides,
  };
}
function store(overrides: Row = {}): Row {
  return {
    slug: 'catalogue',
    hash: 'fixture-store-hash',
    name: 'Fixture store',
    enabled: true,
    url: 'https://example.invalid/catalogue.git',
    branch: 'main',
    created_at: 1_700_000_000,
    updated_at: 1_700_000_001,
    ...overrides,
  };
}
function link(overrides: Row = {}): Row {
  return {
    id: 1,
    title: 'Fixture link',
    url: 'https://example.invalid/',
    icon_url: null,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_001,
    user_id: 1,
    description: null,
    is_visible_on_guest_dashboard: false,
    ...overrides,
  };
}
function credential(id = 'ZmFrZS1jcmVkZW50aWFs') {
  return {
    id,
    publicKey: 'ZmFrZS1wdWJsaWMta2V5',
    counter: 0,
    name: 'Disposable fixture',
    rpID: 'example.invalid',
    createdAt: 1_700_000_000,
    lastUsedAt: null,
    transports: ['internal'],
  };
}
function passkeys(users: Record<string, unknown> = { '1': { handle: 'ZmFrZS11c2VyLWhhbmRsZQ', credentials: [credential()] } }) {
  return { version: 1, users };
}
function expectRecordError(action: () => unknown, reason: BackupDatabaseRecordError['reason']) {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught instanceof BackupDatabaseRecordError).toBe(true);
  if (caught instanceof BackupDatabaseRecordError) expect(caught.reason).toBe(reason);
}
async function expectFinishError(records: BackupDatabaseRecords, value: unknown, reason: BackupDatabaseRecordError['reason']) {
  let caught: unknown;
  try {
    await records.finish(value, signal());
  } catch (error) {
    caught = error;
  }
  expect(caught instanceof BackupDatabaseRecordError).toBe(true);
  if (caught instanceof BackupDatabaseRecordError) expect(caught.reason).toBe(reason);
}

it('exports every current physical column, including editable-app template tracking', () => {
  expect(backupDatabaseColumns('app')).toEqual([
    'id',
    'status',
    'config',
    'created_at',
    'updated_at',
    'version',
    'ignored_version',
    'exposed',
    'domain',
    'is_visible_on_guest_dashboard',
    'open_port',
    'port',
    'exposed_local',
    'app_store_slug',
    'app_name',
    'enable_auth',
    'subnet',
    'local_subdomain',
    'pending_restart',
    'user_config_enabled',
    'max_backups',
    'template_urn',
    'last_template_sync_at',
    'template_version',
  ]);
  expect(backupDatabaseColumns('user')).toEqual([
    'id',
    'username',
    'password',
    'created_at',
    'updated_at',
    'operator',
    'totp_secret',
    'totp_enabled',
    'salt',
    'locale',
    'has_seen_welcome',
  ]);
  expect(backupDatabaseColumns('link')).toEqual([
    'id',
    'title',
    'url',
    'icon_url',
    'created_at',
    'updated_at',
    'user_id',
    'description',
    'is_visible_on_guest_dashboard',
  ]);
  expect(backupDatabaseColumns('app_store')).toEqual(['slug', 'hash', 'name', 'enabled', 'url', 'branch', 'created_at', 'updated_at']);
});

it('round-trips current app data and a virtual custom-app store without inventing a store FK', async () => {
  const records = new BackupDatabaseRecords(sourceKey);
  await accept(records, 'user', account());
  const original = app();
  const normalized = await accept(records, 'app', original);
  expect(JSON.stringify(normalized) === JSON.stringify(original)).toBe(true);
  expect(normalized.config === original.config).toBe(false);
  await accept(
    records,
    'app',
    app({
      id: 2,
      app_name: 'retained-app',
      app_store_slug: 'removed-store',
      subnet: null,
      template_urn: null,
      template_version: null,
      last_template_sync_at: null,
    }),
  );
  await expect(records.finish(undefined, signal())).resolves.toEqual({ user: 1, app_store: 0, app: 2, link: 0 });
});

it.each(['missing', 'extra', 'wrong-case'] as const)('rejects %s physical columns instead of applying defaults', async (kind) => {
  const row = app();
  if (kind === 'missing') delete row.template_version;
  if (kind === 'extra') row.unexpected = true;
  if (kind === 'wrong-case') {
    row.templateVersion = row.template_version;
    delete row.template_version;
  }
  const value = await onDisk(row);
  expectRecordError(() => new BackupDatabaseRecords(sourceKey).accept('app', value), 'schema');
});

it.each([
  ['null required field', { status: null }],
  ['invalid enum', { status: 'unknown-state' }],
  ['integer string', { version: '3' }],
  ['fractional integer', { version: 1.5 }],
  ['above int32', { version: 2_147_483_648 }],
  ['below int32', { created_at: -2_147_483_649 }],
  ['numeric boolean', { exposed: 1 }],
  ['string boolean', { open_port: 'true' }],
  ['array config', { config: [] }],
  ['null config', { config: null }],
  ['string config', { config: '{}' }],
  ['NUL varchar', { app_name: 'bad\0name' }],
  ['unpaired varchar surrogate', { app_name: '\ud800' }],
] as const)('rejects schema mismatch: %s', async (_name, change) => {
  const value = await onDisk(app(change));
  expectRecordError(() => new BackupDatabaseRecords(sourceKey).accept('app', value), 'schema');
});

it('preserves signed int32 boundaries, optional nulls and valid Unicode', async () => {
  const records = new BackupDatabaseRecords(sourceKey);
  await accept(records, 'user', account());
  const row = await accept(
    records,
    'app',
    app({
      created_at: -2_147_483_648,
      updated_at: 2_147_483_647,
      ignored_version: null,
      subnet: null,
      config: { text: '日本語 😀 é', count: 1.25 },
      app_name: '日本語-app',
    }),
  );
  expect(row.created_at).toBe(-2_147_483_648);
  expect(row.updated_at).toBe(2_147_483_647);
  await accept(records, 'link', link({ title: '😀'.repeat(20), description: '界'.repeat(50) }));
  await accept(records, 'app_store', store({ name: '😀'.repeat(16) }));
  await expect(records.finish(undefined, signal())).resolves.toEqual({ user: 1, app_store: 1, app: 1, link: 1 });
});

it.each([
  ['link title', 'link', () => link({ title: '😀'.repeat(21) })],
  ['link description', 'link', () => link({ description: '界'.repeat(51) })],
  ['store name', 'app_store', () => store({ name: '😀'.repeat(17) })],
] as const)('counts varchar characters rather than UTF-16 units: %s', async (_name, table, build) => {
  const value = await onDisk(build());
  expectRecordError(() => new BackupDatabaseRecords(sourceKey).accept(table, value), 'schema');
});

function nested(depth: number) {
  let value: unknown = 'leaf';
  for (let index = 0; index < depth; index++) value = { nested: value };
  return value;
}
it('accepts the configured JSON depth boundary and rejects one level deeper', async () => {
  const records = new BackupDatabaseRecords(sourceKey);
  await accept(records, 'app', app({ config: nested(backupDatabaseLimits.depth) }));
  const value = await onDisk(app({ id: 2, config: nested(backupDatabaseLimits.depth + 1) }));
  expectRecordError(() => records.accept('app', value), 'limit');
});

it.each([
  ['NUL value', { text: 'bad\0value' }],
  ['surrogate value', { text: '\udfff' }],
  ['NUL key', { 'bad\0key': true }],
  ['surrogate key', { '\ud800': true }],
] as const)('rejects JSON incompatible with PostgreSQL UTF-8: %s', async (_name, config) => {
  const value = await onDisk(app({ config }));
  expectRecordError(() => new BackupDatabaseRecords(sourceKey).accept('app', value), 'schema');
});

it('rejects nonfinite JSON numbers parsed from an overflowing exponent', async () => {
  const file = path.join(directory, 'overflow.json');
  const row = app({ config: { number: 1 } });
  await fs.writeFile(file, JSON.stringify(row).replace('"number":1', '"number":1e1000'), { mode: 0o600 });
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  expectRecordError(() => new BackupDatabaseRecords(sourceKey).accept('app', value), 'schema');
});

it('bounds wide JSON and serialized row bytes independently of nesting', async () => {
  const wide = await onDisk(app({ config: { values: Array(backupDatabaseLimits.nodes).fill(null) } }));
  expectRecordError(() => new BackupDatabaseRecords(sourceKey).accept('app', wide), 'limit');
  const large = await onDisk(app({ config: { text: 'x'.repeat(backupDatabaseLimits.rowBytes) } }));
  expectRecordError(() => new BackupDatabaseRecords(sourceKey).accept('app', large), 'limit');
});

it.each(['user', 'app', 'link', 'app_store'] as const)('rejects duplicate primary identity in %s without incrementing counts', async (table) => {
  const records = new BackupDatabaseRecords(sourceKey);
  const row = table === 'user' ? account() : table === 'app' ? app() : table === 'link' ? link() : store();
  await accept(records, table, row);
  const duplicate = await onDisk(row);
  expectRecordError(() => records.accept(table, duplicate), 'identity');
  expect(records.counts[table]).toBe(1);
});

it.each([0, -1, 2_147_483_648])('rejects an invalid positive serial identity', async (id) => {
  const value = await onDisk(link({ id }));
  expectRecordError(() => new BackupDatabaseRecords(sourceKey).accept('link', value), id > 2_147_483_647 ? 'schema' : 'identity');
});

it('rejects duplicate store hashes and non-null subnets while allowing multiple null subnets', async () => {
  const records = new BackupDatabaseRecords(sourceKey);
  await accept(records, 'app_store', store());
  const duplicateHash = await onDisk(store({ slug: 'other-store' }));
  expectRecordError(() => records.accept('app_store', duplicateHash), 'identity');
  await accept(records, 'app', app());
  const duplicateSubnet = await onDisk(app({ id: 2, app_name: 'other-app' }));
  expectRecordError(() => records.accept('app', duplicateSubnet), 'identity');
  await accept(records, 'app', app({ id: 2, app_name: 'other-app', subnet: null }));
  await accept(records, 'app', app({ id: 3, app_name: 'third-app', subnet: null }));
  expect(records.counts.app).toBe(3);
});

it('checks link-user relationships after all tables arrive, allowing forward references', async () => {
  const valid = new BackupDatabaseRecords(sourceKey);
  await accept(valid, 'link', link());
  await accept(valid, 'user', account());
  await expect(valid.finish(undefined, signal())).resolves.toEqual({ user: 1, app_store: 0, app: 0, link: 1 });
  const invalid = new BackupDatabaseRecords(sourceKey);
  await accept(invalid, 'user', account());
  await accept(invalid, 'link', link({ user_id: 9 }));
  await expectFinishError(invalid, undefined, 'identity');
});

it('requires a restored operator account', async () => {
  await expectFinishError(new BackupDatabaseRecords(sourceKey), undefined, 'account');
  const records = new BackupDatabaseRecords(sourceKey);
  await accept(records, 'user', account({ operator: false }));
  await expectFinishError(records, undefined, 'account');
});

it('accepts an actual Argon2 hash produced with the installed library defaults', () => {
  expect(boundedPasswordHash(passwordHash)).toBe(true);
});

function encodedHash(parameters: string, saltBytes = 16, hashBytes = 32) {
  return `$argon2id$v=19$${parameters}$${Buffer.alloc(saltBytes, 3).toString('base64').replace(/=+$/, '')}$${Buffer.alloc(hashBytes, 7).toString('base64').replace(/=+$/, '')}`;
}
it.each([
  ['maximum memory and work', 'm=262144,t=4,p=8'],
  ['maximum iterations', 'm=8192,t=10,p=1'],
  ['minimum lane memory', 'm=64,t=1,p=8'],
])('accepts bounded Argon2 parameters: %s', (_name, parameters) => {
  expect(boundedPasswordHash(encodedHash(parameters))).toBe(true);
});
it.each([
  ['too much memory', 'm=262145,t=1,p=1'],
  ['too much total work', 'm=262144,t=5,p=1'],
  ['too many iterations', 'm=8192,t=11,p=1'],
  ['too many lanes', 'm=8192,t=1,p=9'],
  ['insufficient lane memory', 'm=63,t=1,p=8'],
  ['zero memory', 'm=0,t=1,p=1'],
])('rejects unsafe Argon2 parameters: %s', (_name, parameters) => {
  expect(boundedPasswordHash(encodedHash(parameters))).toBe(false);
});
it.each([
  ['short salt', () => encodedHash('m=8192,t=1,p=1', 7)],
  ['short digest', () => encodedHash('m=8192,t=1,p=1', 16, 15)],
  ['oversized salt', () => encodedHash('m=8192,t=1,p=1', 65)],
  ['unsupported version', () => encodedHash('m=8192,t=1,p=1').replace('v=19', 'v=20')],
  ['padded base64', () => `${encodedHash('m=8192,t=1,p=1')}=`],
  ['other password format', () => 'unsupported-password-format'],
])('rejects malformed encoded hashes: %s', (_name, build) => {
  expect(boundedPasswordHash(build())).toBe(false);
});

it('decrypts real AES-GCM/PBKDF2 TOTP data with the supplied source JWT key', async () => {
  const records = new BackupDatabaseRecords(sourceKey);
  await accept(records, 'user', account({ totp_enabled: true, totp_secret: encryptedTotp, salt: totpSalt }));
  await expect(records.finish(undefined, signal())).resolves.toEqual({ user: 1, app_store: 0, app: 0, link: 0 });
  const wrongKey = new BackupDatabaseRecords(randomBytes(32).toString('hex'));
  await accept(wrongKey, 'user', account({ totp_enabled: true, totp_secret: encryptedTotp, salt: totpSalt }));
  await expectFinishError(wrongKey, undefined, 'account');
});

it.each(['tag', 'missing-salt', 'odd-ciphertext', 'trailing-field'] as const)('rejects inconsistent enabled TOTP: %s', async (kind) => {
  const parts = encryptedTotp.split(':');
  if (kind === 'tag') parts[2] = `${parts[2]?.startsWith('0') ? '1' : '0'}${parts[2]?.slice(1)}`;
  if (kind === 'odd-ciphertext') parts[1] = `${parts[1]}0`;
  if (kind === 'trailing-field') parts.push('00');
  const records = new BackupDatabaseRecords(sourceKey);
  await accept(records, 'user', account({ totp_enabled: true, totp_secret: parts.join(':'), salt: kind === 'missing-salt' ? null : totpSalt }));
  await expectFinishError(records, undefined, 'account');
});

it('validates passkey ownership and the existing TOTP-after-passkey binding', async () => {
  const records = new BackupDatabaseRecords(sourceKey);
  await accept(records, 'user', account({ totp_enabled: true, totp_secret: encryptedTotp, salt: totpSalt }));
  const binding = createHash('sha256').update(`${encryptedTotp}/${totpSalt}`).digest('hex');
  const value = await onDisk(passkeys({ '1': { handle: 'ZmFrZS11c2VyLWhhbmRsZQ', credentials: [credential()], totpAfterPasskey: binding } }));
  await expect(records.finish(value, signal())).resolves.toEqual({ user: 1, app_store: 0, app: 0, link: 0 });
});

it.each(['unknown-user', 'duplicate-key', 'wrong-binding', 'binding-without-totp', 'invalid-schema'] as const)(
  'rejects inconsistent passkey state: %s',
  async (kind) => {
    const records = new BackupDatabaseRecords(sourceKey);
    await accept(records, 'user', account());
    await accept(records, 'user', account({ id: 2, username: 'second@example.invalid', operator: false }));
    const users: Record<string, Row> = { '1': { handle: 'ZmFrZS11c2VyLWhhbmRsZQ', credentials: [credential()] } };
    const primary = users['1'];
    if (!primary) throw new Error('Missing fixture user');
    if (kind === 'unknown-user') users['9'] = { handle: 'YW5vdGhlci1oYW5kbGU', credentials: [] };
    if (kind === 'duplicate-key') users['2'] = { handle: 'YW5vdGhlci1oYW5kbGU', credentials: [credential()] };
    if (kind === 'wrong-binding' || kind === 'binding-without-totp') primary.totpAfterPasskey = '0'.repeat(64);
    if (kind === 'invalid-schema') primary.unexpected = true;
    if (kind === 'wrong-binding') {
      const withTotp = new BackupDatabaseRecords(sourceKey);
      await accept(withTotp, 'user', account({ totp_enabled: true, totp_secret: encryptedTotp, salt: totpSalt }));
      await expectFinishError(withTotp, await onDisk(passkeys(users)), 'passkey');
    } else await expectFinishError(records, await onDisk(passkeys(users)), 'passkey');
  },
);

it('honours cancellation before validation and during asynchronous account decryption', async () => {
  const before = new BackupDatabaseRecords(sourceKey);
  await accept(before, 'user', account());
  await expect(before.finish(undefined, AbortSignal.abort())).rejects.toThrow();
  const during = new BackupDatabaseRecords(sourceKey);
  await accept(during, 'user', account({ totp_enabled: true, totp_secret: encryptedTotp, salt: totpSalt }));
  const controller = new AbortController();
  const finishing = during.finish(undefined, controller.signal);
  controller.abort();
  await expect(finishing).rejects.toThrow();
});
