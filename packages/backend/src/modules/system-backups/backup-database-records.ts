import { createDecipheriv, createHash, pbkdf2 } from 'node:crypto';
import { promisify } from 'node:util';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { type } from 'arktype';
import { app, appMigration, appStore, link, user } from '@/core/database/drizzle/schema';
import { passkeyStateSchema } from '../auth/passkey.store';
import { BackupRequirementError } from './backup-files';
import { appRuntimeImageBindings, type decodeAppRuntimeCapture } from './time-machine-app-runtime-capture';

const deriveKey = promisify(pbkdf2);
const tables = { user, app_store: appStore, app, link, app_migration: appMigration } as const;
export type BackupDatabaseTable = keyof typeof tables;
const legacyTables = ['user', 'app_store', 'app', 'link'] as const;
const ledgerTables = [...legacyTables, 'app_migration'] as const;
export const backupDatabaseTables = (version: 1 | 2): readonly BackupDatabaseTable[] => (version === 2 ? ledgerTables : legacyTables);

const count = 'number.integer >= 0 & number <= 250000';
const legacyCounts = { user: count, app_store: count, app: count, link: count } as const;
export const backupDatabaseCountsSchema = type(legacyCounts)
  .onUndeclaredKey('reject')
  .or(type({ ...legacyCounts, app_migration: count }).onUndeclaredKey('reject'));
export type BackupDatabaseCounts = typeof backupDatabaseCountsSchema.infer;
export const backupDatabaseVersion = (counts: BackupDatabaseCounts) => ('app_migration' in counts ? 2 : 1);
export const backupDatabaseCount = (counts: BackupDatabaseCounts, table: BackupDatabaseTable) =>
  table === 'app_migration' ? ('app_migration' in counts ? counts.app_migration : 0) : counts[table];

const metadata = Object.fromEntries(ledgerTables.map((table) => [table, getTableConfig(tables[table]).columns])) as Record<
  BackupDatabaseTable,
  ReturnType<typeof getTableConfig>['columns']
>;
const legacyAppColumns = metadata.app.filter((column) => column.name !== 'migrations_baselined');
const columns = (name: BackupDatabaseTable, version: 1 | 2) => (name === 'app' && version === 1 ? legacyAppColumns : metadata[name]);
export const backupDatabaseColumns = (name: BackupDatabaseTable, version: 1 | 2 = 1) => columns(name, version).map((column) => column.name);
export const backupDatabaseOrder = (table: BackupDatabaseTable) =>
  table === 'app_migration' ? ['app_id', 'migration_id'] : [table === 'app_store' ? 'slug' : 'id'];

export const backupDatabaseLimits = { rows: 250_000, rowBytes: 8 * 1024 * 1024, totalBytes: 256 * 1024 * 1024, depth: 32, nodes: 250_000 };
type RecordValue = Record<string, unknown>;
type Account = { id: number; operator: boolean; totp_enabled: boolean; totp_secret: string | null; salt: string | null };

export class BackupDatabaseRecordError extends BackupRequirementError {
  constructor(readonly reason: 'schema' | 'limit' | 'identity' | 'account' | 'passkey') {
    super('The backup database contains unsupported or inconsistent records. No server data has been changed.');
  }
}
function invalid(reason: ConstructorParameters<typeof BackupDatabaseRecordError>[0]): never {
  throw new BackupDatabaseRecordError(reason);
}
const object = (value: unknown): value is RecordValue =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value)));
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
export function backupMigrationDigest(flags: ReadonlyMap<number, boolean>, migrations: ReadonlyMap<number, string[]>) {
  const digest = createHash('sha256');
  for (const [id, baselined] of [...flags].sort(([a], [b]) => a - b)) {
    digest.update(JSON.stringify([id, baselined, [...(migrations.get(id) ?? [])].sort()]));
    digest.update('\n');
  }
  return digest.digest('hex');
}
const safeText = (value: string) => !/[\0\uD800-\uDFFF]/u.test(value);

export function boundedPasswordHash(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 1024) return false;
  const match =
    /^\$argon2(?:id|i|d)\$v=(?:16|19)\$m=([1-9][0-9]{0,8}),t=([1-9][0-9]{0,2}),p=([1-9][0-9]{0,2})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(value);
  if (!match) return false;
  const memory = Number(match[1]);
  const iterations = Number(match[2]);
  const parallel = Number(match[3]);
  if (memory < 8 * parallel || memory > 262144 || iterations > 10 || parallel > 8 || memory * iterations > 1048576) return false;
  return [match[4], match[5]].every((part, index) => {
    if (!part) return false;
    const bytes = Buffer.from(part, 'base64');
    return bytes.length >= (index ? 16 : 8) && bytes.length <= (index ? 128 : 64) && bytes.toString('base64').replace(/=+$/, '') === part;
  });
}

