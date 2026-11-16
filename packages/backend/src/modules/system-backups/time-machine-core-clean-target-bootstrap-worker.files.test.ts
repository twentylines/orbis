import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { inspectCoreDatabaseStructure } from './time-machine-core-database';
import {
  bootstrapCoreCleanTarget,
  coreCleanTargetBootstrapFailureDiagnostic,
  coreCleanTargetBootstrapWorkerCapability,
  coreCleanTargetBootstrapWorkerCapabilityV2,
} from './time-machine-core-clean-target-bootstrap-worker';
import { canonicalCoreJson } from './time-machine-core-payload';

type Row = Record<string, unknown>;
type FakeClient = { config: Row; ended: number; query: (sql: string, values?: unknown[]) => Promise<{ rows: Row[]; rowCount?: number }> };
const state = vi.hoisted(() => ({
  client: undefined as FakeClient | undefined,
  actualTarget: {} as Row,
  major: 17,
  serverVersion: '170006',
  objects: false,
  extensions: [{ name: 'plpgsql' }],
  context: 'pg_catalog',
  clocks: ['2000000000', '2000000000'],
  clockIndex: 0,
  seedRows: [] as Row[],
  seedOverride: undefined as Row[] | undefined,
  ledger: [] as Row[],
  otherCount: '0',
  transaction: undefined as { seed: Row[]; ledger: Row[] } | undefined,
  transactionPhase: 'ledger',
  commitErrorPhase: 'sanitation',
  sequenceValue: '1',
  sequenceCalled: true,
  ledgerUpdates: [] as unknown[][],
  updateCount: 1,
  migrated: false,
  ddl: 0,
  deletes: 0,
  rollback: 0,
  deleteCount: 1,
  queries: [] as string[],
  migrateHook: undefined as (() => Promise<void>) | undefined,
  afterMigration: undefined as (() => void) | undefined,
  beforeDelete: undefined as ((values: unknown[]) => Promise<void>) | undefined,
  migrationError: undefined as unknown,
  commitError: undefined as unknown,
  connectError: undefined as unknown,
  catalog: 'c'.repeat(64),
}));
vi.mock('pg', async (original) => ({
  ...(await original<typeof import('pg')>()),
  Client: class {
    config: Row;
    ended = 0;
    constructor(config: Row) {
      this.config = config;
      state.client = this;
    }
    on() {
      return this;
    }
    async connect() {
      if (state.connectError) throw state.connectError;
    }
    async end() {
      this.ended += 1;
    }
    async query(sql: string, values: unknown[] = []) {
      state.queries.push(sql);
      if (sql === 'SHOW server_version_num') return { rows: [{ server_version_num: state.serverVersion }] };
      if (sql.includes('pg_control_system()')) {
        const row: Row = { ...state.actualTarget, search_path: state.context, read_only: 'off' };
        if (!sql.includes('datlocprovider')) delete row.provider;
        return { rows: [row] };
      }
      if (sql.includes('FROM pg_catalog.pg_database d WHERE')) {
        const row: Row = {
          database: state.actualTarget.database,
          encoding: state.actualTarget.encoding,
          collate: state.actualTarget.collate,
          ctype: state.actualTarget.ctype,
        };
        if (sql.includes('datlocprovider')) row.provider = state.actualTarget.provider;
        return { rows: [row] };
      }
      if (sql.startsWith('SELECT 1 FROM pg_catalog.pg_class')) return { rows: state.objects ? [{ present: 1 }] : [] };
      if (sql.startsWith('SELECT extname AS name')) return { rows: structuredClone(state.extensions) };
      if (sql.startsWith('SELECT pg_catalog.floor')) return { rows: [{ seconds: state.clocks[state.clockIndex++] }] };
      if (sql === 'SET search_path TO public') {
        state.context = 'public';
        return { rows: [] };
      }
      if (sql === 'SET search_path TO pg_catalog') {
        state.context = 'pg_catalog';
        return { rows: [] };
      }
      if (sql === 'CREATE SCHEMA fixture_migration_ddl') {
        state.ddl += 1;
        return { rows: [] };
      }
      if (sql.startsWith('SELECT * FROM drizzle.__drizzle_migrations')) return { rows: structuredClone(state.ledger) };
      if (sql.startsWith('SELECT count(*)::text AS count'))
        return { rows: [{ count: sql.includes('"app_store"') ? String(state.seedRows.length) : state.otherCount }] };
      if (sql === 'SELECT * FROM public.app_store LIMIT 2') return { rows: structuredClone(state.seedRows.slice(0, 2)) };
      if (sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE') {
        state.transaction = { seed: structuredClone(state.seedRows), ledger: structuredClone(state.ledger) };
        return { rows: [] };
      }
      if (sql.startsWith('LOCK TABLE')) {
        state.transactionPhase = sql.includes('public.') ? 'sanitation' : 'ledger';
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE drizzle.__drizzle_migrations SET id=$1')) {
        state.ledgerUpdates.push(values);
        const row = state.ledger.find((row) => row.id === values[1] && row.hash === values[2] && row.created_at === values[3]);
        if (row && state.updateCount === 1) row.id = values[0];
        return { rows: [], rowCount: row ? state.updateCount : 0 };
      }
      if (sql.startsWith('SELECT pg_catalog.pg_get_serial_sequence')) return { rows: [{ sequence: 'drizzle.__drizzle_migrations_id_seq' }] };
      if (sql.startsWith('SELECT pg_catalog.setval')) {
        expect(values[0]).toBe('drizzle.__drizzle_migrations_id_seq');
        state.sequenceValue = String(values[1]);
        state.sequenceCalled = true;
        return { rows: [] };
      }
      if (sql.startsWith('SELECT last_value::text AS value')) return { rows: [{ value: state.sequenceValue, called: state.sequenceCalled }] };
      if (sql.startsWith('DELETE FROM public.app_store WHERE')) {
        await state.beforeDelete?.(values);
        state.deletes += 1;
        expect(values).toEqual([
          'migrated',
          'migrated',
          'migrated',
          true,
          'migrated',
          'main',
          state.seedRows[0]?.created_at,
          state.seedRows[0]?.updated_at,
        ]);
        if (state.deleteCount === 1) state.seedRows = [];
        return { rows: [], rowCount: state.deleteCount };
      }
      if (sql === 'COMMIT') {
        state.transaction = undefined;
        if (state.commitError && state.transactionPhase === state.commitErrorPhase) throw state.commitError;
        return { rows: [] };
      }
      if (sql === 'ROLLBACK') {
        state.rollback += 1;
        if (state.transaction) {
          state.seedRows = state.transaction.seed;
          state.ledger = state.transaction.ledger;
        }
        state.transaction = undefined;
        return { rows: [] };
      }
      throw new Error('Unexpected fixture SQL category');
    }
  },
}));
vi.mock('drizzle-orm/node-postgres', () => ({ drizzle: (client: FakeClient) => ({ client }) }));
vi.mock('drizzle-orm/node-postgres/migrator', () => ({
  migrate: vi.fn(async (db: { client: FakeClient }, config: { migrationsFolder: string }) => {
    await state.migrateHook?.();
    const migrations = readMigrationFiles(config);
    await db.client.query('CREATE SCHEMA fixture_migration_ddl');
    if (state.migrationError) throw state.migrationError;
    state.ledger = migrations.map((migration, index) => ({ id: index + 1, hash: migration.hash, created_at: String(migration.folderMillis) }));
    state.sequenceValue = String(migrations.length);
    state.sequenceCalled = true;
    state.seedRows = structuredClone(
      state.seedOverride ?? [
        {
          slug: 'migrated',
          hash: 'migrated',
          name: 'migrated',
          enabled: true,
          url: 'migrated',
          branch: 'main',
          created_at: 2000000000,
          updated_at: 2000000000,
        },
      ],
    );
    state.migrated = true;
    state.afterMigration?.();
  }),
}));
vi.mock('./time-machine-core-database', () => ({ inspectCoreDatabaseStructure: vi.fn() }));
const sha = (body: string | Buffer) => createHash('sha256').update(body).digest('hex');
const digest = (value: unknown) => sha(canonicalCoreJson(value));
const policy = 'orbis.core-clean-target-migrated-seed.v1';
const target = () => ({
  systemIdentifier: '7000000000000000003',
  databaseOid: '16384',
  database: 'clean_target',
  role: 'clean_role',
  locale: { encoding: 'UTF8', collate: 'C.UTF-8', ctype: 'C.UTF-8', provider: 'c' },
});
let root: string;
let input: string;
let output: string;
let migrations: string;
let inventory: { schema: string; files: Record<string, { bytes: number; sha256: string }> };
type LedgerRow = { id: number; hash: string; created_at: string };
let expectedLedger: LedgerRow[];
const ledgerDigest = (rows: LedgerRow[]) => digest([...rows].sort((a, b) => canonicalCoreJson(a).localeCompare(canonicalCoreJson(b), 'en')));
const request = () => ({
  schema: 'orbis.core-clean-target-bootstrap-input.v1',
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  nonce: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  rootIntentSha256: '1'.repeat(64),
  target: target(),
  sourceControllerImageId: `sha256:${'2'.repeat(64)}`,
  migrationInventorySha256: digest(inventory),
  expectedCatalogSha256: 'c'.repeat(64),
  expectedMigrationLedgerSha256: ledgerDigest(expectedLedger),
  expectedMigrationLedger: structuredClone(expectedLedger),
  migrationLedgerPolicy: 'orbis.core-clean-target-migration-ledger.v1',
  sanitationPolicy: policy,
  scope: 'bootstrap-clean-target-only',
  activation: false,
  environmentProved: false,
  restoreAuthority: false,
});
type Request = ReturnType<typeof request>;
const authorization = (r: Request) => ({
  ...r,
  schema: 'orbis.core-clean-target-bootstrap-authorization.v1',
  decision: 'approved',
  requestSha256: digest(r),
});
const options = () => ({ input, output, migrations, signal: new AbortController().signal });
async function write(directory: string, name: string, body: string) {
  const file = path.join(directory, name);
  await fs.chmod(file, 0o600).catch(() => undefined);
  await fs.writeFile(file, body, { mode: 0o600 });
  await fs.chmod(file, 0o400);
}
async function setRequest(r: Request = request()) {
  await write(input, 'request.json', canonicalCoreJson(r));
  await write(input, 'authorization.json', canonicalCoreJson(authorization(r)));
}
async function setupMigrations(files: Record<string, string>) {
  inventory = { schema: 'orbis.core-executable-migration-inventory.v1', files: {} };
  for (const [name, body] of Object.entries(files)) {
    await write(migrations, name, body);
    inventory.files[name] = { bytes: Buffer.byteLength(body), sha256: sha(body) };
  }
  const journal = JSON.parse(files['meta/_journal.json'] ?? '{}') as { entries: { when: number; tag: string }[] };
  expectedLedger = journal.entries.map((entry, index) => ({
    id: index + 1,
    hash: sha(files[`${entry.tag}.sql`] ?? ''),
    created_at: String(entry.when),
  }));
  await write(input, 'migration-inventory.json', canonicalCoreJson(inventory));
  await setRequest();
}
async function names() {
  return (await fs.readdir(output)).sort();
}
async function result(name: string) {
  return JSON.parse(await fs.readFile(path.join(output, name), 'utf8'));
}
beforeEach(async () => {
  vi.clearAllMocks();
  state.client = undefined;
  state.major = 17;
  state.serverVersion = '170006';
  state.objects = false;
  state.extensions = [{ name: 'plpgsql' }];
  state.context = 'pg_catalog';
  state.clocks = ['2000000000', '2000000000'];
  state.clockIndex = 0;
  state.seedRows = [];
  state.seedOverride = undefined;
  state.ledger = [];
  state.otherCount = '0';
  state.transaction = undefined;
  state.migrated = false;
  state.ddl = 0;
  state.deletes = 0;
  state.rollback = 0;
  state.deleteCount = 1;
  state.transactionPhase = 'ledger';
  state.commitErrorPhase = 'sanitation';
  state.sequenceValue = '1';
  state.sequenceCalled = true;
  state.ledgerUpdates = [];
  state.updateCount = 1;
  state.queries = [];
  state.migrateHook = undefined;
  state.afterMigration = undefined;
  state.beforeDelete = undefined;
  state.migrationError = undefined;
  state.commitError = undefined;
  state.connectError = undefined;
  state.catalog = 'c'.repeat(64);
  const t = target();
  state.actualTarget = {
    system_identifier: t.systemIdentifier,
    database_oid: t.databaseOid,
    database: t.database,
    current_user: t.role,
    session_user: t.role,
    ...t.locale,
  };
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'core-clean-target-bootstrap-')));
  input = path.join(root, 'input');
  output = path.join(root, 'output');
  migrations = path.join(root, 'migrations');
  for (const directory of [input, output, migrations, path.join(migrations, 'meta')]) await fs.mkdir(directory, { mode: 0o700 });
  const journal = {
    version: '7',
    dialect: 'postgresql',
    entries: [{ idx: 0, version: '7', when: 1700000000000, tag: '0000_fixture', breakpoints: true }],
  };
  await setupMigrations({
    'meta/_journal.json': JSON.stringify(journal, null, 2),
    '0000_fixture.sql': 'CREATE TABLE public.fixture(id integer);\n--> statement-breakpoint\nALTER TABLE public.fixture ADD value text;',
  });
  vi.mocked(inspectCoreDatabaseStructure).mockImplementation(async () => ({
    schema: 'orbis.core-database-structure.v1',
    sha256: 'a'.repeat(64),
    major: state.major,
    catalogSha256: state.catalog,
    authenticationVerified: false,
    restoreAuthority: false,
    rows: {
      user: Number(state.otherCount),
      link: Number(state.otherCount),
      app: Number(state.otherCount),
      app_store: state.seedRows.length,
      orbis_reset_receipt: Number(state.otherCount),
      __drizzle_migrations: state.ledger.length,
    },
  }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of [input, migrations, path.join(migrations, 'meta')]) await fs.chmod(directory, 0o700).catch(() => undefined);
  await fs.rm(root, { recursive: true, force: true });
});

