import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { backupDatabaseColumns, backupDatabaseTables, type BackupDatabaseTable } from './backup-database-records';
import { prepareRestoreDatabase, type RestoreDatabaseConnection, type RestoreDatabaseOwner } from './backup-restore-database';
import type { BackupDatabaseReview } from './backup-database.service';

type MockClient = { config: { database: string; user: string }; query: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
type MockQueryResult = { rowCount: number | null; rows: Array<Record<string, unknown>> };

const fakePg = vi.hoisted(() => ({
  clients: [] as MockClient[],
  handler: undefined as unknown as (client: MockClient, sql: string, values: unknown[]) => Promise<MockQueryResult>,
  migrateHook: undefined as unknown as (client: unknown, options: unknown) => Promise<void>,
  migrateCalls: [] as Array<{ database: unknown; options: unknown }>,
  database: undefined as { name: string; user: string; marker: string | null; oid: number } | undefined,
  collision: false,
  endFailure: undefined as ((client: MockClient) => Error | undefined) | undefined,
}));

vi.mock('pg', () => ({
  Client: class {
    config: MockClient['config'];
    query: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    constructor(config: MockClient['config']) {
      this.config = config;
      this.query = vi.fn((sql: string, values?: unknown[]) => fakePg.handler(this, sql, values ?? []));
      this.end = vi.fn(async () => {
        const error = fakePg.endFailure?.(this);
        if (error) throw error;
      });
      fakePg.clients.push(this);
    }
    on() {
      return this;
    }
    async connect() {}
  },
}));

vi.mock('drizzle-orm/node-postgres', () => ({ drizzle: (client: unknown) => ({ client }) }));
vi.mock('drizzle-orm/node-postgres/migrator', () => ({
  migrate: async (database: { client: unknown }, options: unknown) => {
    fakePg.migrateCalls.push({ database: database.client, options });
    await fakePg.migrateHook(database.client, options);
  },
}));

type Row = Record<string, unknown>;
type Entry = { table: BackupDatabaseTable; row: Row };

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const nonce = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const mainDatabase = 'orbis_main';
const usernamePayload = "fixture'); DROP DATABASE important; --";
const configPayload = 'value\'); DELETE FROM public."user"; --';
let directory: string;
let file: string;
let entries: Entry[];
let bytes: Buffer;
let expected: BackupDatabaseReview;
let source: { file: string; expected: BackupDatabaseReview; jwtSecret: string };
let connection: RestoreDatabaseConnection;
let ownerRecord: { name: string; user: string; marker: string | null; oid: number } | undefined;
let tableRows: Record<BackupDatabaseTable, Row[]>;
let queryLog: Array<{ database: string; sql: string; values: unknown[] }>;
let dropped: string[];
let committed = false;
let transactionStarted = false;
let migrationSeeded = false;
let throwOn: 'migrate' | 'insert' | 'create' | 'comment' | undefined;

beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-restore-database-')));
  await fs.chmod(directory, 0o700);
  file = path.join(directory, 'records.ndjson');
  connection = { host: 'localhost', port: 5432, user: 'fixture_owner', password: 'disposable fixture', database: mainDatabase };
  entries = databaseRows();
  bytes = encode(entries);
  expected = review(bytes, entries);
  source = { file, expected, jwtSecret: 'disposable restore fixture key' };
  await fs.writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
  fakePg.clients.length = 0;
  fakePg.migrateCalls.length = 0;
  fakePg.database = undefined;
  fakePg.collision = false;
  fakePg.endFailure = undefined;
  ownerRecord = undefined;
  tableRows = emptyTables();
  queryLog = [];
  dropped = [];
  committed = false;
  transactionStarted = false;
  migrationSeeded = false;
  throwOn = undefined;
  fakePg.migrateHook = async () => {
    if (throwOn === 'migrate') throw new Error('fixture migration failure with private detail');
    migrationSeeded = true;
    tableRows.user.push({ id: 900, fixture: 'migration seed' });
    tableRows.app.push({ id: 900, status: 'running', fixture: 'migration seed' });
    tableRows.link.push({ id: 900, fixture: 'migration seed' });
  };
  fakePg.handler = async (client: MockClient, sql: string, values: unknown[]) => {
    queryLog.push({ database: client.config.database, sql, values });
    if (throwOn === 'create' && sql.startsWith('CREATE DATABASE')) throw new Error('fixture create failure with private detail');
    if (throwOn === 'comment' && sql.startsWith('COMMENT ON DATABASE')) throw new Error('fixture comment failure with private detail');
    if (sql.startsWith('SELECT 1 FROM pg_catalog.pg_database')) {
      return { rowCount: fakePg.collision ? 1 : 0, rows: fakePg.collision ? [{ '?column?': 1 }] : [] };
    }
    if (sql.startsWith('CREATE DATABASE')) {
      const match = /^CREATE DATABASE "([^"]+)" WITH OWNER "([^"]+)"/.exec(sql);
      if (!match) throw new Error('Unexpected database creation statement');
      const name = match[1];
      const user = match[2];
      if (!name || !user) throw new Error('Missing fixture database identity');
      ownerRecord = { name, user, marker: null, oid: 4201 };
      fakePg.database = ownerRecord;
      return { rowCount: null, rows: [] };
    }
    if (sql.startsWith('COMMENT ON DATABASE')) {
      const match = / IS '([^']+)'$/.exec(sql);
      if (!ownerRecord || !match) throw new Error('Unexpected database ownership marker statement');
      const marker = match[1];
      if (!marker) throw new Error('Missing fixture ownership marker');
      ownerRecord.marker = marker;
      return { rowCount: null, rows: [] };
    }
    if (sql.startsWith('SELECT oid, pg_catalog.pg_get_userbyid')) {
      if (!ownerRecord || values[0] !== ownerRecord.name) return { rowCount: 0, rows: [] };
      return {
        rowCount: 1,
        rows: [{ oid: ownerRecord.oid, owner: ownerRecord.user, marker: ownerRecord.marker }],
      };
    }
    if (sql.startsWith('DROP DATABASE')) {
      const match = /^DROP DATABASE "([^"]+)" WITH \(FORCE\)$/.exec(sql);
      if (!match) throw new Error('Unexpected database deletion statement');
      const name = match[1];
      if (!name) throw new Error('Missing fixture database name');
      dropped.push(name);
      if (ownerRecord?.name === name) {
        ownerRecord = undefined;
        fakePg.database = undefined;
      }
      return { rowCount: null, rows: [] };
    }
    if (sql.startsWith('TRUNCATE ')) {
      if (!sql.endsWith(' RESTART IDENTITY')) throw new Error('Unexpected table reset statement');
      tableRows = emptyTables();
      transactionStarted = true;
      return { rowCount: null, rows: [] };
    }
    if (sql.startsWith('INSERT INTO public.')) {
      if (!transactionStarted) throw new Error('Insert occurred outside the restore transaction');
      if (throwOn === 'insert') throw new Error('fixture insert failure with private detail');
      const match = /^INSERT INTO public\."([^"]+)"/.exec(sql);
      if (!match || !backupDatabaseTables.includes(match[1] as BackupDatabaseTable)) throw new Error('Unexpected insert target');
      const table = match[1] as BackupDatabaseTable;
      const row = Object.fromEntries(backupDatabaseColumns(table).map((column, index) => [column, values[index]]));
      tableRows[table].push(row);
      return { rowCount: 1, rows: [] };
    }
    if (sql.startsWith('SELECT pg_catalog.setval')) return { rowCount: 1, rows: [{ setval: 1 }] };
    const count = /^SELECT count\(\*\) AS count FROM public\."([^"]+)"$/.exec(sql);
    if (count) return { rowCount: 1, rows: [{ count: String(tableRows[count[1] as BackupDatabaseTable].length) }] };
    if (sql === 'BEGIN') return { rowCount: null, rows: [] };
    if (sql === 'COMMIT') {
      committed = true;
      return { rowCount: null, rows: [] };
    }
    if (sql === 'ROLLBACK') return { rowCount: null, rows: [] };
    throw new Error(`Unexpected fixture query category: ${sql.slice(0, 20)}`);
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