function validateJson(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  if (++budget.nodes > backupDatabaseLimits.nodes || depth > backupDatabaseLimits.depth) invalid('limit');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid('schema');
    return;
  }
  if (typeof value === 'string') {
    if (!safeText(value)) invalid('schema');
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) validateJson(child, depth + 1, budget);
    return;
  }
  if (!object(value)) invalid('schema');
  for (const [key, child] of Object.entries(value)) {
    if (!safeText(key)) invalid('schema');
    validateJson(child, depth + 1, budget);
  }
}

export class BackupDatabaseRecords {
  private count = 0;
  private bytes = 0;
  private accounts = new Map<number, Account>();
  private linkUsers = new Set<number>();
  private identities = Object.fromEntries(backupDatabaseTables(2).map((name) => [name, new Set<number | string>()])) as Record<
    BackupDatabaseTable,
    Set<number | string>
  >;
  private storeHashes = new Set<string>();
  private subnets = new Set<string>();
  readonly counts: BackupDatabaseCounts;
  private readonly migrationFlags = new Map<number, boolean>();
  private readonly migrationIds = new Map<number, string[]>();

  private readonly expectedApps: Map<number, ReturnType<typeof decodeAppRuntimeCapture>['metadata']['apps'][number]> | undefined;
  private readonly seenApps = new Set<number>();

  constructor(
    private readonly jwtSecret: string,
    appRuntime?: ReturnType<typeof decodeAppRuntimeCapture>,
    private readonly version: 1 | 2 = 1,
  ) {
    this.counts = { user: 0, app_store: 0, app: 0, link: 0, ...(version === 2 ? { app_migration: 0 } : {}) };
    if (!jwtSecret || jwtSecret.length > 4096) invalid('account');
    if (appRuntime) {
      appRuntimeImageBindings(appRuntime);
      this.expectedApps = new Map(appRuntime.metadata.apps.map((entry) => [entry.id, entry]));
    }
  }

  accept(name: BackupDatabaseTable, value: unknown): RecordValue {
    if (!backupDatabaseTables(this.version).includes(name) || !object(value)) invalid('schema');
    const fields = columns(name, this.version);
    if (Object.keys(value).length !== fields.length || fields.some((column) => !Object.hasOwn(value, column.name))) invalid('schema');
    const row: RecordValue = {};
    for (const column of fields) {
      const entry = value[column.name];
      if (entry === null) {
        if (column.notNull && !(name === 'app' && column.name === 'user_config_enabled' && this.expectedApps)) invalid('schema');
      } else if (column.enumValues?.length) {
        if (typeof entry !== 'string' || !column.enumValues.includes(entry)) invalid('schema');
      } else if (column.dataType === 'number') {
        if (!integer(entry)) invalid('schema');
      } else if (column.dataType === 'boolean') {
        if (typeof entry !== 'boolean') invalid('schema');
      } else if (column.dataType === 'string') {
        if (typeof entry !== 'string' || !safeText(entry)) invalid('schema');
        const length = /^varchar\((\d+)\)$/.exec(column.getSQLType())?.[1];
        if (length && Array.from(entry).length > Number(length)) invalid('schema');
      } else if (column.dataType === 'json' || column.getSQLType() === 'jsonb') {
        if (!object(entry)) invalid('schema');
        validateJson(entry);
      } else invalid('schema');
      row[column.name] = name === 'app' && column.name === 'user_config_enabled' && entry === null && this.expectedApps ? true : entry;
    }
    const encoded = JSON.stringify(row);
    const size = Buffer.byteLength(encoded);
    if (this.count + 1 > backupDatabaseLimits.rows || size > backupDatabaseLimits.rowBytes || this.bytes + size > backupDatabaseLimits.totalBytes)
      invalid('limit');
    const id = name === 'app_store' ? row.slug : row.id;
    let key: number | string;
    if (name === 'app_migration') {
      const { app_id: appId, migration_id: migrationId } = row;
      if (
        !integer(appId) ||
        this.migrationFlags.get(appId) !== true ||
        typeof migrationId !== 'string' ||
        !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(migrationId)
      )
        invalid('identity');
      const ids = this.migrationIds.get(appId) ?? [];
      if (ids.length >= 300) invalid('limit');
      key = `${appId}:${migrationId}`;
      if (this.identities[name].has(key)) invalid('identity');
      ids.push(migrationId);
      this.migrationIds.set(appId, ids);
    } else if (name === 'app_store' && typeof id === 'string' && id) key = id;
    else if (name !== 'app_store' && integer(id) && id > 0) key = id;
    else invalid('identity');
    if (this.identities[name].has(key)) invalid('identity');
    if (name === 'app' && this.expectedApps) {
      const expected = this.expectedApps.get(row.id as number);
      if (
        !expected ||
        expected.urn !== `${row.app_name}:${row.app_store_slug}` ||
        expected.status !== row.status ||
        expected.pendingRestart !== row.pending_restart ||
        expected.userConfigEnabled !== (row.user_config_enabled ?? true)
      )
        invalid('identity');
      this.seenApps.add(expected.id);
    }
    if (name === 'user') {
      if (!boundedPasswordHash(row.password) || typeof row.username !== 'string' || !row.username) invalid('account');
    }
    const unique = (set: Set<string>, key: string): string | null => {
      const entry = row[key];
      if (entry === null) return null;
      if (typeof entry !== 'string' || set.has(entry)) invalid('identity');
      return entry;
    };
    const storeHash = name === 'app_store' ? unique(this.storeHashes, 'hash') : null;
    const subnet = name === 'app' ? unique(this.subnets, 'subnet') : null;
    this.identities[name].add(key);
    if (name === 'app' && this.version === 2) this.migrationFlags.set(row.id as number, row.migrations_baselined as boolean);
    if (name === 'user') this.accounts.set(row.id as number, row as Account);
    if (name === 'link') this.linkUsers.add(row.user_id as number);
    if (storeHash !== null) this.storeHashes.add(storeHash);
    if (subnet !== null) this.subnets.add(subnet);
    this.count++;
    this.bytes += size;
    if (name === 'app_migration') {
      if (!('app_migration' in this.counts)) invalid('schema');
      this.counts.app_migration++;
    } else this.counts[name]++;
    return JSON.parse(encoded) as RecordValue;
  }

