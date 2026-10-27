import { createDecipheriv, createHash, pbkdf2 } from 'node:crypto';
import { promisify } from 'node:util';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { type } from 'arktype';
import { app, appStore, link, user } from '@/core/database/drizzle/schema';
import { passkeyStateSchema } from '../auth/passkey.store';
import { BackupRequirementError } from './backup-files';

const deriveKey = promisify(pbkdf2);
const tables = { user, app_store: appStore, app, link } as const;
export type BackupDatabaseTable = keyof typeof tables;
export const backupDatabaseTables = Object.keys(tables) as BackupDatabaseTable[];
const metadata = Object.fromEntries(backupDatabaseTables.map((name) => [name, getTableConfig(tables[name]).columns])) as Record<
  BackupDatabaseTable,
  ReturnType<typeof getTableConfig>['columns']
>;
export const backupDatabaseColumns = (name: BackupDatabaseTable) => metadata[name].map((column) => column.name);
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
  private identities = Object.fromEntries(backupDatabaseTables.map((name) => [name, new Set<number | string>()])) as Record<
    BackupDatabaseTable,
    Set<number | string>
  >;
  private storeHashes = new Set<string>();
  private subnets = new Set<string>();
  readonly counts = { user: 0, app_store: 0, app: 0, link: 0 };

  constructor(private readonly jwtSecret: string) {
    if (!jwtSecret || jwtSecret.length > 4096) invalid('account');
  }

  accept(name: BackupDatabaseTable, value: unknown): RecordValue {
    if (!Object.hasOwn(tables, name) || !object(value)) invalid('schema');
    const columns = metadata[name];
    if (Object.keys(value).length !== columns.length || columns.some((column) => !Object.hasOwn(value, column.name))) invalid('schema');
    const row: RecordValue = {};
    for (const column of columns) {
      const entry = value[column.name];
      if (entry === null) {
        if (column.notNull) invalid('schema');
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
      row[column.name] = entry;
    }
    const encoded = JSON.stringify(row);
    const size = Buffer.byteLength(encoded);
    if (this.count + 1 > backupDatabaseLimits.rows || size > backupDatabaseLimits.rowBytes || this.bytes + size > backupDatabaseLimits.totalBytes)
      invalid('limit');
    const id = name === 'app_store' ? row.slug : row.id;
    if (name === 'app_store' ? typeof id !== 'string' || !id : !integer(id) || id <= 0) invalid('identity');
    if (this.identities[name].has(id as number | string)) invalid('identity');
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
    this.identities[name].add(id as number | string);
    if (name === 'user') this.accounts.set(row.id as number, row as Account);
    if (name === 'link') this.linkUsers.add(row.user_id as number);
    if (storeHash !== null) this.storeHashes.add(storeHash);
    if (subnet !== null) this.subnets.add(subnet);
    this.count++;
    this.bytes += size;
    this.counts[name]++;
    return JSON.parse(encoded) as RecordValue;
  }

  async finish(passkeys: unknown | undefined, signal: AbortSignal) {
    signal.throwIfAborted();
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
