import { createHash } from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigurationService } from '@/core/config/configuration.service';
import { EncryptionService } from '@/core/encryption/encryption.service';
import { UserRepository } from '../user/user.repository';
import { PasskeyStore, type PreparedPasskeyChange } from '../auth/passkey.store';
import { HostCredentialRecoveryBroker, type MainCounterCeremony } from './host-broker';
import { buildRecoveryIdentitySource } from './source';
import { credentialWriters } from './writer-gate';

type Purpose = 'login' | 'sensitive';
type KeyView = PreparedPasskeyChange<unknown>['before'];
type Verified<T> = { accountId: number; credentialId: string; newCounter: number; value: T };
type Outcome = {
  phase: 'admission' | 'proof' | 'root-counter' | 'file' | 'after-success';
  recovery: 'not-started' | 'unknown' | 'acknowledged' | 'unmanaged';
  passkeys: 'uncommitted' | 'committed' | 'uncertain';
};
const unavailable = () => new ServiceUnavailableException('The passkey could not be synchronized. Check recovery before trying again.');
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const counter = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

export class MainCounterCatchupError extends ServiceUnavailableException {
  constructor(readonly outcome: Readonly<{ phase: 'admission' | 'proof' | 'floors' | 'file' | 'sql'; passkeys: Outcome['passkeys'] }>) {
    super('The passkey counter catchup could not be verified. Check recovery before trying again.');
  }
}

export class MainPasskeySynchronizationError extends ServiceUnavailableException {
  constructor(readonly outcome: Readonly<Outcome>) {
    super('The passkey could not be synchronized. Check recovery before trying again.');
  }
}

/** Main assertions only advance counters. Recovery authority, TOTP and sessions
 * remain separate. Unknown/missing host admission is never unmanaged.
 */
@Injectable()
export class MainPasskeySynchronization {
  constructor(
    private readonly users: UserRepository,
    private readonly passkeys: PasskeyStore,
    private readonly config: ConfigurationService,
    private readonly encryption: EncryptionService,
  ) {}

  private broker() {
    try {
      return new HostCredentialRecoveryBroker(process.env.ORBIS_HOST_SOCKET);
    } catch {
      throw unavailable();
    }
  }

  private origin() {
    try {
      const origin = process.env.ORBIS_SENTINEL_RECOVERY_ORIGIN;
      if (typeof origin !== 'string' || origin.length > 512) throw unavailable();
      const realm = new URL(origin);
      if (realm.protocol !== 'https:' || realm.origin !== origin || realm.username || realm.password || realm.port === '0') throw unavailable();
      return origin;
    } catch {
      throw unavailable();
    }
  }

  private context() {
    return createHash('sha256')
      .update(
        JSON.stringify([
          this.config.get('directories').dataDir,
          this.config.get('jwtSecret'),
          process.env.ORBIS_HOST_SOCKET,
          process.env.ORBIS_SENTINEL_RECOVERY_ORIGIN,
        ]),
      )
      .digest('hex');
  }

  async prepare(options: { purpose: Purpose; ceremonyBinding: string; origin: string; rpID: string }): Promise<MainCounterCeremony> {
    try {
      const broker = this.broker();
      const context = this.context();
      const admission = await broker.admission({});
      if ((admission.mode !== 'managed' && admission.mode !== 'unmanaged') || !hash(admission.binding)) throw unavailable();
      const ceremony = await broker.counterChallenge({
        admissionBinding: admission.binding,
        purpose: options.purpose,
        ceremonyBinding: options.ceremonyBinding,
      });
      if (
        ceremony.mode !== admission.mode ||
        ceremony.admissionBinding !== admission.binding ||
        this.context() !== context ||
        (ceremony.mode === 'managed' && (this.origin() !== options.origin || ceremony.rpID !== options.rpID))
      )
        throw unavailable();
      return ceremony;
    } catch {
      throw unavailable();
    }
  }

