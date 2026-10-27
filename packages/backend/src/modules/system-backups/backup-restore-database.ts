import { Client, type ClientConfig } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { backupDatabaseColumns, backupDatabaseTables } from './backup-database-records';
import { invalidRestoreDatabase, readNormalizedBackupDatabase, type NormalizedBackupDatabase } from './backup-normalized-database';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
export type RestoreDatabaseConnection = { host: string; port: number; user: string; password: string; database: string };
export type RestoreDatabaseOwner = { name: string; oid: number; marker: string };
type Preparation = {
  id: string;
  nonce: string;
  connection: RestoreDatabaseConnection;
  trustedMigrationsFolder: string;
  source: NormalizedBackupDatabase;
  signal: AbortSignal;
  onCreated: (owner: RestoreDatabaseOwner) => Promise<void>;
  progress: (records: number, total: number) => void;
};

function identity(id: string, nonce: string) {
  if (!uuid.test(id) || !uuid.test(nonce)) throw invalidRestoreDatabase();
  return { name: `orbis_restore_${id.replaceAll('-', '')}`, marker: `orbis.restore.v1/${id}/${nonce}` };
}

async function connect(connection: RestoreDatabaseConnection, database: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const options: ClientConfig = {
    ...connection,
    database,
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
    statement_timeout: 30_000,
    application_name: 'orbis_restore',
  };
  const client = new Client(options);
  // A socket failure outside a query must not become an unhandled EventEmitter error.
  client.on('error', () => undefined);
  const abort = () => {
    void client.end().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    await client.connect();
    signal.throwIfAborted();
    return {
      client,
      close: async () => {
        signal.removeEventListener('abort', abort);
        await client.end();
      },
    };
  } catch {
    signal.removeEventListener('abort', abort);
    await client.end().catch(() => undefined);
    throw invalidRestoreDatabase();
  }
}

async function ownedDatabase(client: Client, name: string, marker: string, username: string, oid?: number) {
  const result = await client.query<{ oid: number; owner: string; marker: string | null }>(
    "SELECT oid, pg_catalog.pg_get_userbyid(datdba) AS owner, pg_catalog.shobj_description(oid, 'pg_database') AS marker FROM pg_catalog.pg_database WHERE datname=$1",
    [name],
  );
  if (!result.rowCount) return undefined;
  const row = result.rows[0];
  if (
    !row ||
    !Number.isSafeInteger(row.oid) ||
    row.oid < 1 ||
    row.owner !== username ||
    row.marker !== marker ||
    (oid !== undefined && row.oid !== oid)
  )
    throw invalidRestoreDatabase();
  return { name, oid: row.oid, marker };
}

export async function verifyRestoreDatabase(options: {
  id: string;
  nonce: string;
  connection: RestoreDatabaseConnection;
  owner: RestoreDatabaseOwner;
  counts: Record<(typeof backupDatabaseTables)[number], number>;
  signal: AbortSignal;
}) {
  const expected = identity(options.id, options.nonce);
  if (options.owner.name !== expected.name || options.owner.marker !== expected.marker || expected.name === options.connection.database)
    throw invalidRestoreDatabase();
  const control = await connect(options.connection, options.connection.database, options.signal);
  let target: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    if (!(await ownedDatabase(control.client, expected.name, expected.marker, options.connection.user, options.owner.oid)))
      throw invalidRestoreDatabase();
    target = await connect(options.connection, expected.name, options.signal);
    for (const table of backupDatabaseTables) {
      const expectedCount = options.counts[table];
      if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) throw invalidRestoreDatabase();
      const result = await target.client.query(`SELECT count(*)::integer AS count FROM public.${quote(table)}`);
      if (result.rows[0]?.count !== expectedCount) throw invalidRestoreDatabase();
    }
    const active = await target.client.query("SELECT count(*)::integer AS count FROM public.app WHERE status <> 'stopped'");
    if (active.rows[0]?.count !== 0) throw invalidRestoreDatabase();
  } catch {
    throw invalidRestoreDatabase();
  } finally {
    try {
      await target?.close();
    } finally {
      await control.close();
    }
  }
}