it('runs installed migration parsing only after a durable Root-bound intent, then removes only the approved exact seed', async () => {
  state.migrateHook = async () => {
    expect(state.ddl).toBe(0);
    expect(state.queries.filter((sql) => sql.startsWith('SELECT 1 FROM pg_catalog.pg_class'))).toHaveLength(2);
    expect(await names()).toEqual(['migration-intent.json', 'worker-start.json']);
    expect(await result('migration-intent.json')).toMatchObject({
      sanitationPolicy: policy,
      target: target(),
      sourceControllerImageId: request().sourceControllerImageId,
      migrationInventorySha256: request().migrationInventorySha256,
      rootIntentSha256: request().rootIntentSha256,
      serverBeforeSeconds: 2000000000,
    });
  };
  state.beforeDelete = async () => {
    expect(await names()).toEqual([
      'ledger-intent.json',
      'migration-completion.json',
      'migration-intent.json',
      'sanitation-intent.json',
      'worker-start.json',
    ]);
    expect(await result('sanitation-intent.json')).toMatchObject({ seedSha256: digest(state.seedRows[0]), sanitationPolicy: policy });
  };
  const report = await bootstrapCoreCleanTarget(options());
  expect(report).toMatchObject({
    schema: 'orbis.core-clean-target-bootstrap-result.v1',
    applicationTablesEmpty: true,
    sanitationCommitAcknowledged: true,
    sanitationPolicy: policy,
    activation: false,
    environmentProved: false,
    restoreAuthority: false,
    serverQuiescenceProved: false,
  });
  expect(state.seedRows).toEqual([]);
  expect(state.ledger).toEqual(expectedLedger);
  expect(state.ddl).toBe(1);
  expect(state.deletes).toBe(1);
  expect(state.client?.ended).toBe(1);
  expect(state.queries.indexOf('SET search_path TO public')).toBeLessThan(state.queries.indexOf('CREATE SCHEMA fixture_migration_ddl'));
  expect(state.context).toBe('pg_catalog');
  expect(state.queries.find((sql) => sql.startsWith('DELETE'))).toBe(
    'DELETE FROM public.app_store WHERE "slug"=$1 AND "hash"=$2 AND "name"=$3 AND "enabled"=$4 AND "url"=$5 AND "branch"=$6 AND "created_at"=$7 AND "updated_at"=$8',
  );
  for (const name of await names()) {
    expect((await fs.stat(path.join(output, name))).mode & 0o777).toBe(0o400);
    expect(await fs.readFile(path.join(output, name), 'utf8')).toBe(canonicalCoreJson(await result(name)));
  }
  expect(coreCleanTargetBootstrapWorkerCapability).toMatchObject({
    uid: 0,
    socket: '/clean-target-target-socket',
    localeProvider: 'c',
    sanitationPolicy: policy,
  });
  expect(state.client?.config).toMatchObject({
    host: '/clean-target-target-socket',
    password: '',
    port: 5432,
    ssl: false,
    statement_timeout: 15000,
    query_timeout: 20000,
    connectionTimeoutMillis: 10000,
  });
});

