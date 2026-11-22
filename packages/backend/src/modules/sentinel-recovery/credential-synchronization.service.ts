import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DATABASE, type Database } from '@/core/database/database.module';
import { ConfigurationService } from '@/core/config/configuration.service';
import { EncryptionService } from '@/core/encryption/encryption.service';
import { UserRepository } from '../user/user.repository';
import { PasskeyStore } from '../auth/passkey.store';
import { RecoveryChangeCoordinator } from './change-coordinator';
import { HostCredentialRecoveryBroker, type OwnershipPurpose } from './host-broker';
import { OwnershipWriteLease } from './ownership-authority';
import { credentialWriters } from './writer-gate';
import { MainPasskeySynchronization } from './main-passkey-synchronization.service';
import { LocalCredentialChangeCoordinator } from './local-change-coordinator';

type CoordinatorRequest = Parameters<RecoveryChangeCoordinator['change']>[0];
type Plan<T> = Omit<Awaited<ReturnType<CoordinatorRequest['plan']>>, 'value'> & { value: T };
export type CredentialChange<T> = Omit<CoordinatorRequest, 'plan' | 'afterSuccess'> & {
  plan(...args: Parameters<CoordinatorRequest['plan']>): Plan<T> | Promise<Plan<T>>;
};

/** Production account-change boundary. Configuration is read lazily so normal
 * password sign-in and account reads do not depend on recovery availability.
 * An absent/old/unreachable host is never treated as an unmanaged installation.
 */
@Injectable()
export class CredentialSynchronization {
  constructor(
    private readonly users: UserRepository,
    @Inject(DATABASE) private readonly database: Database,
    private readonly passkeys: PasskeyStore,
    private readonly config: ConfigurationService,
    private readonly encryption: EncryptionService,
  ) {}

  /** This grant comes from Root's current ownership proof, independently of
   * Main's operator rows and the configured credential recovery realm.
   */
  async beginOwnership(purpose: OwnershipPurpose, request?: { requestId: string; replay: boolean }): Promise<OwnershipWriteLease> {
    let broker: HostCredentialRecoveryBroker;
    try {
      broker = new HostCredentialRecoveryBroker(process.env.ORBIS_HOST_SOCKET);
    } catch {
      throw new ServiceUnavailableException('Account ownership could not be verified. Check recovery before trying again.');
    }
    return request?.replay
      ? OwnershipWriteLease.resume(broker, purpose, request.requestId)
      : OwnershipWriteLease.prepare(broker, purpose, request?.requestId);
  }

  /** Read-only ceremony preparation for an already persisted handle. This pins
   * the same SQL/file sources as a change without manufacturing a Root lease.
   * Callers creating a handle must reauthorize through change instead.
   */
  inspect<T>(
    accountId: number,
    work: (account: Parameters<CoordinatorRequest['authorize']>[0], passkeys: Parameters<CoordinatorRequest['authorize']>[1]) => Promise<T>,
  ): Promise<T> {
    return credentialWriters.run(() =>
      this.users.withCredentialTransaction(async (repository) => {
        const operators = await repository.getOperators();
        const account = await repository.getUserById(accountId);
        if (operators.length !== 1 || operators[0]?.id !== accountId || !account?.operator)
          throw new ServiceUnavailableException('This account authority cannot be changed safely.');
        return this.passkeys.withReadFence(async () => {
          const snapshot = await this.passkeys.snapshot();
          const freeze = <V>(value: V): V => {
            if (value && typeof value === 'object') {
              for (const item of Object.values(value)) freeze(item);
              Object.freeze(value);
            }
            return value;
          };
          return work(freeze(structuredClone(account)), freeze(snapshot));
        });
      }),
    );
  }

  change<T>(request: CredentialChange<T>): Promise<T>;
  change<T, R>(request: CredentialChange<T> & { afterSuccess(value: T): R | Promise<R> }): Promise<R>;
  async change<T, R>(request: CredentialChange<T> & { afterSuccess?(value: T): R | Promise<R> }): Promise<T | R> {
    return credentialWriters.run(
      async () => {
        let broker: HostCredentialRecoveryBroker;
        let admission: Awaited<ReturnType<HostCredentialRecoveryBroker['changeAdmission']>>;
        try {
          broker = new HostCredentialRecoveryBroker(process.env.ORBIS_HOST_SOCKET);
          admission = await broker.changeAdmission({ signal: request.signal });
        } catch {
          throw new ServiceUnavailableException('The credential change could not be verified. Check recovery before trying again.');
        }
        if (admission.protocol === 'root-ownership') {
          return new LocalCredentialChangeCoordinator({
            users: this.users,
            passkeys: this.passkeys,
            config: this.config,
            broker,
            admissionBinding: admission.binding,
          }).change(request);
        }
        let coordinator: RecoveryChangeCoordinator;
        try {
          const origin = process.env.ORBIS_SENTINEL_RECOVERY_ORIGIN;
          if (typeof origin !== 'string' || origin.length > 512) throw new Error('Missing recovery realm.');
          const realm = new URL(origin);
          if (realm.protocol !== 'https:' || realm.origin !== origin || realm.username || realm.password || realm.port === '0')
            throw new Error('Invalid recovery realm.');
          coordinator = new RecoveryChangeCoordinator({
            users: this.users,
            database: this.database,
            passkeys: this.passkeys,
            config: this.config,
            encryption: this.encryption,
            broker,
            origin,
          });
        } catch {
          throw new ServiceUnavailableException('The credential change could not be verified. Check recovery before trying again.');
        }
        await new MainPasskeySynchronization(this.users, this.passkeys, this.config, this.encryption).synchronizeCounters(
          request.accountId,
          request.authorize,
          request.signal,
        );
        return coordinator.change(request);
      },
      { signal: request.signal },
    );
  }
}
