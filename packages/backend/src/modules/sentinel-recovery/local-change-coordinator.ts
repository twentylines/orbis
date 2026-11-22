import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { User } from '@/core/database/drizzle/types';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { PasskeyState, PasskeyStore, PreparedPasskeyChange } from '../auth/passkey.store';
import type { UserRepository } from '../user/user.repository';
import { accountPatch, RecoveryChangeError, type RecoveryChangeOutcome } from './change-coordinator';
import type { CredentialChange } from './credential-synchronization.service';
import type { HostCredentialRecoveryBroker } from './host-broker';
import { OwnershipWriteError, OwnershipWriteLease, type OwnershipOutcome } from './ownership-authority';
import { credentialWriters } from './writer-gate';

type Dependencies = {
  users: Pick<UserRepository, 'withCredentialTransaction'>;
  passkeys: Pick<PasskeyStore, 'withPreparedChange' | 'withReadFence' | 'snapshot'>;
  config: Pick<ConfigurationService, 'get'>;
  broker: Pick<HostCredentialRecoveryBroker, 'ownershipPrepare' | 'ownershipCheck' | 'ownershipComplete'>;
  admissionBinding: string;
};
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const sameAccount = (actual: User, planned: User) => {
  // The database owns updatedAt; every other column must match the plan.
  const { updatedAt: _actualTime, ...actualFields } = actual;
  const { updatedAt: _plannedTime, ...plannedFields } = planned;
  return isDeepStrictEqual(actualFields, plannedFields);
};

/** Only a positively admitted Root birth issuer selects this path. No recovery
 * identity or realm is manufactured for an installation that has never joined.
 * The durable Root hold covers both stores, including uncertain COMMIT replies.
 */
export class LocalCredentialChangeCoordinator {
  constructor(private readonly dependencies: Dependencies) {}

