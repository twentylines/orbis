import { createCipheriv, createHash, pbkdf2Sync, randomUUID } from 'node:crypto';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { expect, it, vi } from 'vitest';
import { app, appStore, link, user, appMigrationCommit } from '@/core/database/drizzle/schema';
import { backupDatabaseColumns, backupDatabaseLimits, type BackupDatabaseTable } from './backup-database-records';
import {
  type CoreCleanTargetReconciliation,
  type CoreCleanTargetSequencePolicy,
  coreSourceBootstrapEvidence,
  coreSourceCatalogBootstrapEvidence,
  inspectCoreDatabase,
  inspectCoreDatabaseStructure,
  prepareCoreCleanTarget,
  verifyCoreCleanTarget,
  verifyCoreImportedDatabase,
  type CoreImportedDatabaseBinding,
} from './time-machine-core-database';
import { canonicalCoreJson } from './time-machine-core-payload';
import {
  assertCoreLiveReconciliationHeld,
  holdCoreLiveDatabase,
  observeCoreLiveDatabase,
  reconcileCoreLiveDatabase,
  type CoreLiveDatabaseFenceIntent,
  type HeldCoreLiveDatabase,
  type HeldCoreLiveReconciliation,
} from './time-machine-core-live-database-fence';

type Row = Record<string, unknown>;
type Table = BackupDatabaseTable | 'orbis_reset_receipt' | '__drizzle_migrations' | 'app_migration_commit';
type Rows = Record<Exclude<Table, 'app_migration' | 'app_migration_commit'>, Row[]> & { app_migration?: Row[]; app_migration_commit?: Row[] };
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
const sequenceTables: Record<string, Exclude<Table, 'app_migration' | 'app_migration_commit'>> = {
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
      const columns =
        table === 'orbis_reset_receipt'
          ? ['id', 'completed_at']
          : table === 'app_migration_commit'
            ? getTableConfig(appMigrationCommit).columns.map(({ name }) => name)
            : backupDatabaseColumns(table, this.rows.app_migration ? 2 : 1);
      if (!this.transaction || columns.length !== values.length) throw new Error('fixture unsupported insert');
      const destination = this.rows[table];
      if (!destination) throw new Error('Migration table absent');
      destination.push(Object.fromEntries(columns.map((column, index) => [column, clone(values[index])])));
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
function upgradeLedgerFixture(database: Database, migrationId?: string) {
  const { tables, columns, constraints } = database.catalog;
  const appPosition = columns.filter((row) => row.schema === 'public' && row.table === 'app').length + 1;
  tables.push({ schema: 'public', name: 'app_migration', kind: 'r', persistence: 'p', rls: false, force_rls: false });
  const base = { schema: 'public', type_schema: 'pg_catalog', not_null: true, identity: '', generated: '', default: null };
  columns.push(
    { ...base, table: 'app', name: 'migrations_baselined', position: appPosition, type: 'bool', format: 'boolean', default: 'false' },
    { ...base, table: 'app_migration', name: 'app_id', position: 1, type: 'int4', format: 'integer' },
    { ...base, table: 'app_migration', name: 'migration_id', position: 2, type: 'varchar', format: 'character varying(128)' },
  );
  constraints.push(
    { schema: 'public', table: 'app_migration', type: 'p', validated: true, definition: 'PRIMARY KEY (app_id, migration_id)' },
    {
      schema: 'public',
      table: 'app_migration',
      type: 'f',
      validated: true,
      definition: 'FOREIGN KEY (app_id) REFERENCES public.app(id) ON DELETE CASCADE',
    },
  );
  for (const row of database.rows.app) row.migrations_baselined = true;
  database.rows.app_migration = migrationId ? [{ app_id: present(database.rows.app[0]).id, migration_id: migrationId }] : [];
}

function upgradeCommitFixture(database: Database, receipt?: Row) {
  upgradeLedgerFixture(database);
  database.catalog.tables.push({ schema: 'public', name: 'app_migration_commit', kind: 'r', persistence: 'p', rls: false, force_rls: false });
  for (const [index, column] of getTableConfig(appMigrationCommit).columns.entries()) {
    const sql = column.getSQLType();
    database.catalog.columns.push({
      schema: 'public',
      table: 'app_migration_commit',
      name: column.name,
      position: index + 1,
      type: sql.startsWith('varchar') ? 'varchar' : 'int4',
      type_schema: 'pg_catalog',
      format: sql.replace(/^varchar/, 'character varying'),
      not_null: true,
      identity: '',
      generated: '',
      default: null,
    });
  }
  database.catalog.constraints.push(
    { schema: 'public', table: 'app_migration_commit', type: 'p', validated: true, definition: 'PRIMARY KEY (request_id)' },
    { schema: 'public', table: 'app_migration_commit', type: 'u', validated: true, definition: 'UNIQUE (stage_id)' },
  );
  database.rows.app_migration_commit = receipt ? [receipt] : [];
  database.rows.__drizzle_migrations.push(
    { id: 82, hash: '931cd10ce91be3582efccc9c17d34d9042db48db925b90b2e88b75496060602a', created_at: '1795203554058' },
    { id: 83, hash: '838b363174dd85025ce1eff4d4a0c29aaa5cf68a9276b722ff8e8ca39153f3b8', created_at: '1795305600000' },
  );
}
const appCommitReceipt = () => ({
  request_id: randomUUID(),
  app_id: 47,
  stage_id: randomUUID(),
  operation_sha256: 'a'.repeat(64),
  ledger_sha256: 'b'.repeat(64),
  version: 3,
  committed_at: 1700000001,
});

it('preserves only destination app commit receipts in an exact matching Core target and verifies them on replay', async () => {
  const f = await fixture((source, destination, target) => {
    upgradeCommitFixture(source, appCommitReceipt());
    upgradeCommitFixture(destination, appCommitReceipt());
    upgradeCommitFixture(target);
  });
  const report = await inspectCoreDatabaseStructure(f.target as never, signal());
  expect(report.schema).toBe('orbis.core-database-structure.v3');
  expect(report.rows.app_migration_commit).toBe(0);
  const receipt = await prepareCoreCleanTarget(f.options);
  expect(f.target.rows.app_migration_commit).toEqual(f.destination.rows.app_migration_commit);
  expect(f.target.rows.app_migration_commit).not.toEqual(f.source.rows.app_migration_commit);
  expect(writes(f.target).some(([sql]) => sql.startsWith('LOCK TABLE') && sql.includes('public.app_migration_commit'))).toBe(true);
  present(f.target.rows.app_migration_commit?.[0]).operation_sha256 = 'c'.repeat(64);
  await expect(verifyCoreCleanTarget(f.target as never, receipt, signal())).rejects.toThrow('(receipt)');
});

it.each(['missing-ledger', 'bad-history', 'wrong-columns', 'nonempty-target', 'bad-receipt'])(
  'refuses an unqualified app-commit catalog or record: %s',
  async (kind) => {
    const setup = (source: Database, destination: Database, target: Database) => {
      for (const database of [source, destination, target]) upgradeCommitFixture(database);
      if (kind === 'missing-ledger') source.catalog.tables = source.catalog.tables.filter((row) => row.name !== 'app_migration');
      if (kind === 'bad-history') present(source.rows.__drizzle_migrations.at(-1)).hash = 'c'.repeat(64);
      if (kind === 'wrong-columns') present(source.catalog.columns.find((row) => row.table === 'app_migration_commit')).format = 'text';
      if (kind === 'nonempty-target') target.rows.app_migration_commit = [appCommitReceipt()];
      if (kind === 'bad-receipt') source.rows.app_migration_commit = [{ ...appCommitReceipt(), ledger_sha256: 'invalid' }];
    };
    if (kind === 'nonempty-target') {
      const f = await fixture(setup);
      await expect(prepareCoreCleanTarget(f.options)).rejects.toThrow('(records)');
      expect(inserts(f.target)).toEqual([]);
    } else await expect(fixture(setup)).rejects.toThrow();
  },
);

it('reports seven structure counts only when catalog and canonical 0033 history match', async () => {
  const database = new Database('captured', '7000000000000000001');
  const legacy = await inspectCoreDatabaseStructure(database as never, signal());
  expect(legacy.schema).toBe('orbis.core-database-structure.v1');
  expect(Object.keys(legacy.rows)).toHaveLength(6);

  const marker = {
    id: 81,
    hash: '931cd10ce91be3582efccc9c17d34d9042db48db925b90b2e88b75496060602a',
    created_at: '1795203554058',
  };
  database.rows.__drizzle_migrations.push(marker);
  await expect(inspectCoreDatabaseStructure(database as never, signal())).rejects.toThrow('(catalog)');
  upgradeLedgerFixture(database);
  const modern = await inspectCoreDatabaseStructure(database as never, signal());
  expect(modern.schema).toBe('orbis.core-database-structure.v2');
  expect(modern.rows.app_migration).toBe(0);
  expect(Object.keys(modern.rows)).toHaveLength(7);

  present(database.rows.__drizzle_migrations.at(-1)).hash = '0'.repeat(64);
  await expect(inspectCoreDatabaseStructure(database as never, signal())).rejects.toThrow('(catalog)');
  database.rows.__drizzle_migrations.pop();
  await expect(inspectCoreDatabaseStructure(database as never, signal())).rejects.toThrow('(catalog)');
});

it('copies only destination migration IDs into a matching ledger-aware Core target and binds replay to them', async () => {
  const f = await fixture((source, destination, target) => {
    upgradeLedgerFixture(source, '001-captured');
    upgradeLedgerFixture(destination, '002-destination');
    upgradeLedgerFixture(target);
  });
  const receipt = await prepareCoreCleanTarget(f.options);
  expect(f.target.rows.app_migration).toEqual(f.destination.rows.app_migration);
  expect(f.target.rows.app[0]?.migrations_baselined).toBe(true);
  expect(writes(f.target).some(([sql]) => sql.startsWith('LOCK TABLE') && sql.includes('public.app_migration'))).toBe(true);
  const row = present(f.target.rows.app_migration?.[0]);
  row.migration_id = '003-tamper';
  await expect(verifyCoreCleanTarget(f.target as never, receipt, signal())).rejects.toThrow('(receipt)');
});

it('rejects a mixed old and ledger-aware Core catalog before inserting anything', async () => {
  const f = await fixture((source) => upgradeLedgerFixture(source, '001-captured'));
  await expect(prepareCoreCleanTarget(f.options)).rejects.toThrow('(catalog)');
  expect(inserts(f.target)).toEqual([]);
});

const writes = (database: Database) =>
  database.query.mock.calls.filter(([sql]) => /^(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|COMMENT|LOCK)|^SELECT pg_catalog.setval/.test(sql));
const inserts = (database: Database) => database.query.mock.calls.filter(([sql]) => sql.startsWith('INSERT'));

async function liveFixture() {
  const f = await fixture();
  const original = f.destination.query;
  let allowed = true;
  let foreign = false;
  let revoked = false;
  let fence: CoreLiveDatabaseFenceIntent | undefined;
  const expected = {
    systemIdentifier: f.destination.identity.system_identifier,
    database: f.destination.identity.database,
    databaseOid: f.destination.identity.database_oid,
    role: f.destination.owner,
    roleOid: '10',
    serverVersionNum: f.destination.version,
  };
  const observed = (control: boolean) => ({
    ...expected,
    ...(control ? { database: 'postgres', databaseOid: '5' } : {}),
    pid: control ? '101' : '102',
    startedAt: '1794481200.123456',
    allowConnections: control || allowed,
  });
  f.destination.query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.includes('pg_backend_pid()')) return { rows: [observed(false)] };
    return original(sql, values);
  });
  const maintenance = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('pg_backend_pid()')) return { rows: [observed(true)] };
      if (sql.includes('pg_locks')) return { rows: [] };
      if (sql.includes('pg_stat_activity')) return { rows: [{ pid: '102' }, ...(foreign ? [{ pid: '103' }] : [])] };
      if (sql.includes('pg_prepared_xacts')) return { rows: [{ count: '0' }] };
      if (sql === 'ALTER DATABASE "destination" ALLOW_CONNECTIONS false') {
        allowed = false;
        return { rows: [] };
      }
      throw new Error('fixture unexpected maintenance query');
    }),
  };
  const hold = async () =>
    holdCoreLiveDatabase({
      observation: await observeCoreLiveDatabase({ live: f.destination as never, maintenance: maintenance as never, expected, signal: signal() }),
      id: randomUUID(),
      nonce: randomUUID(),
      rootIntentSha256: 'a'.repeat(64),
      signal: signal(),
      journal: {
        persist: async (value) => {
          fence = structuredClone(value);
        },
        verify: async () => {
          if (revoked) throw new Error('Root revoked');
        },
      },
    });
  const authorize = vi.fn(async (_prepared, _evidence) => {});
  const committed = vi.fn(async (_prepared, _evidence) => {});
  const verify = vi.fn(async (_prepared, _evidence) => {
    if (revoked) throw new Error('Root revoked');
  });
  const run = (held: HeldCoreLiveDatabase) =>
    reconcileCoreLiveDatabase({
      ...f.options,
      held,
      destinationAuthentication: { jwtSecret: 'destination candidate key' },
      authorize,
      committed,
      verify,
    });
  return {
    ...f,
    hold,
    run,
    authorize,
    committed,
    verify,
    maintenance,
    fence: () => present(fence),
    allowed: () => allowed,
    foreign: () => {
      foreign = true;
    },
    revoke: () => {
      revoked = true;
    },
  };
}

