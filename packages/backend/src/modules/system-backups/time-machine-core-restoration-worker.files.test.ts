import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { app, appStore, link, user } from '@/core/database/drizzle/schema';
import { backupDatabaseColumns, type BackupDatabaseTable } from './backup-database-records';
import { type CoreCleanTargetReconciliation, inspectCoreDatabase, prepareCoreCleanTarget } from './time-machine-core-database';
import { canonicalCoreJson } from './time-machine-core-payload';
import {
  coreRestorationFailureDiagnostic,
  coreRestorationWorkerCapability,
  coreLiveRestorationWorkerCapability,
  verifyCoreRestorationWorker,
  verifyCoreLiveRestorationWorker,
} from './time-machine-core-restoration-worker';

const pg = vi.hoisted(() => ({
  clients: [] as { config: Record<string, unknown>; ended: number }[],
  sessionQueries: [] as string[],
  query: undefined as ((sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) | undefined,
  connect: undefined as (() => Promise<void>) | undefined,
  error: undefined as unknown,
}));
vi.mock('pg', async (original) => ({
  ...(await original<typeof import('pg')>()),
  Client: class {
    ended = 0;
    constructor(public config: Record<string, unknown>) {
      pg.clients.push(this);
    }
    on() {
      return this;
    }
    async connect() {
      if (pg.error) throw pg.error;
      await pg.connect?.();
    }
    async query(sql: string, values: unknown[] = []) {
      if (!pg.query) throw new Error('missing fake SQL');
      return pg.query(sql, values);
    }
    async end() {
      this.ended += 1;
    }
  },
}));
type Row = Record<string, unknown>;
type Table = BackupDatabaseTable | 'orbis_reset_receipt' | '__drizzle_migrations';
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
const jwtSecret = 'synthetic captured candidate key';
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
    for (const [position, column] of getTableConfig(table).columns.entries()) {
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
async function fixture(setup?: (source: Database, destination: Database, target: Database) => void) {
  const source = new Database('captured', '7000000000000000001');
  const destination = new Database('destination', '7000000000000000002');
  const target = new Database('clean_target', '7000000000000000003');
  source.rows.app = source.rows.app.map((row) => ({ ...row, id: 2, status: 'stopped', app_name: 'source-app' }));
  source.rows.orbis_reset_receipt = [];
  destination.rows.user = destination.rows.user.map((row) => ({ ...row, password: password(2), updated_at: 1700000010 }));
  destination.rows.link = destination.rows.link.map((row) => ({ ...row, title: 'destination link', id: 31 }));
  for (const table of ['user', 'link', 'app_store', 'app', 'orbis_reset_receipt'] as const) target.rows[table] = [];
  setup?.(source, destination, target);
  const inspectedSource = await inspectCoreDatabase({ client: source as never, authentication: { jwtSecret }, signal: signal() });
  const inspectedDestination = await inspectCoreDatabase({
    client: destination as never,
    authentication: { jwtSecret: 'destination candidate key' },
    signal: signal(),
  });
  const options = {
    id: randomUUID(),
    nonce: randomUUID(),
    source: inspectedSource.token,
    destination: inspectedDestination.token,
    sourceOwnerId: 11,
    destinationOwnerId: 11,
    catalogOwnerIds: [11],
    target: target as never,
    signal: signal(),
    authorize: vi.fn(async (_prepared: CoreCleanTargetReconciliation) => {}),
    committed: vi.fn(async (_prepared: CoreCleanTargetReconciliation) => {}),
  };
  return { source, destination, target, options, sourceSummary: inspectedSource.summary };
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => hash(canonicalCoreJson(value));
let root: string;
let input: string;
let output: string;
let imported: Database;
let request: {
  schema: string;
  authenticationSha256: string;
  prepared: CoreCleanTargetReconciliation;
  binding: {
    schema: string;
    id: string;
    nonce: string;
    stageSha256: string;
    dumpSha256: string;
    preparedSha256: string;
    database: { systemIdentifier: string; databaseOid: string; database: string; owner: string; marker: string };
  };
};
let descriptor: {
  [key: string]: unknown;
  id: string;
  nonce: string;
  databaseName: string;
  databaseRole: string;
  network: { name: string; id: string; address: string };
  dump: { bytes: number; sha256: string };
  server: { systemIdentifier: string; role: string; serverVersionNum: number; postmasterEpochUs: number };
  liveDestinationProved: boolean;
};
const authentication = { jwtSecret, passkeys: null };
let sessionMutation: ((row: Record<string, unknown>) => void) | undefined;
const options = () => ({ input, output, signal: signal() });
async function write(name: string, value: unknown) {
  const file = path.join(input, name);
  await fs.chmod(file, 0o600).catch(() => undefined);
  await fs.writeFile(file, canonicalCoreJson(value), { mode: 0o600 });
  await fs.chmod(file, 0o600);
}
async function rebind() {
  request.binding.stageSha256 = digest(descriptor);
  request.binding.database.marker = `orbis.core-derived-logical.v1/${descriptor.id}/${descriptor.nonce}/${request.binding.stageSha256}`;
  imported.marker = request.binding.database.marker;
  await write('descriptor.json', descriptor);
  await write('request.json', request);
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'core-restoration-worker-'));
  await fs.chmod(root, 0o700);
  input = path.join(root, 'input');
  output = path.join(root, 'output');
  await fs.mkdir(input, { mode: 0o700 });
  await fs.mkdir(output, { mode: 0o700 });
  pg.clients = [];
  pg.sessionQueries = [];
  pg.error = undefined;
  pg.connect = undefined;
  sessionMutation = undefined;
  const f = await fixture();
  const sourceControllerImageId = `sha256:${'3'.repeat(64)}`;
  const prepared = await prepareCoreCleanTarget({
    ...f.options,
    sequencePolicy: { schema: 'orbis.core-clean-target-sequence-policy.v2', sourceControllerImageId, catalogSha256: f.sourceSummary.catalogSha256 },
  });
  const id = randomUUID();
  const nonce = randomUUID();
  imported = new Database(`orbis_restore_${id.replaceAll('-', '')}`, f.destination.identity.system_identifier);
  imported.identity.database_oid = '26400';
  imported.rows = clone(f.target.rows);
  imported.catalog = clone(f.target.catalog);
  imported.sequences = clone(f.target.sequences);
  descriptor = {
    schema: 'orbis.core-derived-logical-stage.v1',
    id,
    nonce,
    reviewId: randomUUID(),
    reconciliationReceiptSha256: '1'.repeat(64),
    preparedSha256: digest(prepared),
    sourceControllerImageId,
    installedRuntime: { id: randomUUID(), installationSha256: '2'.repeat(64), sourceControllerImageId },
    migrationPolicySha256: '4'.repeat(64),
    currentSnapshotSha256: '5'.repeat(64),
    currentDatabase: { id: '6'.repeat(64), definition: '7'.repeat(64), startedAt: '2026-11-12T00:00:00.123456789Z' },
    server: {
      systemIdentifier: imported.identity.system_identifier,
      role: imported.owner,
      serverVersionNum: 170006,
      postmasterEpochUs: 1700000000000000,
    },
    dump: { bytes: 100, sha256: '8'.repeat(64) },
    targetProfile: {
      schema: 'orbis.core-clean-target-pg.v2',
      profileId: 'pg17-alpine-arm64.v1',
      imageId: 'sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24',
      os: 'linux',
      architecture: 'arm64',
      major: 17,
      uid: 70,
      gid: 70,
      role: 'source_role',
      database: 'clean_target',
      locale: { encoding: 'UTF8', collate: 'C', ctype: 'C', provider: 'c' },
      scope: 'prepare-clean-target-only',
      activation: false,
      environmentProved: false,
      restoreAuthority: false,
    },
    databaseName: imported.identity.database,
    databaseRole: imported.owner,
    network: { name: 'installed-core', id: '9'.repeat(64), address: '192.0.2.20' },
    scope: 'core-derived-logical-stage-only',
    activation: false,
    environmentProved: false,
    restoreAuthority: false,
    sourceWrites: false,
    liveDestinationProved: false,
    destinationEvidence: 'saved-capture-only',
  };
  request = {
    schema: 'orbis.core-imported-database-worker-input.v1',
    authenticationSha256: digest(authentication),
    prepared,
    binding: {
      schema: 'orbis.core-imported-database-binding.v1',
      id,
      nonce,
      stageSha256: '',
      dumpSha256: descriptor.dump.sha256,
      preparedSha256: digest(prepared),
      database: {
        systemIdentifier: imported.identity.system_identifier,
        databaseOid: imported.identity.database_oid,
        database: imported.identity.database,
        owner: imported.owner,
        marker: '',
      },
    },
  };
  await write('authentication.json', authentication);
  await write('connection.json', {
    host: descriptor.network.address,
    port: 5432,
    user: imported.owner,
    password: 'private:password\\fixture',
    database: imported.identity.database,
  });
  await rebind();
  pg.query = async (sql, values = []) => {
    if (sql.startsWith('SELECT current_user::text AS role,session_user')) {
      pg.sessionQueries.push(sql);
      const row = {
        role: imported.owner,
        session_role: imported.owner,
        database: imported.identity.database,
        search_path: 'pg_catalog',
        read_only: 'on',
        transaction_read_only: 'on',
        version: 170006,
        epoch: '1700000000000000',
        address: '192.0.2.20',
        port: 5432,
        encoding: 'UTF8',
        collate: 'C',
        ctype: 'C',
        provider: 'c',
      };
      sessionMutation?.(row);
      return { rows: [row] };
    }
    return imported.query(sql, values);
  };
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
it('runs the REAL imported verifier through a fake PG boundary, canonical sole result and read-only session', async () => {
  const result = await verifyCoreRestorationWorker(options());
  expect(result).toEqual({
    ...request.binding,
    schema: 'orbis.core-imported-database-verification.v1',
    logicalTargetVerified: true,
    environmentProved: false,
    restoreAuthority: false,
    activation: false,
  });
  expect(await fs.readdir(output)).toEqual(['result.json']);
  expect(await fs.readFile(path.join(output, 'result.json'), 'utf8')).toBe(canonicalCoreJson(result));
  expect((await fs.stat(path.join(output, 'result.json'))).mode & 0o777).toBe(0o400);
  expect(pg.clients).toHaveLength(1);
  expect(pg.clients[0]?.ended).toBe(1);
  expect(pg.clients[0]?.config).toMatchObject({
    host: '192.0.2.20',
    port: 5432,
    user: imported.owner,
    database: imported.identity.database,
    password: 'private:password\\fixture',
    ssl: false,
  });
  expect(String(pg.clients[0]?.config.options)).toContain('default_transaction_read_only=on');
  expect(pg.sessionQueries.length).toBe(2);
  expect(pg.sessionQueries.every((sql) => sql.includes('pg_catalog.host(inet_server_addr()) AS address'))).toBe(true);
  expect(imported.query.mock.calls.some(([sql]) => sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')).toBe(true);
  expect(
    imported.query.mock.calls.filter(([sql]) => /^(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|LOCK|COMMENT)|^SELECT pg_catalog.setval/.test(sql)),
  ).toEqual([]);
  expect(canonicalCoreJson(result)).not.toContain('password');
  expect(canonicalCoreJson(result)).not.toContain(jwtSecret);
});
it('also accepts private readonly publisher inputs without changing their seals', async () => {
  for (const name of await fs.readdir(input)) await fs.chmod(path.join(input, name), 0o400);
  await expect(verifyCoreRestorationWorker(options())).resolves.toMatchObject({ logicalTargetVerified: true, activation: false });
});
it.each(['address', 'role', 'version', 'epoch', 'collate', 'provider', 'read_only', 'transaction_read_only', 'search_path'])(
  'refuses actual SQL session %s mismatch without result',
  async (field) => {
    sessionMutation = (row) => {
      row[field] = 'wrong';
    };
    await expect(verifyCoreRestorationWorker(options())).rejects.toThrow('Core imported database verification failed.');
    expect(await fs.readdir(output)).toEqual([]);
    expect(pg.clients[0]?.ended).toBe(1);
  },
);
it.each(['accounts', 'apps', 'marker', 'owner', 'oid', 'sequence'])('actual helper rejects imported %s mismatch', async (attack) => {
  if (attack === 'accounts') present(imported.rows.user[0]).password = password(3);
  if (attack === 'apps') present(imported.rows.app[0]).status = 'stopped';
  if (attack === 'marker') imported.marker = 'unowned';
  if (attack === 'owner') imported.owner = 'foreign';
  if (attack === 'oid') imported.identity.database_oid = '26401';
  if (attack === 'sequence') present(imported.sequences.user_id_seq).value = '999';
  await expect(verifyCoreRestorationWorker(options())).rejects.toThrow();
  expect(await fs.readdir(output)).toEqual([]);
  expect(pg.clients[0]?.ended).toBe(1);
  expect(imported.transaction).toBeUndefined();
});
it.each(['host', 'port', 'user', 'database', 'password'])('binds credentials field %s before connection', async (field) => {
  const value = JSON.parse(await fs.readFile(path.join(input, 'connection.json'), 'utf8'));
  value[field] = field === 'port' ? 5433 : field === 'password' ? 'bad\npassword' : 'mismatch';
  await write('connection.json', value);
  await expect(verifyCoreRestorationWorker(options())).rejects.toThrow();
  expect(pg.clients).toEqual([]);
  expect(await fs.readdir(output)).toEqual([]);
});
it.each(['network', 'stageHash', 'major', 'flags', 'extra', 'numericOid', 'auth', 'prepared'])(
  'refuses malformed Root %s binding',
  async (attack) => {
    if (attack === 'network') Reflect.deleteProperty(descriptor, 'network');
    if (attack === 'major') descriptor.server.serverVersionNum = 140001;
    if (attack === 'flags') descriptor.liveDestinationProved = true;
    if (attack === 'extra') descriptor.extra = 'not-authority';
    if (attack === 'auth') request.authenticationSha256 = 'a'.repeat(64);
    if (attack === 'prepared') request.prepared = { ...request.prepared, destinationAppsSha256: 'a'.repeat(64) };
    await rebind();
    if (attack === 'stageHash') {
      request.binding.stageSha256 = 'b'.repeat(64);
      await write('request.json', request);
    }
    if (attack === 'numericOid') {
      Reflect.set(request.binding.database, 'databaseOid', 26400);
      await write('request.json', request);
    }
    await expect(verifyCoreRestorationWorker(options())).rejects.toThrow();
    expect(pg.clients).toEqual([]);
  },
);
it.each(['symlink', 'hardlink', 'mode0640', 'mode0660', 'extra', 'noncanonical', 'oversize'])('rejects protected input %s', async (attack) => {
  const file = path.join(input, 'request.json');
  if (attack === 'symlink') {
    await fs.rename(file, path.join(root, 'saved.json'));
    await fs.symlink(path.join(root, 'saved.json'), file);
  }
  if (attack === 'hardlink') await fs.link(file, path.join(root, 'linked.json'));
  if (attack === 'mode0640') await fs.chmod(file, 0o640);
  if (attack === 'mode0660') await fs.chmod(file, 0o660);
  if (attack === 'extra') await fs.writeFile(path.join(input, 'extra.json'), '{}', { mode: 0o400 });
  if (attack === 'noncanonical') {
    await fs.chmod(file, 0o600);
    await fs.writeFile(file, JSON.stringify(request, null, 2));
    await fs.chmod(file, 0o400);
  }
  if (attack === 'oversize') {
    await fs.chmod(file, 0o600);
    await fs.writeFile(file, 'x'.repeat(65537));
    await fs.chmod(file, 0o400);
  }
  await expect(verifyCoreRestorationWorker(options())).rejects.toThrow();
  expect(pg.clients).toEqual([]);
});
it.each(['input-file', 'input-directory', 'output-directory', 'late-input'])(
  'detects %s drift across async SQL and closes its client',
  async (attack) => {
    const mutate = async () => {
      if (attack === 'input-file') {
        const f = path.join(input, 'request.json');
        await fs.rename(f, path.join(root, 'old-request'));
        await write('request.json', request);
      }
      if (attack === 'input-directory') {
        await fs.rename(input, path.join(root, 'old-input'));
        await fs.mkdir(input, { mode: 0o700 });
      }
      if (attack === 'output-directory') {
        await fs.rename(output, path.join(root, 'old-output'));
        await fs.mkdir(output, { mode: 0o700 });
      }
      if (attack === 'late-input') await fs.chmod(path.join(input, 'descriptor.json'), 0o640);
    };
    if (attack === 'late-input') {
      let done = false;
      imported.hook = async (sql) => {
        if (sql.includes('pg_get_userbyid') && !done) {
          done = true;
          await mutate();
        }
      };
    } else pg.connect = mutate;
    await expect(verifyCoreRestorationWorker(options())).rejects.toThrow();
    expect(pg.clients[0]?.ended).toBe(1);
    expect(await fs.readdir(output)).toEqual([]);
  },
);
it('refuses aliased/nonempty output without a connection and preserves foreign files', async () => {
  await expect(verifyCoreRestorationWorker({ ...options(), output: input })).rejects.toThrow();
  await fs.writeFile(path.join(output, 'result.json'), 'foreign', { mode: 0o600 });
  await expect(verifyCoreRestorationWorker(options())).rejects.toThrow();
  expect(await fs.readFile(path.join(output, 'result.json'), 'utf8')).toBe('foreign');
  expect(pg.clients).toEqual([]);
});
it('redacts driver failures, closes connection and emits only fixed diagnostic fields', async () => {
  pg.error = Object.assign(new Error(`private:password\\fixture ${jwtSecret}`), { code: '28P01', detail: 'secret' });
  let caught: unknown;
  try {
    await verifyCoreRestorationWorker(options());
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(String(caught)).toBe('Error: Core imported database verification failed.');
  expect(coreRestorationFailureDiagnostic(caught)).toEqual({ event: 'core-restoration-verification-failed', phase: 'connect', code: '28P01' });
  expect(coreRestorationFailureDiagnostic(new Error('password'))).toEqual({
    event: 'core-restoration-verification-failed',
    phase: 'input',
    code: 'unknown',
  });
  expect(pg.clients[0]?.ended).toBe(1);
  expect(await fs.readdir(output)).toEqual([]);
});
it('aborted admission performs no SQL and capability exports no restore grant', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(verifyCoreRestorationWorker({ ...options(), signal: controller.signal })).rejects.toThrow();
  expect(pg.clients).toEqual([]);
  expect(coreRestorationWorkerCapability).toMatchObject({
    input: '/core-restoration-input',
    output: '/core-restoration-output',
    activation: false,
    restoreAuthority: false,
    liveDestinationProved: false,
  });
});

async function liveInputs() {
  request.schema = 'orbis.core-live-imported-database-worker-input.v1';
  descriptor.schema = 'orbis.core-live-derived-logical-stage.v1';
  Reflect.deleteProperty(descriptor, 'reviewId');
  Reflect.deleteProperty(descriptor, 'reconciliationReceiptSha256');
  descriptor.liveJobId = randomUUID();
  descriptor.liveAdmissionSha256 = 'a'.repeat(64);
  descriptor.liveHeldStageSha256 = 'b'.repeat(64);
  descriptor.scope = 'core-live-derived-logical-stage-only';
  descriptor.destinationEvidence = 'live-held-derived';
  await rebind();
}
it('verifies live-held provenance with the real neutral SQL helper and emits only distinct live lineage', async () => {
  await liveInputs();
  const result = await verifyCoreLiveRestorationWorker(options());
  expect(result).toEqual({
    ...request.binding,
    schema: 'orbis.core-live-imported-database-verification.v1',
    liveJobId: descriptor.liveJobId,
    liveAdmissionSha256: descriptor.liveAdmissionSha256,
    liveHeldStageSha256: descriptor.liveHeldStageSha256,
    logicalTargetVerified: true,
    environmentProved: false,
    restoreAuthority: false,
    activation: false,
  });
  expect(result.database.marker).toBe(request.binding.database.marker);
  expect(result.database.marker).toMatch(/^orbis\.core-derived-logical\.v1\//);
  expect(await fs.readFile(path.join(output, 'result.json'), 'utf8')).toBe(canonicalCoreJson(result));
  expect(Object.keys(result)).not.toContain('reviewId');
  expect(Object.keys(result)).not.toContain('reconciliationReceiptSha256');
  expect(canonicalCoreJson(result)).not.toContain('saved-capture');
  expect(canonicalCoreJson(result)).not.toContain(jwtSecret);
  expect(pg.sessionQueries).toHaveLength(2);
  expect(imported.query.mock.calls.some(([sql]) => sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')).toBe(true);
  expect(
    imported.query.mock.calls.filter(([sql]) => /^(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|LOCK|COMMENT)|^SELECT pg_catalog.setval/.test(sql)),
  ).toEqual([]);
  expect(pg.clients[0]?.ended).toBe(1);
});
it.each([
  ['saved', 'saved', 'live'],
  ['saved', 'live', 'saved'],
  ['saved', 'live', 'live'],
  ['live', 'saved', 'saved'],
  ['live', 'saved', 'live'],
  ['live', 'live', 'saved'],
])('mode %s rejects request %s with descriptor %s before connection', async (mode, requestMode, descriptorMode) => {
  const savedDescriptor = clone(descriptor);
  await liveInputs();
  if (requestMode === 'saved') request.schema = 'orbis.core-imported-database-worker-input.v1';
  if (descriptorMode === 'saved') descriptor = savedDescriptor;
  await rebind();
  await expect((mode === 'saved' ? verifyCoreRestorationWorker : verifyCoreLiveRestorationWorker)(options())).rejects.toThrow(
    'Core imported database verification failed.',
  );
  expect(pg.clients).toEqual([]);
  expect(await fs.readdir(output)).toEqual([]);
});
it.each([
  'missing-job',
  'bad-job',
  'aliased-job',
  'aliased-nonce',
  'missing-admission',
  'bad-admission',
  'missing-held',
  'bad-held',
  'old-review',
  'old-receipt',
  'wrong-scope',
  'wrong-evidence',
  'grant',
  'unknown-request',
  'unknown-descriptor',
])('refuses live lineage %s', async (attack) => {
  await liveInputs();
  if (attack === 'missing-job') Reflect.deleteProperty(descriptor, 'liveJobId');
  if (attack === 'bad-job') descriptor.liveJobId = 'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa';
  if (attack === 'aliased-job') descriptor.liveJobId = descriptor.id;
  if (attack === 'aliased-nonce') descriptor.liveJobId = descriptor.nonce;
  if (attack === 'missing-admission') Reflect.deleteProperty(descriptor, 'liveAdmissionSha256');
  if (attack === 'bad-admission') descriptor.liveAdmissionSha256 = 'invalid';
  if (attack === 'missing-held') Reflect.deleteProperty(descriptor, 'liveHeldStageSha256');
  if (attack === 'bad-held') descriptor.liveHeldStageSha256 = 1;
  if (attack === 'old-review') descriptor.reviewId = randomUUID();
  if (attack === 'old-receipt') descriptor.reconciliationReceiptSha256 = 'c'.repeat(64);
  if (attack === 'wrong-scope') descriptor.scope = 'core-derived-logical-stage-only';
  if (attack === 'wrong-evidence') descriptor.destinationEvidence = 'saved-capture-only';
  if (attack === 'grant') descriptor.liveDestinationProved = true;
  if (attack === 'unknown-request') request.schema = 'orbis.core-live-imported-database-worker-input.v2';
  if (attack === 'unknown-descriptor') descriptor.schema = 'orbis.core-live-derived-logical-stage.v2';
  await rebind();
  await expect(verifyCoreLiveRestorationWorker(options())).rejects.toThrow();
  expect(pg.clients).toEqual([]);
});
it.each(['address', 'epoch', 'provider', 'transaction_read_only'])('live mode retains actual SQL %s checks', async (field) => {
  await liveInputs();
  sessionMutation = (row) => {
    row[field] = 'wrong';
  };
  await expect(verifyCoreLiveRestorationWorker(options())).rejects.toThrow();
  expect(await fs.readdir(output)).toEqual([]);
  expect(pg.clients[0]?.ended).toBe(1);
});
it.each(['accounts', 'apps', 'marker', 'oid', 'sequence'])('live mode retains actual helper %s checks', async (attack) => {
  await liveInputs();
  if (attack === 'accounts') present(imported.rows.user[0]).password = password(3);
  if (attack === 'apps') present(imported.rows.app[0]).status = 'stopped';
  if (attack === 'marker') imported.marker = 'unowned';
  if (attack === 'oid') imported.identity.database_oid = '26401';
  if (attack === 'sequence') present(imported.sequences.user_id_seq).value = '999';
  await expect(verifyCoreLiveRestorationWorker(options())).rejects.toThrow();
  expect(await fs.readdir(output)).toEqual([]);
  expect(imported.transaction).toBeUndefined();
  expect(pg.clients[0]?.ended).toBe(1);
});
it.each(['input', 'lineage', 'output'])('live mode detects asynchronous %s drift without result', async (attack) => {
  await liveInputs();
  pg.connect = async () => {
    if (attack === 'input') await fs.chmod(path.join(input, 'authentication.json'), 0o640);
    if (attack === 'lineage') {
      descriptor.liveHeldStageSha256 = 'c'.repeat(64);
      await rebind();
    }
    if (attack === 'output') {
      await fs.rename(output, path.join(root, 'old-live-output'));
      await fs.mkdir(output, { mode: 0o700 });
    }
  };
  await expect(verifyCoreLiveRestorationWorker(options())).rejects.toThrow();
  expect(await fs.readdir(output)).toEqual([]);
  expect(pg.clients[0]?.ended).toBe(1);
});
it('live SQL failures preserve fixed secret-safe diagnostic behavior', async () => {
  await liveInputs();
  pg.error = Object.assign(new Error(`private:password\\fixture ${jwtSecret}`), { code: '28P01' });
  let caught: unknown;
  try {
    await verifyCoreLiveRestorationWorker(options());
  } catch (error) {
    caught = error;
  }
  expect(String(caught)).toBe('Error: Core imported database verification failed.');
  expect(coreRestorationFailureDiagnostic(caught)).toEqual({ event: 'core-restoration-verification-failed', phase: 'connect', code: '28P01' });
  expect(await fs.readdir(output)).toEqual([]);
  expect(pg.clients[0]?.ended).toBe(1);
});
it('keeps saved capability exact and exposes a separate live capability without granting authority', () => {
  expect(coreRestorationWorkerCapability).toEqual({
    schema: 'orbis.core-restoration-worker-capability.v1',
    mode: 'verify-imported-only',
    requestSchema: 'orbis.core-imported-database-worker-input.v1',
    resultSchema: 'orbis.core-imported-database-verification.v1',
    operatingSystem: 'linux',
    uid: 0,
    input: '/core-restoration-input',
    output: '/core-restoration-output',
    port: 5432,
    deadlineMs: 150000,
    connectionTimeoutMs: 10000,
    queryTimeoutMs: 20000,
    statementTimeoutMs: 15000,
    scope: 'core-derived-logical-stage-only',
    activation: false,
    restoreAuthority: false,
    environmentProved: false,
    sourceWrites: false,
    liveDestinationProved: false,
    destinationEvidence: 'saved-capture-only',
  });
  expect(coreLiveRestorationWorkerCapability).toEqual({
    ...coreRestorationWorkerCapability,
    schema: 'orbis.core-live-restoration-worker-capability.v1',
    mode: 'verify-live-imported-only',
    requestSchema: 'orbis.core-live-imported-database-worker-input.v1',
    resultSchema: 'orbis.core-live-imported-database-verification.v1',
    scope: 'core-live-derived-logical-stage-only',
    destinationEvidence: 'live-held-derived',
  });
  expect(Object.isFrozen(coreLiveRestorationWorkerCapability)).toBe(true);
});
