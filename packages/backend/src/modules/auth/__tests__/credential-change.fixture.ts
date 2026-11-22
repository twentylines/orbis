import { ServiceUnavailableException } from '@nestjs/common';
import type { UserRepository } from '@/modules/user/user.repository';
import { TranslatableError } from '@/common/error/translatable-error';
import type { CredentialChange, CredentialSynchronization } from '../../sentinel-recovery/credential-synchronization.service';
import { credentialWriters } from '../../sentinel-recovery/writer-gate';
import type { PasskeyState, PasskeyStore } from '../passkey.store';
import { OwnershipWriteLease } from '../../sentinel-recovery/ownership-authority';

/** Auth policy unit-test port only. Production ordering/custody tests must use
 * the real coordinator, SQL adapter, prepared file and actual host port.
 */
export function credentialChangeFixture(
  users: Pick<UserRepository, 'getUserById' | 'getFirstOperator' | 'updateUser'>,
  passkeys?: Pick<PasskeyStore, 'withPreparedChange' | 'withReadFence' | 'snapshot'>,
) {
  const control: { failure?: Error; state: PasskeyState; plans: PasskeyState[] } = { state: { version: 1, users: {} }, plans: [] };
  async function change<T, R>(request: CredentialChange<T> & { afterSuccess?(value: T): R | Promise<R> }): Promise<T | R> {
    return credentialWriters.run(async () => {
      if (control.failure) throw control.failure;
      const selected = (await users.getUserById(request.accountId)) ?? (await users.getFirstOperator());
      if (!selected || selected.id !== request.accountId) throw new TranslatableError('AUTH_ERROR_USER_NOT_FOUND');
      if (!selected.operator) throw new ServiceUnavailableException('Unsupported account authority.');
      const account = Object.freeze(structuredClone(selected));
      const plan = async (draft: PasskeyState) => {
        await request.authorize(account, structuredClone(draft));
        const next = await request.plan(account, draft);
        control.plans.push(structuredClone(draft));
        return next;
      };
      let value: T;
      if (passkeys) {
        value = await passkeys.withPreparedChange(plan, async (file) => {
          await users.updateUser(account.id, file.value.patch);
          await file.commit();
          return file.value.value;
        });
        control.state = await passkeys.snapshot();
      } else {
        const draft = structuredClone(control.state);
        const next = await plan(draft);
        await users.updateUser(account.id, next.patch);
        control.state = draft;
        value = next.value;
      }
      return request.afterSuccess ? request.afterSuccess(value) : value;
    });
  }
  const inspect: CredentialSynchronization['inspect'] = async (accountId, work) =>
    credentialWriters.run(async () => {
      const selected = await users.getUserById(accountId);
      if (!selected?.operator) throw new ServiceUnavailableException('Unsupported account authority.');
      const read = async () => work(Object.freeze(structuredClone(selected)), passkeys ? await passkeys.snapshot() : structuredClone(control.state));
      return passkeys ? passkeys.withReadFence(read) : credentialWriters.read(read);
    });
  const beginOwnership: CredentialSynchronization['beginOwnership'] = async (purpose, request) => {
    if (control.failure) throw control.failure;
    // Auth policy unit-test port only; actual ownership transport has separate
    // socket and Root issuer tests and is never replaced by this fixture.
    const requestId = request?.requestId ?? 'c'.repeat(64);
    const grant = { operationId: 'b'.repeat(64), requestId, purpose, admissionBinding: 'a'.repeat(64), state: 'pending' as const };
    const broker = {
      ownershipPrepare: async () => grant,
      ownershipCheck: async () => grant,
      ownershipComplete: async () => ({ ...grant, state: 'completed' as const }),
    };
    return request?.replay ? OwnershipWriteLease.resume(broker, purpose, requestId) : OwnershipWriteLease.prepare(broker, purpose, requestId);
  };
  return { sync: { change, inspect, beginOwnership } as unknown as CredentialSynchronization, control };
}