export async function removeRestoreDatabase(options: {
  id: string;
  nonce: string;
  connection: RestoreDatabaseConnection;
  owner: RestoreDatabaseOwner;
  signal: AbortSignal;
}) {
  const expected = identity(options.id, options.nonce);
  if (options.owner.name !== expected.name || options.owner.marker !== expected.marker || expected.name === options.connection.database)
    throw invalidRestoreDatabase();
  const connection = await connect(options.connection, options.connection.database, options.signal);
  try {
    const owner = await ownedDatabase(connection.client, expected.name, expected.marker, options.connection.user, options.owner.oid);
    if (!owner) return false;
    options.signal.throwIfAborted();
    await connection.client.query(`DROP DATABASE ${quote(owner.name)} WITH (FORCE)`);
    return true;
  } catch {
    throw invalidRestoreDatabase();
  } finally {
    await connection.close();
  }
}

export async function prepareRestoreDatabase(options: Preparation) {
  const { connection: current, source, signal } = options;
  const expected = identity(options.id, options.nonce);
  if (current.database === expected.name) throw invalidRestoreDatabase();
  // Validate before allocating a database, then verify the exact bytes again inside the insertion transaction.
  try {
    await readNormalizedBackupDatabase(source, signal);
  } catch {
    throw invalidRestoreDatabase();
  }
  const control = await connect(current, current.database, signal);
  let owner: RestoreDatabaseOwner | undefined;
  let target: Awaited<ReturnType<typeof connect>> | undefined;
  let complete = false;
  try {
    const existing = await control.client.query('SELECT 1 FROM pg_catalog.pg_database WHERE datname=$1', [expected.name]);
    if (existing.rowCount) throw invalidRestoreDatabase();
    signal.throwIfAborted();
    await control.client.query(`CREATE DATABASE ${quote(expected.name)} WITH OWNER ${quote(current.user)} TEMPLATE template0 ENCODING 'UTF8'`);
    // A crash before this marker is saved leaves an unverified empty database; never delete it by name alone.
    await control.client.query(`COMMENT ON DATABASE ${quote(expected.name)} IS '${expected.marker}'`);
    owner = await ownedDatabase(control.client, expected.name, expected.marker, current.user);
    if (!owner) throw invalidRestoreDatabase();
    await options.onCreated(owner);
    target = await connect(current, owner.name, signal);
    await migrate(drizzle(target.client), { migrationsFolder: options.trustedMigrationsFolder });
    signal.throwIfAborted();
    await target.client.query('BEGIN');
    await target.client.query(`TRUNCATE ${backupDatabaseTables.map((table) => `public.${quote(table)}`).join(',')} RESTART IDENTITY`);
    let records = 0;
    const total = Object.values(source.expected.counts).reduce((sum, count) => sum + count, 0);
    const client = target.client;
    await readNormalizedBackupDatabase(source, signal, async (table, row) => {
      signal.throwIfAborted();
      const columns = backupDatabaseColumns(table);
      const values = columns.map((column) => (table === 'app' && column === 'status' ? 'stopped' : row[column]));
      await client.query(
        `INSERT INTO public.${quote(table)} (${columns.map(quote).join(',')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')})`,
        values,
      );
      options.progress(++records, total);
    });
    for (const table of ['user', 'app', 'link'] as const) {
      signal.throwIfAborted();
      // The legacy app sequence has no OWNED BY link, so pg_get_serial_sequence returns null.
      await client.query(`SELECT pg_catalog.setval($1::regclass,COALESCE(max(id),1),max(id) IS NOT NULL) FROM public.${quote(table)}`, [
        `public.${quote(`${table}_id_seq`)}`,
      ]);
    }
    for (const table of backupDatabaseTables) {
      const count = await client.query<{ count: string }>(`SELECT count(*) AS count FROM public.${quote(table)}`);
      if (Number(count.rows[0]?.count) !== source.expected.counts[table]) throw invalidRestoreDatabase();
    }
    signal.throwIfAborted();
    await client.query('COMMIT');
    complete = true;
    return owner;
  } catch {
    throw invalidRestoreDatabase();
  } finally {
    try {
      await target?.close();
    } finally {
      try {
        await control.close();
      } finally {
        if (!complete && owner)
          await removeRestoreDatabase({ id: options.id, nonce: options.nonce, connection: current, owner, signal: AbortSignal.timeout(30_000) });
      }
    }
  }
}
