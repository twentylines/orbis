import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ServiceUnavailableException } from '@nestjs/common';
import type { Database } from '@/core/database/database.module';
import type { User } from '@/core/database/drizzle/types';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { EncryptionService } from '@/core/encryption/encryption.service';
import type { PasskeyState, PasskeyStore, PreparedPasskeyChange } from '../auth/passkey.store';
import type { UserRepository } from '../user/user.repository';
import { buildRecoveryIdentitySource, withRecoveryIdentitySource } from './source';
import { credentialWriters } from './writer-gate';

type AccountPatch = Partial<Pick<User, 'username' | 'password' | 'totpEnabled' | 'totpSecret' | 'salt'>>;
type KeyView = PreparedPasskeyChange<unknown>['before'];
type Admission = { mode: 'managed' | 'unmanaged' | 'unknown'; binding: string };
type Pending = { operationId: string; state: 'pending'; admissionBinding: string; baselineSha256: string; plannedSha256: string };
type Completed = { operationId: string; state: 'completed'; admissionBinding: string; plannedSha256: string };

/** Trusted, fixed-purpose host port. Main never receives the Root change token.
 * Missing service is unknown. Even unmanaged writes need a durable host lease so
 * installation cannot enable recovery in the middle of an uncoordinated write.
 */
export type CredentialRecoveryBroker = {
  admission(options: { signal?: AbortSignal }): Promise<Admission>;
  prepare(options: {
    requestId: string;
    admissionBinding: string;
    baselineIdentity: Buffer;
    plannedIdentity: Buffer;
    signal?: AbortSignal;
  }): Promise<Pending>;
  complete(options: { operationId: string; admissionBinding: string; currentIdentity: Buffer; signal?: AbortSignal }): Promise<Completed>;
};

export type RecoveryChangeOutcome = Readonly<{
  phase: 'admission' | 'proof' | 'plan' | 'prepare' | 'write' | 'source' | 'complete' | 'after-success';
  sql: 'not-written' | 'uncertain' | 'committed';
  passkeys: PreparedPasskeyChange<unknown>['outcome'];
  recovery: 'not-started' | 'unknown' | 'pending' | 'completed';
  requestId: string;
  operationId?: string;
}>;

export class RecoveryChangeError extends ServiceUnavailableException {
  constructor(
    readonly code: 'unavailable' | 'invalid-plan' | 'counter-sync-required',
    readonly outcome: RecoveryChangeOutcome,
  ) {
    super('The credential change could not be verified. Check recovery before trying again.');
  }
}

type Dependencies = {
  users: Pick<UserRepository, 'withCredentialTransaction'>;
  database: Pick<Database, 'transaction'>;
  passkeys: Pick<PasskeyStore, 'withPreparedChange' | 'withReadFence' | 'snapshot'>;
  config: Pick<ConfigurationService, 'get'>;
  encryption: Pick<EncryptionService, 'decrypt'>;
  broker: CredentialRecoveryBroker;
  origin: string;
};
type Change<T> = {
  accountId: number;
  signal?: AbortSignal;
  authorize(account: Readonly<User>, passkeys: KeyView): void | Promise<void>;
  plan(account: Readonly<User>, passkeys: PasskeyState): { patch: AccountPatch; value: T } | Promise<{ patch: AccountPatch; value: T }>;
};

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Reflect.ownKeys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const frozen = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
};

export function accountPatch(value: unknown): AccountPatch {
  const fields = ['username', 'password', 'totpEnabled', 'totpSecret', 'salt'];
  if (value === null || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new Error('Invalid credential plan.');
  const result: AccountPatch = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !fields.includes(key)) throw new Error('Invalid credential plan.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new Error('Invalid credential plan.');
    const item: unknown = descriptor.value;
    if (
      key === 'totpEnabled'
        ? typeof item !== 'boolean'
        : key === 'totpSecret' || key === 'salt'
          ? item !== null && typeof item !== 'string'
          : typeof item !== 'string'
    )
      throw new Error('Invalid credential plan.');
    Reflect.set(result, key, item);
  }
  return result;
}

