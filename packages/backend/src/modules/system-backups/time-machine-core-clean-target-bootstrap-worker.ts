import { backupDatabaseProfileQuery, readBackupDatabaseProfile } from './backup-database-profile';
import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client, types } from 'pg';
import { inspectCoreDatabaseStructure } from './time-machine-core-database';
import { canonicalCoreJson } from './time-machine-core-payload';
import {
  corePgExecutionProfiles,
  corePgExecutionProfile,
  observeCorePgExecution,
  requireCorePgExecutionArchitecture,
  type CorePgExecutionProfileId,
} from './time-machine-core-pg-profile';

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const digest = (value: unknown) => sha(canonicalCoreJson(value));
const fail = () => new Error('Core clean target bootstrap failed.');
const hex = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const identifier = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const sqlFile = /^[0-9]{4}_[A-Za-z0-9_-]+\.sql$/;
const sanitationPolicy = 'orbis.core-clean-target-migrated-seed.v1' as const;
const migrationLedgerPolicy = 'orbis.core-clean-target-migration-ledger.v1' as const;
const scope = 'bootstrap-clean-target-only' as const;
export const coreCleanTargetBootstrapWorkerCapability = Object.freeze({
  schema: 'orbis.core-clean-target-bootstrap-worker-capability.v1',
  requestSchema: 'orbis.core-clean-target-bootstrap-input.v1',
  authorizationSchema: 'orbis.core-clean-target-bootstrap-authorization.v1',
  inventorySchema: 'orbis.core-executable-migration-inventory.v1',
  input: '/clean-target-bootstrap-input',
  output: '/clean-target-bootstrap-output',
  migrations: '/clean-target-migrations',
  socket: '/clean-target-target-socket',
  operatingSystem: 'linux',
  uid: 0,
  port: 5432,
  deadlineMs: 300000,
  connectionTimeoutMs: 10000,
  queryTimeoutMs: 20000,
  statementTimeoutMs: 15000,
  lockTimeoutMs: 5000,
  migrationFileBytes: 4 * 1024 * 1024,
  migrationTotalBytes: 16 * 1024 * 1024,
  migrationEntries: 4096,
  journalVersion: '7',
  encoding: 'UTF8',
  localeProvider: 'c',
  sanitationPolicy,
  migrationLedgerPolicy,
  scope,
  qualification: 'independent-root-qualified-migrations-and-fresh-target-required',
  activation: false,
  environmentProved: false,
  restoreAuthority: false,
});
export const coreCleanTargetBootstrapWorkerCapabilityV2 = Object.freeze({
  ...coreCleanTargetBootstrapWorkerCapability,
  schema: 'orbis.core-clean-target-bootstrap-worker-capability.v2',
  requestSchema: 'orbis.core-clean-target-bootstrap-input.v2',
  authorizationSchema: 'orbis.core-clean-target-bootstrap-authorization.v2',
  profiles: corePgExecutionProfiles,
});
type Phase = 'input' | 'connect' | 'blank' | 'migrate' | 'ledger' | 'sanitize' | 'verify' | 'output';
const codes = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOENT',
  'EACCES',
  'EEXIST',
  '28000',
  '28P01',
  '3D000',
  '57P03',
  '25006',
  '42501',
  '42P01',
  '42703',
  '42883',
  '53300',
  '53200',
  '57014',
  '40001',
  '40P01',
  '55P03',
  'XX000',
]);
const failures = new WeakMap<object, { phase: Phase; code: string }>();
export function coreCleanTargetBootstrapFailureDiagnostic(error: unknown) {
  const detail = error !== null && typeof error === 'object' ? failures.get(error) : undefined;
  return { event: 'core-clean-target-bootstrap-failed' as const, phase: detail?.phase ?? 'input', code: detail?.code ?? 'unknown' };
}
function failure(error: unknown, phase: Phase) {
  let code = 'unknown';
  try {
    const value = error !== null && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    if (typeof value === 'string' && codes.has(value)) code = value;
  } catch {
    code = 'unknown';
  }
  const result = fail();
  failures.set(result, { phase, code });
  return result;
}
const exact = (value: unknown, fields: readonly string[]): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...fields].sort().join(',');
const same = (a: BigIntStats, b: BigIntStats) =>
  ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every((key) => Reflect.get(a, key) === Reflect.get(b, key));