function passwordHash() {
  const salt = Buffer.alloc(16, 1).toString('base64').replace(/=+$/, '');
  const digest = Buffer.alloc(32, 2).toString('base64').replace(/=+$/, '');
  return `$argon2id$v=19$m=8192,t=1,p=1$${salt}$${digest}`;
}

function databaseRows(): Entry[] {
  const rows: Record<BackupDatabaseTable, Row> = {
    user: {
      id: 1,
      username: usernamePayload,
      password: passwordHash(),
      created_at: 1_700_000_000,
      updated_at: 1_700_000_001,
      operator: true,
      totp_secret: null,
      totp_enabled: false,
      salt: null,
      locale: 'en',
      has_seen_welcome: true,
    },
    app_store: {
      slug: 'fixture-store',
      hash: 'fixture-store-hash',
      name: 'Fixture store',
      enabled: true,
      url: 'https://example.invalid/fixture.git',
      branch: 'main',
      created_at: 1_700_000_000,
      updated_at: 1_700_000_001,
    },
    app: {
      id: 7,
      status: 'running',
      config: { environment: { FIXTURE_SQL_LIKE_VALUE: configPayload }, settings: { keep: true } },
      created_at: 1_700_000_000,
      updated_at: 1_700_000_001,
      version: 3,
      ignored_version: null,
      exposed: false,
      domain: null,
      is_visible_on_guest_dashboard: true,
      open_port: true,
      port: 8080,
      exposed_local: false,
      app_store_slug: 'fixture-store',
      app_name: 'fixture-app',
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
    link: {
      id: 2,
      title: 'Fixture link',
      url: 'https://example.invalid/',
      icon_url: null,
      created_at: 1_700_000_000,
      updated_at: 1_700_000_001,
      user_id: 1,
      description: null,
      is_visible_on_guest_dashboard: false,
    },
  };
  return backupDatabaseTables.map((table) => ({ table, row: rows[table] }));
}

function encode(records: Entry[]) {
  return Buffer.from(`${records.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
}

function review(data: Buffer, records: Entry[]): BackupDatabaseReview {
  return {
    counts: Object.fromEntries(
      backupDatabaseTables.map((table) => [table, records.filter((entry) => entry.table === table).length]),
    ) as BackupDatabaseReview['counts'],
    bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
  };
}

function emptyTables(): Record<BackupDatabaseTable, Row[]> {
  return { user: [], app_store: [], app: [], link: [] };
}

function options(
  overrides: Partial<{
    id: string;
    nonce: string;
    signal: AbortSignal;
    onCreated: (value: RestoreDatabaseOwner) => Promise<void>;
    progress: (records: number, total: number) => void;
  }> = {},
) {
  return {
    id,
    nonce,
    connection,
    trustedMigrationsFolder: '/private/fixture/migrations',
    source,
    signal: overrides.signal ?? new AbortController().signal,
    onCreated: overrides.onCreated ?? (async () => undefined),
    progress: overrides.progress ?? (() => undefined),
  };
}

it('validates the exact normalized review before allocating a PostgreSQL client', async () => {
  source = { ...source, expected: { ...expected, sha256: '0'.repeat(64) } };
  await expect(prepareRestoreDatabase(options())).rejects.toThrow();
  expect(fakePg.clients).toHaveLength(0);
});

it('clears migration seeds, restores parameterized rows with apps stopped, and targets the trusted app sequence', async () => {
  const progress: Array<[number, number]> = [];
  const owner = await prepareRestoreDatabase(options({ progress: (records, total) => progress.push([records, total]) }));
  const target = fakePg.clients.find((client: MockClient) => client.config.database === owner.name);
  if (!target) throw new Error('Missing target database client');
  const inserts = queryLog.filter((query) => query.sql.startsWith('INSERT INTO public.'));
  expect(migrationSeeded).toBe(true);
  expect(
    target.query.mock.calls.some((call: unknown[]) => {
      const sql = call[0];
      return typeof sql === 'string' && sql.startsWith('TRUNCATE ') && sql.endsWith(' RESTART IDENTITY');
    }),
  ).toBe(true);
  expect(tableRows.user.map((row) => row.id)).toEqual([1]);
  expect(tableRows.app.map((row) => row.id)).toEqual([7]);
  expect(tableRows.link.map((row) => row.id)).toEqual([2]);
  expect(tableRows.app_store.map((row) => row.slug)).toEqual(['fixture-store']);
  expect(tableRows.app[0]?.status).toBe('stopped');
  expect(progress).toEqual([
    [1, 4],
    [2, 4],
    [3, 4],
    [4, 4],
  ]);
  expect(committed).toBe(true);
  expect(dropped).toEqual([]);

  const insertStatements = inserts.map(({ sql }) => sql);
  expect(insertStatements.every((sql) => !sql.includes(usernamePayload) && !sql.includes(configPayload))).toBe(true);
  const allValues = inserts.flatMap(({ values }) => values);
  expect(allValues).toContain(usernamePayload);
  expect(allValues).toContainEqual(entries.find((entry) => entry.table === 'app')?.row.config);
  const sequenceCalls = queryLog.filter(({ sql }) => sql.startsWith('SELECT pg_catalog.setval'));
  expect(sequenceCalls.map(({ values }) => values[0])).toEqual(['public."user_id_seq"', 'public."app_id_seq"', 'public."link_id_seq"']);
  expect(fakePg.migrateCalls[0]?.options).toEqual({ migrationsFolder: '/private/fixture/migrations' });
});

it('rejects an existing database name before creation', async () => {
  fakePg.collision = true;
  await expect(prepareRestoreDatabase(options())).rejects.toThrow();
  expect(queryLog.some(({ sql }) => sql.startsWith('CREATE DATABASE'))).toBe(false);
  expect(dropped).toEqual([]);
});

it.each([
  [
    'owner',
    (database: { user: string; marker: string | null; oid: number }) => {
      database.user = 'foreign_owner';
    },
  ],
  [
    'marker',
    (database: { user: string; marker: string | null; oid: number }) => {
      database.marker = 'foreign marker';
    },
  ],
  [
    'OID',
    (database: { user: string; marker: string | null; oid: number }) => {
      database.oid += 1;
    },
  ],
] as const)('does not drop a restore database after its %s changes before cleanup', async (_name, tamper) => {
  await expect(
    prepareRestoreDatabase(
      options({
        onCreated: async () => {
          if (!ownerRecord) throw new Error('Missing fixture owner record');
          tamper(ownerRecord);
          throw new Error('fixture stop after ownership checkpoint');
        },
      }),
    ),
  ).rejects.toThrow();
  expect(ownerRecord).toBeDefined();
  expect(dropped).toEqual([]);
});

it.each(['migrate', 'insert', 'onCreated', 'cancel'] as const)('cleans up owned database after %s failure', async (phase) => {
  const controller = new AbortController();
  if (phase === 'migrate') throwOn = 'migrate';
  if (phase === 'insert') throwOn = 'insert';
  const onCreated = async () => {
    if (phase === 'onCreated') throw new Error('fixture onCreated failure');
    if (phase === 'cancel') controller.abort();
  };
  await expect(prepareRestoreDatabase(options({ signal: controller.signal, onCreated }))).rejects.toThrow();
  expect(dropped).toEqual([`orbis_restore_${id.replaceAll('-', '')}`]);
  expect(ownerRecord).toBeUndefined();
  expect(committed).toBe(false);
});

it('rejects a source changed during row insertion before commit and removes the prepared database', async () => {
  let changed = false;
  await expect(
    prepareRestoreDatabase(
      options({
        progress: async () => {
          if (!changed) {
            changed = true;
            const modified = Buffer.from(bytes);
            const index = modified.indexOf(Buffer.from(usernamePayload));
            if (index < 0) throw new Error('Missing fixture mutation target');
            modified[index] = modified[index] === 0x66 ? 0x67 : 0x66;
            await fs.writeFile(file, modified);
          }
        },
      }),
    ),
  ).rejects.toThrow();
  expect(changed).toBe(true);
  expect(committed).toBe(false);
  expect(dropped).toEqual([`orbis_restore_${id.replaceAll('-', '')}`]);
});

it('redacts PostgreSQL error text and values from restore failures', async () => {
  throwOn = 'insert';
  let failure: unknown;
  try {
    await prepareRestoreDatabase(options());
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  if (failure instanceof Error) {
    expect(failure.message).not.toContain('private detail');
    expect(failure.message).not.toContain(usernamePayload);
    expect(failure.message).not.toContain(configPayload);
  }
  expect(dropped).toEqual([`orbis_restore_${id.replaceAll('-', '')}`]);
});

it.each(['target', 'control'] as const)('removes the owned database when the %s connection close fails during rollback', async (which) => {
  throwOn = 'insert';
  fakePg.endFailure = (client: MockClient) =>
    (which === 'target' ? client.config.database.startsWith('orbis_restore_') : client.config.database === mainDatabase)
      ? new Error(`fixture ${which} connection close failure`)
      : undefined;
  await expect(prepareRestoreDatabase(options())).rejects.toThrow();
  expect(dropped).toEqual([`orbis_restore_${id.replaceAll('-', '')}`]);
  expect(ownerRecord).toBeUndefined();
});