it('accepts the actual current executable asset/journal dialect without changing its bytes', async () => {
  for (const name of Object.keys(inventory.files)) await fs.unlink(path.join(migrations, name));
  const source = path.resolve('src/core/database/drizzle');
  const sourceNames = (await fs.readdir(source)).filter((name) => /^[0-9]{4}_.*\.sql$/.test(name));
  const files: Record<string, string> = { 'meta/_journal.json': await fs.readFile(path.join(source, 'meta/_journal.json'), 'utf8') };
  for (const name of sourceNames) files[name] = await fs.readFile(path.join(source, name), 'utf8');
  await setupMigrations(files);
  await bootstrapCoreCleanTarget(options());
  expect(state.ledger).toEqual(expectedLedger);
  expect(state.ledger.length).toBeGreaterThan(30);
}, 30_000); // Cold reads of the real migration tree can exceed Vitest's five-second default.

async function gappedLedgerFixture() {
  const journal = {
    version: '7',
    dialect: 'postgresql',
    entries: [
      { idx: 0, version: '7', when: 1700000000000, tag: '0000_fixture', breakpoints: true },
      { idx: 1, version: '7', when: 1700000001000, tag: '0001_fixture', breakpoints: true },
    ],
  };
  await setupMigrations({ 'meta/_journal.json': JSON.stringify(journal), '0000_fixture.sql': 'SELECT 1;', '0001_fixture.sql': 'SELECT 2;' });
  const first = expectedLedger[0];
  const second = expectedLedger[1];
  if (!first || !second) throw new Error('fixture ledger absent');
  first.id = 3;
  second.id = 9;
  await setRequest();
}

