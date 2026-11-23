import { appUpdateSettings } from './app-update-settings';
import { createMockAppInfo } from '@/tests/helpers/app-mocks';
import { appFormSchema } from '../app-lifecycle/dto/app-lifecycle.dto';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Client } from 'pg';
import { beforeEach, expect, it } from 'vitest';
import * as schema from '@/core/database/drizzle/schema';
import type { Database } from '@/core/database/database.module';
import type { MigrationJournalState } from '../backups/app-migration-journal';
import { migrationHash } from '../backups/app-migration-journal';
import { appMigrationCommitBinding, commitAppMigration, readAppMigrationCommit, verifyAppMigrationCommitReceipt } from './app-migration-commit';

type Row = Record<string, unknown>;
let state: MigrationJournalState;
let current: Row;
let ledger: Row[];
let receipts: Row[];
let queries: string[];
let behavior: string;
let database: Database;

beforeEach(() => {
  const pin = {
    migrationId: '002-upgrade',
    sourceSha256: 'a'.repeat(64),
    definitionSha256: 'b'.repeat(64),
    reference: 'postgres@sha256:' + 'c'.repeat(64),
    imageId: 'sha256:' + 'd'.repeat(64),
    platform: 'linux/amd64' as const,
  };
  state = {
    schema: 'orbis.app-migration-journal.v1',
    revision: 7,
    operation: {
      version: 1,
      requestId: randomUUID(),
      stageId: randomUUID(),
      appUrn: 'demo:store',
      appId: 1,
      createdAt: 123,
      fromVersion: 4,
      toVersion: 5,
      previousLedger: { baselined: true, migrationIds: ['001-initial'] },
      images: [pin],
      originalContainers: [],
    },
    storageSha256: 'e'.repeat(64),
    sourceController: { id: '1'.repeat(64), imageId: 'sha256:' + '2'.repeat(64), startedAt: 'fixture', definitionSha256: '3'.repeat(64) },
    phase: 'commit-intent',
    targetWritesPossible: true,
    commitAttempted: true,
    commitReceiptSha256: null,
    checkpoint: { file: 'before.tar.gz', sha256: '4'.repeat(64), bytes: 100, fileIdentity: 'fixture-file' },
    runners: [
      {
        migrationId: pin.migrationId,
        nonce: '5'.repeat(32),
        name: 'orbis-migration-' + '6'.repeat(32) + '-' + '5'.repeat(12),
        specSha256: '7'.repeat(64),
        containerId: '8'.repeat(64),
        phase: 'terminal',
        exitCode: 0,
        terminalSha256: '9'.repeat(64),
      },
    ],
    restores: [],
  };
  current = {
    id: 1,
    app_name: 'demo',
    app_store_slug: 'store',
    created_at: 123,
    version: 4,
    migrations_baselined: true,
    status: 'updating',
    pending_restart: true,
  };
  ledger = [{ app_id: 1, migration_id: '001-initial' }];
  receipts = [];
  queries = [];
  behavior = '';
  let snapshot: { current: Row; ledger: Row[]; receipts: Row[] } | undefined;
  // Actual installed Drizzle emits and decodes SQL. Storage/transactions below are a model, not PostgreSQL acceptance.
  const client = {
    query: async (config: string | { text: string; rowMode?: string }, params: unknown[] = []) => {
      const text = typeof config === 'string' ? config : config.text;
      queries.push(text);
      if (text.startsWith('begin')) {
        expect(text).toContain('isolation level serializable');
        snapshot = structuredClone({ current, ledger, receipts });
        return { rows: [], rowCount: 0 };
      }
      if (text === 'commit') {
        snapshot = undefined;
        if (behavior === 'lost-commit') throw new Error('Synthetic lost commit reply');
        return { rows: [], rowCount: 0 };
      }
      if (text === 'rollback') {
        if (snapshot) ({ current, ledger, receipts } = snapshot);
        snapshot = undefined;
        return { rows: [], rowCount: 0 };
      }
      const columns = (selection: string) => [...selection.matchAll(/(?:"[^"]+"\.)?"([^"]+)"/g)].map((match) => match[1] ?? '');
      const rows = (values: Row[], selection: string) => ({
        rowCount: values.length,
        rows: values.map((value) => columns(selection).map((column) => value[column])),
      });
      if (text.startsWith('select ')) {
        const select = text.split(' from ')[0]?.slice(7) ?? '';
        if (text.includes('from "app_migration_commit"'))
          return rows(
            receipts.filter((row) => row.request_id === params[0]),
            select,
          );
        if (text.includes('from "app_migration"')) return rows(ledger, select);
        if (text.includes('from "app"')) {
          expect(text).toContain('for update');
          return rows(current.id === params[0] ? [current] : [], select);
        }
      }
      if (text.startsWith('update "app"')) {
        expect(snapshot).toBeDefined();
        for (const match of (text.split(' where ')[0] ?? '').matchAll(/"([^"]+)" = \$(\d+)/g)) current[match[1] ?? ''] = params[Number(match[2]) - 1];
        if (typeof current.config === 'string') current.config = JSON.parse(current.config);
        return rows([current], text.split(' returning ')[1] ?? '');
      }
      if (text.startsWith('delete from "app_migration"')) {
        ledger = [];
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith('insert into ')) {
        if (text.startsWith('insert into "app_migration_commit"') && behavior === 'receipt-failed')
          throw new Error('Synthetic receipt insert failure');
        const names = columns(text.slice(text.indexOf('(') + 1, text.indexOf(')')));
        const added: Row[] = [];
        for (let offset = 0; offset < params.length; offset += names.length)
          added.push(Object.fromEntries(names.map((name, index) => [name, params[offset + index]])));
        if (text.startsWith('insert into "app_migration_commit"')) receipts.push(...added);
        else ledger.push(...added);
        return rows(added, text.split(' returning ')[1] ?? '');
      }
      throw new Error('Unexpected SQL in transaction fixture');
    },
  } as unknown as Client;
  database = drizzle({ client, schema });
});

it('commits version, the full migration ledger and the bound receipt in one serializable transaction', async () => {
  const result = await commitAppMigration(database, state, 'running', false);
  expect(result.replayed).toBe(false);
  expect(current).toMatchObject({ version: 5, status: 'running', migrations_baselined: true, pending_restart: false });
  expect(ledger).toEqual([
    { app_id: 1, migration_id: '001-initial' },
    { app_id: 1, migration_id: '002-upgrade' },
  ]);
  expect(receipts).toHaveLength(1);
  expect(queries[0]).toBe('begin isolation level serializable');
  expect(queries.at(-1)).toBe('commit');
  expect(queries.findIndex((query) => query.includes('for update'))).toBeLessThan(queries.findIndex((query) => query.startsWith('update')));
  expect(result.receipt.operationSha256).toBe(appMigrationCommitBinding(state).binding.operationSha256);
});

it('rolls back the version and ledger if the receipt cannot be written', async () => {
  behavior = 'receipt-failed';
  await expect(commitAppMigration(database, state, 'running')).rejects.toThrow('verified recovery');
  expect(current.version).toBe(4);
  expect(ledger).toEqual([{ app_id: 1, migration_id: '001-initial' }]);
  expect(receipts).toEqual([]);
  expect(queries.at(-1)).toBe('rollback');
});

it('resolves a lost commit reply through the receipt without replaying a single mutation', async () => {
  behavior = 'lost-commit';
  await expect(commitAppMigration(database, state, 'running')).rejects.toThrow('verified recovery');
  expect(current.version).toBe(5);
  expect(receipts).toHaveLength(1);
  behavior = '';
  queries = [];
  const receipt = await readAppMigrationCommit(database, state);
  expect(receipt?.receipt.version).toBe(5);
  const replay = await commitAppMigration(database, state, 'running');
  expect(replay.replayed).toBe(true);
  expect(queries.every((query) => !/^(?:insert|update|delete)/.test(query))).toBe(true);
});

it.each(['created_at', 'version', 'app_name', 'app_store_slug', 'migrations_baselined', 'status'])(
  'refuses changed %s before any mutation',
  async (field) => {
    current[field] = field === 'migrations_baselined' ? false : field === 'created_at' || field === 'version' ? 999 : 'different';
    await expect(commitAppMigration(database, state, 'running')).rejects.toThrow('verified recovery');
    expect(queries.some((query) => /^(?:insert|update|delete)/.test(query))).toBe(false);
  },
);

it('refuses migration-history drift and a request without a durable SQL intent', async () => {
  ledger.push({ app_id: 1, migration_id: 'unknown' });
  await expect(commitAppMigration(database, state, 'running')).rejects.toThrow();
  expect(queries.some((query) => query.startsWith('update'))).toBe(false);
  queries = [];
  state.commitAttempted = false;
  await expect(commitAppMigration(database, state, 'running')).rejects.toThrow();
  expect(queries).toEqual([]);
});

it.each(['request', 'stage', 'checkpoint', 'ledger', 'storage', 'process'])(
  'rejects a receipt belonging to a different %s binding',
  async (field) => {
    const first = await commitAppMigration(database, state, 'running');
    const changed = structuredClone(state);
    if (field === 'request') changed.operation.requestId = randomUUID();
    if (field === 'stage') changed.operation.stageId = randomUUID();
    if (field === 'checkpoint' && changed.checkpoint) changed.checkpoint.sha256 = '0'.repeat(64);
    if (field === 'ledger') changed.operation.previousLedger.migrationIds = [];
    if (field === 'storage') changed.storageSha256 = '0'.repeat(64);
    if (field === 'process' && changed.runners[0]) changed.runners[0].containerId = '0'.repeat(64);
    expect(() => verifyAppMigrationCommitReceipt(first.receipt, changed)).toThrow();
  },
);

it('treats a missing receipt as unknown and accepts a valid receipt independent of object key order', async () => {
  expect(await readAppMigrationCommit(database, state)).toBeUndefined();
  const committed = await commitAppMigration(database, state, 'running');
  const reordered = Object.fromEntries(Object.entries(committed.receipt).reverse());
  state.commitReceiptSha256 = committed.sha256;
  expect(verifyAppMigrationCommitReceipt(reordered, state).sha256).toBe(committed.sha256);
  expect(migrationHash(committed.receipt)).toMatch(/^[a-f0-9]{64}$/);
});

it('never recreates a missing database receipt after private committed acknowledgement', async () => {
  const first = await commitAppMigration(database, state, 'running');
  state.phase = 'committed';
  state.commitReceiptSha256 = first.sha256;
  receipts = [];
  current.version = 4;
  current.status = 'updating';
  ledger = [{ app_id: 1, migration_id: '001-initial' }];
  queries = [];
  await expect(commitAppMigration(database, state, 'running')).rejects.toThrow();
  expect(queries.some((query) => /^(?:insert|update|delete)/.test(query))).toBe(false);
});

it('does not infer a clean baseline from an empty database history', async () => {
  state.operation.previousLedger = { baselined: false, migrationIds: [] };
  current.migrations_baselined = false;
  ledger = [];
  await expect(commitAppMigration(database, state, 'running')).rejects.toThrow();
  expect(queries).toEqual([]);
});

it('atomically saves target settings with the migration ledger and acknowledges the exact current values', async () => {
  const original = { exposed: true, domain: 'example.test' };
  current.config = original;
  state.operation.settings = appUpdateSettings(
    createMockAppInfo({ port: 8090 }),
    original,
    appFormSchema.assert({ exposed: false, EXTRA: 'target' }),
  );
  await commitAppMigration(database, state, 'running', false);
  expect(current).toMatchObject({ version: 5, exposed: false, domain: null, port: 8090 });
  expect(await readAppMigrationCommit(database, state)).toBeDefined();
  current.config = { EXTRA: 'newer-setting' };
  await expect(readAppMigrationCommit(database, state)).rejects.toThrow();
  await expect(commitAppMigration(database, state, 'running', false)).rejects.toThrow();
  expect(queries.filter((query) => query.startsWith('update'))).toHaveLength(1);
});

it('does not overwrite changed source settings while committing a migration', async () => {
  const original = { EXTRA: 'old-setting' };
  state.operation.settings = appUpdateSettings(createMockAppInfo({ port: 8090 }), original, appFormSchema.assert({ EXTRA: 'target' }));
  current.config = { EXTRA: 'newer-setting' };
  const before = structuredClone(current);
  await expect(commitAppMigration(database, state, 'running', false)).rejects.toThrow();
  expect(current).toEqual(before);
  expect(receipts).toEqual([]);
  expect(queries.some((query) => query.startsWith('update'))).toBe(false);
});