const directoryIdentity = (a: BigIntStats, b: BigIntStats) =>
  ['dev', 'ino', 'mode', 'uid', 'gid'].every((key) => Reflect.get(a, key) === Reflect.get(b, key));
type Locale = { encoding: 'UTF8'; collate: string; ctype: string; provider: 'c' };
type Target = { systemIdentifier: string; databaseOid: string; database: string; role: string; locale: Locale };
type LedgerRow = { id: number; hash: string; created_at: string };
const ledgerHash = (rows: LedgerRow[]) => digest([...rows].sort((a, b) => canonicalCoreJson(a).localeCompare(canonicalCoreJson(b), 'en')));
type RequestV1 = {
  schema: 'orbis.core-clean-target-bootstrap-input.v1';
  id: string;
  nonce: string;
  rootIntentSha256: string;
  target: Target;
  sourceControllerImageId: string;
  migrationInventorySha256: string;
  expectedCatalogSha256: string;
  expectedMigrationLedgerSha256: string;
  expectedMigrationLedger: LedgerRow[];
  migrationLedgerPolicy: typeof migrationLedgerPolicy;
  sanitationPolicy: typeof sanitationPolicy;
  scope: typeof scope;
  activation: false;
  environmentProved: false;
  restoreAuthority: false;
};
type Request =
  | RequestV1
  | (Omit<RequestV1, 'schema'> & { schema: 'orbis.core-clean-target-bootstrap-input.v2'; executionProfile: CorePgExecutionProfileId });