it('rebinds only legitimate captured ledger IDs in descending order and verifies the owned sequence', async () => {
  await gappedLedgerFixture();
  const report = await bootstrapCoreCleanTarget(options());
  expect(state.ledger).toEqual(expectedLedger);
  expect(state.ledgerUpdates.map((values) => values.slice(0, 2))).toEqual([
    [9, 2],
    [3, 1],
  ]);
  expect(state.ledgerUpdates.map((values) => values.slice(2))).toEqual(
    [expectedLedger[1], expectedLedger[0]].map((row) => [row?.hash, row?.created_at]),
  );
  expect(state.sequenceValue).toBe('9');
  expect(state.sequenceCalled).toBe(true);
  expect(report).toMatchObject({
    migrationLedgerPolicy: 'orbis.core-clean-target-migration-ledger.v1',
    expectedMigrationLedgerSha256: ledgerDigest(expectedLedger),
  });
  expect(await result('ledger-intent.json')).toMatchObject({ migrationLedgerPolicy: 'orbis.core-clean-target-migration-ledger.v1', ledgerRows: 2 });
});

it.each(['zero', 'negative', 'duplicate', 'extra', 'hash', 'timestamp', 'missing', 'policy'])(
  'refuses unsupported expected ledger %s before DDL',
  async (attack) => {
    await gappedLedgerFixture();
    const r = request();
    const first = r.expectedMigrationLedger[0];
    const second = r.expectedMigrationLedger[1];
    if (!first || !second) throw new Error('fixture ledger absent');
    if (attack === 'zero') first.id = 0;
    if (attack === 'negative') first.id = -1;
    if (attack === 'duplicate') second.id = first.id;
    if (attack === 'extra') Object.assign(first, { extra: true });
    if (attack === 'hash') first.hash = 'f'.repeat(64);
    if (attack === 'timestamp') first.created_at = '1700000009999';
    if (attack === 'missing') r.expectedMigrationLedger.pop();
    if (attack === 'policy') r.migrationLedgerPolicy = 'unapproved';
    r.expectedMigrationLedgerSha256 = ledgerDigest(r.expectedMigrationLedger);
    await setRequest(r);
    await expect(bootstrapCoreCleanTarget(options())).rejects.toThrow();
    expect(state.ddl).toBe(0);
    expect(state.ledgerUpdates).toEqual([]);
  },
);