  migrationDigest() {
    return this.version === 2 ? backupMigrationDigest(this.migrationFlags, this.migrationIds) : undefined;
  }

  async finish(passkeys: unknown | undefined, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.expectedApps && this.seenApps.size !== this.expectedApps.size) invalid('identity');
    if (![...this.accounts.values()].some((account) => account.operator)) invalid('account');
    if ([...this.linkUsers].some((id) => !this.accounts.has(id))) invalid('identity');
    for (const account of this.accounts.values()) {
      signal.throwIfAborted();
      if (!account.totp_enabled) continue;
      if (typeof account.salt !== 'string' || !account.salt || account.salt.length > 1024 || typeof account.totp_secret !== 'string')
        invalid('account');
      const parts = /^([a-f0-9]{24}):([a-f0-9]{16,1024}):([a-f0-9]{32})$/.exec(account.totp_secret);
      if (!parts || (parts[2]?.length ?? 0) % 2) invalid('account');
      const key = await deriveKey(this.jwtSecret, account.salt, 100000, 32, 'sha256');
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1] ?? '', 'hex'));
        decipher.setAuthTag(Buffer.from(parts[3] ?? '', 'hex'));
        const seed = Buffer.concat([decipher.update(Buffer.from(parts[2] ?? '', 'hex')), decipher.final()]);
        try {
          if (!/^[A-Z2-7]{16,256}=*$/.test(seed.toString('utf8'))) invalid('account');
        } finally {
          seed.fill(0);
        }
      } catch {
        invalid('account');
      } finally {
        key.fill(0);
      }
    }
    if (passkeys !== undefined) {
      const parsed = passkeyStateSchema(passkeys);
      if (parsed instanceof type.errors) invalid('passkey');
      const ids = new Set<string>();
      for (const [id, state] of Object.entries(parsed.users)) {
        const account = this.accounts.get(Number(id));
        if (!account) invalid('passkey');
        if (state.totpAfterPasskey) {
          const binding =
            account.totp_enabled && account.totp_secret && account.salt
              ? createHash('sha256').update(`${account.totp_secret}/${account.salt}`).digest('hex')
              : null;
          if (binding !== state.totpAfterPasskey) invalid('passkey');
        }
        for (const credential of state.credentials) {
          if (ids.has(credential.id)) invalid('passkey');
          ids.add(credential.id);
        }
      }
    }
    signal.throwIfAborted();
    return { ...this.counts };
  }
}