it('reconciles the current held destination instead of the earlier inspected app and reset state', async () => {
  const f = await liveFixture();
  present(f.destination.rows.app[0]).status = 'stopped';
  present(f.destination.rows.app[0]).version = 9;
  f.destination.rows.orbis_reset_receipt.push({ id: randomUUID(), completed_at: 1700000100 });
  const before = clone(f.destination.rows);
  const held = await f.hold();
  const result = await f.run(held);
  expect(result.prepared.destinationSha256).not.toBe('');
  expect(result.evidence).toEqual({
    schema: 'orbis.core-live-target-reconciliation.v1',
    id: result.prepared.id,
    nonce: result.prepared.nonce,
    rootIntentSha256: f.fence().rootIntentSha256,
    fenceIntentSha256: createHash('sha256').update(canonicalCoreJson(f.fence())).digest('hex'),
    destinationSha256: result.prepared.destinationSha256,
    preparedSha256: createHash('sha256').update(canonicalCoreJson(result.prepared)).digest('hex'),
    destinationEvidence: 'held-live-database',
    activation: false,
    restoreAuthority: false,
    environmentProved: false,
  });
  expect(f.target.rows.app).toEqual(before.app);
  expect(f.target.rows.orbis_reset_receipt).toEqual(before.orbis_reset_receipt);
  expect(f.target.rows.user).toEqual(f.source.rows.user);
  expect(f.destination.rows).toEqual(before);
  expect(f.allowed()).toBe(false);
  expect(f.authorize).toHaveBeenCalledWith(result.prepared, result.evidence);
  expect(f.committed).toHaveBeenCalledTimes(1);
  await assertCoreLiveReconciliationHeld(result.token, signal());
  await expect(f.run(held)).rejects.toThrow();
  expect(f.maintenance.query.mock.calls.some(([sql]) => sql.endsWith('ALLOW_CONNECTIONS true'))).toBe(false);
});

