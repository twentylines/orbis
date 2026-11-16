import { createHash } from 'node:crypto';
import type { Client } from 'pg';
import {
  BackupDatabaseRecords,
  backupDatabaseColumns,
  backupDatabaseLimits,
  backupDatabaseTables,
  type BackupDatabaseTable,
} from './backup-database-records';
import { canonicalCoreJson } from './time-machine-core-payload';

export const coreDatabasePolicy = Object.freeze({
  schema: 'orbis.core-database-reconciliation.v1',
  source: ['user', 'link'],
  destination: ['app_store', 'app', 'orbis_reset_receipt'],
  compatibility: 'exact-catalog-and-postgresql-major',
  queue: 'preserve-current-drained',
  activation: false,
});
const hash = (value: unknown) => createHash('sha256').update(canonicalCoreJson(value)).digest('hex');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
type Query = Pick<Client, 'query'>;
type Row = Record<string, unknown>;
type Catalog = Record<'tables' | 'columns' | 'enums' | 'constraints' | 'indexes' | 'sequences' | 'extensions', Row[]>;
type Rows = Record<BackupDatabaseTable | 'orbis_reset_receipt' | '__drizzle_migrations', Row[]>;
type Snapshot = { schema: 'orbis.core-database-snapshot.v1'; major: number; database: string; catalog: Catalog; rows: Rows; sha256: string };
declare const coreDatabaseSnapshot: unique symbol;
export type CoreDatabaseSnapshot = { readonly [coreDatabaseSnapshot]: true };
type Captured = { client: Query; snapshot: Snapshot; authenticationSha256: string; recheck: (inTransaction?: boolean) => Promise<void> };
const snapshots = new WeakMap<CoreDatabaseSnapshot, Captured>();

export class CoreDatabaseCompatibilityError extends Error {
  constructor(readonly reason: 'catalog' | 'major' | 'records' | 'authentication' | 'changed' | 'approval' | 'receipt' | 'ownership') {
    super(`The captured database cannot preserve this destination (${reason}). Existing server data was preserved.`);
  }
}
function fail(reason: CoreDatabaseCompatibilityError['reason']): never {
  throw new CoreDatabaseCompatibilityError(reason);
}
const schemaQueries = {
  tables: `SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind,c.relpersistence AS persistence,c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f') ORDER BY 1,2`,
  columns: `SELECT n.nspname AS schema,c.relname AS table,a.attname AS name,a.attnum AS position,t.typname AS type,tn.nspname AS type_schema,
    pg_catalog.format_type(a.atttypid,a.atttypmod) AS format,a.attnotnull AS not_null,a.attidentity AS identity,a.attgenerated AS generated,
    pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_type t ON t.oid=a.atttypid JOIN pg_catalog.pg_namespace tn ON tn.oid=t.typnamespace
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY 1,2,4`,
  enums: `SELECT n.nspname AS schema,t.typname AS name,e.enumlabel AS label,e.enumsortorder::text AS position
    FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace JOIN pg_catalog.pg_enum e ON e.enumtypid=t.oid
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' ORDER BY 1,2,e.enumsortorder`,
  constraints: `SELECT n.nspname AS schema,c.relname AS table,k.conname AS name,k.contype AS type,k.convalidated AS validated,
    pg_catalog.pg_get_constraintdef(k.oid,true) AS definition
    FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' ORDER BY 1,2,3`,
  indexes: `SELECT schemaname AS schema,tablename AS table,indexname AS name,indexdef AS definition FROM pg_catalog.pg_indexes
    WHERE schemaname !~ '^pg_' AND schemaname <> 'information_schema' ORDER BY 1,2,3`,
  sequences: `SELECT schemaname AS schema,sequencename AS name,data_type::text AS type,start_value::text AS start,
    min_value::text AS min,max_value::text AS max,increment_by::text AS increment,cycle,cache_size::text AS cache
    FROM pg_catalog.pg_sequences WHERE schemaname !~ '^pg_' AND schemaname <> 'information_schema' ORDER BY 1,2`,
  extensions: 'SELECT extname AS name,extversion AS version FROM pg_catalog.pg_extension ORDER BY 1',
};
async function catalog(client: Query, signal: AbortSignal): Promise<Catalog> {
  const result = {} as Catalog;
  for (const name of Object.keys(schemaQueries) as (keyof Catalog)[]) {
    signal.throwIfAborted();
    const response = await client.query(schemaQueries[name]);
    if (response.rows.length > 4096) fail('catalog');
    result[name] = response.rows;
  }
  // pg_dump removes dropped-column slots. Bind live column order, not physical attnum gaps.
  const positions = new Map<string, { physical: number; logical: number }>();
  result.columns = result.columns.map((column) => {
    if (typeof column.schema !== 'string' || typeof column.table !== 'string') fail('catalog');
    const key = `${column.schema}\0${column.table}`;
    const previous = positions.get(key) ?? { physical: 0, logical: 0 };
    if (!Number.isInteger(column.position) || (column.position as number) <= previous.physical || (column.position as number) > 32767)
      fail('catalog');
    const logical = previous.logical + 1;
    positions.set(key, { physical: column.position as number, logical });
    return { ...column, position: logical };
  });
  const names = result.tables.map((row) => `${row.schema}.${row.name}`).sort();
  if (
    names.join(',') !==
      ['drizzle.__drizzle_migrations', 'public.app', 'public.app_store', 'public.link', 'public.orbis_reset_receipt', 'public.user']
        .sort()
        .join(',') ||
    result.tables.some((row) => row.kind !== 'r' || row.persistence !== 'p' || row.rls !== false || row.force_rls !== false) ||
    result.columns.some(
      (row) =>
        row.generated !== '' ||
        row.identity !== '' ||
        !(
          (row.type_schema === 'pg_catalog' && ['int4', 'int8', 'varchar', 'text', 'bool', 'jsonb'].includes(row.type as string)) ||
          (row.type_schema === 'public' && ['app_status_enum', 'update_status_enum'].includes(row.type as string))
        ),
    ) ||
    result.constraints.some((row) => row.validated !== true || !['p', 'u', 'f', 'c'].includes(row.type as string)) ||
    result.extensions.length !== 1 ||
    result.extensions[0]?.name !== 'plpgsql'
  )
    fail('catalog');
  for (const table of backupDatabaseTables) {
    const actual = result.columns
      .filter((row) => row.schema === 'public' && row.table === table)
      .map((row) => row.name)
      .sort();
    if (canonicalCoreJson(actual) !== canonicalCoreJson(backupDatabaseColumns(table).sort())) fail('catalog');
  }
  for (const [schema, table, columns] of [
    ['public', 'orbis_reset_receipt', ['id', 'completed_at']],
    ['drizzle', '__drizzle_migrations', ['id', 'hash', 'created_at']],
  ] as const) {
    if (
      canonicalCoreJson(result.columns.filter((row) => row.schema === schema && row.table === table).map((row) => row.name)) !==
      canonicalCoreJson(columns)
    )
      fail('catalog');
  }
  const executable = await client.query(`SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
    UNION ALL SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND NOT t.tgisinternal
    UNION ALL SELECT 1 FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid=r.ev_class
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' LIMIT 1`);
  if (executable.rows.length) fail('catalog');
  return result;
}
async function contents(client: Query, signal: AbortSignal) {
  const result = await client.query("SELECT current_database() AS database,current_setting('server_version_num')::integer AS version");
  const version = result.rows[0]?.version;
  const database = result.rows[0]?.database;
  if (!Number.isInteger(version) || version < 140000 || typeof database !== 'string' || !database || Buffer.byteLength(database) > 63) fail('major');
  const structure = await catalog(client, signal);
  const rows = {} as Rows;
  let bytes = 0;
  let count = 0;
  for (const table of [...backupDatabaseTables, 'orbis_reset_receipt', '__drizzle_migrations'] as const) {
    signal.throwIfAborted();
    const schema = table === '__drizzle_migrations' ? 'drizzle' : 'public';
    const selected = await client.query(`SELECT * FROM ${quote(schema)}.${quote(table)} LIMIT ${backupDatabaseLimits.rows + 1}`);
    count += selected.rows.length;
    bytes += Buffer.byteLength(canonicalCoreJson(selected.rows));
    if (count > backupDatabaseLimits.rows || bytes > backupDatabaseLimits.totalBytes) fail('records');
    rows[table] = selected.rows.sort((a, b) => canonicalCoreJson(a).localeCompare(canonicalCoreJson(b), 'en'));
  }
  const body = { schema: 'orbis.core-database-snapshot.v1' as const, major: Math.floor(version / 10000), database, catalog: structure, rows };
  return { ...body, sha256: hash(body) };
}
async function records(snapshot: Snapshot, authentication: { jwtSecret: string; passkeys?: unknown }, signal: AbortSignal) {
  const validator = new BackupDatabaseRecords(authentication.jwtSecret);
  try {
    for (const table of backupDatabaseTables) for (const row of snapshot.rows[table]) validator.accept(table, row);
    await validator.finish(authentication.passkeys, signal);
  } catch {
    fail('authentication');
  }
  const stores = new Set(snapshot.rows.app_store.map((row) => row.slug));
  if (snapshot.rows.app.some((row) => !stores.has(row.app_store_slug) || !['running', 'stopped'].includes(row.status as string))) fail('records');
  for (const row of snapshot.rows.orbis_reset_receipt) {
    if (
      Object.keys(row).sort().join(',') !== 'completed_at,id' ||
      typeof row.id !== 'string' ||
      !uuid.test(row.id) ||
      !Number.isInteger(row.completed_at) ||
      (row.completed_at as number) < 1
    )
      fail('records');
  }
}