  change<T>(request: CredentialChange<T>): Promise<T>;
  change<T, R>(request: CredentialChange<T> & { afterSuccess(value: T): R | Promise<R> }): Promise<R>;
  change<T, R>(request: CredentialChange<T> & { afterSuccess?(value: T): R | Promise<R> }): Promise<T | R> {
    const { users, passkeys, config, broker, admissionBinding } = this.dependencies;
    return credentialWriters.run(
      async () => {
        let lease: OwnershipWriteLease | undefined;
        const requestId = randomBytes(32).toString('hex');
        let failedPreparation: OwnershipOutcome | undefined;
        const outcome: { phase: RecoveryChangeOutcome['phase']; sql: RecoveryChangeOutcome['sql'] } = { phase: 'admission', sql: 'not-written' };
        let fileOutcome: (() => PreparedPasskeyChange<unknown>['outcome']) | undefined;
        let expectedAccount: User | undefined;
        let expectedKeys: PasskeyState | undefined;
        const context = () =>
          createHash('sha256')
            .update(
              JSON.stringify([
                config.get('directories').dataDir,
                config.get('jwtSecret'),
                process.env.ORBIS_HOST_SOCKET,
                process.env.ORBIS_SENTINEL_RECOVERY_ORIGIN,
              ]),
            )
            .digest('hex');
        const expectedContext = context();
        const failure = (code: RecoveryChangeError['code'] = 'unavailable') => {
          const held = lease?.outcome ?? failedPreparation;
          return new RecoveryChangeError(
            code,
            Object.freeze({
              phase: outcome.phase,
              sql: outcome.sql,
              passkeys: fileOutcome?.() ?? 'uncommitted',
              recovery: held?.authority === 'completed' ? 'completed' : held?.authority === 'pending' ? 'pending' : held ? 'unknown' : 'not-started',
              requestId: held?.requestId ?? requestId,
              ...(held?.operationId ? { operationId: held.operationId } : {}),
            }),
          );
        };
        const check = () => {
          if (request.signal?.aborted || context() !== expectedContext) throw failure();
        };
        try {
          check();
          if (!Number.isSafeInteger(request.accountId) || request.accountId < 1 || !/^[a-f0-9]{64}$/.test(admissionBinding))
            throw failure('invalid-plan');
          const result = await users.withCredentialTransaction(async (repository) => {
            const operators = await repository.getOperators();
            const account = await repository.getUserById(request.accountId);
            if (operators.length !== 1 || operators[0]?.id !== request.accountId || !account?.operator) throw failure('invalid-plan');
            const before = freeze(structuredClone(account));
            return passkeys.withPreparedChange(
              async (draft) => {
                outcome.phase = 'proof';
                check();
                await credentialWriters.read(() => request.authorize(before, freeze(structuredClone(draft))));
                outcome.phase = 'plan';
                check();
                const proposed = await credentialWriters.read(() => request.plan(before, draft));
                check();
                if (
                  !proposed ||
                  typeof proposed !== 'object' ||
                  Reflect.ownKeys(proposed).length !== 2 ||
                  !Object.hasOwn(proposed, 'patch') ||
                  !Object.hasOwn(proposed, 'value')
                )
                  throw failure('invalid-plan');
                let patch: ReturnType<typeof accountPatch>;
                try {
                  patch = accountPatch(proposed.patch);
                } catch {
                  throw failure('invalid-plan');
                }
                return { patch, value: proposed.value };
              },
              async (file) => {
                fileOutcome = () => file.outcome;
                check();
                const otherAccounts = (view: typeof file.before) =>
                  Object.fromEntries(Object.entries(view.users).filter(([id]) => id !== String(request.accountId)));
                if (!isDeepStrictEqual(otherAccounts(file.before), otherAccounts(file.after))) throw failure('invalid-plan');
                const oldKeys = file.before.users[String(request.accountId)]?.credentials ?? [];
                const nextKeys = file.after.users[String(request.accountId)]?.credentials ?? [];
                if (
                  nextKeys.some((key) =>
                    oldKeys.some(
                      (old) => old.id === key.id && old.publicKey === key.publicKey && old.rpID === key.rpID && old.counter !== key.counter,
                    ),
                  )
                )
                  throw failure('counter-sync-required');
                expectedAccount = structuredClone({ ...before, ...file.value.patch });
                expectedKeys = structuredClone(file.after) as PasskeyState;
                outcome.phase = 'prepare';
                try {
                  lease = await OwnershipWriteLease.prepare(broker, 'credential-change', requestId);
                } catch (error) {
                  if (error instanceof OwnershipWriteError) failedPreparation = error.outcome;
                  throw error;
                }
                if (lease.admissionBinding !== admissionBinding) throw failure();
                check();
                outcome.phase = 'write';
                await lease.beforeWrite();
                check();
                if (Object.keys(file.value.patch).length) {
                  outcome.sql = 'uncertain';
                  await repository.updateUser(request.accountId, file.value.patch);
                }
                const actual = await repository.getUserById(request.accountId);
                if (!actual || !sameAccount(actual, expectedAccount)) throw failure();
                check();
                await file.commit();
                check();
                return file.value.value;
              },
            );
          });
          outcome.sql = outcome.sql === 'uncertain' ? 'committed' : 'not-written';
          outcome.phase = 'source';
          check();
          if (!lease || !expectedAccount || !expectedKeys) throw failure();
          const plannedAccount = expectedAccount;
          await users.withCredentialTransaction(async (repository) =>
            passkeys.withReadFence(async () => {
              const operators = await repository.getOperators();
              const actual = await repository.getUserById(request.accountId);
              if (
                operators.length !== 1 ||
                operators[0]?.id !== request.accountId ||
                !actual ||
                !sameAccount(actual, plannedAccount) ||
                !isDeepStrictEqual(await passkeys.snapshot(), expectedKeys)
              )
                throw failure();
              check();
            }),
          );
          check();
          outcome.phase = 'complete';
          await lease.finishCommitted();
          outcome.phase = 'after-success';
          check();
          return request.afterSuccess ? await request.afterSuccess(result) : result;
        } catch (error) {
          // Only an uninvoked write can release its hold. A failed transaction or
          // file rename may already have taken effect; preserve those for review.
          if (lease?.outcome.writes === 'not-started') {
            try {
              await lease.cancelUnwritten();
            } catch {
              throw failure();
            }
          }
          if (outcome.phase === 'proof' && !lease) throw error;
          if (error instanceof RecoveryChangeError) throw failure(error.code);
          throw failure();
        }
      },
      { signal: request.signal },
    );
  }
}