it.each(['foreign', 'revoke'] as const)('refuses %s during live reconciliation authorization before target writes', async (attack) => {
  const f = await liveFixture();
  const held = await f.hold();
  f.authorize.mockImplementation(async () => {
    f[attack]();
  });
  await expect(f.run(held)).rejects.toThrow();
  expect(inserts(f.target)).toEqual([]);
  expect(f.committed).not.toHaveBeenCalled();
  expect(f.allowed()).toBe(false);
});

it('leaves a lost target commit acknowledgement held for Root recovery without replaying inserts', async () => {
  const f = await liveFixture();
  const held = await f.hold();
  f.authorize.mockImplementation(async () => {
    f.target.failCommitAfter = true;
  });
  await expect(f.run(held)).rejects.toThrow('commit acknowledgement');
  expect(f.target.marker).not.toBeNull();
  expect(f.target.rows.app).toEqual(f.destination.rows.app);
  expect(f.committed).not.toHaveBeenCalled();
  const count = inserts(f.target).length;
  await expect(f.run(held)).rejects.toThrow();
  expect(inserts(f.target)).toHaveLength(count);
  expect(f.allowed()).toBe(false);
});

it('does not return live evidence when the hold is lost while writing the isolated target', async () => {
  const f = await liveFixture();
  const held = await f.hold();
  f.target.hook = (sql) => {
    if (sql.startsWith('INSERT')) f.foreign();
  };
  await expect(f.run(held)).rejects.toThrow();
  expect(f.target.marker).not.toBeNull();
  expect(f.committed).not.toHaveBeenCalled();
  expect(f.allowed()).toBe(false);
  await expect(f.run(held)).rejects.toThrow();
});

it('keeps a failed durable completion acknowledgement for recovery instead of reopening the database', async () => {
  const f = await liveFixture();
  const held = await f.hold();
  f.committed.mockImplementation(async () => {
    throw new Error('Completion acknowledgement lost');
  });
  await expect(f.run(held)).rejects.toThrow('Completion acknowledgement lost');
  expect(f.target.marker).not.toBeNull();
  expect(f.target.rows.app).toEqual(f.destination.rows.app);
  expect(f.allowed()).toBe(false);
  await expect(f.run(held)).rejects.toThrow();
  expect(f.committed).toHaveBeenCalledTimes(1);
});

it.each(['current-data', 'target-data', 'foreign', 'revoke'] as const)('rejects a live reconciliation token after %s drift', async (attack) => {
  const f = await liveFixture();
  const result = await f.run(await f.hold());
  if (attack === 'current-data') present(f.destination.rows.app[0]).version = 12;
  if (attack === 'target-data') present(f.target.rows.app[0]).version = 12;
  if (attack === 'foreign') f.foreign();
  if (attack === 'revoke') f.revoke();
  await expect(assertCoreLiveReconciliationHeld(result.token, signal())).rejects.toThrow();
  expect(f.allowed()).toBe(false);
});

it('refuses serialized live hold and reconciliation reports as process authority', async () => {
  const f = await liveFixture();
  await expect(f.run({} as HeldCoreLiveDatabase)).rejects.toThrow();
  await expect(assertCoreLiveReconciliationHeld({} as HeldCoreLiveReconciliation, signal())).rejects.toThrow();
  expect(f.allowed()).toBe(true);
  expect(f.authorize).not.toHaveBeenCalled();
  expect(inserts(f.target)).toEqual([]);
});

it('binds every authenticated account identity in v2 evidence without changing legacy evidence or leaking account values', async () => {
  const f = await fixture((source) => {
    source.rows.user.push({ ...present(source.rows.user[0]), id: 2, username: 'second-private-account', operator: false });
    source.rows.__drizzle_migrations = [{ id: 3, hash: 'a'.repeat(64), created_at: '1700000000000' }];
  });
  const evidence = await coreSourceCatalogBootstrapEvidence(f.options.source, 11);
  expect(evidence.schema).toBe('orbis.core-source-bootstrap-evidence.v2');
  expect(evidence.catalogUserIdentities).toEqual(
    [2, 11].map((id) => {
      const row = present(f.source.rows.user.find((row) => row.id === id));
      return {
        ownerId: id,
        identitySha256: createHash('sha256')
          .update(canonicalCoreJson({ id, username: row.username, createdAt: row.created_at }))
          .digest('hex'),
      };
    }),
  );
  expect(evidence.catalogUserIdentities[1]?.identitySha256).toBe(evidence.identitySha256);
  expect(Object.isFrozen(evidence.catalogUserIdentities)).toBe(true);
  expect(evidence.catalogUserIdentities.every(Object.isFrozen)).toBe(true);
  const old = await coreSourceBootstrapEvidence(f.options.source, 11);
  expect(old.schema).toBe('orbis.core-source-bootstrap-evidence.v1');
  expect(old).not.toHaveProperty('catalogUserIdentities');
  for (const secret of ['same-owner', 'second-private-account', password(1), jwtSecret]) expect(JSON.stringify(evidence)).not.toContain(secret);
  expect(writes(f.source)).toEqual([]);
});

it('refuses forged tokens and account changes when exporting catalog identities', async () => {
  await expect(coreSourceCatalogBootstrapEvidence({} as never, 11)).rejects.toThrow('(ownership)');
  const f = await fixture((source) => {
    source.rows.__drizzle_migrations = [{ id: 3, hash: 'a'.repeat(64), created_at: '1700000000000' }];
  });
  present(f.source.rows.user[0]).username = 'changed-after-inspection';
  await expect(coreSourceCatalogBootstrapEvidence(f.options.source, 11)).rejects.toThrow('(changed)');
  expect(writes(f.source)).toEqual([]);
});