it.each(['hash', 'created_at', 'id'])('refuses changed generated Drizzle ledger %s instead of relabeling its graph', async (field) => {
  state.afterMigration = () => {
    const row = state.ledger[0];
    if (!row) throw new Error('fixture ledger absent');
    row[field] = 'changed';
  };
  await expect(bootstrapCoreCleanTarget(options())).rejects.toThrow();
  expect(state.ledgerUpdates).toEqual([]);
  expect(state.deletes).toBe(0);
});

it('rolls ledger updates back on an exact-row mismatch and retains their intent', async () => {
  await gappedLedgerFixture();
  state.updateCount = 0;
  await expect(bootstrapCoreCleanTarget(options())).rejects.toThrow();
  expect(state.ledger.map((row) => row.id)).toEqual([1, 2]);
  expect(state.rollback).toBe(1);
  expect(state.deletes).toBe(0);
  expect(await names()).toContain('ledger-intent.json');
  expect(await names()).not.toContain('result.json');
});

it('retains an uncertain ledger commit without rerunning migrations or sanitizing', async () => {
  await gappedLedgerFixture();
  state.commitError = Object.assign(new Error('synthetic lost ledger acknowledgement'), { code: 'ECONNRESET' });
  state.commitErrorPhase = 'ledger';
  await expect(bootstrapCoreCleanTarget(options())).rejects.toThrow();
  expect(state.ledger).toEqual(expectedLedger);
  expect(state.deletes).toBe(0);
  expect(await names()).toContain('ledger-intent.json');
  expect(await names()).not.toContain('result.json');
});

