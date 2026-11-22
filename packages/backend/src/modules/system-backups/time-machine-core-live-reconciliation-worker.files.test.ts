import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { app, appStore, link, user } from '@/core/database/drizzle/schema';
import { backupDatabaseColumns, type BackupDatabaseTable } from './backup-database-records';
import { inspectCoreDatabase, requireCoreCatalogOwnership } from './time-machine-core-database';
import { canonicalCoreJson } from './time-machine-core-payload';
import {
  coreLiveReconciliationFailureDiagnostic,
  coreLiveReconciliationWorkerCapability,
  reconcileCoreLiveDatabaseWorker,
} from './time-machine-core-live-reconciliation-worker';

type FakeClient = { config: Record<string, unknown>; ended: number; query: (sql: string, values?: unknown[]) => Promise<{ rows: Row[] }> };
const state = vi.hoisted(() => ({
  clients: [] as FakeClient[],
  query: undefined as undefined | ((client: FakeClient, sql: string, values: unknown[]) => Promise<{ rows: Row[] }>),
  hook: undefined as undefined | ((client: FakeClient, sql: string) => Promise<void>),
  endHook: undefined as undefined | ((client: FakeClient) => Promise<void>),
}));
vi.mock('pg', async (original) => ({
  ...(await original<typeof import('pg')>()),
  Client: class {
    ended = 0;
    constructor(public config: Record<string, unknown>) {
      state.clients.push(this);
    }
    on() {
      return this;
    }
    async connect() {}
    async query(sql: string, values: unknown[] = []) {
      await state.hook?.(this, sql);
      if (!state.query) throw new Error('Missing SQL fixture');
      return state.query(this, sql, values);
    }
    async end() {
      this.ended++;
      await state.endHook?.(this);
    }
  },
}));
type Row = Record<string, unknown>;
type Table = Exclude<BackupDatabaseTable, 'app_migration'> | 'orbis_reset_receipt' | '__drizzle_migrations';
type Rows = Record<Table, Row[]>;
const clone = <T>(value: T): T => structuredClone(value);
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('fixture missing value');
  return value;
}
const signal = () => new AbortController().signal;
const contextQuery = "SELECT pg_catalog.current_setting('search_path') AS search_path";
const password = (byte: number) =>
  `$argon2id$v=19$m=8192,t=1,p=1$${Buffer.alloc(16, byte).toString('base64').replace(/=+$/, '')}$${Buffer.alloc(32, byte).toString('base64').replace(/=+$/, '')}`;