it('exports bounded historical bootstrap evidence only from an authenticated captured snapshot', async () => {
  const ledger = [
    { id: 12, hash: 'b'.repeat(64), created_at: '1700000000001' },
    { id: 2, hash: 'a'.repeat(64), created_at: '1700000000000' },
  ];
  const f = await fixture((source) => {
    source.rows.__drizzle_migrations = clone(ledger);
  });
  const evidence = await coreSourceBootstrapEvidence(f.options.source, 11);
  expect(evidence).toMatchObject({
    schema: 'orbis.core-source-bootstrap-evidence.v1',
    sourceSha256: f.sourceSummary.sha256,
    catalogSha256: f.sourceSummary.catalogSha256,
    sourceOwnerId: 11,
    database: 'captured',
    systemIdentifier: '7000000000000000001',
    migrationLedger: [...ledger].sort((left, right) => left.id - right.id),
    authenticationVerified: true,
    environmentProved: false,
    restoreAuthority: false,
  });
  expect(Object.keys(evidence).sort()).toEqual([
    'authenticationSha256',
    'authenticationVerified',
    'catalogSha256',
    'database',
    'environmentProved',
    'identitySha256',
    'migrationLedger',
    'restoreAuthority',
    'schema',
    'sourceOwnerId',
    'sourceSha256',
    'systemIdentifier',
  ]);
  expect(evidence.authenticationSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(evidence.identitySha256).toMatch(/^[a-f0-9]{64}$/);
  expect(Object.isFrozen(evidence)).toBe(true);
  expect(Object.isFrozen(evidence.migrationLedger)).toBe(true);
  expect(evidence.migrationLedger.every(Object.isFrozen)).toBe(true);
  const queries = f.source.query.mock.calls.map(([sql]) => sql);
  const identityReads = queries.flatMap((sql, index) => (sql.includes('pg_control_system()') ? [index] : []));
  expect(identityReads).toHaveLength(2);
  expect(queries[(identityReads[0] ?? 0) - 1]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  expect(queries.slice((identityReads[0] ?? 0) + 1, identityReads[1])).toContain(
    `SELECT * FROM "drizzle"."__drizzle_migrations" LIMIT ${backupDatabaseLimits.rows + 1}`,
  );
  expect(queries[(identityReads[1] ?? 0) + 1]).toBe('COMMIT');
  expect(writes(f.source)).toEqual([]);
  for (const secret of [jwtSecret, 'same-owner', password(1), "captured');DELETE;--"]) expect(JSON.stringify(evidence)).not.toContain(secret);
});

it.each([
  'empty',
  'excessive',
  'duplicate',
  'zero-id',
  'large-id',
  'fractional-id',
  'hash',
  'time-zero',
  'time-leading-zero',
  'time-unsafe',
  'extra',
])('refuses malformed authenticated bootstrap ledger %s', async (attack) => {
  const f = await fixture((source) => {
    const row: Row = { id: 2, hash: 'a'.repeat(64), created_at: '1700000000000' };
    if (attack === 'zero-id') row.id = 0;
    if (attack === 'large-id') row.id = 2147483648;
    if (attack === 'fractional-id') row.id = 1.5;
    if (attack === 'hash') row.hash = 'private-ledger-value';
    if (attack === 'time-zero') row.created_at = '0';
    if (attack === 'time-leading-zero') row.created_at = '01700000000000';
    if (attack === 'time-unsafe') row.created_at = '9007199254740992';
    if (attack === 'extra') row.secret = 'private-ledger-value';
    source.rows.__drizzle_migrations =
      attack === 'empty'
        ? []
        : attack === 'duplicate'
          ? [row, clone(row)]
          : attack === 'excessive'
            ? Array.from({ length: 4097 }, (_, id) => ({ ...row, id: id + 1 }))
            : [row];
  });
  await expect(coreSourceBootstrapEvidence(f.options.source, 11)).rejects.toThrow('(records)');
  expect(f.source.query.mock.calls.some(([sql]) => sql.includes('pg_control_system()'))).toBe(false);
});

it.each(['0', '01', '-1', '18446744073709551616', 'private-identity'])('refuses noncanonical PostgreSQL source identity %s', async (identity) => {
  const f = await fixture((source) => {
    source.rows.__drizzle_migrations = [{ id: 1, hash: 'a'.repeat(64), created_at: '1700000000000' }];
    source.identity.system_identifier = identity;
  });
  await expect(coreSourceBootstrapEvidence(f.options.source, 11)).rejects.toThrow('(receipt)');
  expect(f.source.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
});

it.each(['rows', 'catalog', 'database', 'system-identifier', 'read-failure', 'owner-recheck-failure'])(
  'refuses a changed or unreadable captured bootstrap source: %s',
  async (attack) => {
    const f = await fixture((source) => {
      source.rows.__drizzle_migrations = [{ id: 1, hash: 'a'.repeat(64), created_at: '1700000000000' }];
    });
    let reads = 0;
    f.source.hook = (sql) => {
      if (attack === 'owner-recheck-failure' && sql.startsWith('SELECT current_database()'))
        throw new Error('private SELECT secret FROM user password');
      if (!sql.includes('pg_control_system()')) return;
      reads += 1;
      if (attack === 'read-failure') throw new Error('private SELECT secret FROM user password');
      if (reads === 1 && attack === 'rows') present(f.source.rows.__drizzle_migrations[0]).hash = 'b'.repeat(64);
      if (reads === 1 && attack === 'catalog') f.source.catalog.indexes.push({ secret: 'changed-catalog' });
      if (reads === 1 && attack === 'database') f.source.identity.database = 'changed_database';
      if (reads === 2 && attack === 'system-identifier') f.source.identity.system_identifier = '7000000000000000009';
    };
    const error = await coreSourceBootstrapEvidence(f.options.source, 11).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('(changed)');
    expect((error as Error).message).not.toContain('private');
    expect((error as Error).cause).toBeUndefined();
    expect(f.source.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  },
);

it('refuses forged tokens, a different owner, and changed authenticated account data', async () => {
  const f = await fixture();
  await expect(coreSourceBootstrapEvidence({} as never, 11)).rejects.toThrow('(ownership)');
  await expect(coreSourceBootstrapEvidence(JSON.parse('{}') as never, 11)).rejects.toThrow('(ownership)');
  for (const ownerId of [0, -1, 1.5, 12, 2147483648])
    await expect(coreSourceBootstrapEvidence(f.options.source, ownerId)).rejects.toThrow('(ownership)');
  present(f.source.rows.user[0]).username = 'changed-owner';
  await expect(coreSourceBootstrapEvidence(f.options.source, 11)).rejects.toThrow('(changed)');
});

it('accepts the bounded PostgreSQL identifier and safe canonical ledger timestamp limits', async () => {
  const f = await fixture((source) => {
    source.identity.system_identifier = '18446744073709551615';
    source.rows.__drizzle_migrations = [{ id: 2147483647, hash: 'a'.repeat(64), created_at: '9007199254740991' }];
  });
  const evidence = await coreSourceBootstrapEvidence(f.options.source, 11);
  expect(evidence.systemIdentifier).toBe('18446744073709551615');
  expect(evidence.migrationLedger).toEqual(f.source.rows.__drizzle_migrations);
  expect(evidence.migrationLedger).not.toBe(f.source.rows.__drizzle_migrations);
  expect(evidence.migrationLedger[0]).not.toBe(f.source.rows.__drizzle_migrations[0]);
});

it('never issues a snapshot token for unauthenticated source account records', async () => {
  const source = new Database('captured', '7000000000000000001');
  present(source.rows.user[0]).password = 'private-invalid-password';
  await expect(inspectCoreDatabase({ client: source as never, authentication: { jwtSecret }, signal: signal() })).rejects.toThrow('(authentication)');
  expect(source.query.mock.calls.some(([sql]) => sql.includes('pg_control_system()'))).toBe(false);
});

it.each([140023, 170006])('copies source accounts/auth and destination apps/recovery into only the isolated target on server %i', async (version) => {
  const f = await fixture((source, destination, target) => {
    for (const database of [source, destination, target]) database.version = version;
    const salt = 'synthetic-source-account-salt';
    const key = pbkdf2Sync(jwtSecret, salt, 100000, 32, 'sha256');
    const iv = Buffer.alloc(12, 3);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update('JBSWY3DPEHPK3PXP'), cipher.final()]);
    Object.assign(present(source.rows.user[0]), {
      totp_enabled: true,
      salt,
      totp_secret: `${iv.toString('hex')}:${encrypted.toString('hex')}:${cipher.getAuthTag().toString('hex')}`,
    });
    key.fill(0);
  });
  const sourceBefore = clone(f.source.rows);
  const destinationBefore = clone(f.destination.rows);
  const receipt = await prepareCoreCleanTarget(f.options);
  expect(receipt).toMatchObject({
    schema: 'orbis.core-clean-target-reconciliation.v1',
    targetIdentity: { database: 'clean_target', databaseOid: '16384', systemIdentifier: '7000000000000000003' },
    sourceOwnerId: 11,
    destinationOwnerId: 11,
    major: Math.floor(version / 10000),
    catalogContext: 'pg_catalog',
    environmentProved: false,
    restoreAuthority: false,
  });
  expect(f.target.rows.user).toEqual(sourceBefore.user);
  expect(f.target.rows.link).toEqual(sourceBefore.link);
  expect(f.target.rows.app).toEqual(destinationBefore.app);
  expect(f.target.rows.app_store).toEqual(destinationBefore.app_store);
  expect(f.target.rows.orbis_reset_receipt).toEqual(destinationBefore.orbis_reset_receipt);
  expect(f.target.rows.__drizzle_migrations).toEqual(sourceBefore.__drizzle_migrations);
  expect(f.source.rows).toEqual(sourceBefore);
  expect(f.destination.rows).toEqual(destinationBefore);
  expect(writes(f.source)).toEqual([]);
  expect(writes(f.destination)).toEqual([]);
  expect(f.options.authorize).toHaveBeenCalledWith(receipt);
  expect(f.options.committed).toHaveBeenCalledWith(receipt);
  const begin = f.target.query.mock.calls.findIndex(([sql]) => sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE');
  expect(f.target.query.mock.calls[0]?.[0]).toBe(contextQuery);
  expect(begin).toBeGreaterThan(0);
  expect(f.target.query.mock.calls[begin + 1]?.[0]).toBe(contextQuery);
  expect(f.target.query.mock.calls[begin + 2]?.[0]).toContain('ACCESS EXCLUSIVE');
  expect(Object.values(f.target.sequences)).toEqual([
    { value: '11', called: true },
    { value: '29', called: true },
    { value: '47', called: true },
    { value: '3', called: true },
  ]);
  expect(inserts(f.target).every(([sql]) => !sql.includes('captured') && !sql.includes('DROP TABLE'))).toBe(true);
  expect(inserts(f.target).find(([sql]) => sql.includes('"link"'))?.[1]).toContain(sourceBefore.link[0]?.title);
  expect(f.target.marker).toBe(receipt.marker);
  await expect(verifyCoreCleanTarget(f.target as never, receipt, signal())).resolves.toBe(true);
  expect(JSON.stringify(receipt)).not.toContain(jwtSecret);
  expect(JSON.stringify(receipt)).not.toContain(sourceBefore.user[0]?.totp_secret);
  expect([f.source, f.destination, f.target].flatMap((database) => database.query.mock.calls).some(([sql]) => /^SET\b|set_config/.test(sql))).toBe(
    false,
  );
});

it.each(['source-client', 'destination-client', 'source-cluster', 'destination-cluster'])(
  'rejects a target aliasing %s before writes',
  async (attack) => {
    const f = await fixture();
    if (attack === 'source-client') f.options.target = f.source as never;
    if (attack === 'destination-client') f.options.target = f.destination as never;
    if (attack === 'source-cluster') f.target.identity.system_identifier = f.source.identity.system_identifier;
    if (attack === 'destination-cluster') f.target.identity.system_identifier = f.destination.identity.system_identifier;
    await expect(prepareCoreCleanTarget(f.options)).rejects.toThrow();
    expect(f.options.authorize).not.toHaveBeenCalled();
    expect(inserts(f.target)).toEqual([]);
    expect(f.target.query.mock.calls.some(([sql]) => sql.startsWith('LOCK'))).toBe(false);
    expect(writes(f.source)).toEqual([]);
    expect(writes(f.destination)).toEqual([]);
  },
);

it.each(['source', 'destination', 'target'] as const)('refuses the wrong %s catalog context before target locks or writes', async (side) => {
  const f = await fixture();
  f[side].catalogContext = 'public, pg_catalog';
  await expect(prepareCoreCleanTarget(f.options)).rejects.toThrow('(catalog)');
  expect(writes(f.target)).toEqual([]);
  expect(f.options.authorize).not.toHaveBeenCalled();
  expect(f.target.query.mock.calls.every(([sql]) => sql === contextQuery)).toBe(true);
});

it.each(['public', 'pg_catalog, public', '"pg_catalog"', ' pg_catalog', 'PG_CATALOG', ''])(
  'requires the exact pg_catalog context rather than %j',
  async (context) => {
    const f = await fixture();
    f.target.catalogContext = context;
    await expect(prepareCoreCleanTarget(f.options)).rejects.toThrow('(catalog)');
    expect(writes(f.target)).toEqual([]);
    expect(f.options.authorize).not.toHaveBeenCalled();
  },
);

it.each(['source', 'destination', 'target'] as const)('rechecks %s context after authorization before inserting', async (side) => {
  const f = await fixture();
  f.options.authorize.mockImplementation(async () => {
    f[side].catalogContext = 'public';
  });
  await expect(prepareCoreCleanTarget(f.options)).rejects.toThrow('(catalog)');
  expect(inserts(f.target)).toEqual([]);
  expect(f.target.marker).toBeNull();
  expect(writes(f.source)).toEqual([]);
  expect(writes(f.destination)).toEqual([]);
});

it('rechecks target context immediately before locking', async () => {
  const f = await fixture();
  f.target.hook = (sql) => {
    if (sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE') f.target.catalogContext = 'public';
  };
  await expect(prepareCoreCleanTarget(f.options)).rejects.toThrow('(catalog)');
  expect(writes(f.target)).toEqual([]);
  expect(f.options.authorize).not.toHaveBeenCalled();
});

it('rejects snapshots captured in a different deparser context instead of normalizing their catalog', async () => {
  const f = await fixture((source, destination, target) => {
    for (const database of [source, destination, target]) {
      database.catalogContext = 'public';
      database.contextSensitiveCatalog = true;
    }
  });
  for (const database of [f.source, f.destination, f.target]) database.catalogContext = 'pg_catalog';
  await expect(prepareCoreCleanTarget(f.options)).rejects.toThrow('(changed)');
  expect(writes(f.target)).toEqual([]);
  expect(f.options.authorize).not.toHaveBeenCalled();
});

it('requires the fixed catalog context for interrupted-commit verification too', async () => {
  const f = await fixture();
  const prepared = await prepareCoreCleanTarget(f.options);
  f.target.catalogContext = 'public';
  const queries = f.target.query.mock.calls.length;
  const changes = writes(f.target).length;
  await expect(verifyCoreCleanTarget(f.target as never, prepared, signal())).rejects.toThrow('(catalog)');
  expect(f.target.query.mock.calls.slice(queries)).toEqual([[contextQuery]]);
  expect(writes(f.target)).toHaveLength(changes);
});

it.each(['user', 'link', 'app_store', 'app', 'orbis_reset_receipt'] as const)('rejects a nonempty target %s before approval', async (table) => {
  const f = await fixture();
  f.target.rows[table] = clone(f.source.rows[table].length ? f.source.rows[table] : f.destination.rows[table]);
  await expect(prepareCoreCleanTarget(f.options)).rejects.toThrow();
  expect(f.options.authorize).not.toHaveBeenCalled();
  expect(inserts(f.target)).toEqual([]);
});

it.each(['major', 'catalog', 'migration-ledger', 'existing-marker', 'unowned-sequence', 'unsupported-sequence'])(
  'refuses incompatible target %s without data writes',
  async (attack) => {
    const f = await fixture((source, destination, target) => {
      if (attack === 'unowned-sequence')
        for (const database of [source, destination, target]) {
          database.catalog.sequences.push({ ...present(database.catalog.sequences[0]), name: 'unowned' });
        }
      if (attack === 'unsupported-sequence')
        for (const database of [source, destination, target]) {
          present(database.catalog.sequences[0]).increment = '2';
        }
    });
    if (attack === 'major') f.target.version = 160006;
    if (attack === 'catalog') present(f.target.catalog.columns[0]).default = 'changed';
    if (attack === 'migration-ledger') present(f.target.rows.__drizzle_migrations[0]).hash = 'different migration';
    if (attack === 'existing-marker') f.target.marker = 'existing independent owner';
    await expect(prepareCoreCleanTarget(f.options)).rejects.toThrow();
    expect(f.options.authorize).not.toHaveBeenCalled();
    expect(inserts(f.target)).toEqual([]);
    expect(f.target.query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
  },
);

it.each(['source', 'destination'] as const)('rechecks changed %s before any insert after authorization', async (side) => {
  const f = await fixture();
  f.options.authorize.mockImplementation(async () => {
    present(f[side].rows.link[0]).title = 'changed after inspection';
  });
  await expect(prepareCoreCleanTarget(f.options)).rejects.toThrow('(changed)');
  expect(inserts(f.target)).toEqual([]);
  expect(f.target.marker).toBeNull();
  expect(writes(f.source)).toEqual([]);
  expect(writes(f.destination)).toEqual([]);
});

it.each(['source', 'destination'] as const)('rolls back if %s changes during target construction', async (side) => {
  const f = await fixture();
  f.target.hook = (sql) => {
    if (sql.startsWith('COMMENT ON DATABASE')) present(f[side].rows.link[0]).title = 'changed before commit';
  };
  await expect(prepareCoreCleanTarget(f.options)).rejects.toThrow('(changed)');
  expect(f.target.rows.user).toEqual([]);
  expect(f.target.marker).toBeNull();
  expect(f.options.committed).not.toHaveBeenCalled();
});

it.each(['source', 'destination', 'target'] as const)('refuses %s cluster replacement even with unchanged logical bytes', async (side) => {
  const f = await fixture();
  f.options.authorize.mockImplementation(async () => {
    f[side].identity.system_identifier = '7000000000000000099';
  });
  await expect(prepareCoreCleanTarget(f.options)).rejects.toThrow('(changed)');
  expect(inserts(f.target)).toEqual([]);
});

it.each(['owner-id', 'username', 'creation-time', 'catalog-owner'])(
  'refuses same-principal ownership mismatch %s before target mutation',
  async (attack) => {
    const f = await fixture((_source, destination) => {
      if (attack === 'username') present(destination.rows.user[0]).username = 'different-owner';
      if (attack === 'creation-time') present(destination.rows.user[0]).created_at = 1800000000;
    });
    if (attack === 'owner-id') f.options.destinationOwnerId = 12;
    if (attack === 'catalog-owner') f.options.catalogOwnerIds = [12];
    await expect(prepareCoreCleanTarget(f.options)).rejects.toThrow('(ownership)');
    expect(f.target.query.mock.calls.every(([sql]) => sql === contextQuery)).toBe(true);
  },
);

it('requires genuine authenticated opaque tokens and UUID admission identifiers', async () => {
  const f = await fixture();
  await expect(prepareCoreCleanTarget({ ...f.options, source: {} as never })).rejects.toThrow('(approval)');
  await expect(prepareCoreCleanTarget({ ...f.options, id: "'; injected" })).rejects.toThrow('(approval)');
  await expect(prepareCoreCleanTarget({ ...f.options, nonce: 'not-a-uuid' })).rejects.toThrow('(approval)');
  expect(f.target.query).not.toHaveBeenCalled();
});

it('does not write before authorization, and rolls back a refused approval', async () => {
  const f = await fixture();
  f.options.authorize.mockImplementation(async () => {
    expect(inserts(f.target)).toEqual([]);
    throw new Error('synthetic refusal');
  });
  await expect(prepareCoreCleanTarget(f.options)).rejects.toThrow('synthetic refusal');
  expect(inserts(f.target)).toEqual([]);
  expect(f.target.marker).toBeNull();
});

it.each(['rows', 'bytes'] as const)('bounds the merged target %s before locking or approval', async (limit) => {
  const f = await fixture((source) => {
    source.rows.link.push({ ...present(source.rows.link[0]), id: 30 });
  });
  const previous = { ...backupDatabaseLimits };
  if (limit === 'rows') backupDatabaseLimits.rows = 6;
  else {
    const bytes = (database: Database) => Object.values(database.rows).reduce((total, rows) => total + Buffer.byteLength(canonicalCoreJson(rows)), 0);
    backupDatabaseLimits.totalBytes = Math.max(bytes(f.source), bytes(f.destination));
  }
  try {
    await expect(prepareCoreCleanTarget(f.options)).rejects.toThrow('(records)');
    expect(f.options.authorize).not.toHaveBeenCalled();
    expect(writes(f.target)).toEqual([]);
  } finally {
    Object.assign(backupDatabaseLimits, previous);
  }
});

it.each(['rows', 'marker'] as const)('refuses target %s changed by an authorization callback before inserting', async (change) => {
  const f = await fixture();
  f.options.authorize.mockImplementation(async (prepared) => {
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.targetIdentity)).toBe(true);
    if (change === 'rows') f.target.rows.user.push(clone(present(f.source.rows.user[0])));
    else f.target.marker = 'foreign callback marker';
  });
  await expect(prepareCoreCleanTarget(f.options)).rejects.toThrow('(changed)');
  expect(inserts(f.target)).toEqual([]);
});

it('rolls back a failed insert and cannot verify a noncommitted marker', async () => {
  const f = await fixture();
  let receipt: CoreCleanTargetReconciliation | undefined;
  f.options.authorize.mockImplementation(async (prepared) => {
    receipt = prepared;
  });
  f.target.hook = (sql) => {
    if (sql.startsWith('INSERT INTO public."app"')) throw new Error('synthetic insert interruption');
  };
  await expect(prepareCoreCleanTarget(f.options)).rejects.toThrow('synthetic insert interruption');
  expect(f.target.rows.user).toEqual([]);
  expect(f.target.marker).toBeNull();
  f.target.hook = undefined;
  await expect(verifyCoreCleanTarget(f.target as never, present(receipt), signal())).rejects.toThrow('(receipt)');
  expect(f.options.committed).not.toHaveBeenCalled();
});

it('verifies an interrupted post-commit callback without replaying writes', async () => {
  const f = await fixture();
  let receipt: CoreCleanTargetReconciliation | undefined;
  f.options.authorize.mockImplementation(async (prepared) => {
    receipt = prepared;
  });
  f.options.committed.mockRejectedValue(new Error('synthetic receipt persistence interruption'));
  await expect(prepareCoreCleanTarget(f.options)).rejects.toThrow('synthetic receipt persistence interruption');
  const count = inserts(f.target).length;
  await expect(verifyCoreCleanTarget(f.target as never, present(receipt), signal())).resolves.toBe(true);
  await expect(verifyCoreCleanTarget(f.target as never, present(receipt), signal())).resolves.toBe(true);
  await expect(prepareCoreCleanTarget(f.options)).rejects.toThrow();
  expect(inserts(f.target)).toHaveLength(count);
  expect(f.options.authorize).toHaveBeenCalledTimes(1);
});

it('resolves a lost COMMIT acknowledgement using the target marker and actual rows', async () => {
  const f = await fixture();
  let receipt: CoreCleanTargetReconciliation | undefined;
  f.options.authorize.mockImplementation(async (prepared) => {
    receipt = prepared;
  });
  f.target.failCommitAfter = true;
  await expect(prepareCoreCleanTarget(f.options)).rejects.toThrow('synthetic lost commit acknowledgement');
  expect(f.options.committed).not.toHaveBeenCalled();
  await expect(verifyCoreCleanTarget(f.target as never, present(receipt), signal())).resolves.toBe(true);
});

it.each(['identity', 'oid', 'database', 'marker', 'accounts', 'apps', 'recovery', 'migrations', 'catalog', 'sequence', 'receipt', 'authority'])(
  'verifier rejects changed %s',
  async (attack) => {
    const f = await fixture();
    let prepared = await prepareCoreCleanTarget(f.options);
    if (attack === 'identity') f.target.identity.system_identifier = '7000000000000000004';
    if (attack === 'oid') f.target.identity.database_oid = '16385';
    if (attack === 'database') f.target.identity.database = 'another_database';
    if (attack === 'marker') f.target.marker = 'replaced';
    if (attack === 'accounts') present(f.target.rows.user[0]).password = password(3);
    if (attack === 'apps') present(f.target.rows.app[0]).status = 'stopped';
    if (attack === 'recovery') f.target.rows.orbis_reset_receipt = [];
    if (attack === 'migrations') present(f.target.rows.__drizzle_migrations[0]).hash = 'changed';
    if (attack === 'catalog') present(f.target.catalog.columns[0]).default = 'changed';
    if (attack === 'sequence') present(f.target.sequences.user_id_seq).value = '999';
    if (attack === 'receipt') prepared = { ...prepared, nonce: randomUUID() };
    if (attack === 'authority') prepared = { ...prepared, restoreAuthority: true } as never;
    const count = writes(f.target).length;
    await expect(verifyCoreCleanTarget(f.target as never, prepared, signal())).rejects.toThrow();
    expect(writes(f.target)).toHaveLength(count);
  },
);

it('resets empty-table sequences without manufacturing rows', async () => {
  const f = await fixture((source, destination) => {
    source.rows.link = [];
    destination.rows.app = [];
  });
  const receipt = await prepareCoreCleanTarget(f.options);
  expect(f.target.sequences.link_id_seq).toEqual({ value: '1', called: false });
  expect(f.target.sequences.app_id_seq).toEqual({ value: '1', called: false });
  await expect(verifyCoreCleanTarget(f.target as never, receipt, signal())).resolves.toBe(true);
});

it('refuses aborts before writing and never notifies committed', async () => {
  const f = await fixture();
  const controller = new AbortController();
  f.options.signal = controller.signal;
  f.options.authorize.mockImplementation(async () => {
    controller.abort();
  });
  await expect(prepareCoreCleanTarget(f.options)).rejects.toThrow();
  expect(inserts(f.target)).toEqual([]);
  expect(f.options.committed).not.toHaveBeenCalled();
});

async function legacyFixture(change?: (database: Database) => void) {
  const f = await fixture((source, destination, target) => {
    for (const database of [source, destination, target]) {
      database.orphanTables.add('app');
      const column = present(database.catalog.columns.find((row) => row.schema === 'public' && row.table === 'app' && row.name === 'id'));
      column.default = "nextval('public.app_id_seq'::regclass)";
      const sequence = present(database.catalog.sequences.find((row) => row.name === 'app_id_seq'));
      sequence.type = 'bigint';
      sequence.max = '9223372036854775807';
      change?.(database);
    }
  });
  const sequencePolicy: CoreCleanTargetSequencePolicy = {
    schema: 'orbis.core-clean-target-sequence-policy.v2',
    sourceControllerImageId: `sha256:${'a'.repeat(64)}`,
    catalogSha256: f.sourceSummary.catalogSha256,
  };
  return { ...f, sequencePolicy };
}

it.each([140023, 170006])(
  'v2 associates only the approved legacy app sequence without changing ownership or either input on server %i',
  async (version) => {
    const f = await legacyFixture((database) => {
      database.version = version;
    });
    const prepared = await prepareCoreCleanTarget({ ...f.options, sequencePolicy: f.sequencePolicy });
    expect(prepared.schema).toBe('orbis.core-clean-target-reconciliation.v2');
    expect(prepared.marker).toMatch(/^orbis\.core-clean-target\.v2\//);
    expect(prepared).toMatchObject({
      sequencePolicy: f.sequencePolicy,
      major: Math.floor(version / 10000),
      environmentProved: false,
      restoreAuthority: false,
    });
    expect(f.target.sequences.app_id_seq).toEqual({ value: '47', called: true });
    await expect(verifyCoreCleanTarget(f.target as never, prepared, signal())).resolves.toBe(true);
    expect(writes(f.source)).toEqual([]);
    expect(writes(f.destination)).toEqual([]);
    expect([f.source, f.destination, f.target].flatMap((database) => database.query.mock.calls).some(([sql]) => sql.startsWith('ALTER'))).toBe(false);
    expect(f.target.orphanTables.has('app')).toBe(true);
  },
);

it.each(['source', 'destination', 'target'] as const)('v2 refuses mixed PostgreSQL14/17 %s before copying data', async (side) => {
  const f = await legacyFixture((database) => {
    database.version =
      database.identity.database === ({ source: 'captured', destination: 'destination', target: 'clean_target' } as const)[side] ? 170006 : 140023;
  });
  await expect(prepareCoreCleanTarget({ ...f.options, sequencePolicy: f.sequencePolicy })).rejects.toThrow('(major)');
  expect(inserts(f.target)).toEqual([]);
  expect(f.target.marker).toBeNull();
  expect(f.options.authorize).not.toHaveBeenCalled();
  expect(f.options.committed).not.toHaveBeenCalled();
  expect(writes(f.source)).toEqual([]);
  expect(writes(f.destination)).toEqual([]);
});

it('v1 still refuses the same orphan rather than inferring permission from its observed catalog', async () => {
  const f = await legacyFixture();
  await expect(prepareCoreCleanTarget(f.options)).rejects.toThrow('(catalog)');
  expect(inserts(f.target)).toEqual([]);
  expect(f.options.authorize).not.toHaveBeenCalled();
});

it.each(['catalog', 'image', 'schema', 'extra'])('requires exact Root sequence policy %s before granting the exception', async (field) => {
  const f = await legacyFixture();
  const policy: Record<string, unknown> = { ...f.sequencePolicy };
  policy[field === 'catalog' ? 'catalogSha256' : field === 'image' ? 'sourceControllerImageId' : field] =
    field === 'catalog' ? 'f'.repeat(64) : 'invalid';
  await expect(prepareCoreCleanTarget({ ...f.options, sequencePolicy: policy as CoreCleanTargetSequencePolicy })).rejects.toThrow();
  expect(inserts(f.target)).toEqual([]);
  expect(f.options.authorize).not.toHaveBeenCalled();
});

it.each(['default', 'type', 'maximum', 'cache', 'second-dependent', 'wrong-dependent', 'owned-elsewhere', 'other-orphan'])(
  'v2 refuses ambiguous legacy sequence %s even when all three catalog hashes match the supplied policy',
  async (attack) => {
    const f = await legacyFixture((database) => {
      if (attack === 'default')
        present(database.catalog.columns.find((row) => row.table === 'app' && row.name === 'id')).default = "nextval('app_id_seq'::regclass)";
      if (attack === 'type') present(database.catalog.columns.find((row) => row.table === 'app' && row.name === 'id')).type = 'int8';
      if (attack === 'maximum') present(database.catalog.sequences.find((row) => row.name === 'app_id_seq')).max = '2147483647';
      if (attack === 'cache') present(database.catalog.sequences.find((row) => row.name === 'app_id_seq')).cache = '2';
      if (attack === 'second-dependent')
        database.appReferences.push({ schema: 'public', table: 'user', column: 'id', expression: "nextval('public.app_id_seq'::regclass)" });
      if (attack === 'wrong-dependent') present(database.appReferences[0]).table = 'user';
      if (attack === 'owned-elsewhere') database.appOwnedElsewhere = true;
      if (attack === 'other-orphan') database.orphanTables.add('link');
    });
    await expect(prepareCoreCleanTarget({ ...f.options, sequencePolicy: f.sequencePolicy })).rejects.toThrow('(catalog)');
    expect(inserts(f.target)).toEqual([]);
  },
);

it('v2 rechecks actual default dependency after approval before inserting', async () => {
  const f = await legacyFixture();
  f.options.authorize.mockImplementation(async () => {
    f.destination.appReferences.push({ schema: 'public', table: 'user', column: 'id', expression: "nextval('public.app_id_seq'::regclass)" });
  });
  await expect(prepareCoreCleanTarget({ ...f.options, sequencePolicy: f.sequencePolicy })).rejects.toThrow('(catalog)');
  expect(inserts(f.target)).toEqual([]);
});

it.each(['policy', 'marker', 'association'])('v2 verification refuses changed %s', async (attack) => {
  const f = await legacyFixture();
  let prepared = await prepareCoreCleanTarget({ ...f.options, sequencePolicy: f.sequencePolicy });
  if (prepared.schema !== 'orbis.core-clean-target-reconciliation.v2') throw new Error('fixture receipt version');
  if (attack === 'policy')
    prepared = { ...prepared, sequencePolicy: { ...prepared.sequencePolicy, sourceControllerImageId: `sha256:${'b'.repeat(64)}` } };
  if (attack === 'marker') prepared = { ...prepared, marker: prepared.marker.replace('.v2/', '.v1/') };
  if (attack === 'association')
    f.target.appReferences.push({ schema: 'public', table: 'link', column: 'id', expression: "nextval('public.app_id_seq'::regclass)" });
  await expect(verifyCoreCleanTarget(f.target as never, prepared, signal())).rejects.toThrow();
});

async function importedFixture(setup?: (source: Database, destination: Database, target: Database) => void) {
  const f = await fixture(setup);
  const prepared = await prepareCoreCleanTarget(f.options);
  const id = randomUUID();
  const nonce = randomUUID();
  const stageSha256 = 'f'.repeat(64);
  const imported = new Database(`orbis_restore_${id.replaceAll('-', '')}`, f.destination.identity.system_identifier);
  imported.identity.database_oid = '26400';
  imported.rows = clone(f.target.rows);
  imported.catalog = clone(f.target.catalog);
  imported.sequences = clone(f.target.sequences);
  imported.marker = `orbis.core-derived-logical.v1/${id}/${nonce}/${stageSha256}`;
  const binding: CoreImportedDatabaseBinding = {
    schema: 'orbis.core-imported-database-binding.v1',
    id,
    nonce,
    stageSha256,
    dumpSha256: 'e'.repeat(64),
    preparedSha256: createHash('sha256').update(canonicalCoreJson(prepared)).digest('hex'),
    database: {
      systemIdentifier: imported.identity.system_identifier,
      databaseOid: imported.identity.database_oid,
      database: imported.identity.database,
      owner: imported.owner,
      marker: imported.marker,
    },
  };
  const verify = vi.fn(async (_binding: CoreImportedDatabaseBinding) => {});
  const options = { client: imported as never, prepared, binding, authentication: { jwtSecret }, signal: signal(), verify };
  return { ...f, imported, prepared, binding, options, verify };
}

it('verifies a genuine logical import under its new current-server identity without changing either database', async () => {
  const f = await importedFixture();
  f.target.query.mockClear();
  f.imported.query.mockClear();
  const result = await verifyCoreImportedDatabase(f.options);
  expect(result).toEqual({
    schema: 'orbis.core-imported-database-verification.v1',
    id: f.binding.id,
    nonce: f.binding.nonce,
    stageSha256: f.binding.stageSha256,
    dumpSha256: f.binding.dumpSha256,
    preparedSha256: f.binding.preparedSha256,
    database: f.binding.database,
    logicalTargetVerified: true,
    environmentProved: false,
    restoreAuthority: false,
    activation: false,
  });
  expect(result.database.systemIdentifier).not.toBe(f.prepared.targetIdentity.systemIdentifier);
  expect(f.verify).toHaveBeenCalledTimes(2);
  expect(writes(f.imported)).toEqual([]);
  expect(f.target.query).not.toHaveBeenCalled();
  expect(f.imported.transaction).toBeUndefined();
});

it('verifies a compacted logical import after migrations dropped physical column slots', async () => {
  const f = await importedFixture((...databases) => {
    databases.forEach((database, index) => {
      for (const column of database.catalog.columns) column.position = (column.position as number) * (index + 2) + index;
    });
  });
  const positions = new Map<string, number>();
  for (const column of f.imported.catalog.columns) {
    const key = `${column.schema}.${column.table}`;
    const position = (positions.get(key) ?? 0) + 1;
    positions.set(key, position);
    column.position = position;
  }
  expect(f.imported.catalog.columns).not.toEqual(f.target.catalog.columns);
  await expect(verifyCoreImportedDatabase(f.options)).resolves.toMatchObject({ logicalTargetVerified: true, activation: false });
  expect(writes(f.imported)).toEqual([]);
});

it('still refuses a changed live column order after physical slots are compacted', async () => {
  const f = await importedFixture();
  const columns = f.imported.catalog.columns.filter((column) => column.schema === 'public' && column.table === 'user');
  const first = present(columns[0]);
  const second = present(columns[1]);
  [first.name, second.name] = [second.name, first.name];
  await expect(verifyCoreImportedDatabase(f.options)).rejects.toThrow();
  expect(writes(f.imported)).toEqual([]);
});

it.each([0, -1, 1.5, 32768, 1])('refuses an invalid or repeated physical column position %s', async (position) => {
  const f = await importedFixture();
  const columns = f.imported.catalog.columns.filter((column) => column.schema === 'public' && column.table === 'user');
  present(columns[1]).position = position;
  await expect(verifyCoreImportedDatabase(f.options)).rejects.toThrow('(catalog)');
  expect(writes(f.imported)).toEqual([]);
});

it.each(['accounts', 'apps', 'recovery', 'catalog', 'sequence', 'marker', 'database', 'owner', 'authentication'] as const)(
  'refuses changed logical-import %s without granting activation',
  async (attack) => {
    const f = await importedFixture();
    if (attack === 'accounts') present(f.imported.rows.user[0]).password = password(3);
    if (attack === 'apps') present(f.imported.rows.app[0]).status = 'stopped';
    if (attack === 'recovery') f.imported.rows.orbis_reset_receipt = [];
    if (attack === 'catalog') f.imported.catalog.columns = [];
    if (attack === 'sequence') present(f.imported.sequences.user_id_seq).value = '999';
    if (attack === 'marker') f.imported.marker = f.prepared.marker;
    if (attack === 'database') f.imported.identity.database_oid = '26401';
    if (attack === 'owner') f.imported.owner = 'someone_else';
    if (attack === 'authentication') f.options.authentication = { jwtSecret: 'unrelated candidate key' };
    f.imported.query.mockClear();
    await expect(verifyCoreImportedDatabase(f.options)).rejects.toThrow();
    expect(writes(f.imported)).toEqual([]);
    expect(f.imported.transaction).toBeUndefined();
  },
);

it('requires the unchanged Root stage binding before and after imported SQL verification', async () => {
  const f = await importedFixture();
  let calls = 0;
  f.verify.mockImplementation(async () => {
    if (++calls === 2) throw new Error('Root stage changed');
  });
  await expect(verifyCoreImportedDatabase(f.options)).rejects.toThrow('Root stage changed');
  expect(f.imported.transaction).toBeUndefined();
  expect(writes(f.imported)).toEqual([]);
});

it.each(['stageSha256', 'dumpSha256', 'preparedSha256', 'database', 'id', 'nonce', 'schema'] as const)(
  'rejects a malformed import %s before issuing SQL',
  async (field) => {
    const f = await importedFixture();
    f.imported.query.mockClear();
    await expect(
      verifyCoreImportedDatabase({ ...f.options, binding: { ...f.binding, [field]: null } as unknown as CoreImportedDatabaseBinding }),
    ).rejects.toThrow();
    expect(f.imported.query).not.toHaveBeenCalled();
  },
);