type Pinned = { directory: string; name: string; handle: FileHandle; stat: BigIntStats; bytes: Buffer };
async function privateDirectory(directory: string, writable = false) {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || (await fs.realpath(directory)) !== directory) throw fail();
  const stat = await fs.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.uid !== BigInt(process.getuid?.() ?? -1) || !(writable ? [0o700n] : [0o500n, 0o700n]).includes(stat.mode & 0o7777n))
    throw fail();
  return stat;
}
async function read(directory: string, name: string, maximum: number): Promise<Pinned> {
  const handle = await fs.open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat({ bigint: true });
    if (
      !stat.isFile() ||
      stat.uid !== BigInt(process.getuid?.() ?? -1) ||
      stat.nlink !== 1n ||
      (stat.mode & 0o7777n) !== 0o400n ||
      stat.size < 1n ||
      stat.size > maximum
    )
      throw fail();
    const bytes = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw fail();
      offset += result.bytesRead;
    }
    if (
      (await handle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead ||
      !same(stat, await handle.stat({ bigint: true })) ||
      !same(stat, await fs.lstat(path.join(directory, name), { bigint: true }))
    )
      throw fail();
    return { directory, name, handle, stat, bytes };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
function json(file: Pinned, canonical = true): unknown {
  const text = file.bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(file.bytes)) throw fail();
  const value: unknown = JSON.parse(text);
  if (canonical && canonicalCoreJson(value) !== text) throw fail();
  return value;
}
function validTarget(value: unknown): value is Target {
  return (
    exact(value, ['systemIdentifier', 'databaseOid', 'database', 'role', 'locale']) &&
    typeof value.systemIdentifier === 'string' &&
    /^[1-9][0-9]{0,19}$/.test(value.systemIdentifier) &&
    BigInt(value.systemIdentifier) <= 18446744073709551615n &&
    typeof value.databaseOid === 'string' &&
    /^[1-9][0-9]{0,9}$/.test(value.databaseOid) &&
    BigInt(value.databaseOid) <= 4294967295n &&
    typeof value.database === 'string' &&
    identifier.test(value.database) &&
    typeof value.role === 'string' &&
    identifier.test(value.role) &&
    exact(value.locale, ['encoding', 'collate', 'ctype', 'provider']) &&
    value.locale.encoding === 'UTF8' &&
    value.locale.provider === 'c' &&
    [value.locale.collate, value.locale.ctype].every(
      (item) => typeof item === 'string' && item.length > 0 && Buffer.byteLength(item) <= 256 && !item.includes('\0'),
    )
  );
}
function requestFrom(file: Pinned): Request {
  const value = json(file);
  const versioned = value !== null && typeof value === 'object' && Reflect.get(value, 'schema') === 'orbis.core-clean-target-bootstrap-input.v2';
  if (
    !exact(value, [
      'schema',
      'id',
      'nonce',
      'rootIntentSha256',
      'target',
      'sourceControllerImageId',
      'migrationInventorySha256',
      'expectedCatalogSha256',
      'expectedMigrationLedgerSha256',
      'expectedMigrationLedger',
      'migrationLedgerPolicy',
      'sanitationPolicy',
      'scope',
      'activation',
      'environmentProved',
      'restoreAuthority',
      ...(versioned ? ['executionProfile'] : []),
    ]) ||
    value.schema !== (versioned ? 'orbis.core-clean-target-bootstrap-input.v2' : 'orbis.core-clean-target-bootstrap-input.v1') ||
    typeof value.id !== 'string' ||
    !uuid.test(value.id) ||
    typeof value.nonce !== 'string' ||
    !uuid.test(value.nonce) ||
    !validTarget(value.target) ||
    typeof value.sourceControllerImageId !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(value.sourceControllerImageId) ||
    ![value.rootIntentSha256, value.migrationInventorySha256, value.expectedCatalogSha256, value.expectedMigrationLedgerSha256].every(
      (item) => typeof item === 'string' && hex.test(item),
    ) ||
    !Array.isArray(value.expectedMigrationLedger) ||
    !value.expectedMigrationLedger.length ||
    value.expectedMigrationLedger.length > 4096 ||
    value.migrationLedgerPolicy !== migrationLedgerPolicy ||
    value.sanitationPolicy !== sanitationPolicy ||
    value.scope !== scope ||
    value.activation !== false ||
    value.environmentProved !== false ||
    value.restoreAuthority !== false
  )
    throw fail();
  if (versioned) requireCorePgExecutionArchitecture(value.executionProfile, os.arch());
  return value as Request;
}
function requireAuthorization(file: Pinned, request: Request, requestSha256: string) {
  const value = json(file);
  if (
    !exact(value, ['schema', 'decision', 'requestSha256', ...Object.keys(request).filter((key) => key !== 'schema')]) ||
    value.schema !==
      (request.schema === 'orbis.core-clean-target-bootstrap-input.v2'
        ? 'orbis.core-clean-target-bootstrap-authorization.v2'
        : 'orbis.core-clean-target-bootstrap-authorization.v1') ||
    value.decision !== 'approved' ||
    value.requestSha256 !== requestSha256
  )
    throw fail();
  const { schema: _schema, ...fields } = request;
  for (const [key, expected] of Object.entries(fields)) if (canonicalCoreJson(value[key]) !== canonicalCoreJson(expected)) throw fail();
}
type Inventory = { schema: 'orbis.core-executable-migration-inventory.v1'; files: Record<string, { bytes: number; sha256: string }> };
function inventoryFrom(file: Pinned, expected: string): Inventory {
  const value = json(file);
  if (
    sha(file.bytes) !== expected ||
    !exact(value, ['schema', 'files']) ||
    value.schema !== 'orbis.core-executable-migration-inventory.v1' ||
    value.files === null ||
    typeof value.files !== 'object' ||
    Array.isArray(value.files)
  )
    throw fail();
  const files = Object.entries(value.files);
  if (files.length < 2 || files.length > 4097 || !Object.hasOwn(value.files, 'meta/_journal.json')) throw fail();
  let total = 0;
  for (const [name, binding] of files) {
    if (
      !(name === 'meta/_journal.json' || sqlFile.test(name)) ||
      !exact(binding, ['bytes', 'sha256']) ||
      !Number.isSafeInteger(binding.bytes) ||
      (binding.bytes as number) < 1 ||
      (binding.bytes as number) > 4 * 1024 * 1024 ||
      typeof binding.sha256 !== 'string' ||
      !hex.test(binding.sha256)
    )
      throw fail();
    total += binding.bytes as number;
  }
  if (total > 16 * 1024 * 1024) throw fail();
  return value as Inventory;
}
function journalLedger(journal: Pinned, files: Map<string, Pinned>) {
  const value = json(journal, false);
  if (
    !exact(value, ['version', 'dialect', 'entries']) ||
    value.version !== '7' ||
    value.dialect !== 'postgresql' ||
    !Array.isArray(value.entries) ||
    !value.entries.length ||
    value.entries.length > 4096
  )
    throw fail();
  let last = 0;
  const ledger: { id: number; hash: string; created_at: string }[] = [];
  const seen = new Set<string>(['meta/_journal.json']);
  for (const [index, entry] of value.entries.entries()) {
    if (
      !exact(entry, ['idx', 'version', 'when', 'tag', 'breakpoints']) ||
      entry.idx !== index ||
      entry.version !== '7' ||
      !Number.isSafeInteger(entry.when) ||
      (entry.when as number) <= last ||
      typeof entry.tag !== 'string' ||
      !sqlFile.test(`${entry.tag}.sql`) ||
      !entry.tag.startsWith(`${String(index).padStart(4, '0')}_`) ||
      typeof entry.breakpoints !== 'boolean' ||
      seen.has(`${entry.tag}.sql`)
    )
      throw fail();
    const file = files.get(`${entry.tag}.sql`);
    if (!file || !Buffer.from(file.bytes.toString('utf8'), 'utf8').equals(file.bytes) || file.bytes.includes(0)) throw fail();
    seen.add(`${entry.tag}.sql`);
    last = entry.when as number;
    ledger.push({ id: index + 1, hash: sha(file.bytes), created_at: String(entry.when) });
  }
  if ([...files.keys()].sort().join(',') !== [...seen].sort().join(',')) throw fail();
  return ledger;
}
function validateExpectedLedger(request: Request, generated: LedgerRow[]) {
  if (request.expectedMigrationLedger.length !== generated.length) throw fail();
  let previous = 0;
  for (const [index, row] of request.expectedMigrationLedger.entries()) {
    const expected = generated[index];
    if (
      !exact(row, ['id', 'hash', 'created_at']) ||
      !Number.isInteger(row.id) ||
      row.id <= previous ||
      row.id > 2147483647 ||
      !expected ||
      row.hash !== expected.hash ||
      row.created_at !== expected.created_at
    )
      throw fail();
    previous = row.id;
  }
  if (ledgerHash(request.expectedMigrationLedger) !== request.expectedMigrationLedgerSha256) throw fail();
}
async function targetIdentity(client: Client, expected: Target, searchPath: string, executionProfile?: CorePgExecutionProfileId) {
  const execution = executionProfile ? corePgExecutionProfile(executionProfile) : undefined;
  if (executionProfile) {
    const observation = await observeCorePgExecution(client, executionProfile, expected.database);
    if (canonicalCoreJson(observation.locale) !== canonicalCoreJson(expected.locale)) throw fail();
  }
  const catalogProvider = execution?.major !== 14;
  const result = await client.query(`SELECT s.system_identifier::text AS system_identifier,d.oid::text AS database_oid,d.datname AS database,
    CURRENT_USER AS current_user,SESSION_USER AS session_user,pg_catalog.pg_encoding_to_char(d.encoding) AS encoding,
    d.datcollate AS collate,d.datctype AS ctype,${catalogProvider ? 'd.datlocprovider AS provider,' : ''}pg_catalog.current_setting('search_path') AS search_path,
    pg_catalog.current_setting('default_transaction_read_only') AS read_only
    FROM pg_catalog.pg_control_system() s CROSS JOIN pg_catalog.pg_database d WHERE d.datname=pg_catalog.current_database()`);
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    !exact(row, [
      'system_identifier',
      'database_oid',
      'database',
      'current_user',
      'session_user',
      'encoding',
      'collate',
      'ctype',
      ...(catalogProvider ? ['provider'] : []),
      'search_path',
      'read_only',
    ]) ||
    row.system_identifier !== expected.systemIdentifier ||
    row.database_oid !== expected.databaseOid ||
    row.database !== expected.database ||
    row.current_user !== expected.role ||
    row.session_user !== expected.role ||
    row.encoding !== expected.locale.encoding ||
    row.collate !== expected.locale.collate ||
    row.ctype !== expected.locale.ctype ||
    (catalogProvider && row.provider !== expected.locale.provider) ||
    row.search_path !== searchPath ||
    row.read_only !== 'off'
  )
    throw fail();
}
async function blank(client: Client) {
  const result = await client.query(`SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
    UNION ALL SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
    UNION ALL SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
    UNION ALL SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
    UNION ALL SELECT 1 FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid=r.ev_class JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
    UNION ALL SELECT 1 FROM pg_catalog.pg_event_trigger
    UNION ALL SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('information_schema','public') LIMIT 1`);
  const extensions = await client.query('SELECT extname AS name FROM pg_catalog.pg_extension ORDER BY extname');
  if (result.rows.length || extensions.rows.length !== 1 || !exact(extensions.rows[0], ['name']) || extensions.rows[0].name !== 'plpgsql')
    throw fail();
}
async function clock(client: Client) {
  const result = await client.query('SELECT pg_catalog.floor(extract(epoch FROM pg_catalog.clock_timestamp()))::pg_catalog.int8::text AS seconds');
  const value = result.rows[0]?.seconds;
  if (result.rows.length !== 1 || typeof value !== 'string' || !/^[1-9][0-9]{0,12}$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw fail();
  return Number(value);
}
async function readLedger(client: Client): Promise<LedgerRow[]> {
  const result = await client.query('SELECT * FROM drizzle.__drizzle_migrations LIMIT 4097');
  if (!result.rows.length || result.rows.length > 4096) throw fail();
  for (const row of result.rows)
    if (
      !exact(row, ['id', 'hash', 'created_at']) ||
      !Number.isInteger(row.id) ||
      (row.id as number) < 1 ||
      (row.id as number) > 2147483647 ||
      typeof row.hash !== 'string' ||
      !hex.test(row.hash) ||
      typeof row.created_at !== 'string' ||
      !/^[1-9][0-9]*$/.test(row.created_at)
    )
      throw fail();
  return (result.rows as LedgerRow[]).sort((a, b) => a.id - b.id);
}
async function requireLedger(client: Client, expected: string, count: number) {
  const rows = await readLedger(client);
  if (rows.length !== count || ledgerHash(rows) !== expected) throw fail();
  return rows;
}
async function requireLedgerSequence(client: Client, maximum: number) {
  const sequence = await client.query('SELECT last_value::text AS value,is_called AS called FROM drizzle.__drizzle_migrations_id_seq');
  if (sequence.rows.length !== 1 || sequence.rows[0]?.value !== String(maximum) || sequence.rows[0]?.called !== true) throw fail();
}
const applicationTables = (version: 1 | 2, commits = false) =>
  [
    'user',
    'link',
    'app',
    'app_store',
    'orbis_reset_receipt',
    ...(version === 2 ? ['app_migration' as const] : []),
    ...(commits ? ['app_migration_commit' as const] : []),
  ] as const;
async function emptyTables(client: Client, seed: boolean, version: 1 | 2, commits = false) {
  for (const table of applicationTables(version, commits)) {
    const result = await client.query(`SELECT count(*)::text AS count FROM public."${table}"`);
    if (result.rows.length !== 1 || result.rows[0]?.count !== (seed && table === 'app_store' ? '1' : '0')) throw fail();
  }
}
const seedColumns = ['slug', 'hash', 'name', 'enabled', 'url', 'branch', 'created_at', 'updated_at'] as const;
function requireSeed(row: unknown, before: number, after: number): Record<(typeof seedColumns)[number], unknown> {
  if (
    !exact(row, seedColumns) ||
    !['slug', 'hash', 'name', 'url'].every((field) => row[field] === 'migrated') ||
    row.branch !== 'main' ||
    row.enabled !== true ||
    !Number.isSafeInteger(row.created_at) ||
    row.created_at !== row.updated_at ||
    (row.created_at as number) < before - 1 ||
    (row.created_at as number) > after + 1
  )
    throw fail();
  return row as Record<(typeof seedColumns)[number], unknown>;
}

/** Root must independently prove a fresh isolated target, image/locale profile, approved SQL bytes and read-only migration mounts.
 * Drizzle reopens the pinned paths; seals are checked around it. Any uncertainty retains this candidate, never grants activation. */
export async function bootstrapCoreCleanTarget(options: { input: string; output: string; migrations: string; signal: AbortSignal }) {
  let phase: Phase = 'input';
  const pinned: Pinned[] = [];
  let client: Client | undefined;
  let ending: Promise<void> | undefined;
  const close = () => {
    if (!ending && client)
      ending = Promise.resolve()
        .then(() => client?.end())
        .then(() => undefined)
        .catch(() => undefined);
    return ending;
  };
  const abort = () => {
    void close();
  };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    options.signal.throwIfAborted();
    const directories = new Map<string, BigIntStats>();
    for (const name of [options.input, options.migrations, path.join(options.migrations, 'meta')])
      directories.set(name, await privateDirectory(name));
    const outputStat = await privateDirectory(options.output, true);
    for (const left of [options.input, options.output, options.migrations])
      for (const right of [options.input, options.output, options.migrations])
        if (left !== right && (left.startsWith(`${right}/`) || right.startsWith(`${left}/`))) throw fail();
    if (new Set([options.input, options.output, options.migrations]).size !== 3 || (await fs.readdir(options.output)).length) throw fail();
    for (const name of ['request.json', 'authorization.json', 'migration-inventory.json']) pinned.push(await read(options.input, name, 1024 * 1024));
    const [manifest, authorization, inventoryFile] = pinned;
    if (!manifest || !authorization || !inventoryFile) throw fail();
    const request = requestFrom(manifest);
    const executionProfile = request.schema === 'orbis.core-clean-target-bootstrap-input.v2' ? request.executionProfile : undefined;
    const outputVersion = executionProfile ? 'v2' : 'v1';
    const requestSha256 = sha(manifest.bytes);
    requireAuthorization(authorization, request, requestSha256);
    const inventory = inventoryFrom(inventoryFile, request.migrationInventorySha256);
    const migrationFiles = new Map<string, Pinned>();
    for (const [name, expected] of Object.entries(inventory.files)) {
      const file = await read(
        name === 'meta/_journal.json' ? path.join(options.migrations, 'meta') : options.migrations,
        path.basename(name),
        expected.bytes,
      );
      pinned.push(file);
      if (file.bytes.length !== expected.bytes || sha(file.bytes) !== expected.sha256) throw fail();
      migrationFiles.set(name, file);
    }
    const journal = migrationFiles.get('meta/_journal.json');
    if (!journal) throw fail();
    const generatedLedger = journalLedger(journal, migrationFiles);
    validateExpectedLedger(request, generatedLedger);
    const expectedLedger = request.expectedMigrationLedger;
    const published = new Map<string, BigIntStats>();
    const unchanged = async () => {
      options.signal.throwIfAborted();
      for (const [name, stat] of directories) if (!same(stat, await privateDirectory(name))) throw fail();
      if (
        !directoryIdentity(outputStat, await privateDirectory(options.output, true)) ||
        (await fs.readdir(options.input)).sort().join(',') !== 'authorization.json,migration-inventory.json,request.json' ||
        (await fs.readdir(options.output)).sort().join(',') !== [...published.keys()].sort().join(',')
      )
        throw fail();
      const names = [
        ...(await fs.readdir(options.migrations)).filter((name) => name !== 'meta'),
        ...(await fs.readdir(path.join(options.migrations, 'meta'))).map((name) => `meta/${name}`),
      ];
      if (names.sort().join(',') !== Object.keys(inventory.files).sort().join(',')) throw fail();
      for (const file of pinned)
        if (
          !same(file.stat, await file.handle.stat({ bigint: true })) ||
          !same(file.stat, await fs.lstat(path.join(file.directory, file.name), { bigint: true }))
        )
          throw fail();
      for (const [name, stat] of published) if (!same(stat, await fs.lstat(path.join(options.output, name), { bigint: true }))) throw fail();
    };
    const write = async (name: string, value: unknown) => {
      await unchanged();
      const body = canonicalCoreJson(value);
      if (Buffer.byteLength(body) > 65536) throw fail();
      const handle = await fs.open(
        path.join(options.output, name),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(body);
        await handle.chmod(0o400);
        await handle.sync();
        const stat = await handle.stat({ bigint: true });
        if (!stat.isFile() || stat.uid !== BigInt(process.getuid?.() ?? -1) || stat.nlink !== 1n || (stat.mode & 0o7777n) !== 0o400n) throw fail();
        published.set(name, stat);
      } finally {
        await handle.close();
      }
      const parent = await fs.open(options.output, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        if (!directoryIdentity(outputStat, await parent.stat({ bigint: true }))) throw fail();
        await parent.sync();
      } finally {
        await parent.close();
      }
      await unchanged();
      return sha(body);
    };
    const bound = {
      id: request.id,
      nonce: request.nonce,
      requestSha256,
      authorizationSha256: sha(authorization.bytes),
      rootIntentSha256: request.rootIntentSha256,
      target: request.target,
      sourceControllerImageId: request.sourceControllerImageId,
      ...(executionProfile ? { executionProfile } : {}),
      migrationInventorySha256: request.migrationInventorySha256,
      expectedCatalogSha256: request.expectedCatalogSha256,
      expectedMigrationLedgerSha256: request.expectedMigrationLedgerSha256,
      sanitationPolicy,
      migrationLedgerPolicy,
      scope,
      activation: false as const,
      environmentProved: false as const,
      restoreAuthority: false as const,
    };
    await write('worker-start.json', { schema: `orbis.core-clean-target-bootstrap-start.${outputVersion}`, ...bound });
    phase = 'connect';
    client = new Client({
      host: coreCleanTargetBootstrapWorkerCapability.socket,
      port: 5432,
      user: request.target.role,
      database: request.target.database,
      password: '',
      ssl: false,
      types,
      application_name: 'orbis-core-clean-target-bootstrap',
      connectionTimeoutMillis: 10000,
      query_timeout: 20000,
      statement_timeout: 15000,
      options:
        '-c search_path=pg_catalog -c default_transaction_read_only=off -c session_preload_libraries= -c local_preload_libraries= -c lock_timeout=5000 -c idle_in_transaction_session_timeout=30000',
    });
    client.on('error', () => undefined);
    await client.connect();
    options.signal.throwIfAborted();
    phase = 'blank';
    await targetIdentity(client, request.target, 'pg_catalog', executionProfile);
    await blank(client);
    await unchanged();
    const before = await clock(client);
    const migrationIntentSha256 = await write('migration-intent.json', {
      schema: `orbis.core-clean-target-migration-intent.${outputVersion}`,
      ...bound,
      serverBeforeSeconds: before,
    });
    await targetIdentity(client, request.target, 'pg_catalog', executionProfile);
    await blank(client);
    await unchanged();
    phase = 'migrate';
    await client.query('SET search_path TO public');
    await targetIdentity(client, request.target, 'public', executionProfile);
    await migrate(drizzle(client), { migrationsFolder: options.migrations });
    await client.query('SET search_path TO pg_catalog');
    await targetIdentity(client, request.target, 'pg_catalog', executionProfile);
    await unchanged();
    const after = await clock(client);
    if (after < before) throw fail();
    const migrated = await inspectCoreDatabaseStructure(client, options.signal);
    if (executionProfile && migrated.major !== corePgExecutionProfile(executionProfile).major) throw fail();
    if (migrated.catalogSha256 !== request.expectedCatalogSha256) throw fail();
    const generatedActual = await requireLedger(client, ledgerHash(generatedLedger), generatedLedger.length);
    if (canonicalCoreJson(generatedActual) !== canonicalCoreJson(generatedLedger)) throw fail();
    phase = 'ledger';
    let ledgerCommitted = false;
    const maximumLedgerId = expectedLedger.at(-1)?.id;
    if (maximumLedgerId === undefined) throw fail();
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
      await client.query('LOCK TABLE drizzle.__drizzle_migrations IN ACCESS EXCLUSIVE MODE');
      if (canonicalCoreJson(await requireLedger(client, ledgerHash(generatedLedger), generatedLedger.length)) !== canonicalCoreJson(generatedLedger))
        throw fail();
      await write('ledger-intent.json', {
        schema: `orbis.core-clean-target-ledger-intent.${outputVersion}`,
        ...bound,
        migrationIntentSha256,
        generatedLedgerSha256: ledgerHash(generatedLedger),
        ledgerRows: expectedLedger.length,
      });
      for (let index = expectedLedger.length - 1; index >= 0; index -= 1) {
        const expected = expectedLedger[index];
        const original = generatedLedger[index];
        if (!expected || !original) throw fail();
        if (expected.id !== original.id) {
          const changed = await client.query(
            'UPDATE drizzle.__drizzle_migrations SET id=$1 WHERE id=$2 AND hash=$3 AND created_at=$4::pg_catalog.int8',
            [expected.id, original.id, original.hash, original.created_at],
          );
          if (changed.rowCount !== 1) throw fail();
        }
      }
      const sequence = await client.query("SELECT pg_catalog.pg_get_serial_sequence('drizzle.__drizzle_migrations','id') AS sequence");
      if (sequence.rows.length !== 1 || sequence.rows[0]?.sequence !== 'drizzle.__drizzle_migrations_id_seq') throw fail();
      await client.query('SELECT pg_catalog.setval($1::pg_catalog.regclass,$2::pg_catalog.int8,true)', [
        'drizzle.__drizzle_migrations_id_seq',
        maximumLedgerId,
      ]);
      await requireLedgerSequence(client, maximumLedgerId);
      if (
        canonicalCoreJson(await requireLedger(client, request.expectedMigrationLedgerSha256, expectedLedger.length)) !==
        canonicalCoreJson(expectedLedger)
      )
        throw fail();
      await unchanged();
      await targetIdentity(client, request.target, 'pg_catalog', executionProfile);
      await client.query('COMMIT');
      ledgerCommitted = true;
    } finally {
      if (!ledgerCommitted) await client.query('ROLLBACK').catch(() => undefined);
    }
    phase = 'sanitize';
    const version = readBackupDatabaseProfile((await client.query(backupDatabaseProfileQuery)).rows[0]);
    const commits = migrated.schema === 'orbis.core-database-structure.v3';
    if (commits ? version !== 2 || migrated.rows.app_migration_commit !== 0 : migrated.schema !== `orbis.core-database-structure.v${version}`)
      throw fail();
    await emptyTables(client, true, version, commits);
    await write('migration-completion.json', {
      schema: `orbis.core-clean-target-migration-completion.${outputVersion}`,
      ...bound,
      migrationIntentSha256,
      serverBeforeSeconds: before,
      serverAfterSeconds: after,
      migrationCommitAcknowledged: true,
      ledgerCommitAcknowledged: true,
      sanitationPending: true,
    });
    phase = 'sanitize';
    let sanitationCommitted = false;
    let seedSha256 = '';
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
      await client.query(
        `LOCK TABLE public."user",public.link,public.app,public.app_store,public.orbis_reset_receipt,drizzle.__drizzle_migrations${version === 2 ? ',public.app_migration' : ''}${commits ? ',public.app_migration_commit' : ''} IN ACCESS EXCLUSIVE MODE`,
      );
      await targetIdentity(client, request.target, 'pg_catalog', executionProfile);
      await emptyTables(client, true, version, commits);
      await requireLedger(client, request.expectedMigrationLedgerSha256, expectedLedger.length);
      const selected = await client.query('SELECT * FROM public.app_store LIMIT 2');
      if (selected.rows.length !== 1) throw fail();
      const seed = requireSeed(selected.rows[0], before, after);
      seedSha256 = digest(seed);
      await write('sanitation-intent.json', {
        schema: `orbis.core-clean-target-sanitation-intent.${outputVersion}`,
        ...bound,
        migrationIntentSha256,
        seedSha256,
        serverBeforeSeconds: before,
        serverAfterSeconds: after,
      });
      const removed = await client.query(
        `DELETE FROM public.app_store WHERE ${seedColumns.map((name, index) => `"${name}"=$${index + 1}`).join(' AND ')}`,
        seedColumns.map((name) => seed[name]),
      );
      if (removed.rowCount !== 1) throw fail();
      await emptyTables(client, false, version, commits);
      await requireLedger(client, request.expectedMigrationLedgerSha256, expectedLedger.length);
      await unchanged();
      await targetIdentity(client, request.target, 'pg_catalog', executionProfile);
      await client.query('COMMIT');
      sanitationCommitted = true;
    } finally {
      if (!sanitationCommitted) await client.query('ROLLBACK').catch(() => undefined);
    }
    phase = 'verify';
    const structure = await inspectCoreDatabaseStructure(client, options.signal);
    if (
      structure.catalogSha256 !== request.expectedCatalogSha256 ||
      structure.major !== migrated.major ||
      structure.schema !== migrated.schema ||
      applicationTables(version, commits).some((table) => structure.rows[table] !== 0) ||
      structure.rows.__drizzle_migrations !== expectedLedger.length
    )
      throw fail();
    await emptyTables(client, false, version);
    await requireLedger(client, request.expectedMigrationLedgerSha256, expectedLedger.length);
    await requireLedgerSequence(client, maximumLedgerId);
    await targetIdentity(client, request.target, 'pg_catalog', executionProfile);
    await unchanged();
    phase = 'output';
    const report = {
      schema: `orbis.core-clean-target-bootstrap-result.${outputVersion}`,
      ...bound,
      migrationIntentSha256,
      seedSha256,
      structure,
      ledgerCommitAcknowledged: true,
      sanitationCommitAcknowledged: true,
      applicationTablesEmpty: true,
      serverQuiescenceProved: false,
    };
    await write('result.json', report);
    return report;
  } catch (error) {
    throw failure(error, phase);
  } finally {
    options.signal.removeEventListener('abort', abort);
    await close();
    for (const file of pinned) {
      file.bytes.fill(0);
      await file.handle.close().catch(() => undefined);
    }
  }
}