const jwtSecret = 'synthetic captured candidate key long enough for worker';
function rows(): Rows {
  return {
    user: [
      {
        id: 11,
        username: 'same-owner',
        password: password(1),
        created_at: 1700000000,
        updated_at: 1700000001,
        operator: true,
        totp_secret: null,
        totp_enabled: false,
        salt: null,
        locale: 'en',
        has_seen_welcome: true,
      },
    ],
    link: [
      {
        id: 29,
        title: "captured');DELETE;--",
        url: 'https://example.invalid/source',
        icon_url: null,
        created_at: 1700000000,
        updated_at: 1700000001,
        user_id: 11,
        description: null,
        is_visible_on_guest_dashboard: false,
      },
    ],
    app_store: [
      {
        slug: 'destination-store',
        hash: 'store-hash',
        name: 'Store',
        enabled: true,
        url: 'https://example.invalid/store.git',
        branch: 'main',
        created_at: 1700000000,
        updated_at: 1700000001,
      },
    ],
    app: [
      {
        id: 47,
        status: 'running',
        config: { environment: { VALUE: "'); DROP TABLE public.app; --" } },
        created_at: 1700000000,
        updated_at: 1700000001,
        version: 3,
        ignored_version: null,
        exposed: false,
        domain: null,
        is_visible_on_guest_dashboard: true,
        open_port: true,
        port: 8080,
        exposed_local: false,
        app_store_slug: 'destination-store',
        app_name: 'destination-app',
        enable_auth: true,
        subnet: null,
        local_subdomain: null,
        pending_restart: true,
        user_config_enabled: true,
        max_backups: 5,
        template_urn: null,
        last_template_sync_at: null,
        template_version: null,
      },
    ],
    orbis_reset_receipt: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', completed_at: 1700000000 }],
    __drizzle_migrations: [{ id: 3, hash: 'captured-migration-hash', created_at: '1700000000000' }],
  };
}
function catalog() {
  const tables: Row[] = [];
  const columns: Row[] = [];
  for (const [name, table] of Object.entries({ user, app_store: appStore, app, link })) {
    tables.push({ schema: 'public', name, kind: 'r', persistence: 'p', rls: false, force_rls: false });
    for (const [position, column] of getTableConfig(table)
      .columns.filter((column) => column.name !== 'migrations_baselined')
      .entries()) {
      const sql = column.getSQLType();
      const type = sql.startsWith('varchar') ? 'varchar' : sql === 'integer' || sql === 'serial' ? 'int4' : sql === 'boolean' ? 'bool' : sql;
      columns.push({
        schema: 'public',
        table: name,
        name: column.name,
        position: position + 1,
        type,
        type_schema: column.enumValues?.length ? 'public' : 'pg_catalog',
        format: sql,
        not_null: column.notNull,
        identity: '',
        generated: '',
        default: null,
      });
    }
  }
  for (const [schema, name, fields] of [
    ['public', 'orbis_reset_receipt', ['id', 'completed_at']],
    ['drizzle', '__drizzle_migrations', ['id', 'hash', 'created_at']],
  ] as const) {
    tables.push({ schema, name, kind: 'r', persistence: 'p', rls: false, force_rls: false });
    fields.forEach((column, position) => {
      columns.push({
        schema,
        table: name,
        name: column,
        position: position + 1,
        type: 'text',
        type_schema: 'pg_catalog',
        format: 'text',
        not_null: true,
        identity: '',
        generated: '',
        default: null,
      });
    });
  }
  const sequences = Object.entries(sequenceTables).map(([name, table]) => ({
    schema: table === '__drizzle_migrations' ? 'drizzle' : 'public',
    name,
    type: 'integer',
    start: '1',
    min: '1',
    max: '2147483647',
    increment: '1',
    cycle: false,
    cache: '1',
  }));
  return {
    tables,
    columns,
    enums: [] as Row[],
    constraints: [] as Row[],
    indexes: [] as Row[],
    sequences,
    extensions: [{ name: 'plpgsql', version: '1.0' }],
  };
}
const sequenceTables: Record<string, Table> = {
  user_id_seq: 'user',
  link_id_seq: 'link',
  app_id_seq: 'app',
  __drizzle_migrations_id_seq: '__drizzle_migrations',
};
class Database {
  rows = rows();
  catalog = catalog();
  version = 170006;
  catalogContext = 'pg_catalog';
  contextSensitiveCatalog = false;
  identity: { system_identifier: string; database_oid: string; database: string };
  marker: string | null = null;
  owner = 'orbis_owner';
  sequences = Object.fromEntries(Object.keys(sequenceTables).map((name) => [name, { value: '1', called: false }]));
  hook?: (sql: string, values: unknown[]) => void | Promise<void>;
  transaction?: { rows: Rows; marker: string | null };
  failCommitAfter = false;
  orphanTables = new Set<string>();
  appOwnedElsewhere = false;
  appReferences: Row[] = [{ schema: 'public', table: 'app', column: 'id', expression: "nextval('public.app_id_seq'::regclass)" }];
  query = vi.fn(async (sql: string, values: unknown[] = []): Promise<{ rows: Row[] }> => {
    await this.hook?.(sql, values);
    if (sql.startsWith('BEGIN')) {
      if (this.transaction) throw new Error('fixture nested transaction');
      this.transaction = { rows: clone(this.rows), marker: this.marker };
      return { rows: [] };
    }
    if (sql === 'COMMIT') {
      this.transaction = undefined;
      if (this.failCommitAfter) {
        this.failCommitAfter = false;
        throw new Error('synthetic lost commit acknowledgement');
      }
      return { rows: [] };
    }
    if (sql === 'ROLLBACK') {
      if (this.transaction) {
        this.rows = this.transaction.rows;
        this.marker = this.transaction.marker;
        this.transaction = undefined;
      }
      return { rows: [] };
    }
    if (sql.startsWith('LOCK TABLE')) return { rows: [] };
    if (sql === contextQuery) return { rows: [{ search_path: this.catalogContext }] };
    if (sql.includes('pg_control_system()')) return { rows: [clone(this.identity)] };
    if (sql.startsWith('SELECT current_database()')) return { rows: [{ database: this.identity.database, version: this.version }] };
    if (sql.includes(' AS rls,')) return { rows: clone(this.catalog.tables) };
    if (sql.includes(' AS not_null,')) {
      const columns = clone(this.catalog.columns);
      if (this.contextSensitiveCatalog)
        for (const column of columns) {
          if (column.type_schema === 'public') column.format = `${this.catalogContext === 'pg_catalog' ? 'public.' : ''}${column.type}`;
        }
      return { rows: columns };
    }
    if (sql.includes('e.enumlabel')) return { rows: clone(this.catalog.enums) };
    if (sql.includes('pg_get_constraintdef')) return { rows: clone(this.catalog.constraints) };
    if (sql.includes('FROM pg_catalog.pg_indexes')) return { rows: clone(this.catalog.indexes) };
    if (sql.includes('FROM pg_catalog.pg_sequences')) return { rows: clone(this.catalog.sequences) };
    if (sql.includes('FROM pg_catalog.pg_extension')) return { rows: clone(this.catalog.extensions) };
    if (sql.includes('FROM pg_catalog.pg_proc')) return { rows: [] };
    if (sql.startsWith('SELECT * FROM')) {
      const table = /\."([^"]+)" LIMIT/.exec(sql)?.[1] as Table;
      if (!table || !this.rows[table]) throw new Error('fixture unsupported row read');
      return { rows: clone(this.rows[table]) };
    }
    if (sql.includes('pg_catalog.shobj_description')) return { rows: [{ marker: this.marker }] };
    if (sql.includes('pg_catalog.pg_get_userbyid')) return { rows: [{ owner: this.owner, role: this.owner }] };
    if (sql.startsWith('SELECT n.nspname AS schema,s.relname AS name')) {
      const table = String(values[0]).split('.')[1]?.replaceAll('"', '') as Table;
      if (this.orphanTables.has(table)) return { rows: [] };
      const entry = Object.entries(sequenceTables).find(([, name]) => name === table);
      if (!entry) return { rows: [] };
      return { rows: [{ schema: table === '__drizzle_migrations' ? 'drizzle' : 'public', name: entry[0] }] };
    }
    if (sql.startsWith('SELECT n.nspname AS schema,c.relname AS table,a.attname AS column')) return { rows: clone(this.appReferences) };
    if (sql.startsWith('SELECT 1 FROM pg_catalog.pg_depend')) return { rows: this.appOwnedElsewhere ? [{ owner: 1 }] : [] };
    if (sql.startsWith('INSERT INTO')) {
      const table = /^INSERT INTO public\."([^"]+)"/.exec(sql)?.[1] as Exclude<Table, '__drizzle_migrations'>;
      const columns = table === 'orbis_reset_receipt' ? ['id', 'completed_at'] : backupDatabaseColumns(table);
      if (!this.transaction || columns.length !== values.length) throw new Error('fixture unsupported insert');
      this.rows[table].push(Object.fromEntries(columns.map((column, index) => [column, clone(values[index])])));
      return { rows: [] };
    }
    if (sql.startsWith('SELECT pg_catalog.setval')) {
      const name = String(values[0]).split('.')[1]?.replaceAll('"', '') ?? '';
      const table = sequenceTables[name];
      if (!table) throw new Error('fixture unsupported sequence write');
      this.sequences[name] = {
        value: String(this.rows[table].length ? Math.max(...this.rows[table].map((row) => Number(row.id))) : values[1]),
        called: this.rows[table].length > 0,
      };
      return { rows: [] };
    }
    if (sql.startsWith('SELECT s.last_value')) {
      const name = /\."([^"]+)" s$/.exec(sql)?.[1] ?? '';
      const table = sequenceTables[name];
      if (!table || !this.sequences[name]) throw new Error('fixture unsupported sequence read');
      const populated = this.rows[table].length > 0;
      return {
        rows: [
          {
            ...this.sequences[name],
            expected: populated ? String(Math.max(...this.rows[table].map((row) => Number(row.id)))) : values[0],
            populated,
          },
        ],
      };
    }
    if (sql.startsWith('COMMENT ON DATABASE')) {
      const marker = / IS '([^']+)'$/.exec(sql)?.[1];
      if (!marker || !sql.includes(`"${this.identity.database.replaceAll('"', '""')}"`)) throw new Error('fixture unsupported marker write');
      this.marker = marker;
      return { rows: [] };
    }
    throw new Error('fixture unexpected query');
  });
  constructor(name: string, systemIdentifier: string) {
    this.identity = { system_identifier: systemIdentifier, database_oid: '16384', database: name };
  }
}
const digest = (value: unknown) => createHash('sha256').update(canonicalCoreJson(value)).digest('hex');
let root: string;
let input: string;
let output: string;
let source: Database;
let destination: Database;
let target: Database;
let allowed: boolean;
let foreign: boolean;
let starting: boolean;
let preparedTransaction: boolean;
const sourceAuth = () => ({ jwtSecret, passkeys: null });
const destinationAuth = () => ({ jwtSecret: 'synthetic destination candidate key long enough', passkeys: null });
const identity = () => ({
  systemIdentifier: destination.identity.system_identifier,
  database: destination.identity.database,
  databaseOid: '16384',
  role: 'orbis_owner',
  roleOid: '10',
  serverVersionNum: 170006,
});
const makeRequest = async () => {
  const s = await inspectCoreDatabase({ client: source as never, authentication: { jwtSecret }, signal: signal() });
  const d = await inspectCoreDatabase({ client: destination as never, authentication: { jwtSecret: destinationAuth().jwtSecret }, signal: signal() });
  const ownership = await requireCoreCatalogOwnership({
    source: s.token,
    destination: d.token,
    sourceOwnerId: 11,
    destinationOwnerId: 11,
    catalogOwnerIds: [11],
  });
  return {
    schema: 'orbis.core-live-reconciliation-worker-input.v1',
    id: randomUUID(),
    nonce: randomUUID(),
    rootIntentSha256: 'a'.repeat(64),
    sourceControllerImageId: `sha256:${'b'.repeat(64)}`,
    source: { role: 'orbis_owner', database: 'captured', snapshotSha256: s.summary.sha256, authenticationSha256: digest(sourceAuth()) },
    destination: {
      identity: identity(),
      address: '192.0.2.12',
      postmasterEpochUs: '1794481200123456',
      authenticationSha256: digest(destinationAuth()),
    },
    target: {
      identity: { systemIdentifier: target.identity.system_identifier, databaseOid: '16384', database: 'clean_target' },
      role: 'orbis_owner',
    },
    expected: {
      catalogSha256: s.summary.catalogSha256,
      migrationsSha256: digest(source.rows.__drizzle_migrations),
      catalogOwnership: {
        schema: 'orbis.core-catalog-ownership-identities.v1',
        sourceOwnerId: 11,
        destinationOwnerId: 11,
        owners: ownership.owners,
        aliases: false,
        restoreAuthority: false,
      },
    },
    sourceOwnerId: 11,
    destinationOwnerId: 11,
    catalogOwnerIds: [11],
    sequencePolicy: {
      schema: 'orbis.core-clean-target-sequence-policy.v2',
      sourceControllerImageId: `sha256:${'b'.repeat(64)}`,
      catalogSha256: s.summary.catalogSha256,
    },
    scope: 'reconcile-held-live-database-only',
    activation: false,
    environmentProved: false,
    restoreAuthority: false,
  };
};
type Request = Awaited<ReturnType<typeof makeRequest>>;
let request: Request;
const authorization = (r: Request) => ({
  schema: 'orbis.core-live-reconciliation-authorization.v1',
  decision: 'approved',
  id: r.id,
  nonce: r.nonce,
  requestSha256: digest(r),
  rootIntentSha256: r.rootIntentSha256,
  controllerStopped: true,
  queueDrained: true,
  scope: r.scope,
  activation: false,
  environmentProved: false,
  restoreAuthority: false,
});
async function write(name: string, value: unknown) {
  const f = path.join(input, name);
  await fs.chmod(f, 0o600).catch(() => undefined);
  await fs.writeFile(f, canonicalCoreJson(value), { mode: 0o600 });
  await fs.chmod(f, 0o400);
}
async function writeRequest() {
  await write('request.json', request);
  await write('authorization.json', authorization(request));
}
const names = async () => (await fs.readdir(output)).sort();
const result = async (name: string) => JSON.parse(await fs.readFile(path.join(output, name), 'utf8'));
const run = () => reconcileCoreLiveDatabaseWorker({ input, output, signal: signal() });
const targetWrites = () => target.query.mock.calls.filter(([sql]) => /^(INSERT|COMMENT|SELECT pg_catalog.setval)/.test(sql));
beforeEach(async () => {
  state.clients = [];
  state.hook = undefined;
  state.endHook = undefined;
  allowed = true;
  foreign = false;
  starting = false;
  preparedTransaction = false;
  source = new Database('captured', '7000000000000000001');
  destination = new Database('destination', '7000000000000000002');
  target = new Database('clean_target', '7000000000000000003');
  present(source.rows.app[0]).app_name = 'captured-app';
  source.rows.orbis_reset_receipt = [];
  present(destination.rows.user[0]).password = password(2);
  present(destination.rows.link[0]).title = 'destination-link';
  present(destination.rows.app[0]).version = 9;
  destination.rows.orbis_reset_receipt.push({ id: randomUUID(), completed_at: 1700000100 });
  for (const table of ['user', 'link', 'app_store', 'app', 'orbis_reset_receipt'] as const) target.rows[table] = [];
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'core-live-worker-')));
  input = path.join(root, 'input');
  output = path.join(root, 'output');
  await fs.mkdir(input, { mode: 0o700 });
  await fs.mkdir(output, { mode: 0o700 });
  request = await makeRequest();
  await writeRequest();
  await write('connection.json', {
    host: request.destination.address,
    port: 5432,
    user: 'orbis_owner',
    password: 'synthetic tcp password',
    database: 'destination',
  });
  await write('source-authentication.json', sourceAuth());
  await write('destination-authentication.json', destinationAuth());
  state.query = async (client, sql, values) => {
    if (sql.startsWith('SELECT CURRENT_USER'))
      return {
        rows: [
          {
            current_user: client.config.user,
            session_user: client.config.user,
            database: client.config.database,
            search_path: 'pg_catalog',
            read_only: String(client.config.options).includes('default_transaction_read_only=on') ? 'on' : 'off',
          },
        ],
      };
    if (sql.includes('inet_server_addr'))
      return { rows: [{ address: request.destination.address, port: 5432, version: 170006, epoch: '1794481200123456' }] };
    if (sql.includes('pg_backend_pid()'))
      return {
        rows: [
          {
            ...identity(),
            ...(client.config.database === 'postgres' ? { database: 'postgres', databaseOid: '5' } : {}),
            pid: client.config.database === 'postgres' ? '101' : '102',
            startedAt: '1794481200.123456',
            allowConnections: client.config.database === 'postgres' || allowed,
          },
        ],
      };
    if (sql.includes('pg_locks')) return { rows: starting ? [{ pid: '103' }] : [] };
    if (sql.includes('pg_stat_activity')) return { rows: [{ pid: '102' }, ...(foreign ? [{ pid: '103' }] : [])] };
    if (sql.includes('pg_prepared_xacts')) return { rows: [{ count: preparedTransaction ? '1' : '0' }] };
    if (sql === 'ALTER DATABASE "destination" ALLOW_CONNECTIONS false') {
      expect(await names()).toEqual(['fence-intent.json', 'worker-start.json']);
      expect((await fs.stat(path.join(output, 'fence-intent.json'))).mode & 0o777).toBe(0o400);
      allowed = false;
      return { rows: [] };
    }
    if (sql.includes('AS "systemIdentifier"'))
      return {
        rows: [
          { systemIdentifier: target.identity.system_identifier, databaseOid: target.identity.database_oid, database: target.identity.database },
        ],
      };
    const db = client.config.host === '/core-live-source-socket' ? source : client.config.host === '/core-live-target-socket' ? target : destination;
    if (sql.startsWith('SELECT * FROM drizzle.')) return { rows: clone(db.rows.__drizzle_migrations) };
    return db.query(sql, values);
  };
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