it.each([
  'missing',
  'decision',
  'requestSha256',
  'rootIntentSha256',
  'target',
  'sourceControllerImageId',
  'migrationInventorySha256',
  'expectedCatalogSha256',
  'expectedMigrationLedgerSha256',
  'sanitationPolicy',
  'scope',
  'activation',
  'extra',
])('refuses separate authorization %s before connecting', async (field) => {
  if (field === 'missing') await fs.unlink(path.join(input, 'authorization.json'));
  else {
    const value: Row = authorization(request());
    value[field] = 'unapproved';
    await write(input, 'authorization.json', canonicalCoreJson(value));
  }
  await expect(bootstrapCoreCleanTarget(options())).rejects.toThrow('Core clean target bootstrap failed.');
  expect(state.client).toBeUndefined();
  expect(await names()).toEqual([]);
});

it.each([
  'id',
  'nonce',
  'sourceControllerImageId',
  'rootIntentSha256',
  'migrationInventorySha256',
  'expectedCatalogSha256',
  'expectedMigrationLedgerSha256',
  'sanitationPolicy',
  'extra',
])('rejects malformed request %s', async (field) => {
  const r: Row = request();
  r[field] = 'invalid';
  await write(input, 'request.json', canonicalCoreJson(r));
  await expect(bootstrapCoreCleanTarget(options())).rejects.toThrow();
  expect(state.ddl).toBe(0);
});

it.each(['encoding', 'collate', 'ctype', 'provider', 'system_identifier', 'database_oid', 'database', 'current_user', 'session_user'])(
  'refuses actual target %s mismatch before any DDL',
  async (field) => {
    state.actualTarget[field] = 'different';
    await expect(bootstrapCoreCleanTarget(options())).rejects.toThrow();
    expect(state.ddl).toBe(0);
    expect(await names()).toEqual(['worker-start.json']);
  },
);

it.each(['provider', 'encoding'])('does not silently support another locale %s', async (field) => {
  const r = request();
  Object.assign(r.target.locale, { [field]: field === 'provider' ? 'i' : 'LATIN1' });
  await setRequest(r);
  await expect(bootstrapCoreCleanTarget(options())).rejects.toThrow();
  expect(state.client).toBeUndefined();
});

it.each(['objects', 'extensions'])('requires actual blank target %s rather than absence of a journal', async (field) => {
  if (field === 'objects') state.objects = true;
  else state.extensions.push({ name: 'unexpected' });
  await expect(bootstrapCoreCleanTarget(options())).rejects.toThrow();
  expect(state.ddl).toBe(0);
  expect(await names()).toEqual(['worker-start.json']);
});

it.each(['symlink', 'hardlink', 'writable', 'unlisted', 'changed', 'extra-meta'])(
  'rejects %s executable migration custody before connecting',
  async (attack) => {
    const file = path.join(migrations, '0000_fixture.sql');
    if (attack === 'writable') await fs.chmod(file, 0o600);
    if (attack === 'unlisted') await write(migrations, '0001_unlisted.sql', 'SELECT 1;');
    if (attack === 'extra-meta') await write(migrations, 'meta/0000_snapshot.json', '{}');
    if (attack === 'changed') await write(migrations, '0000_fixture.sql', 'SELECT changed;');
    if (attack === 'symlink' || attack === 'hardlink') {
      const old = path.join(root, 'retained.sql');
      await fs.rename(file, old);
      if (attack === 'symlink') await fs.symlink(old, file);
      else await fs.link(old, file);
    }
    await expect(bootstrapCoreCleanTarget(options())).rejects.toThrow();
    expect(state.client).toBeUndefined();
    expect(state.ddl).toBe(0);
  },
);

it.each(['version', 'dialect', 'idx', 'tag', 'when', 'breakpoints'])('rejects unsupported journal %s without DDL', async (field) => {
  const journal = JSON.parse(await fs.readFile(path.join(migrations, 'meta/_journal.json'), 'utf8'));
  if (field === 'version' || field === 'dialect') journal[field] = 'unsupported';
  else journal.entries[0][field] = 'unsupported';
  const sql = await fs.readFile(path.join(migrations, '0000_fixture.sql'), 'utf8');
  await setupMigrations({ 'meta/_journal.json': JSON.stringify(journal), '0000_fixture.sql': sql });
  await expect(bootstrapCoreCleanTarget(options())).rejects.toThrow();
  expect(state.ddl).toBe(0);
});

