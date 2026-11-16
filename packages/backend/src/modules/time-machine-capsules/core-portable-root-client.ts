import { type } from 'arktype';
import { timeMachineCoreMetadataSchema, timeMachineHashSchema as hash, timeMachineIdSchema as uuid } from '@runtipi/common/schemas/time-machine';
import { callProtectedRetainedRoot } from '../system-backups/time-machine-retained-phase-client';

export type CorePortableActor = { ownerId: number; sessionBinding: string; securityBinding: string };
const preparedSchema = type({
  version: '1',
  id: uuid,
  phase: "'awaiting-approval'",
  restoreSupported: 'false',
  reviewSha256: hash,
  approvalNonce: hash,
  approvalExpiresAt: 'number.integer > 0',
  pointId: uuid,
  sourceOwnerId: 'number.integer > 0',
  ownerId: 'number.integer > 0',
  metadata: timeMachineCoreMetadataSchema,
}).onUndeclaredKey('reject');
const enrolledSchema = type({
  version: '1',
  id: uuid,
  phase: "'enrolled'",
  restoreSupported: 'false',
  pointId: uuid,
  provenanceSha256: hash,
  created: 'true',
}).onUndeclaredKey('reject');
const pendingSchema = type({
  version: '1',
  id: uuid,
  phase: "'preparing' | 'publishing' | 'recovery-required'",
  restoreSupported: 'false',
}).onUndeclaredKey('reject');
export type CorePortablePreparation = typeof preparedSchema.infer;
export type CorePortableStatus = CorePortablePreparation | typeof enrolledSchema.infer | typeof pendingSchema.infer;
const fail = () => new Error('The destination could not authorize this portable core import. Existing points were preserved.');
export async function callCorePortableRoot(options: {
  action: 'prepare' | 'approve' | 'status' | 'reconcile';
  id: string;
  actor: CorePortableActor;
  input?: { capsuleJobId: string; capsuleSha256: string; passphrase: string } | { reviewSha256: string; approvalNonce: string };
  signal: AbortSignal;
}): Promise<CorePortableStatus> {
  const { action, id, actor, signal } = options;
  if (
    !uuid.allows(id) ||
    !Number.isSafeInteger(actor.ownerId) ||
    actor.ownerId < 1 ||
    !hash.allows(actor.sessionBinding) ||
    !hash.allows(actor.securityBinding)
  )
    throw fail();
  const body = { id, actor, ...options.input, ...(action === 'approve' ? { action: 'enroll-core-portable-point' } : {}) };
  const raw = await callProtectedRetainedRoot(
    '/run/orbis/host.sock',
    `/v1/core-portable-enrollment/${action}`,
    body,
    signal,
    2 * 1024 * 1024,
    200,
    action === 'prepare' ? 900_000 : 300_000,
  );
  const parsed = preparedSchema.or(enrolledSchema).or(pendingSchema)(raw);
  if (
    parsed instanceof type.errors ||
    parsed.id !== id ||
    (parsed.phase === 'awaiting-approval' &&
      (parsed.ownerId !== actor.ownerId || parsed.metadata.id !== parsed.pointId || parsed.metadata.restore.ready))
  )
    throw fail();
  if (action === 'prepare' && (parsed.phase !== 'awaiting-approval' || parsed.approvalExpiresAt <= Date.now())) throw fail();
  if (action === 'approve' && parsed.phase !== 'enrolled') throw fail();
  return parsed;
}