it('uses the real held reconciliation flow, durably fences then commits latest app/reset data and closes all sessions', async () => {
  present(destination.rows.app[0]).version = 12;
  destination.rows.orbis_reset_receipt.push({ id: randomUUID(), completed_at: 1700000300 });
  const originalSource = clone(source.rows);
  const originalDestination = clone(destination.rows);
  let committed = false;
  state.hook = async (client, sql) => {
    if (client.config.host === '/core-live-target-socket' && sql.startsWith('INSERT')) {
      expect(allowed).toBe(false);
      expect(await names()).toEqual(['fence-intent.json', 'worker-start.json', 'write-intent.json']);
    }
    if (sql === 'COMMIT' && client.config.host === '/core-live-target-socket' && !committed) {
      committed = true;
      expect(await names()).not.toContain('completion.json');
    }
  };
  const report = await run();
  expect(report).toMatchObject({
    schema: 'orbis.core-live-reconciliation-result.v1',
    targetVerified: true,
    admissionReopened: false,
    rootMustVerifyRetiredFence: true,
    activation: false,
    environmentProved: false,
    restoreAuthority: false,
  });
  expect(source.rows).toEqual(originalSource);
  expect(destination.rows).toEqual(originalDestination);
  expect(target.rows.user).toEqual(source.rows.user);
  expect(target.rows.link).toEqual(source.rows.link);
  expect(target.rows.app).toEqual(destination.rows.app);
  expect(target.rows.orbis_reset_receipt).toEqual(destination.rows.orbis_reset_receipt);
  expect(allowed).toBe(false);
  expect(state.clients).toHaveLength(4);
  expect(state.clients.every((c) => c.ended === 1)).toBe(true);
  expect(await names()).toEqual(['completion.json', 'fence-intent.json', 'result.json', 'worker-start.json', 'write-intent.json']);
  for (const name of await names()) expect((await fs.stat(path.join(output, name))).mode & 0o777).toBe(0o400);
  expect(report.fenceIntentSha256).toBe(digest(await result('fence-intent.json')));
  expect(report.evidence.fenceIntentSha256).toBe(digest((await result('fence-intent.json')).fence));
  expect((await result('completion.json')).writeIntentSha256).toBe(digest(await result('write-intent.json')));
});