/** Reads data only. The caller must independently prove socket/container isolation before applying to a copied candidate. */
export async function inspectCoreDatabase(options: {
  client: Query;
  authentication: { jwtSecret: string; passkeys?: unknown };
  signal: AbortSignal;
}) {
  const { client, authentication, signal } = options;
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  let snapshot: Snapshot;
  try {
    snapshot = await contents(client, signal);
    await records(snapshot, authentication, signal);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
  const token = Object.freeze(Object.create(null)) as CoreDatabaseSnapshot;
  snapshots.set(token, {
    client,
    snapshot,
    authenticationSha256: hash(authentication),
    recheck: async (inTransaction = false) => {
      if (!inTransaction) await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        if ((await contents(client, signal)).sha256 !== snapshot.sha256) fail('changed');
        if (!inTransaction) await client.query('COMMIT');
      } catch (error) {
        if (!inTransaction) await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    },
  });
  return {
    token,
    summary: Object.freeze({
      schema: snapshot.schema,
      sha256: snapshot.sha256,
      major: snapshot.major,
      catalogSha256: hash(snapshot.catalog),
      rows: Object.fromEntries(Object.entries(snapshot.rows).map(([name, rows]) => [name, rows.length])),
    }),
  };
}
export type CoreDatabaseReconciliation = {
  schema: 'orbis.core-database-reconciliation.v1';
  id: string;
  nonce: string;
  sourceSha256: string;
  destinationSha256: string;
  catalogSha256: string;
  authenticationSha256: string;
  sourceAccountsSha256: string;
  destinationAppsSha256: string;
  destinationRecoverySha256: string;
  database: string;
  major: number;
  marker: string;
};

export async function inspectCoreDatabaseStructure(client: Query, signal: AbortSignal) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const snapshot = await contents(client, signal);
    await client.query('COMMIT');
    return Object.freeze({
      schema: 'orbis.core-database-structure.v1' as const,
      sha256: snapshot.sha256,
      major: snapshot.major,
      catalogSha256: hash(snapshot.catalog),
      rows: Object.fromEntries(Object.entries(snapshot.rows).map(([name, rows]) => [name, rows.length])),
      authenticationVerified: false as const,
      restoreAuthority: false as const,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export async function requireCoreSourceOwner(token: CoreDatabaseSnapshot, sourceOwnerId: number) {
  const captured = snapshots.get(token);
  if (!captured || !Number.isSafeInteger(sourceOwnerId) || sourceOwnerId < 1 || sourceOwnerId > 2147483647) fail('ownership');
  const owner = captured.snapshot.rows.user.find((row) => row.id === sourceOwnerId);
  if (owner?.operator !== true) fail('ownership');
  await captured.recheck();
  return Object.freeze({
    schema: 'orbis.core-source-owner.v1' as const,
    sourceOwnerId,
    sourceSha256: captured.snapshot.sha256,
    identitySha256: hash({ id: owner.id, username: owner.username, createdAt: owner.created_at }),
    authenticationSha256: captured.authenticationSha256,
    restoreAuthority: false as const,
  });
}

export type CoreSourceBootstrapEvidence = Readonly<{
  schema: 'orbis.core-source-bootstrap-evidence.v1';
  sourceSha256: string;
  catalogSha256: string;
  authenticationSha256: string;
  sourceOwnerId: number;
  identitySha256: string;
  database: string;
  systemIdentifier: string;
  migrationLedger: readonly Readonly<{ id: number; hash: string; created_at: string }>[];
  authenticationVerified: true;
  environmentProved: false;
  restoreAuthority: false;
}>;

export async function coreSourceBootstrapEvidence(token: CoreDatabaseSnapshot, sourceOwnerId: number): Promise<CoreSourceBootstrapEvidence> {
  try {
    return await capturedSourceBootstrapEvidence(token, sourceOwnerId);
  } catch (error) {
    if (error instanceof CoreDatabaseCompatibilityError) throw error;
    fail('changed');
  }
}

export type CoreSourceCatalogBootstrapEvidence = Readonly<
  Omit<CoreSourceBootstrapEvidence, 'schema'> & {
    schema: 'orbis.core-source-bootstrap-evidence.v2';
    catalogUserIdentities: readonly Readonly<{ ownerId: number; identitySha256: string }>[];
  }
>;

export async function coreSourceCatalogBootstrapEvidence(
  token: CoreDatabaseSnapshot,
  sourceOwnerId: number,
): Promise<CoreSourceCatalogBootstrapEvidence> {
  const evidence = await coreSourceBootstrapEvidence(token, sourceOwnerId);
  const captured = snapshots.get(token);
  if (!captured) fail('ownership');
  const catalogUserIdentities = captured.snapshot.rows.user
    .map((row) => {
      if (!Number.isSafeInteger(row.id) || (row.id as number) < 1 || (row.id as number) > 2147483647) fail('ownership');
      return Object.freeze({
        ownerId: row.id as number,
        identitySha256: hash({ id: row.id, username: row.username, createdAt: row.created_at }),
      });
    })
    .sort((a, b) => a.ownerId - b.ownerId);
  if (catalogUserIdentities.some((row, index) => index > 0 && row.ownerId === catalogUserIdentities[index - 1]?.ownerId)) fail('ownership');
  if (catalogUserIdentities.find((row) => row.ownerId === sourceOwnerId)?.identitySha256 !== evidence.identitySha256) fail('ownership');
  await captured.recheck();
  return Object.freeze({
    ...evidence,
    schema: 'orbis.core-source-bootstrap-evidence.v2',
    catalogUserIdentities: Object.freeze(catalogUserIdentities),
  });
}

async function capturedSourceBootstrapEvidence(token: CoreDatabaseSnapshot, sourceOwnerId: number): Promise<CoreSourceBootstrapEvidence> {
  const owner = await requireCoreSourceOwner(token, sourceOwnerId);
  const captured = snapshots.get(token);
  if (!captured) fail('ownership');
  const rows = captured.snapshot.rows.__drizzle_migrations;
  if (rows.length < 1 || rows.length > 4096) fail('records');
  const migrationLedger = rows.map((row) => {
    if (
      Object.keys(row).sort().join(',') !== 'created_at,hash,id' ||
      !Number.isInteger(row.id) ||
      (row.id as number) < 1 ||
      (row.id as number) > 2147483647 ||
      typeof row.hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.hash) ||
      typeof row.created_at !== 'string' ||
      !/^[1-9][0-9]{0,15}$/.test(row.created_at) ||
      !Number.isSafeInteger(Number(row.created_at))
    )
      fail('records');
    return Object.freeze({ id: row.id as number, hash: row.hash, created_at: row.created_at });
  });
  migrationLedger.sort((left, right) => left.id - right.id);
  if (migrationLedger.some((row, index) => index > 0 && row.id <= (migrationLedger[index - 1]?.id ?? 0))) fail('records');
  const client = captured.client;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const before = await cleanDatabaseIdentity(client);
    if (before.database !== captured.snapshot.database) fail('changed');
    await captured.recheck(true);
    const after = await cleanDatabaseIdentity(client);
    if (!sameIdentity(before, after)) fail('changed');
    await client.query('COMMIT');
    return Object.freeze({
      schema: 'orbis.core-source-bootstrap-evidence.v1' as const,
      sourceSha256: owner.sourceSha256,
      catalogSha256: hash(captured.snapshot.catalog),
      authenticationSha256: owner.authenticationSha256,
      sourceOwnerId,
      identitySha256: owner.identitySha256,
      database: before.database,
      systemIdentifier: before.systemIdentifier,
      migrationLedger: Object.freeze(migrationLedger),
      authenticationVerified: true as const,
      environmentProved: false as const,
      restoreAuthority: false as const,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof CoreDatabaseCompatibilityError) throw error;
    fail('changed');
  }
}

/** Compatibility gate for historical targets whose catalog access uses numeric owners.
 * Cross-identity restore requires a separate Root ownership transition, not rewritten capture receipts. */
export async function requireCoreCatalogOwnership(options: {
  source: CoreDatabaseSnapshot;
  destination: CoreDatabaseSnapshot;
  sourceOwnerId: number;
  destinationOwnerId: number;
  catalogOwnerIds: readonly number[];
}) {
  const source = snapshots.get(options.source);
  const destination = snapshots.get(options.destination);
  const valid = (id: number) => Number.isSafeInteger(id) && id > 0 && id <= 2147483647;
  if (
    !source ||
    !destination ||
    !valid(options.sourceOwnerId) ||
    !valid(options.destinationOwnerId) ||
    !Array.isArray(options.catalogOwnerIds) ||
    options.catalogOwnerIds.length > backupDatabaseLimits.rows ||
    options.catalogOwnerIds.some((id) => !valid(id))
  )
    fail('ownership');
  if (options.sourceOwnerId !== options.destinationOwnerId) fail('ownership');
  const before = new Map(destination.snapshot.rows.user.map((row) => [row.id as number, row]));
  const after = new Map(source.snapshot.rows.user.map((row) => [row.id as number, row]));
  const actorBefore = before.get(options.destinationOwnerId);
  const actorAfter = after.get(options.sourceOwnerId);
  if (actorBefore?.operator !== true || actorAfter?.operator !== true) fail('ownership');
  const owners = [...new Set([options.destinationOwnerId, ...before.keys(), ...options.catalogOwnerIds])].sort((a, b) => a - b);
  const identities = owners.map((id) => {
    const original = before.get(id);
    const restored = after.get(id);
    if (!original || !restored || original.username !== restored.username || original.created_at !== restored.created_at) fail('ownership');
    return { ownerId: id, identitySha256: hash({ id, username: original.username, createdAt: original.created_at }) };
  });
  await source.recheck();
  await destination.recheck();
  return Object.freeze({
    schema: 'orbis.core-catalog-ownership-compatibility.v1' as const,
    sourceSha256: source.snapshot.sha256,
    destinationSha256: destination.snapshot.sha256,
    sourceOwnerId: options.sourceOwnerId,
    destinationOwnerId: options.destinationOwnerId,
    owners: Object.freeze(identities.map(Object.freeze)),
    aliases: false as const,
    restoreAuthority: false as const,
  });
}

/** Mutates only the independently isolated copied source database. No live admission or activation is granted here. */
export async function reconcileCoreDatabase(options: {
  id: string;
  nonce: string;
  source: CoreDatabaseSnapshot;
  destination: CoreDatabaseSnapshot;
  signal: AbortSignal;
  authorize: (prepared: Readonly<CoreDatabaseReconciliation>) => Promise<void>;
  committed: (prepared: Readonly<CoreDatabaseReconciliation>) => Promise<void>;
}) {
  if (!uuid.test(options.id) || !uuid.test(options.nonce)) fail('approval');
  const source = snapshots.get(options.source);
  const destination = snapshots.get(options.destination);
  if (!source || !destination || source.client === destination.client) fail('approval');
  if (source.snapshot.major !== destination.snapshot.major) fail('major');
  if (canonicalCoreJson(source.snapshot.catalog) !== canonicalCoreJson(destination.snapshot.catalog)) fail('catalog');
  const sourceAccountsSha256 = hash({
    user: source.snapshot.rows.user,
    link: source.snapshot.rows.link,
    migrations: source.snapshot.rows.__drizzle_migrations,
  });
  const destinationAppsSha256 = hash({ app: destination.snapshot.rows.app, app_store: destination.snapshot.rows.app_store });
  const descriptor = {
    schema: 'orbis.core-database-reconciliation.v1' as const,
    id: options.id,
    nonce: options.nonce,
    sourceSha256: source.snapshot.sha256,
    destinationSha256: destination.snapshot.sha256,
    catalogSha256: hash(source.snapshot.catalog),
    authenticationSha256: source.authenticationSha256,
    sourceAccountsSha256,
    destinationAppsSha256,
    destinationRecoverySha256: hash(destination.snapshot.rows.orbis_reset_receipt),
    database: source.snapshot.database,
    major: source.snapshot.major,
  };
  const prepared = Object.freeze({ ...descriptor, marker: `orbis.core-restore.v1/${options.id}/${options.nonce}/${hash(descriptor)}` });
  await options.authorize(prepared);
  await destination.recheck();
  const client = source.client;
  let committed = false;
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    await client.query('LOCK TABLE public.app,public.app_store,public.orbis_reset_receipt IN ACCESS EXCLUSIVE MODE');
    await source.recheck(true);
    const comment = await client.query(
      "SELECT pg_catalog.shobj_description(oid,'pg_database') AS marker FROM pg_catalog.pg_database WHERE datname=current_database()",
    );
    if (typeof comment.rows[0]?.marker === 'string' && comment.rows[0].marker.startsWith('orbis.core-restore.v1/')) fail('receipt');
    for (const table of ['app', 'app_store', 'orbis_reset_receipt'] as const) await client.query(`DELETE FROM public.${quote(table)}`);
    for (const table of ['app_store', 'app', 'orbis_reset_receipt'] as const) {
      const columns = table === 'orbis_reset_receipt' ? ['id', 'completed_at'] : backupDatabaseColumns(table);
      for (const row of destination.snapshot.rows[table]) {
        options.signal.throwIfAborted();
        await client.query(
          `INSERT INTO public.${quote(table)} (${columns.map(quote).join(',')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')})`,
          columns.map((name) => row[name]),
        );
      }
    }
    await client.query(
      "SELECT pg_catalog.setval(pg_catalog.pg_get_serial_sequence('public.app','id'),COALESCE((SELECT max(id) FROM public.app),1),(SELECT count(*)>0 FROM public.app))",
    );
    await client.query(`COMMENT ON DATABASE ${quote(source.snapshot.database)} IS '${prepared.marker}'`);
    await verifyCoreDatabaseReconciliation(client, prepared, options.signal);
    await destination.recheck();
    options.signal.throwIfAborted();
    await client.query('COMMIT');
    committed = true;
    await options.committed(prepared);
    snapshots.delete(options.source);
    return prepared;
  } finally {
    if (!committed) await client.query('ROLLBACK').catch(() => undefined);
  }
}

/** After a crash, compare actual copied data and its committed marker; never replay writes from a journal phase alone. */
export async function verifyCoreDatabaseReconciliation(client: Query, prepared: Readonly<CoreDatabaseReconciliation>, signal: AbortSignal) {
  const actual = await contents(client, signal);
  const result = await client.query(
    "SELECT pg_catalog.shobj_description(oid,'pg_database') AS marker FROM pg_catalog.pg_database WHERE datname=current_database()",
  );
  if (
    actual.database !== prepared.database ||
    actual.major !== prepared.major ||
    hash(actual.catalog) !== prepared.catalogSha256 ||
    hash({ user: actual.rows.user, link: actual.rows.link, migrations: actual.rows.__drizzle_migrations }) !== prepared.sourceAccountsSha256 ||
    hash({ app: actual.rows.app, app_store: actual.rows.app_store }) !== prepared.destinationAppsSha256 ||
    hash(actual.rows.orbis_reset_receipt) !== prepared.destinationRecoverySha256 ||
    result.rows[0]?.marker !== prepared.marker
  )
    fail('receipt');
  return true;
}

export type CoreCleanTargetIdentity = Readonly<{ systemIdentifier: string; databaseOid: string; database: string }>;
export type CoreCleanTargetReconciliationV1 = Readonly<{
  schema: 'orbis.core-clean-target-reconciliation.v1';
  id: string;
  nonce: string;
  sourceIdentity: CoreCleanTargetIdentity;
  destinationIdentity: CoreCleanTargetIdentity;
  targetIdentity: CoreCleanTargetIdentity;
  sourceSha256: string;
  destinationSha256: string;
  catalogSha256: string;
  authenticationSha256: string;
  sourceAccountsSha256: string;
  destinationAppsSha256: string;
  destinationRecoverySha256: string;
  sourceOwnerId: number;
  destinationOwnerId: number;
  catalogOwnershipSha256: string;
  catalogContext: 'pg_catalog';
  major: number;
  environmentProved: false;
  restoreAuthority: false;
  marker: string;
}>;
export type CoreCleanTargetSequencePolicy = Readonly<{
  schema: 'orbis.core-clean-target-sequence-policy.v2';
  sourceControllerImageId: string;
  catalogSha256: string;
}>;
export type CoreCleanTargetReconciliationV2 = Readonly<
  Omit<CoreCleanTargetReconciliationV1, 'schema'> & {
    schema: 'orbis.core-clean-target-reconciliation.v2';
    sequencePolicy: CoreCleanTargetSequencePolicy;
  }
>;
export type CoreCleanTargetReconciliation = CoreCleanTargetReconciliationV1 | CoreCleanTargetReconciliationV2;
const cleanMarkerPrefix = 'orbis.core-clean-target.v1/';
const cleanMarkerPrefixV2 = 'orbis.core-clean-target.v2/';
function checkedSequencePolicy(value: CoreCleanTargetSequencePolicy): CoreCleanTargetSequencePolicy {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'catalogSha256,schema,sourceControllerImageId' ||
    value.schema !== 'orbis.core-clean-target-sequence-policy.v2' ||
    typeof value.sourceControllerImageId !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(value.sourceControllerImageId) ||
    typeof value.catalogSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.catalogSha256)
  )
    fail('approval');
  return Object.freeze({ ...value });
}
const cleanCatalogContext = 'pg_catalog' as const;
async function requireCleanCatalogContext(...clients: Query[]) {
  for (const client of clients) {
    const result = await client.query("SELECT pg_catalog.current_setting('search_path') AS search_path");
    if (result.rows.length !== 1 || result.rows[0]?.search_path !== cleanCatalogContext) fail('catalog');
  }
}
const cleanTables = ['user', 'link', 'app_store', 'app', 'orbis_reset_receipt'] as const;
const cleanLocks =
  'LOCK TABLE public."user",public.link,public.app_store,public.app,public.orbis_reset_receipt,drizzle.__drizzle_migrations IN ACCESS EXCLUSIVE MODE';
