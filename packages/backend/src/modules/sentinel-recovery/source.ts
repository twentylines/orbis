import { createHash } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import type { Database } from '@/core/database/database.module';
import { user } from '@/core/database/drizzle/schema';
import type { EncryptionService } from '@/core/encryption/encryption.service';
import type { PasskeyStore, PasskeyState } from '../auth/passkey.store';
import { readRecoveryIdentity, type RecoveryIdentity } from './identity';
import { credentialWriters } from './writer-gate';

const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export class RecoverySourceError extends Error {
  constructor(readonly code: 'busy' | 'source' | 'cancelled') {
    super(code === 'busy' ? 'Account credentials are changing. Try again shortly.' : 'The recovery credential source could not be verified.');
    this.name = 'RecoverySourceError';
  }
}

type Account = typeof user.$inferSelect;
type Dependencies = {
  database: Pick<Database, 'transaction'>;
  passkeys: Pick<PasskeyStore, 'withReadFence' | 'snapshot'>;
  encryption: Pick<EncryptionService, 'decrypt'>;
  config: {
    get(key: 'directories'): { dataDir: string };
    get(key: 'jwtSecret'): string;
  };
  origin: string;
  signal: AbortSignal;
};

/** Pure candidate construction from caller-fenced account and passkey state.
 * Supplied values are not proof of a committed Main identity or host admission.
 */
export function buildRecoveryIdentitySource(account: Account, passkeys: PasskeyState, origin: string, encryption: Dependencies['encryption']) {
  const realm = new URL(origin);
  if (realm.protocol !== 'https:' || realm.origin !== origin || realm.username || realm.password || realm.port === '0')
    throw new RecoverySourceError('source');
  const keys = passkeys.users[String(account.id)];
  const policy = account.totpEnabled && account.totpSecret && account.salt ? digest(`${account.totpSecret}/${account.salt}`) : null;
  const candidate: Omit<RecoveryIdentity, 'revision'> = {
    schema: 'orbis.sentinel-identity.v1',
    accountId: account.id,
    username: account.username,
    operator: true,
    passwordHash: account.password,
    totpEnabled: account.totpEnabled,
    totpSecret: account.totpEnabled && account.totpSecret && account.salt ? encryption.decrypt(account.totpSecret, account.salt) : null,
    requireTotpAfterPasskey: Boolean(policy && keys?.totpAfterPasskey === policy),
    userHandle: keys?.handle ?? null,
    realm: { origin, rpID: realm.hostname },
    credentials: (keys?.credentials ?? [])
      .filter((key) => key.rpID === realm.hostname)
      .map(({ id, publicKey, counter, rpID }) => ({ id, publicKey, counter, rpID }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
  if (!account.operator) throw new RecoverySourceError('source');
  const revision = digest(JSON.stringify(candidate));
  const bytes = Buffer.from(JSON.stringify({ ...candidate, revision }));
  try {
    const sha256 = digest(bytes);
    readRecoveryIdentity(bytes, sha256);
    return { bytes, sha256, revision };
  } catch {
    bytes.fill(0);
    throw new RecoverySourceError('source');
  }
}

/** Pins account and passkey reads while a trusted caller stages the protected identity.
 * The callback must not write accounts or passkeys. This grants no authority to
 * mutate credentials, enroll a recovery operator or assume validity after release.
 */
export async function withRecoveryIdentitySource<T>(
  options: Dependencies,
  work: (source: Readonly<{ bytes: Buffer; sha256: string; revision: string }>) => Promise<T>,
): Promise<T> {
  return credentialWriters.read(() => readRecoveryIdentitySource(options, work), { signal: options.signal });
}

async function readRecoveryIdentitySource<T>(
  options: Dependencies,
  work: (source: Readonly<{ bytes: Buffer; sha256: string; revision: string }>) => Promise<T>,
): Promise<T> {
  const { database, passkeys, encryption, config, origin, signal } = options;
  const context = () => {
    try {
      return digest(JSON.stringify([config.get('directories').dataDir, config.get('jwtSecret')]));
    } catch {
      throw new RecoverySourceError('source');
    }
  };
  const expected = context();
  const check = () => {
    if (signal.aborted) throw new RecoverySourceError('cancelled');
    if (context() !== expected) throw new RecoverySourceError('source');
  };
  try {
    check();
    return await database.transaction(
      async (tx) => {
        check();
        try {
          await tx.execute(sql`LOCK TABLE ${user} IN SHARE MODE NOWAIT`);
        } catch (error) {
          const failure = error as { code?: unknown; cause?: { code?: unknown } };
          throw new RecoverySourceError(failure?.code === '55P03' || failure?.cause?.code === '55P03' ? 'busy' : 'source');
        }
        check();
        return passkeys.withReadFence(async () => {
          check();
          const accounts = await tx.select().from(user).where(eq(user.operator, true)).orderBy(user.id).limit(2);
          if (accounts.length !== 1) throw new RecoverySourceError('source');
          const account = accounts[0];
          if (!account) throw new RecoverySourceError('source');
          const snapshot = await passkeys.snapshot();
          check();
          const source = buildRecoveryIdentitySource(account, snapshot, origin, encryption);
          try {
            const result = await work(Object.freeze(source));
            check();
            if (digest(source.bytes) !== source.sha256) throw new RecoverySourceError('source');
            return result;
          } finally {
            source.bytes.fill(0);
          }
        });
      },
      { isolationLevel: 'read committed', accessMode: 'read write' },
    );
  } catch (error) {
    if (error instanceof RecoverySourceError) throw error;
    throw new RecoverySourceError('source');
  }
}