it.each(['foreign', 'starting', 'prepared'] as const)('refuses %s writers before the durable fence', async (kind) => {
  foreign = kind === 'foreign';
  starting = kind === 'starting';
  preparedTransaction = kind === 'prepared';
  await expect(run()).rejects.toThrow('Core live reconciliation failed.');
  expect(allowed).toBe(true);
  expect(await names()).toEqual(['worker-start.json']);
  expect(targetWrites()).toHaveLength(0);
  expect(state.clients.every((c) => c.ended === 1)).toBe(true);
});
it.each(['controllerStopped', 'queueDrained', 'requestSha256', 'rootIntentSha256', 'id', 'nonce', 'scope', 'activation', 'extra'])(
  'refuses invalid Root attestation %s',
  async (key) => {
    await write('authorization.json', { ...authorization(request), [key]: key === 'activation' });
    await expect(run()).rejects.toThrow();
    expect(state.clients).toHaveLength(0);
    expect(await names()).toEqual([]);
  },
);
it.each(['schema', 'id', 'nonce', 'sourceControllerImageId', 'sourceOwnerId', 'catalogOwnerIds', 'sequencePolicy', 'target', 'destination', 'extra'])(
  'refuses malformed request %s',
  async (key) => {
    (request as unknown as Record<string, unknown>)[key] = null;
    await writeRequest();
    await expect(run()).rejects.toThrow();
    expect(state.clients).toHaveLength(0);
  },
);
it.each(['host', 'port', 'user', 'database', 'password', 'extra'])('refuses unsafe TCP configuration %s', async (key) => {
  await write('connection.json', {
    host: request.destination.address,
    port: 5432,
    user: 'orbis_owner',
    password: 'synthetic tcp password',
    database: 'destination',
    [key]: key === 'password' ? 'bad\nsecret' : null,
  });
  await expect(run()).rejects.toThrow();
  expect(state.clients).toHaveLength(0);
});
it.each(['source-authentication.json', 'destination-authentication.json'])('refuses changed %s bytes', async (name) => {
  await write(name, { jwtSecret: 'changed synthetic authentication key with enough bytes', passkeys: null });
  await expect(run()).rejects.toThrow();
  expect(state.clients).toHaveLength(0);
});
it.each(['source', 'live', 'maintenance', 'target'])('refuses %s session role drift before admission closes', async (kind) => {
  const query = present(state.query);
  state.query = async (c, s, v) => {
    const r = await query(c, s, v);
    const match =
      kind === 'source'
        ? c.config.host === '/core-live-source-socket'
        : kind === 'target'
          ? c.config.host === '/core-live-target-socket'
          : kind === 'maintenance'
            ? c.config.database === 'postgres'
            : c.config.database === 'destination';
    if (match && s.startsWith('SELECT CURRENT_USER')) present(r.rows[0]).session_user = 'wrong';
    return r;
  };
  await expect(run()).rejects.toThrow();
  expect(allowed).toBe(true);
  expect(targetWrites()).toHaveLength(0);
  expect(state.clients.every((c) => c.ended === 1)).toBe(true);
});
it.each(['live', 'maintenance'])('binds actual TCP address/version/epoch on %s', async (kind) => {
  const query = present(state.query);
  state.query = async (c, s, v) => {
    const r = await query(c, s, v);
    if (s.includes('inet_server_addr') && (c.config.database === 'postgres') === (kind === 'maintenance'))
      present(r.rows[0]).epoch = '1794481200123457';
    return r;
  };
  await expect(run()).rejects.toThrow();
  expect(allowed).toBe(true);
});
it('rejects changed source snapshot and target migration/identity before fence', async () => {
  present(source.rows.link[0]).title = 'changed';
  await expect(run()).rejects.toThrow();
  expect(allowed).toBe(true);
  expect(await names()).toEqual(['worker-start.json']);
});
it('refuses a populated isolated target after fence without reopening or replaying', async () => {
  target.rows.user = clone(source.rows.user);
  await expect(run()).rejects.toThrow();
  expect(allowed).toBe(false);
  expect(targetWrites()).toHaveLength(0);
  expect(await names()).toEqual(['fence-intent.json', 'worker-start.json']);
  await expect(run()).rejects.toThrow();
  expect(targetWrites()).toHaveLength(0);
});
it('leaves durable write intent and closed admission when COMMIT acknowledgement is lost', async () => {
  target.failCommitAfter = true;
  await expect(run()).rejects.toThrow();
  expect(allowed).toBe(false);
  expect(target.rows.app).toEqual(destination.rows.app);
  expect(await names()).toEqual(['fence-intent.json', 'worker-start.json', 'write-intent.json']);
  expect(state.clients.every((c) => c.ended === 1)).toBe(true);
});
it.each(['input', 'output'])('refuses late %s drift and leaves admission closed', async (kind) => {
  let changed = false;
  state.hook = async (_c, sql) => {
    if (!changed && sql.startsWith('INSERT')) {
      changed = true;
      if (kind === 'input') await fs.chmod(path.join(input, 'request.json'), 0o600);
      else await fs.writeFile(path.join(output, 'unknown.json'), '{}');
    }
  };
  await expect(run()).rejects.toThrow();
  expect(allowed).toBe(false);
  expect(await names()).not.toContain('result.json');
  expect(state.clients.every((c) => c.ended === 1)).toBe(true);
});
it('requires positively acknowledged client shutdown before a result', async () => {
  state.endHook = async (c) => {
    if (c.config.database === 'destination') throw new Error('private shutdown detail');
  };
  await expect(run()).rejects.toThrow();
  expect(allowed).toBe(false);
  expect(await names()).toEqual(['completion.json', 'fence-intent.json', 'worker-start.json', 'write-intent.json']);
  expect(state.clients.every((c) => c.ended === 1)).toBe(true);
});
it('redacts driver diagnostics and rejects residue without opening sessions', async () => {
  state.hook = async () => {
    throw Object.assign(new Error('private password and path'), { code: '28P01' });
  };
  const error = await run().catch((e) => e);
  expect(coreLiveReconciliationFailureDiagnostic(error)).toEqual({ event: 'core-live-reconciliation-failed', phase: 'connect', code: '28P01' });
  expect(String(error)).not.toContain('private');
});
it('has a single fixed Linux capability with no activation or recovery authority', () => {
  expect(coreLiveReconciliationWorkerCapability).toMatchObject({
    uid: 0,
    input: '/core-live-input',
    output: '/core-live-output',
    sourceSocket: '/core-live-source-socket',
    targetSocket: '/core-live-target-socket',
    rootMustVerifyRetiredFence: true,
    activation: false,
    environmentProved: false,
    restoreAuthority: false,
  });
});
it.each(['before', 'after'] as const)('abort %s admission change closes all clients without reopening', async (when) => {
  const controller = new AbortController();
  if (when === 'before') controller.abort();
  else
    state.hook = async (_c, sql) => {
      if (sql === 'ALTER DATABASE "destination" ALLOW_CONNECTIONS false') controller.abort();
    };
  await expect(reconcileCoreLiveDatabaseWorker({ input, output, signal: controller.signal })).rejects.toThrow();
  expect(allowed).toBe(when === 'before');
  expect(state.clients.every((c) => c.ended === 1)).toBe(true);
  expect(await names()).not.toContain('result.json');
  expect(targetWrites()).toHaveLength(0);
});
it.each(['source', 'live', 'maintenance', 'target'])('rechecks %s session health after fence and before final success', async (kind) => {
  const query = present(state.query);
  state.query = async (c, s, v) => {
    const r = await query(c, s, v);
    const match =
      kind === 'source'
        ? c.config.host === '/core-live-source-socket'
        : kind === 'target'
          ? c.config.host === '/core-live-target-socket'
          : kind === 'maintenance'
            ? c.config.database === 'postgres'
            : c.config.database === 'destination';
    if (!allowed && match && s.startsWith('SELECT CURRENT_USER')) present(r.rows[0]).search_path = 'public';
    return r;
  };
  await expect(run()).rejects.toThrow();
  expect(allowed).toBe(false);
  expect(targetWrites()).toHaveLength(0);
  expect(await names()).not.toContain('write-intent.json');
  expect(state.clients.every((c) => c.ended === 1)).toBe(true);
});
it.each(['address', 'port', 'version', 'epoch'])('rejects TCP %s disagreement', async (key) => {
  const query = present(state.query);
  state.query = async (c, s, v) => {
    const r = await query(c, s, v);
    if (s.includes('inet_server_addr')) present(r.rows[0])[key] = null;
    return r;
  };
  await expect(run()).rejects.toThrow();
  expect(allowed).toBe(true);
  expect(targetWrites()).toHaveLength(0);
});
it.each(['identity', 'migrations'])('rejects target %s drift before fence', async (kind) => {
  if (kind === 'identity') target.identity.system_identifier = '7000000000000000004';
  else target.rows.__drizzle_migrations.push({ id: 4, hash: 'unexpected-migration', created_at: '1700000001000' });
  await expect(run()).rejects.toThrow();
  expect(allowed).toBe(true);
  expect(await names()).not.toContain('fence-intent.json');
});
it.each(['owner', 'catalog'])('rejects changed Root-approved %s after fence without target writes', async (kind) => {
  if (kind === 'owner') present(destination.rows.user[0]).username = 'different-owner';
  else present(destination.catalog.columns[0]).not_null = false;
  await expect(run()).rejects.toThrow();
  expect(allowed).toBe(false);
  expect(targetWrites()).toHaveLength(0);
  expect(await names()).toEqual(['fence-intent.json', 'worker-start.json']);
});
it('requires final source/target verification even after acknowledged target commit', async () => {
  const query = present(state.query);
  let committed = false;
  state.query = async (c, s, v) => {
    const r = await query(c, s, v);
    if (c.config.host === '/core-live-target-socket' && s === 'COMMIT' && !committed) {
      committed = true;
      present(target.rows.app[0]).version = 99;
    }
    return r;
  };
  await expect(run()).rejects.toThrow();
  expect(allowed).toBe(false);
  expect(await names()).not.toContain('result.json');
  expect(state.clients.every((c) => c.ended === 1)).toBe(true);
});
it.each([
  'unknown-input',
  'unknown-output',
  'input-mode',
  'output-mode',
  'file-mode',
  'hardlink',
  'symlink',
  'noncanonical',
  'nested',
  'alias',
] as const)('rejects unsafe IO %s before SQL', async (kind) => {
  const requestPath = path.join(input, 'request.json');
  if (kind === 'unknown-input') await fs.writeFile(path.join(input, 'unknown.json'), '{}');
  if (kind === 'unknown-output') await fs.writeFile(path.join(output, 'unknown.json'), '{}');
  if (kind === 'input-mode') await fs.chmod(input, 0o755);
  if (kind === 'output-mode') await fs.chmod(output, 0o755);
  if (kind === 'file-mode') await fs.chmod(requestPath, 0o644);
  if (kind === 'hardlink') await fs.link(requestPath, path.join(root, 'request-copy.json'));
  if (kind === 'symlink') {
    await fs.rename(requestPath, path.join(root, 'request-original.json'));
    await fs.symlink(path.join(root, 'request-original.json'), requestPath);
  }
  if (kind === 'noncanonical') {
    await fs.chmod(requestPath, 0o600);
    await fs.writeFile(requestPath, JSON.stringify(request, null, 2));
    await fs.chmod(requestPath, 0o400);
  }
  const workerOutput = kind === 'alias' ? input : kind === 'nested' ? path.join(input, 'nested') : output;
  if (kind === 'nested') await fs.mkdir(workerOutput, { mode: 0o700 });
  await expect(reconcileCoreLiveDatabaseWorker({ input, output: workerOutput, signal: signal() })).rejects.toThrow();
  expect(state.clients).toHaveLength(0);
  expect(allowed).toBe(true);
});
it('accepts private 0600 canonical Root inputs', async () => {
  for (const name of await fs.readdir(input)) await fs.chmod(path.join(input, name), 0o600);
  expect((await run()).targetVerified).toBe(true);
});
it.each(['request.json', 'authorization.json', 'source-authentication.json', 'destination-authentication.json', 'connection.json'])(
  'rejects late named inode replacement for %s',
  async (name) => {
    let changed = false;
    state.hook = async (_c, sql) => {
      if (!changed && sql.startsWith('INSERT')) {
        changed = true;
        const original = path.join(input, name);
        await fs.rename(original, path.join(root, 'retained-original.json'));
        await fs.writeFile(original, await fs.readFile(path.join(root, 'retained-original.json')), { mode: 0o400 });
      }
    };
    await expect(run()).rejects.toThrow();
    expect(allowed).toBe(false);
    expect(await names()).not.toContain('result.json');
  },
);
it('rejects late replacement of a sealed fence output even with identical bytes', async () => {
  let changed = false;
  state.hook = async (_c, sql) => {
    if (!changed && sql.startsWith('INSERT')) {
      changed = true;
      const file = path.join(output, 'fence-intent.json');
      await fs.rename(file, path.join(root, 'retained-fence.json'));
      await fs.writeFile(file, await fs.readFile(path.join(root, 'retained-fence.json')), { mode: 0o400 });
    }
  };
  await expect(run()).rejects.toThrow();
  expect(allowed).toBe(false);
  expect(await names()).not.toContain('result.json');
});
it('refuses unknown error codes and hostile getters without exposing details', () => {
  expect(coreLiveReconciliationFailureDiagnostic({ code: 'private-value', message: 'private detail' })).toEqual({
    event: 'core-live-reconciliation-failed',
    phase: 'input',
    code: 'unknown',
  });
});
it.each(['systemIdentifier', 'databaseOid', 'database', 'role', 'roleOid', 'serverVersionNum'] as const)(
  'rejects Root identity %s mismatch before admission changes',
  async (key) => {
    const changed: Record<string, unknown> = {
      systemIdentifier: '7000000000000000009',
      databaseOid: '16385',
      database: 'wrong_database',
      role: 'wrong_role',
      roleOid: '11',
      serverVersionNum: 140001,
    };
    Object.assign(request.destination.identity, { [key]: changed[key] });
    await writeRequest();
    await write('connection.json', {
      host: request.destination.address,
      port: 5432,
      user: request.destination.identity.role,
      password: 'synthetic tcp password',
      database: request.destination.identity.database,
    });
    await expect(run()).rejects.toThrow();
    expect(allowed).toBe(true);
    expect(await names()).not.toContain('fence-intent.json');
    expect(targetWrites()).toHaveLength(0);
    expect(state.clients.every((c) => c.ended === 1)).toBe(true);
  },
);
it.each(['on', 'off', 'public', 'role'] as const)('rejects unsafe session setting %s before fence', async (kind) => {
  const query = present(state.query);
  state.query = async (c, s, v) => {
    const r = await query(c, s, v);
    if (s.startsWith('SELECT CURRENT_USER')) {
      if (kind === 'on' && c.config.database === 'postgres') present(r.rows[0]).read_only = 'on';
      if (kind === 'off' && c.config.host === '/core-live-source-socket') present(r.rows[0]).read_only = 'off';
      if (kind === 'public') present(r.rows[0]).search_path = 'public';
      if (kind === 'role') present(r.rows[0]).current_user = 'wrong';
    }
    return r;
  };
  await expect(run()).rejects.toThrow();
  expect(allowed).toBe(true);
  expect(targetWrites()).toHaveLength(0);
});
it.each(['unknown', 'getter'] as const)('redacts %s driver errors', async (kind) => {
  state.hook = async () => {
    if (kind === 'unknown') throw { code: 'secret-code', message: 'secret-password' };
    throw Object.defineProperty({}, 'code', {
      get() {
        throw new Error('secret getter');
      },
    });
  };
  const error = await run().catch((e) => e);
  expect(coreLiveReconciliationFailureDiagnostic(error)).toEqual({ event: 'core-live-reconciliation-failed', phase: 'connect', code: 'unknown' });
  expect(String(error)).not.toContain('secret');
});
