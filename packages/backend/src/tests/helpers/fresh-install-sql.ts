import { drizzle } from 'drizzle-orm/node-postgres';
import type { Client } from 'pg';
import * as schema from '@/core/database/drizzle/schema';

/** Actual Drizzle transport with a bounded transactional storage model; not native PostgreSQL acceptance. */
export function freshInstallSql() {
  let row: Record<string, unknown> = {
    id: 7,
    created_at: 123,
    app_name: 'demo',
    app_store_slug: 'store',
    version: 1,
    status: 'installing',
    migrations_baselined: false,
  };
  let ids: string[] = [];
  let behavior = '';
  let receipts: Record<string, unknown>[] = [];
  let terminalWrite = false;
  let snapshot: { row: Record<string, unknown>; ids: string[]; receipts: Record<string, unknown>[] } | undefined;
  const queries: string[] = [];
  const client = {
    query: async (config: string | { text: string; rowMode?: string }, params: unknown[] = []) => {
      const sql = typeof config === 'string' ? config : config.text;
      queries.push(sql);
      const values = (selection: string) => [...selection.matchAll(/(?:"[^"]+"\.)?"([^"]+)"/g)].map((match) => match[1] ?? '');
      const rows = (items: Record<string, unknown>[], selection: string) => ({
        rows: items.map((item) => values(selection).map((name) => item[name])),
        rowCount: items.length,
      });
      if (sql.startsWith('begin')) {
        if (!sql.includes('isolation level serializable')) throw new Error('Nonserializable baseline');
        snapshot = structuredClone({ row, ids, receipts });
        terminalWrite = false;
        return { rows: [] };
      }
      if (sql === 'commit') {
        snapshot = undefined;
        if (behavior === 'lost-commit' || (behavior === 'lost-terminal-commit' && terminalWrite)) {
          behavior = '';
          throw new Error('Synthetic lost commit reply');
        }
        return { rows: [] };
      }
      if (sql === 'rollback') {
        if (snapshot) ({ row, ids, receipts } = snapshot);
        snapshot = undefined;
        return { rows: [] };
      }
      if (sql.startsWith('select ') && sql.includes('from "app_migration_commit"'))
        return rows(
          receipts.filter((record) => record.request_id === params[0]),
          sql.slice(7).split(' from ')[0] ?? '',
        );
      if (!snapshot) throw new Error('Baseline SQL escaped its transaction');
      if (sql.startsWith('select ')) {
        const selection = sql.slice(7).split(' from ')[0] ?? '';
        if (sql.includes('from "app_migration"'))
          return rows(
            ids.map((migration_id) => ({ migration_id })),
            selection,
          );
        if (sql.includes('from "app"')) {
          if (!sql.includes('for update')) throw new Error('Missing baseline row lock');
          return rows(row.id === params[0] ? [row] : [], selection);
        }
      }
      if (sql.startsWith('update "app"')) {
        const predicate = sql.split(' where ')[1]?.split(' returning ')[0] ?? '';
        if (![...predicate.matchAll(/"app"\."([^"]+)" = \$(\d+)/g)].every((match) => row[match[1] ?? ''] === params[Number(match[2]) - 1]))
          return { rows: [] };
        for (const match of (sql.split(' where ')[0] ?? '').matchAll(/"([^"]+)" = \$(\d+)/g)) row[match[1] ?? ''] = params[Number(match[2]) - 1];
        return rows([row], sql.split(' returning ')[1] ?? '');
      }
      if (sql.startsWith('insert into "app_migration_commit"')) {
        if (behavior === 'receipt-insert-failed') throw new Error('Synthetic failed terminal receipt insert');
        const columns = values(sql.split('(')[1]?.split(')')[0] ?? '');
        const record = Object.fromEntries(columns.map((name, index) => [name, params[index]]));
        if (receipts.some((existing) => existing.request_id === record.request_id || existing.stage_id === record.stage_id))
          throw new Error('Duplicate install receipt');
        receipts.push(record);
        terminalWrite = true;
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('insert into "app_migration"')) {
        if (behavior === 'insert-failed') throw new Error('Synthetic failed migration insert');
        for (let index = 0; index < params.length; index += 2) {
          if (params[index] !== row.id || typeof params[index + 1] !== 'string') throw new Error('Invalid baseline insert');
          ids.push(String(params[index + 1]));
        }
        ids.sort();
        return { rows: [], rowCount: params.length / 2 };
      }
      throw new Error('Unexpected baseline SQL');
    },
  } as unknown as Client;
  return {
    database: drizzle({ client, schema }),
    queries,
    receipts: () => receipts,
    row: () => row,
    ids: () => ids,
    setIds: (next: string[]) => {
      ids = [...next].sort();
    },
    behavior: (next: string) => {
      behavior = next;
    },
  };
}