it('pins all migration paths across the installed migrator re-read and retains a failed candidate on drift', async () => {
  state.migrateHook = async () => {
    await write(migrations, '0000_fixture.sql', 'SELECT changed;');
  };
  await expect(bootstrapCoreCleanTarget(options())).rejects.toThrow();
  expect(state.ddl).toBe(1);
  expect(state.deletes).toBe(0);
  expect(await names()).toEqual(['migration-intent.json', 'worker-start.json']);
});

it.each(['zero', 'multiple', 'modified', 'extra-field', 'bad-time', 'different-time', 'fractional-time', 'nonempty-other'])(
  'refuses unexpected seed %s without deletion',
  async (attack) => {
    const seed: Row = {
      slug: 'migrated',
      hash: 'migrated',
      name: 'migrated',
      enabled: true,
      url: 'migrated',
      branch: 'main',
      created_at: 2000000000,
      updated_at: 2000000000,
    };
    state.seedOverride = [seed];
    if (attack === 'zero') state.seedOverride = [];
    if (attack === 'multiple') state.seedOverride.push({ ...seed });
    if (attack === 'modified') seed.url = 'different';
    if (attack === 'extra-field') seed.unexpected = true;
    if (attack === 'bad-time') {
      seed.created_at = 1999999990;
      seed.updated_at = 1999999990;
    }
    if (attack === 'different-time') seed.updated_at = 2000000001;
    if (attack === 'fractional-time') {
      seed.created_at = 2000000000.5;
      seed.updated_at = 2000000000.5;
    }
    if (attack === 'nonempty-other') state.otherCount = '1';
    await expect(bootstrapCoreCleanTarget(options())).rejects.toThrow();
    expect(state.ddl).toBe(1);
    expect(state.deletes).toBe(0);
    expect(state.seedRows).toEqual(state.seedOverride);
  },
);

it.each([-1, 1])('allows exactly the PostgreSQL cast rounding margin %i second', async (offset) => {
  state.seedOverride = [
    {
      slug: 'migrated',
      hash: 'migrated',
      name: 'migrated',
      enabled: true,
      url: 'migrated',
      branch: 'main',
      created_at: 2000000000 + offset,
      updated_at: 2000000000 + offset,
    },
  ];
  await bootstrapCoreCleanTarget(options());
  expect(state.deletes).toBe(1);
});

it.each([0, 2])('rolls sanitation back if exact-row DELETE reports %i rows', async (count) => {
  state.deleteCount = count;
  const error = await bootstrapCoreCleanTarget(options()).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect(coreCleanTargetBootstrapFailureDiagnostic(error)).toEqual({
    event: 'core-clean-target-bootstrap-failed',
    phase: 'sanitize',
    code: 'unknown',
  });
  expect(state.rollback).toBe(1);
  expect(state.seedRows).toHaveLength(1);
  expect(await names()).toEqual([
    'ledger-intent.json',
    'migration-completion.json',
    'migration-intent.json',
    'sanitation-intent.json',
    'worker-start.json',
  ]);
});

it('retains partial DDL and its original intent on migration failure, without replay or cleanup', async () => {
  state.migrationError = Object.assign(new Error('private SQL path and bytes'), { code: '42P01' });
  const error = await bootstrapCoreCleanTarget(options()).catch((error: unknown) => error);
  expect(coreCleanTargetBootstrapFailureDiagnostic(error)).toEqual({ event: 'core-clean-target-bootstrap-failed', phase: 'migrate', code: '42P01' });
  expect(String(error)).not.toContain('private SQL');
  expect(state.ddl).toBe(1);
  expect(state.deletes).toBe(0);
  await expect(bootstrapCoreCleanTarget(options())).rejects.toThrow();
  expect(state.ddl).toBe(1);
  expect(state.client?.ended).toBe(1);
});

it('retains sanitation intent on a lost commit acknowledgement and never claims success', async () => {
  state.commitError = Object.assign(new Error('synthetic acknowledgement lost'), { code: 'ECONNRESET' });
  await expect(bootstrapCoreCleanTarget(options())).rejects.toThrow();
  expect(state.seedRows).toEqual([]);
  expect(await names()).not.toContain('result.json');
  expect(await names()).toContain('sanitation-intent.json');
  expect(state.ddl).toBe(1);
  expect(state.deletes).toBe(1);
});

it('refuses catalog/ledger mismatch and does not normalize it', async () => {
  state.catalog = 'd'.repeat(64);
  await expect(bootstrapCoreCleanTarget(options())).rejects.toThrow();
  expect(state.deletes).toBe(0);
});