  verify<T, R>(options: {
    ceremony: MainCounterCeremony;
    challenge: string;
    origin: string;
    rpID: string;
    response: unknown;
    authorize(state: KeyView, repository: UserRepository): Promise<Verified<T>>;
    afterSuccess(value: T): Promise<R>;
  }): Promise<R> {
    return credentialWriters.run(async () => {
      const outcome: Outcome = { phase: 'admission', recovery: 'not-started', passkeys: 'uncommitted' };
      let authorizationFailure: unknown;
      let fileOutcome: (() => Outcome['passkeys']) | undefined;
      try {
        const broker = this.broker();
        const context = this.context();
        const check = () => {
          if (this.context() !== context) throw unavailable();
        };
        const ceremony = options.ceremony;
        const admission = await broker.admission({});
        if (
          (admission.mode !== 'managed' && admission.mode !== 'unmanaged') ||
          admission.mode !== ceremony.mode ||
          admission.binding !== ceremony.admissionBinding ||
          !hash(admission.binding) ||
          (ceremony.mode === 'managed' &&
            (this.origin() !== options.origin ||
              ceremony.rpID !== options.rpID ||
              ceremony.challenge !== options.challenge ||
              !ceremony.expiresAtMs ||
              ceremony.expiresAtMs <= Date.now()))
        )
          throw unavailable();
        check();
        const result = await this.users.withCredentialTransaction(async (repository) =>
          this.passkeys.withPreparedChange(
            async (draft) => {
              outcome.phase = 'proof';
              check();
              let verified: Verified<T>;
              try {
                verified = await credentialWriters.read(() => options.authorize(freeze(structuredClone(draft)), repository));
              } catch (error) {
                authorizationFailure = error;
                throw error;
              }
              check();
              const user = await repository.getUserById(verified.accountId);
              const credential = draft.users[verified.accountId]?.credentials.find(
                (key) => key.id === verified.credentialId && key.rpID === options.rpID,
              );
              if (
                !user ||
                !credential ||
                !counter(verified.newCounter) ||
                !counter(credential.counter) ||
                ((credential.counter !== 0 || verified.newCounter !== 0) && verified.newCounter <= credential.counter)
              )
                throw unavailable();
              if (ceremony.mode === 'managed') {
                const operators = await repository.getOperators();
                if (
                  !user.operator ||
                  operators.length !== 1 ||
                  operators[0]?.id !== user.id ||
                  ceremony.accountId !== user.id ||
                  !ceremony.credentialIds?.includes(credential.id)
                )
                  throw unavailable();
                outcome.phase = 'root-counter';
                outcome.recovery = 'unknown';
                const receipt = await broker.counterComplete({ ceremony, response: options.response });
                if (receipt.accountId !== user.id || receipt.credentialId !== credential.id || receipt.newCounter !== verified.newCounter)
                  throw unavailable();
                outcome.recovery = 'acknowledged';
              } else {
                // Installation transitions require stopped Main. This second read
                // also refuses ordinary admission drift before a metadata commit.
                const current = await broker.admission({});
                if (current.mode !== 'unmanaged' || current.binding !== ceremony.admissionBinding) throw unavailable();
                outcome.recovery = 'unmanaged';
              }
              check();
              credential.counter = verified.newCounter;
              credential.lastUsedAt = Date.now();
              return verified.value;
            },
            async (file) => {
              fileOutcome = () => file.outcome;
              outcome.phase = 'file';
              check();
              await file.commit();
              outcome.passkeys = file.outcome;
              return file.value;
            },
          ),
        );
        check();
        outcome.phase = 'after-success';
        // The SQL transaction has resolved and the file/Root ACK succeeded before
        // the caller may create a Main session or pending TOTP ceremony.
        return await options.afterSuccess(result);
      } catch (error) {
        if (authorizationFailure === error && outcome.phase === 'proof') throw error;
        outcome.passkeys = fileOutcome?.() ?? outcome.passkeys;
        throw new MainPasskeySynchronizationError(Object.freeze({ ...outcome }));
      }
    });
  }

  /** Metadata-only catchup before an authority writer. It deliberately grants no
   * credential lease or auth success; the following coordinator still performs
   * its exact baseline check in Root's revocation transaction.
   */
  synchronizeCounters(
    accountId: number,
    authorize: (account: Readonly<NonNullable<Awaited<ReturnType<UserRepository['getUserById']>>>>, state: KeyView) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    return credentialWriters.run(
      async () => {
        const outcome: { phase: 'admission' | 'proof' | 'floors' | 'file' | 'sql'; passkeys: Outcome['passkeys'] } = {
          phase: 'admission',
          passkeys: 'uncommitted',
        };
        let authorizationFailure: unknown;
        let fileOutcome: (() => Outcome['passkeys']) | undefined;
        try {
          const broker = this.broker();
          const context = this.context();
          const check = () => {
            if (signal?.aborted || this.context() !== context) throw unavailable();
          };
          const admission = await broker.admission({ signal }).catch(() => {
            throw unavailable();
          });
          check();
          if (!hash(admission.binding)) throw unavailable();
          if (admission.mode === 'unmanaged') return;
          if (admission.mode !== 'managed' || !hash(admission.binding)) throw unavailable();
          const origin = this.origin();
          await this.users.withCredentialTransaction(async (repository) => {
            const operators = await repository.getOperators();
            const account = await repository.getUserById(accountId);
            if (!account?.operator || operators.length !== 1 || operators[0]?.id !== accountId) throw unavailable();
            return this.passkeys.withPreparedChange(
              async (draft) => {
                check();
                outcome.phase = 'proof';
                try {
                  await credentialWriters.read(() => authorize(freeze(structuredClone(account)), freeze(structuredClone(draft))));
                } catch (error) {
                  authorizationFailure = error;
                  throw error;
                }
                check();
                const source = buildRecoveryIdentitySource(account, draft, origin, this.encryption);
                try {
                  outcome.phase = 'floors';
                  const receipt = await broker.counterFloors({ admissionBinding: admission.binding, identity: source.bytes, signal }).catch(() => {
                    throw unavailable();
                  });
                  check();
                  const keys = draft.users[accountId]?.credentials.filter((key) => key.rpID === new URL(origin).hostname) ?? [];
                  if (receipt.sourceSha256 !== source.sha256 || Object.keys(receipt.counters).length !== keys.length) throw unavailable();
                  for (const key of keys) {
                    const floor = receipt.counters[key.id];
                    if (!Object.hasOwn(receipt.counters, key.id) || !counter(floor) || floor < key.counter) throw unavailable();
                    key.counter = floor;
                  }
                } finally {
                  source.bytes.fill(0);
                }
              },
              async (file) => {
                fileOutcome = () => file.outcome;
                outcome.phase = 'file';
                check();
                if (file.changed) await file.commit();
                outcome.passkeys = file.outcome;
                outcome.phase = 'sql';
              },
            );
          });
          check();
        } catch (error) {
          if (authorizationFailure === error && outcome.phase === 'proof') throw error;
          outcome.passkeys = fileOutcome?.() ?? outcome.passkeys;
          throw new MainCounterCatchupError(Object.freeze({ ...outcome }));
        }
      },
      { signal },
    );
  }
}