/** Existing-operator authority mutations only. Counter advancement, enrollment,
 * account removal, realm/JWT replacement and stopped-controller lifecycle need
 * their separate host protocols; this coordinator does not silently cover them.
 */
export class RecoveryChangeCoordinator {
  constructor(private readonly dependencies: Dependencies) {}

  change<T>(request: Change<T>): Promise<T>;
  change<T, R>(request: Change<T> & { afterSuccess(value: T): R | Promise<R> }): Promise<R>;
  change<T, R>(request: Change<T> & { afterSuccess?(value: T): R | Promise<R> }): Promise<T | R> {
    const { users, database, passkeys, config, encryption, broker, origin } = this.dependencies;
    return credentialWriters.run(
      async () => {
        const outcome: {
          phase: RecoveryChangeOutcome['phase'];
          sql: RecoveryChangeOutcome['sql'];
          passkeys: RecoveryChangeOutcome['passkeys'];
          recovery: RecoveryChangeOutcome['recovery'];
          requestId: string;
          operationId?: string;
        } = { phase: 'admission', sql: 'not-written', passkeys: 'uncommitted', recovery: 'not-started', requestId: randomBytes(32).toString('hex') };
        const failureCode: RecoveryChangeError['code'] = 'unavailable';
        let fileOutcome: (() => RecoveryChangeOutcome['passkeys']) | undefined;
        const buffers: Buffer[] = [];
        const fail = (code: RecoveryChangeError['code'] = failureCode): never => {
          outcome.passkeys = fileOutcome?.() ?? outcome.passkeys;
          throw new RecoveryChangeError(code, Object.freeze({ ...outcome }));
        };
        const check = () => {
          if (request.signal?.aborted) return fail();
        };
        const context = () => sha256(Buffer.from(JSON.stringify([config.get('directories').dataDir, config.get('jwtSecret'), origin])));
        let expectedContext: string | undefined;
        const checkContext = () => {
          check();
          if (context() !== expectedContext) return fail();
        };
        const copy = (bytes: Buffer) => {
          const value = Buffer.from(bytes);
          buffers.push(value);
          return value;
        };
        try {
          expectedContext = context();
          checkContext();
          const admitted: unknown = await broker.admission({ signal: request.signal });
          if (!exact(admitted, ['mode', 'binding']) || (admitted.mode !== 'managed' && admitted.mode !== 'unmanaged') || !hash(admitted.binding))
            return fail();
          const admissionBinding = admitted.binding;
          checkContext();
          if (!Number.isSafeInteger(request.accountId) || request.accountId < 1) return fail('invalid-plan');
          let expectedSource: string | undefined;
          const result = await users.withCredentialTransaction(async (repository) => {
            const operators = await repository.getOperators();
            if (operators.length !== 1 || operators[0]?.id !== request.accountId) return fail('invalid-plan');
            const current = await repository.getUserById(request.accountId);
            if (!current?.operator) return fail('invalid-plan');
            const beforeAccount = frozen(structuredClone(current));
            return passkeys.withPreparedChange(
              async (draft) => {
                outcome.phase = 'proof';
                checkContext();
                await credentialWriters.read(() => request.authorize(beforeAccount, frozen(structuredClone(draft))));
                outcome.phase = 'plan';
                checkContext();
                const proposed = await credentialWriters.read(() => request.plan(beforeAccount, draft));
                let patch: AccountPatch;
                try {
                  if (!exact(proposed, ['patch', 'value'])) return fail('invalid-plan');
                  patch = accountPatch(proposed.patch);
                } catch {
                  return fail('invalid-plan');
                }
                return { patch, value: proposed.value };
              },
              async (file) => {
                fileOutcome = () => file.outcome;
                checkContext();
                const otherAccounts = (view: KeyView) =>
                  Object.fromEntries(Object.entries(view.users).filter(([id]) => id !== String(request.accountId)));
                if (!isDeepStrictEqual(otherAccounts(file.before), otherAccounts(file.after))) return fail('invalid-plan');
                const baseline = buildRecoveryIdentitySource(beforeAccount, structuredClone(file.before) as PasskeyState, origin, encryption);
                buffers.push(baseline.bytes);
                const plannedAccount = { ...beforeAccount, ...file.value.patch };
                const planned = buildRecoveryIdentitySource(plannedAccount, structuredClone(file.after) as PasskeyState, origin, encryption);
                buffers.push(planned.bytes);
                const oldKeys = file.before.users[String(request.accountId)]?.credentials ?? [];
                const nextKeys = file.after.users[String(request.accountId)]?.credentials ?? [];
                if (
                  nextKeys.some((credential) =>
                    oldKeys.some(
                      (old) =>
                        old.id === credential.id &&
                        old.publicKey === credential.publicKey &&
                        old.rpID === credential.rpID &&
                        old.counter !== credential.counter,
                    ),
                  )
                )
                  return fail('counter-sync-required');
                expectedSource = planned.sha256;
                outcome.phase = 'prepare';
                outcome.recovery = 'unknown';
                const baselineIdentity = copy(baseline.bytes);
                const plannedIdentity = copy(planned.bytes);
                let pending: unknown;
                try {
                  pending = await broker.prepare({
                    requestId: outcome.requestId,
                    admissionBinding,
                    baselineIdentity,
                    plannedIdentity,
                    signal: request.signal,
                  });
                } finally {
                  baselineIdentity.fill(0);
                  plannedIdentity.fill(0);
                }
                if (
                  !exact(pending, ['operationId', 'state', 'admissionBinding', 'baselineSha256', 'plannedSha256']) ||
                  !hash(pending.operationId) ||
                  pending.state !== 'pending' ||
                  pending.admissionBinding !== admissionBinding ||
                  pending.baselineSha256 !== baseline.sha256 ||
                  pending.plannedSha256 !== planned.sha256
                )
                  return fail();
                outcome.operationId = pending.operationId;
                outcome.recovery = 'pending';
                outcome.phase = 'write';
                checkContext();
                if (Object.keys(file.value.patch).length) {
                  // A rejection may be a lost COMMIT reply; only a successful outer
                  // transaction resolution proves commitment to this process.
                  outcome.sql = 'uncertain';
                  await repository.updateUser(request.accountId, file.value.patch);
                }
                const actual = await repository.getUserById(request.accountId);
                if (!actual?.operator) return fail();
                const actualSource = buildRecoveryIdentitySource(actual, structuredClone(file.after) as PasskeyState, origin, encryption);
                buffers.push(actualSource.bytes);
                if (actualSource.sha256 !== planned.sha256) return fail();
                checkContext();
                await file.commit();
                outcome.passkeys = file.outcome;
                return file.value.value;
              },
            );
          });
          outcome.sql = outcome.sql === 'uncertain' ? 'committed' : 'not-written';
          outcome.phase = 'source';
          checkContext();
          const operationId = outcome.operationId;
          if (!operationId || !expectedSource) return fail();
          await withRecoveryIdentitySource(
            { database, passkeys, config, encryption, origin, signal: request.signal ?? new AbortController().signal },
            async (source) => {
              if (source.sha256 !== expectedSource) return fail();
              checkContext();
              outcome.phase = 'complete';
              outcome.recovery = 'unknown';
              const currentIdentity = copy(source.bytes);
              let completed: unknown;
              try {
                completed = await broker.complete({ operationId, admissionBinding, currentIdentity, signal: request.signal });
              } finally {
                currentIdentity.fill(0);
              }
              if (
                !exact(completed, ['operationId', 'state', 'admissionBinding', 'plannedSha256']) ||
                completed.operationId !== operationId ||
                completed.state !== 'completed' ||
                completed.admissionBinding !== admissionBinding ||
                completed.plannedSha256 !== expectedSource
              )
                return fail();
              outcome.recovery = 'completed';
            },
          );
          outcome.phase = 'after-success';
          checkContext();
          return request.afterSuccess ? await request.afterSuccess(result) : result;
        } catch (error) {
          // Existing wrong-password/TOTP authorization errors keep their policy and
          // status before any Root attempt or identity write has occurred.
          if (outcome.phase === 'proof' && outcome.recovery === 'not-started') throw error;
          if (error instanceof RecoveryChangeError) throw error;
          return fail();
        } finally {
          for (const buffer of buffers) buffer.fill(0);
        }
      },
      { signal: request.signal },
    );
  }
}