const databaseMarkerQuery =
  "SELECT pg_catalog.shobj_description(oid,'pg_database') AS marker FROM pg_catalog.pg_database WHERE datname=current_database()";
const sameIdentity = (left: CoreCleanTargetIdentity, right: CoreCleanTargetIdentity) => canonicalCoreJson(left) === canonicalCoreJson(right);
function validDatabaseIdentity(value: CoreCleanTargetIdentity) {
  return (
    value &&
    typeof value.systemIdentifier === 'string' &&
    /^[1-9][0-9]{0,19}$/.test(value.systemIdentifier) &&
    BigInt(value.systemIdentifier) <= 18446744073709551615n &&
    typeof value.databaseOid === 'string' &&
    /^[1-9][0-9]{0,9}$/.test(value.databaseOid) &&
    BigInt(value.databaseOid) <= 4294967295n &&
    typeof value.database === 'string' &&
    value.database.length > 0 &&
    !value.database.includes('\0') &&
    Buffer.byteLength(value.database) <= 63
  );
}
async function cleanDatabaseIdentity(client: Query): Promise<CoreCleanTargetIdentity> {
  const result = await client.query(`SELECT control.system_identifier::text AS system_identifier,d.oid::text AS database_oid,d.datname AS database
    FROM pg_catalog.pg_control_system() AS control CROSS JOIN pg_catalog.pg_database d WHERE d.datname=pg_catalog.current_database()`);
  const row = result.rows[0];
  const identity = { systemIdentifier: row?.system_identifier, databaseOid: row?.database_oid, database: row?.database };
  if (result.rows.length !== 1 || !validDatabaseIdentity(identity)) fail('receipt');
  return Object.freeze(identity);
}
type CleanSequence = { schema: string; name: string; table: string; start: string };
const legacyAppDefault = "nextval('public.app_id_seq'::regclass)";
async function legacyAppSequence(client: Query, structure: Catalog) {
  const columns = structure.columns.filter((row) => row.schema === 'public' && row.table === 'app' && row.name === 'id');
  const definition = structure.sequences.find((row) => row.schema === 'public' && row.name === 'app_id_seq');
  if (
    columns.length !== 1 ||
    columns[0]?.type !== 'int4' ||
    columns[0]?.type_schema !== 'pg_catalog' ||
    columns[0]?.default !== legacyAppDefault ||
    !definition ||
    definition.type !== 'bigint' ||
    definition.start !== '1' ||
    definition.min !== '1' ||
    definition.max !== '9223372036854775807' ||
    definition.increment !== '1' ||
    definition.cache !== '1' ||
    definition.cycle !== false
  )
    fail('catalog');
  const ownership = await client.query(`SELECT 1 FROM pg_catalog.pg_depend
    WHERE classid='pg_catalog.pg_class'::pg_catalog.regclass AND objid='public.app_id_seq'::pg_catalog.regclass
    AND refclassid='pg_catalog.pg_class'::pg_catalog.regclass AND refobjsubid>0 AND deptype IN ('a','i') LIMIT 1`);
  if (ownership.rows.length) fail('catalog');
  const references =
    await client.query(`SELECT n.nspname AS schema,c.relname AS table,a.attname AS column,pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS expression
    FROM pg_catalog.pg_depend p JOIN pg_catalog.pg_attrdef d ON p.classid='pg_catalog.pg_attrdef'::pg_catalog.regclass AND p.objid=d.oid
    JOIN pg_catalog.pg_class c ON c.oid=d.adrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
    WHERE p.refclassid='pg_catalog.pg_class'::pg_catalog.regclass AND p.refobjid='public.app_id_seq'::pg_catalog.regclass ORDER BY 1,2,3`);
  if (
    references.rows.length !== 1 ||
    canonicalCoreJson(references.rows[0]) !== canonicalCoreJson({ schema: 'public', table: 'app', column: 'id', expression: legacyAppDefault })
  )
    fail('catalog');
  return { schema: 'public', name: 'app_id_seq' };
}
async function cleanSequences(
  client: Query,
  structure: Catalog,
  signal: AbortSignal,
  policy?: CoreCleanTargetSequencePolicy,
): Promise<CleanSequence[]> {
  if (policy && hash(structure) !== checkedSequencePolicy(policy).catalogSha256) fail('catalog');
  const sequences: CleanSequence[] = [];
  for (const [schema, table] of [
    ['public', 'user'],
    ['public', 'link'],
    ['public', 'app'],
    ['drizzle', '__drizzle_migrations'],
  ] as const) {
    signal.throwIfAborted();
    const result = await client.query(
      `SELECT n.nspname AS schema,s.relname AS name FROM pg_catalog.pg_class s
      JOIN pg_catalog.pg_namespace n ON n.oid=s.relnamespace WHERE s.oid=pg_catalog.pg_get_serial_sequence($1,'id')::pg_catalog.regclass`,
      [`${quote(schema)}.${quote(table)}`],
    );
    if (!result.rows.length && !(policy && schema === 'public' && table === 'app')) continue;
    const row = result.rows.length ? result.rows[0] : await legacyAppSequence(client, structure);
    const definition = structure.sequences.find((entry) => entry.schema === row?.schema && entry.name === row?.name);
    if (
      result.rows.length > 1 ||
      !definition ||
      typeof definition.schema !== 'string' ||
      typeof definition.name !== 'string' ||
      definition.increment !== '1' ||
      definition.min !== '1' ||
      definition.start !== '1' ||
      definition.cycle !== false ||
      sequences.some((entry) => entry.schema === definition.schema && entry.name === definition.name)
    )
      fail('catalog');
    sequences.push({ schema: definition.schema, name: definition.name, table: `${quote(schema)}.${quote(table)}`, start: definition.start });
  }
  if (sequences.length !== structure.sequences.length) fail('catalog');
  return sequences;
}
async function verifyCleanSequences(client: Query, structure: Catalog, signal: AbortSignal, policy?: CoreCleanTargetSequencePolicy) {
  for (const sequence of await cleanSequences(client, structure, signal, policy)) {
    const result = await client.query(
      `SELECT s.last_value::text AS value,s.is_called AS called,
      COALESCE((SELECT pg_catalog.max("id") FROM ${sequence.table}),$1::pg_catalog.int8)::text AS expected,
      (SELECT pg_catalog.count(*)>0 FROM ${sequence.table}) AS populated FROM ${quote(sequence.schema)}.${quote(sequence.name)} s`,
      [sequence.start],
    );
    const row = result.rows[0];
    if (
      result.rows.length !== 1 ||
      typeof row?.expected !== 'string' ||
      typeof row.called !== 'boolean' ||
      typeof row.populated !== 'boolean' ||
      row.value !== row.expected ||
      row.called !== row.populated
    )
      fail('receipt');
  }
}
function checkCleanReceipt(prepared: CoreCleanTargetReconciliation) {
  const { marker, ...descriptor } = prepared;
  if (
    !['orbis.core-clean-target-reconciliation.v1', 'orbis.core-clean-target-reconciliation.v2'].includes(prepared.schema) ||
    (prepared.schema === 'orbis.core-clean-target-reconciliation.v1' && Object.hasOwn(prepared, 'sequencePolicy')) ||
    (prepared.schema === 'orbis.core-clean-target-reconciliation.v2' &&
      checkedSequencePolicy(prepared.sequencePolicy).catalogSha256 !== prepared.catalogSha256) ||
    !uuid.test(prepared.id) ||
    !uuid.test(prepared.nonce) ||
    !validDatabaseIdentity(prepared.sourceIdentity) ||
    !validDatabaseIdentity(prepared.destinationIdentity) ||
    !validDatabaseIdentity(prepared.targetIdentity) ||
    prepared.targetIdentity.systemIdentifier === prepared.sourceIdentity.systemIdentifier ||
    prepared.targetIdentity.systemIdentifier === prepared.destinationIdentity.systemIdentifier ||
    prepared.environmentProved !== false ||
    prepared.restoreAuthority !== false ||
    prepared.catalogContext !== cleanCatalogContext ||
    !Number.isInteger(prepared.major) ||
    prepared.major < 14 ||
    !Number.isSafeInteger(prepared.sourceOwnerId) ||
    prepared.sourceOwnerId < 1 ||
    prepared.sourceOwnerId > 2147483647 ||
    prepared.sourceOwnerId !== prepared.destinationOwnerId ||
    [
      prepared.sourceSha256,
      prepared.destinationSha256,
      prepared.catalogSha256,
      prepared.authenticationSha256,
      prepared.sourceAccountsSha256,
      prepared.destinationAppsSha256,
      prepared.destinationRecoverySha256,
      prepared.catalogOwnershipSha256,
    ].some((value) => !/^[a-f0-9]{64}$/.test(value)) ||
    marker !==
      `${prepared.schema === 'orbis.core-clean-target-reconciliation.v2' ? cleanMarkerPrefixV2 : cleanMarkerPrefix}${prepared.id}/${prepared.nonce}/${hash(descriptor)}`
  )
    fail('receipt');
}
async function verifyCleanTargetContents(
  client: Query,
  prepared: CoreCleanTargetReconciliation,
  signal: AbortSignal,
  imported?: { identity: CoreCleanTargetIdentity; marker: string },
) {
  checkCleanReceipt(prepared);
  signal.throwIfAborted();
  await requireCleanCatalogContext(client);
  const identity = await cleanDatabaseIdentity(client);
  const expectedIdentity = imported?.identity ?? prepared.targetIdentity;
  const expectedMarker = imported?.marker ?? prepared.marker;
  const actual = await contents(client, signal);
  const result = await client.query(databaseMarkerQuery);
  if (
    !sameIdentity(identity, expectedIdentity) ||
    actual.database !== expectedIdentity.database ||
    actual.major !== prepared.major ||
    hash(actual.catalog) !== prepared.catalogSha256 ||
    hash({ user: actual.rows.user, link: actual.rows.link, migrations: actual.rows.__drizzle_migrations }) !== prepared.sourceAccountsSha256 ||
    hash({ app: actual.rows.app, app_store: actual.rows.app_store }) !== prepared.destinationAppsSha256 ||
    hash(actual.rows.orbis_reset_receipt) !== prepared.destinationRecoverySha256 ||
    result.rows.length !== 1 ||
    result.rows[0]?.marker !== expectedMarker
  )
    fail('receipt');
  await verifyCleanSequences(
    client,
    actual.catalog,
    signal,
    prepared.schema === 'orbis.core-clean-target-reconciliation.v2' ? prepared.sequencePolicy : undefined,
  );
  if (!sameIdentity(await cleanDatabaseIdentity(client), expectedIdentity)) fail('receipt');
  await requireCleanCatalogContext(client);
  return actual;
}

