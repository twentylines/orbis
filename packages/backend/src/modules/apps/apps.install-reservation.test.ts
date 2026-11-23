import { drizzle } from 'drizzle-orm/node-postgres';
import type { Client } from 'pg';
import type { Database } from '@/core/database/database.module';
import * as schema from '@/core/database/drizzle/schema';
import { beforeEach, expect, it } from 'vitest';
import { AppsRepository, type InstallAppReservation } from './apps.repository';

let row: Record<string, unknown>;
let repository: AppsRepository;
let queries: string[];
const reservation: InstallAppReservation = { id: 7, createdAt: 123, appName: 'demo', appStoreSlug: 'store', version: 4 };
beforeEach(() => {
  row = { id: 7, created_at: 123, app_name: 'demo', app_store_slug: 'store', version: 4, status: 'installing', migrations_baselined: false };
  queries = [];
  // Actual Drizzle predicates and result decoding, with a bounded SQL storage model; no PostgreSQL instance.
  const client = {
    query: async (config: string | { text: string; rowMode?: string }, params: unknown[] = []) => {
      const sql = typeof config === 'string' ? config : config.text;
      queries.push(sql);
      if (!/^(update "app"|delete from "app")/.test(sql)) throw new Error('Unexpected reservation SQL');
      const where = sql.split(' where ')[1]?.split(' returning ')[0] ?? '';
      const predicates = [...where.matchAll(/"app"\."([^"]+)" = \$(\d+)/g)];
      const accepted = predicates.length > 0 && predicates.every((match) => row[match[1] ?? ''] === params[Number(match[2]) - 1]);
      if (!accepted) return { rows: [], rowCount: 0 };
      const id = row.id;
      if (sql.startsWith('update')) {
        for (const match of (sql.split(' where ')[0] ?? '').matchAll(/"([^"]+)" = \$(\d+)/g)) row[match[1] ?? ''] = params[Number(match[2]) - 1];
      } else row = {};
      const columns = [...(sql.split(' returning ')[1] ?? '').matchAll(/"([^"]+)"/g)].map((match) => match[1]);
      return { rows: [columns.map((column) => (column === 'id' ? id : row[column ?? '']))], rowCount: 1 };
    },
  } as unknown as Client;
  const db: Database = drizzle({ client, schema });
  repository = new AppsRepository(db);
});
it.each(['finish', 'delete'] as const)('changes only the exact current installing reservation: %s', async (operation) => {
  const accepted =
    operation === 'finish'
      ? await repository.finishInstallReservation(reservation, 'stopped')
      : await repository.deleteInstallReservation(reservation);
  expect(accepted).toBe(true);
  expect(queries).toHaveLength(1);
  expect(queries[0]).toContain('"app"."version" =');
  if (operation === 'finish') expect(row).toMatchObject({ id: 7, version: 4, status: 'stopped', migrations_baselined: false });
  else expect(row).toEqual({});
});
it.each(['id', 'created_at', 'app_name', 'app_store_slug', 'version', 'status'] as const)(
  'preserves a changed row without settling or deleting it: %s',
  async (field) => {
    const changed = { id: 8, created_at: 124, app_name: 'other', app_store_slug: 'other', version: 5, status: 'running' };
    row[field] = changed[field];
    const before = structuredClone(row);
    expect(await repository.finishInstallReservation(reservation, 'running')).toBe(false);
    expect(await repository.deleteInstallReservation(reservation)).toBe(false);
    expect(row).toEqual(before);
  },
);
it('preserves the historical minimal-reservation contract for non-versioned callers', async () => {
  const { version: _version, ...legacy } = reservation;
  expect(await repository.finishInstallReservation(legacy, 'running')).toBe(true);
  expect(queries[0]?.split(' where ')[1]).not.toContain('"app"."version" =');
  expect(row.version).toBe(4);
});

it('releases a saved draft reservation by returning it to missing without deleting its row', async () => {
  row.config = { VALUE: 'retained' };
  const original = structuredClone(row);
  expect(await repository.deleteInstallReservation({ ...reservation, preserveExisting: true })).toBe(true);
  expect(row).toMatchObject({ ...original, status: 'missing' });
  expect(queries[0]).toMatch(/^update /);
});

it.each(['matching', 'changed-id', 'changed-version', 'changed-status', 'migrated', 'other-store'] as const)(
  'reserves only the original uninstalled custom draft: %s',
  async (state) => {
    row.app_store_slug = '_user';
    row.status = 'missing';
    const draft = { ...reservation, appStoreSlug: '_user' };
    if (state === 'changed-id') row.id = 8;
    if (state === 'changed-version') row.version = 5;
    if (state === 'changed-status') row.status = 'running';
    if (state === 'migrated') row.migrations_baselined = true;
    if (state === 'other-store') row.app_store_slug = 'store';
    const before = structuredClone(row);
    const accepted = await repository.reserveCustomDraft(draft, { version: 6, maxBackups: 9 });
    if (state === 'matching') {
      expect(accepted).toMatchObject({ id: 7, createdAt: 123, status: 'installing', version: 6, maxBackups: 9 });
      expect(row).toMatchObject({ id: 7, app_store_slug: '_user', migrations_baselined: false });
    } else {
      expect(accepted).toBeUndefined();
      expect(row).toEqual(before);
    }
  },
);
