import { type } from 'arktype';
import { timeMachineHashSchema as hash, timeMachineIdSchema as uuid } from '@runtipi/common/schemas/time-machine';
import type { CorePortableActor } from '../time-machine-capsules/core-portable-root-client';
import { callProtectedRetainedRoot } from './time-machine-retained-phase-client';

const fields = {
  version: '1',
  id: uuid,
  reconciliationId: uuid,
  scope: "'current-installation-observation-only'",
  logicalConsistencyProved: 'false',
  writerQuiescenceProved: 'false',
  activation: 'false',
  environmentProved: 'false',
  restoreAuthority: 'false',
  sourceWrites: 'false',
} as const;
const statusSchema = type({ ...fields, phase: "'installation-observed'", reviewAvailable: 'true' })
  .onUndeclaredKey('reject')
  .or(type({ ...fields, phase: "'checking' | 'recovery-required'", reviewAvailable: 'false' }).onUndeclaredKey('reject'));
export type CoreRestorationReviewStatus = typeof statusSchema.infer;
const actorSchema = type({ ownerId: '0 < number.integer <= 9007199254740991', sessionBinding: hash, securityBinding: hash }).onUndeclaredKey(
  'reject',
);
const fail = () => new Error('Restore preparation could not be verified. Your saved data is unchanged.');

export async function callCoreRestorationReviewRoot(options: {
  action: 'review' | 'status';
  id: string;
  reconciliationId: string;
  actor: CorePortableActor;
  signal: AbortSignal;
}): Promise<CoreRestorationReviewStatus> {
  if (
    !['review', 'status'].includes(options.action) ||
    !uuid.allows(options.id) ||
    !uuid.allows(options.reconciliationId) ||
    options.id === options.reconciliationId ||
    !actorSchema.allows(options.actor)
  )
    throw fail();
  options.signal.throwIfAborted();
  const actor = { ownerId: options.actor.ownerId, sessionBinding: options.actor.sessionBinding, securityBinding: options.actor.securityBinding };
  const value = await callProtectedRetainedRoot(
    '/run/orbis/host.sock',
    `/v1/core-restoration-review/${options.action}`,
    {
      id: options.id,
      actor,
      ...(options.action === 'review'
        ? {
            reconciliationId: options.reconciliationId,
            action: 'review-current-installation-core-restoration',
          }
        : {}),
    },
    options.signal,
    16384,
    200,
    330_000,
  );
  const parsed = statusSchema(value);
  if (parsed instanceof type.errors || parsed.id !== options.id || parsed.reconciliationId !== options.reconciliationId) throw fail();
  return parsed;
}