it('keeps the migration result sealed and never overwrites completed output', async () => {
  await bootstrapCoreCleanTarget(options());
  const before = await fs.readFile(path.join(output, 'result.json'));
  await expect(bootstrapCoreCleanTarget(options())).rejects.toThrow();
  expect(await fs.readFile(path.join(output, 'result.json'))).toEqual(before);
  expect(state.ddl).toBe(1);
});

it('rejects extra private payloads, noncanonical request and a writable authorization', async () => {
  await write(input, 'auth.json', '{}');
  await expect(bootstrapCoreCleanTarget(options())).rejects.toThrow();
  await fs.unlink(path.join(input, 'auth.json'));
  await write(input, 'request.json', `${canonicalCoreJson(request())}\n`);
  await expect(bootstrapCoreCleanTarget(options())).rejects.toThrow();
  await setRequest();
  await fs.chmod(path.join(input, 'authorization.json'), 0o600);
  await expect(bootstrapCoreCleanTarget(options())).rejects.toThrow();
  expect(state.client).toBeUndefined();
});

async function versionedRequest() {
  state.major = 14;
  state.serverVersion = '140023';
  vi.spyOn(os, 'arch').mockReturnValue('x64');
  const value = { ...request(), schema: 'orbis.core-clean-target-bootstrap-input.v2', executionProfile: 'pg14-debian-amd64.v1' };
  await write(input, 'request.json', canonicalCoreJson(value));
  await write(
    input,
    'authorization.json',
    canonicalCoreJson({ ...value, schema: 'orbis.core-clean-target-bootstrap-authorization.v2', decision: 'approved', requestSha256: digest(value) }),
  );
  return value;
}

it('bootstraps a bound v2 PG14 candidate without querying PG17-only catalog fields', async () => {
  const value = await versionedRequest();
  const report = await bootstrapCoreCleanTarget(options());
  expect(report).toMatchObject({
    schema: 'orbis.core-clean-target-bootstrap-result.v2',
    executionProfile: value.executionProfile,
    structure: { major: 14 },
    applicationTablesEmpty: true,
    activation: false,
    restoreAuthority: false,
  });
  expect(state.queries.every((sql) => !sql.includes('datlocprovider'))).toBe(true);
  expect(state.queries.filter((sql) => sql === 'SHOW server_version_num').length).toBeGreaterThan(1);
  expect(state.ddl).toBe(1);
  for (const name of await names()) {
    expect((await result(name)).schema).toMatch(/\.v2$/);
    expect((await result(name)).executionProfile).toBe(value.executionProfile);
    expect((await fs.stat(path.join(output, name))).mode & 0o777).toBe(0o400);
  }
});

it.each(['old-authorization', 'unknown-profile', 'wrong-architecture'])('refuses v2 %s before connecting', async (attack) => {
  const value = await versionedRequest();
  if (attack === 'old-authorization') await write(input, 'authorization.json', canonicalCoreJson(authorization(value)));
  if (attack === 'unknown-profile') {
    value.executionProfile = '__proto__';
    await write(input, 'request.json', canonicalCoreJson(value));
  }
  if (attack === 'wrong-architecture') vi.mocked(os.arch).mockReturnValue('arm64');
  await expect(bootstrapCoreCleanTarget(options())).rejects.toThrow();
  expect(state.client).toBeUndefined();
  expect(await names()).toEqual([]);
});

it.each(['major', 'locale'])('refuses v2 actual %s mismatch before migration', async (change) => {
  await versionedRequest();
  if (change === 'major') state.serverVersion = '170006';
  else state.actualTarget.collate = 'POSIX';
  await expect(bootstrapCoreCleanTarget(options())).rejects.toThrow();
  expect(state.ddl).toBe(0);
  expect(await names()).toEqual(['worker-start.json']);
});

it('refuses a v2 migration report with a different major', async () => {
  await versionedRequest();
  state.major = 17;
  await expect(bootstrapCoreCleanTarget(options())).rejects.toThrow();
  expect(state.deletes).toBe(0);
  expect(await names()).not.toContain('result.json');
});

it('keeps the v1 capability and request schema independent of v2 profiles', () => {
  expect(coreCleanTargetBootstrapWorkerCapabilityV2.requestSchema).toBe('orbis.core-clean-target-bootstrap-input.v2');
  expect(coreCleanTargetBootstrapWorkerCapabilityV2.profiles['pg14-debian-amd64.v1'].major).toBe(14);
  expect(coreCleanTargetBootstrapWorkerCapability.requestSchema).toBe('orbis.core-clean-target-bootstrap-input.v1');
  expect(coreCleanTargetBootstrapWorkerCapability).not.toHaveProperty('profiles');
});