export type CoreImportedDatabaseBinding = Readonly<{
  schema: 'orbis.core-imported-database-binding.v1';
  id: string;
  nonce: string;
  stageSha256: string;
  dumpSha256: string;
  preparedSha256: string;
  database: CoreCleanTargetIdentity & { owner: string; marker: string };
}>;

/** Read-only logical verification after Root imports into a separately owned database. */
export async function verifyCoreImportedDatabase(options: {
  client: Query;
  prepared: CoreCleanTargetReconciliation;
  binding: CoreImportedDatabaseBinding;
  authentication: { jwtSecret: string; passkeys?: unknown };
  signal: AbortSignal;
  verify: (binding: CoreImportedDatabaseBinding) => Promise<void>;
}) {
  const binding = structuredClone(options.binding);
  const prepared = structuredClone(options.prepared);
  const authentication = structuredClone(options.authentication);
  const exact = (value: unknown, fields: string[]): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === fields.sort().join(',');
  if (
    !exact(binding, ['schema', 'id', 'nonce', 'stageSha256', 'dumpSha256', 'preparedSha256', 'database']) ||
    binding.schema !== 'orbis.core-imported-database-binding.v1' ||
    !uuid.test(binding.id) ||
    !uuid.test(binding.nonce) ||
    binding.id === binding.nonce ||
    [binding.stageSha256, binding.dumpSha256, binding.preparedSha256].some((value) => !/^[a-f0-9]{64}$/.test(value)) ||
    !exact(binding.database, ['systemIdentifier', 'databaseOid', 'database', 'owner', 'marker']) ||
    !validDatabaseIdentity({
      systemIdentifier: binding.database.systemIdentifier,
      databaseOid: binding.database.databaseOid,
      database: binding.database.database,
    }) ||
    binding.database.database !== `orbis_restore_${binding.id.replaceAll('-', '')}` ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(binding.database.owner) ||
    binding.database.marker !== `orbis.core-derived-logical.v1/${binding.id}/${binding.nonce}/${binding.stageSha256}` ||
    binding.preparedSha256 !== hash(prepared) ||
    hash(authentication) !== prepared.authenticationSha256 ||
    typeof options.verify !== 'function'
  )
    fail('receipt');
  checkCleanReceipt(prepared);
  Object.freeze(binding.database);
  Object.freeze(binding);
  const expected = {
    systemIdentifier: binding.database.systemIdentifier,
    databaseOid: binding.database.databaseOid,
    database: binding.database.database,
  };
  options.signal.throwIfAborted();
  await options.verify(binding);
  await options.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const actual = await verifyCleanTargetContents(options.client, prepared, options.signal, { identity: expected, marker: binding.database.marker });
    await records(actual, authentication, options.signal);
    const owner = await options.client.query(
      'SELECT pg_catalog.pg_get_userbyid(datdba) AS owner, current_user::text AS role FROM pg_catalog.pg_database WHERE oid=$1::oid AND datname=current_database()',
      [binding.database.databaseOid],
    );
    if (
      owner.rows.length !== 1 ||
      !exact(owner.rows[0], ['owner', 'role']) ||
      owner.rows[0].owner !== binding.database.owner ||
      owner.rows[0].role !== binding.database.owner ||
      !sameIdentity(await cleanDatabaseIdentity(options.client), expected)
    )
      fail('receipt');
    await options.verify(binding);
    options.signal.throwIfAborted();
    await options.client.query('COMMIT');
    return Object.freeze({
      schema: 'orbis.core-imported-database-verification.v1' as const,
      id: binding.id,
      nonce: binding.nonce,
      stageSha256: binding.stageSha256,
      dumpSha256: binding.dumpSha256,
      preparedSha256: binding.preparedSha256,
      database: binding.database,
      logicalTargetVerified: true as const,
      environmentProved: false as const,
      restoreAuthority: false as const,
      activation: false as const,
    });
  } catch (error) {
    await options.client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/** Root must independently create, migrate and qualify the isolated target and keep both inputs stable.
 * Optional sequence policy requires separate Root approval; observed catalog/image metadata cannot grant it.
 * Copies authenticated logical rows only; this receipt grants no target creation or activation authority. */
export async function prepareCoreCleanTarget(options: {
  id: string;
  nonce: string;
  source: CoreDatabaseSnapshot;
  destination: CoreDatabaseSnapshot;
  sourceOwnerId: number;
  destinationOwnerId: number;
  catalogOwnerIds: readonly number[];
  sequencePolicy?: CoreCleanTargetSequencePolicy;
  target: Client;
  signal: AbortSignal;
  authorize: (prepared: CoreCleanTargetReconciliation) => Promise<void>;
  committed: (prepared: CoreCleanTargetReconciliation) => Promise<void>;
}): Promise<CoreCleanTargetReconciliation> {
  if (!uuid.test(options.id) || !uuid.test(options.nonce)) fail('approval');
  const sequencePolicy = options.sequencePolicy === undefined ? undefined : checkedSequencePolicy(options.sequencePolicy);
  const source = snapshots.get(options.source);
  const destination = snapshots.get(options.destination);
  if (!source || !destination || source.client === destination.client || options.target === source.client || options.target === destination.client)
    fail('approval');
  await requireCleanCatalogContext(source.client, destination.client, options.target);
  if (source.snapshot.major !== destination.snapshot.major) fail('major');
  if (hash(source.snapshot.catalog) !== hash(destination.snapshot.catalog)) fail('catalog');
  if (sequencePolicy) {
    await cleanSequences(source.client, source.snapshot.catalog, options.signal, sequencePolicy);
    await cleanSequences(destination.client, destination.snapshot.catalog, options.signal, sequencePolicy);
  }
  const ownership = await requireCoreCatalogOwnership(options);
  const sourceIdentity = await cleanDatabaseIdentity(source.client);
  const destinationIdentity = await cleanDatabaseIdentity(destination.client);
  if (sourceIdentity.database !== source.snapshot.database || destinationIdentity.database !== destination.snapshot.database) fail('changed');
  const client = options.target;
  const targetIdentity = await cleanDatabaseIdentity(client);
  if (targetIdentity.systemIdentifier === sourceIdentity.systemIdentifier || targetIdentity.systemIdentifier === destinationIdentity.systemIdentifier)
    fail('approval');
  const targetRows = {
    ...source.snapshot.rows,
    app_store: destination.snapshot.rows.app_store,
    app: destination.snapshot.rows.app,
    orbis_reset_receipt: destination.snapshot.rows.orbis_reset_receipt,
  };
  if (
    Object.values(targetRows).reduce((total, rows) => total + rows.length, 0) > backupDatabaseLimits.rows ||
    Object.values(targetRows).reduce((total, rows) => total + Buffer.byteLength(canonicalCoreJson(rows)), 0) > backupDatabaseLimits.totalBytes
  )
    fail('records');
  let committed = false;
  options.signal.throwIfAborted();
  await requireCleanCatalogContext(source.client, destination.client, client);
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    await requireCleanCatalogContext(client);
    await client.query(cleanLocks);
    if (!sameIdentity(await cleanDatabaseIdentity(client), targetIdentity)) fail('changed');
    const target = await contents(client, options.signal);
    if (target.major !== source.snapshot.major) fail('major');
    if (hash(target.catalog) !== hash(source.snapshot.catalog)) fail('catalog');
    if (hash(target.rows.__drizzle_migrations) !== hash(source.snapshot.rows.__drizzle_migrations)) fail('catalog');
    if (cleanTables.some((table) => target.rows[table].length)) fail('records');
    const comment = await client.query(databaseMarkerQuery);
    if (comment.rows.length !== 1 || comment.rows[0]?.marker !== null) fail('receipt');
    const sequences = await cleanSequences(client, target.catalog, options.signal, sequencePolicy);
    const descriptor = {
      schema: sequencePolicy ? ('orbis.core-clean-target-reconciliation.v2' as const) : ('orbis.core-clean-target-reconciliation.v1' as const),
      ...(sequencePolicy ? { sequencePolicy } : {}),
      id: options.id,
      nonce: options.nonce,
      sourceIdentity,
      destinationIdentity,
      targetIdentity,
      sourceSha256: source.snapshot.sha256,
      destinationSha256: destination.snapshot.sha256,
      catalogSha256: hash(source.snapshot.catalog),
      authenticationSha256: source.authenticationSha256,
      sourceAccountsSha256: hash({
        user: source.snapshot.rows.user,
        link: source.snapshot.rows.link,
        migrations: source.snapshot.rows.__drizzle_migrations,
      }),
      destinationAppsSha256: hash({ app: destination.snapshot.rows.app, app_store: destination.snapshot.rows.app_store }),
      destinationRecoverySha256: hash(destination.snapshot.rows.orbis_reset_receipt),
      sourceOwnerId: options.sourceOwnerId,
      destinationOwnerId: options.destinationOwnerId,
      catalogOwnershipSha256: hash(ownership),
      catalogContext: cleanCatalogContext,
      major: target.major,
      environmentProved: false as const,
      restoreAuthority: false as const,
    };
    const prepared = Object.freeze({
      ...descriptor,
      marker: `${sequencePolicy ? cleanMarkerPrefixV2 : cleanMarkerPrefix}${options.id}/${options.nonce}/${hash(descriptor)}`,
    }) as CoreCleanTargetReconciliation;
    await options.authorize(prepared);
    await requireCleanCatalogContext(source.client, destination.client, client);
    await source.recheck();
    await destination.recheck();
    if (sequencePolicy) {
      await cleanSequences(source.client, source.snapshot.catalog, options.signal, sequencePolicy);
      await cleanSequences(destination.client, destination.snapshot.catalog, options.signal, sequencePolicy);
    }
    if (
      !sameIdentity(await cleanDatabaseIdentity(source.client), sourceIdentity) ||
      !sameIdentity(await cleanDatabaseIdentity(destination.client), destinationIdentity)
    )
      fail('changed');
    if (
      !sameIdentity(await cleanDatabaseIdentity(client), targetIdentity) ||
      (await contents(client, options.signal)).sha256 !== target.sha256 ||
      (await client.query(databaseMarkerQuery)).rows[0]?.marker !== null
    )
      fail('changed');
    for (const table of cleanTables) {
      const columns = table === 'orbis_reset_receipt' ? ['id', 'completed_at'] : backupDatabaseColumns(table);
      for (const row of targetRows[table]) {
        options.signal.throwIfAborted();
        await client.query(
          `INSERT INTO public.${quote(table)} (${columns.map(quote).join(',')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')})`,
          columns.map((name) => row[name]),
        );
      }
    }
    for (const sequence of sequences) {
      options.signal.throwIfAborted();
      await client.query(
        `SELECT pg_catalog.setval($1::pg_catalog.regclass,COALESCE((SELECT pg_catalog.max("id") FROM ${sequence.table}),$2::pg_catalog.int8),
        (SELECT pg_catalog.count(*)>0 FROM ${sequence.table}))`,
        [`${quote(sequence.schema)}.${quote(sequence.name)}`, sequence.start],
      );
    }
    await client.query(`COMMENT ON DATABASE ${quote(targetIdentity.database)} IS '${prepared.marker}'`);
    await verifyCleanTargetContents(client, prepared, options.signal);
    await requireCleanCatalogContext(source.client, destination.client, client);
    await source.recheck();
    await destination.recheck();
    if (
      !sameIdentity(await cleanDatabaseIdentity(source.client), sourceIdentity) ||
      !sameIdentity(await cleanDatabaseIdentity(destination.client), destinationIdentity)
    )
      fail('changed');
    options.signal.throwIfAborted();
    await client.query('COMMIT');
    committed = true;
    await options.committed(prepared);
    return prepared;
  } finally {
    if (!committed) await client.query('ROLLBACK').catch(() => undefined);
  }
}

/** Verifies an uncertain commit without replaying inserts. Root must retain the receipt and pin the target independently. */
export async function verifyCoreCleanTarget(client: Query, prepared: CoreCleanTargetReconciliation, signal: AbortSignal) {
  checkCleanReceipt(prepared);
  await requireCleanCatalogContext(client);
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await verifyCleanTargetContents(client, prepared, signal);
    signal.throwIfAborted();
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
