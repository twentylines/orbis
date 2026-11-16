import { type } from 'arktype';
import { timeMachineHashSchema as hash, timeMachineIdSchema as uuid } from '@runtipi/common/schemas/time-machine';
import { callProtectedRetainedRoot } from '../system-backups/time-machine-retained-phase-client';
import type { CorePortableActor } from './core-portable-root-client';

const consent = type({
  schema: "'orbis.core-inspection-execution-consent.v1'",
  role: "'database'",
  imageId: /^sha256:[a-f0-9]{64}$/,
  archiveSha256: hash,
  platform: type({ os: "'linux'", architecture: "'arm64' | 'amd64'" }).onUndeclaredKey('reject'),
  postgresqlMajor: '1 <= number.integer <= 99',
  sandboxProfile: "'orbis.core-source-pg-inspection.v1'",
  authority: "'explicit-fresh-exact-bytes'",
  scope: "'inspection-only'",
}).onUndeclaredKey('reject');
const base = {
  schema: "'orbis.core-restore-inspection.v1'",
  version: '1',
  id: uuid,
  scope: "'inspection-only'",
  restoreSupported: 'false',
  activationAuthorized: 'false',
  workerExecutionAvailable: 'false',
  pointId: uuid,
  ownerId: 'number.integer > 0',
} as const;
const prepared = type({
  ...base,
  phase: "'awaiting-approval'",
  reviewSha256: hash,
  approvalNonce: hash,
  approvalExpiresAt: 'number.integer > 0',
  executionConsent: consent,
  legacyRestrictions: "('legacy-create-intents-not-captured' | 'legacy-effective-environment-not-captured')[]",
}).onUndeclaredKey('reject');
const authorized = type({
  ...base,
  phase: "'inspection-authorized'",
  permitSha256: hash,
  permitExpiresAt: 'number.integer > 0',
}).onUndeclaredKey('reject');
const held = type({ ...base, phase: "'expired' | 'recovery-required'" }).onUndeclaredKey('reject');
export type CoreInspectionStatus = typeof prepared.infer | typeof authorized.infer | typeof held.infer;
export type CoreInspectionApproval = { reviewSha256: string; approvalNonce: string; executionConsent: unknown };
const approval = type({ reviewSha256: hash, approvalNonce: hash, executionConsent: consent }).onUndeclaredKey('reject');
const fail = () => new Error('The destination could not authorize this core inspection. Existing server data was preserved.');

export async function callCoreInspectionRoot(options: {
  action: 'prepare' | 'approve' | 'status';
  id: string;
  actor: CorePortableActor;
  enrollmentId: string;
  input?: CoreInspectionApproval;
  signal: AbortSignal;
}): Promise<CoreInspectionStatus> {
  const { id, actor, action, signal } = options;
  if (
    !uuid.allows(id) ||
    !uuid.allows(options.enrollmentId) ||
    !Number.isSafeInteger(actor.ownerId) ||
    actor.ownerId < 1 ||
    !hash.allows(actor.sessionBinding) ||
    !hash.allows(actor.securityBinding)
  )
    throw fail();
  const checked = action === 'approve' ? approval(options.input) : undefined;
  if (checked instanceof type.errors) throw fail();
  const body = {
    id,
    actor,
    ...(action === 'prepare' ? { enrollmentId: options.enrollmentId } : {}),
    ...(action === 'approve' ? { ...checked, action: 'authorize-core-inspection-only' } : {}),
  };
  const value = await callProtectedRetainedRoot(
    '/run/orbis/host.sock',
    `/v1/core-restore-inspection/${action}`,
    body,
    signal,
    2 * 1024 * 1024,
    200,
    action === 'prepare' ? 900_000 : 300_000,
  );
  const parsed = prepared.or(authorized).or(held)(value);
  if (parsed instanceof type.errors || parsed.id !== id || parsed.ownerId !== actor.ownerId) throw fail();
  if (
    action === 'prepare' &&
    (parsed.phase !== 'awaiting-approval' ||
      parsed.approvalExpiresAt <= Date.now() ||
      parsed.legacyRestrictions.join(',') !== 'legacy-create-intents-not-captured,legacy-effective-environment-not-captured')
  )
    throw fail();
  if (action === 'approve' && (parsed.phase !== 'inspection-authorized' || parsed.permitExpiresAt <= Date.now())) throw fail();
  return parsed;
}
