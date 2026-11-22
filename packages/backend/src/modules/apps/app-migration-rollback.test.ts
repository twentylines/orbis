import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Client } from 'pg';
import { beforeEach, expect, it } from 'vitest';
import * as schema from '@/core/database/drizzle/schema';
import type { Database } from '@/core/database/database.module';
import type { MigrationJournalState } from '../backups/app-migration-journal';
import { migrationRollbackBinding, settleMigrationRollback, readMigrationRollback } from './app-migration-rollback';

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
    phase: 'restored',
    targetWritesPossible: false,
    commitAttempted: false,
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
    restores: [{ id: randomUUID(), phase: 'committed' }],
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

it('settles only the old status inside a serializable locked transaction, preserving version/history/receipt absence', async () => {
  const beforeLedger = structuredClone(ledger);
  expect(await settleMigrationRollback(database, state, 'running')).toBe(true);
  expect(current.status).toBe('running');
  expect(current.version).toBe(4);
  expect(current.pending_restart).toBe(true);
  expect(ledger).toEqual(beforeLedger);
  expect(receipts).toEqual([]);
  expect(queries.filter((sql) => /^(insert|delete)/.test(sql))).toEqual([]);
  expect(queries.find((sql) => sql.startsWith('update'))?.split(' where ')[0]).not.toContain('"version" =');
  expect(await readMigrationRollback(database, state, 'running')).toBe(true);
});
it('accepts a current old status as positive reconciliation without rewriting it', async () => {
  current.status = 'running';
  expect(await settleMigrationRollback(database, state, 'running')).toBe(true);
  expect(queries.filter((sql) => sql.startsWith('update'))).toEqual([]);
});
it('keeps a newer restart-needed preference and only raises that flag when requested', async () => {
  current.pending_restart = false;
  await settleMigrationRollback(database, state, 'stopped', true);
  expect(current.pending_restart).toBe(true);
  expect(current.status).toBe('stopped');
  expect(current.version).toBe(4);
});
it('reconciles a lost status commit reply from current matching old rows without another status write', async () => {
  behavior = 'lost-commit';
  await expect(settleMigrationRollback(database, state, 'running')).rejects.toThrow();
  expect(current.status).toBe('running');
  behavior = '';
  const writes = queries.filter((sql) => sql.startsWith('update')).length;
  expect(await readMigrationRollback(database, state, 'running')).toBe(true);
  expect(await settleMigrationRollback(database, state, 'running')).toBe(true);
  expect(queries.filter((sql) => sql.startsWith('update'))).toHaveLength(writes);
});
it.each(['target', 'sql', 'receipt', 'unrestored', 'unknown-ledger'] as const)('rejects %s authority before any SQL', async (fault) => {
  if (fault === 'target') state.targetWritesPossible = true;
  if (fault === 'sql') state.commitAttempted = true;
  if (fault === 'receipt') state.commitReceiptSha256 = '0'.repeat(64);
  if (fault === 'unrestored') state.phase = 'recovery-required';
  if (fault === 'unknown-ledger') state.operation.previousLedger.baselined = false;
  await expect(settleMigrationRollback(database, state, 'running')).rejects.toThrow();
  expect(queries.filter((sql) => sql.startsWith('update'))).toEqual([]);
});
it.each(['id', 'created_at', 'app_name', 'app_store_slug', 'version', 'migrations_baselined', 'status', 'ledger', 'forward-receipt'] as const)(
  'refuses changed %s without changing SQL state',
  async (fault) => {
    if (fault === 'ledger') ledger = [{ app_id: 1, migration_id: 'unexpected' }];
    else if (fault === 'forward-receipt') receipts = [{ request_id: state.operation.requestId }];
    else current[fault] = fault === 'migrations_baselined' ? false : typeof current[fault] === 'number' ? Number(current[fault]) + 1 : 'foreign';
    const before = structuredClone({ current, ledger, receipts });
    await expect(settleMigrationRollback(database, state, 'running')).rejects.toThrow();
    expect({ current, ledger, receipts }).toEqual(before);
    expect(queries.filter((sql) => sql.startsWith('update'))).toEqual([]);
  },
);
it.each(['allocated', 'capturing', 'ready'] as const)('permits %s preparation only when no runner or restore could have written data', (phase) => {
  state.phase = phase;
  state.runners = [];
  state.restores = [];
  expect(migrationRollbackBinding(state)).toMatchObject({ requestId: state.operation.requestId });
  state.runners = [
    {
      migrationId: '002-upgrade',
      nonce: '5'.repeat(32),
      name: 'orbis-migration-' + '6'.repeat(32) + '-' + '5'.repeat(12),
      specSha256: '7'.repeat(64),
      containerId: null,
      phase: 'create-intent',
      exitCode: null,
      terminalSha256: null,
    },
  ];
  expect(() => migrationRollbackBinding(state)).toThrow();
});
