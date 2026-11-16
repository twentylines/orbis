import { type } from 'arktype';
import { timeMachineHashSchema as hash, timeMachineIdSchema as uuid } from '@runtipi/common/schemas/time-machine';
import type { CorePortableActor } from '../time-machine-capsules/core-portable-root-client';
import { callProtectedRetainedRoot } from './time-machine-retained-phase-client';

const image = /^sha256:[a-f0-9]{64}$/;
const consent = type({
  schema: "'orbis.core-inspection-execution-consent.v2'",
  role: "'database'",
  imageAuthority: "'root-qualified-cached-image'",
  imageId: image,
  platform: type({ os: "'linux'", architecture: "'arm64' | 'amd64'" }).onUndeclaredKey('reject'),
  postgresqlMajor: '1 <= number.integer <= 99',
  sandboxProfile: "'orbis.core-source-pg-inspection.v2'",
  profileSha256: hash,
  settingsSha256: hash,
  sourceWitnessSha256: hash,
  resourcesSha256: hash,
  sourceProjectionSha256: hash,
  configurationReceiptSha256: hash,
  destinationRevisionSha256: hash,
  coordinatorImageId: image,
  coordinatorSha256: hash,
  executionPlanSha256: hash,
  overlaySha256: hash,
  authority: "'explicit-fresh-exact-bytes'",
  scope: "'inspection-only'",
}).onUndeclaredKey('reject');
const base = {
  schema: "'orbis.core-restore-inspection.v2'",
  version: '2',
  id: uuid,
  pointId: uuid,
  sourceManifestSha256: hash.or('null'),
  ownerId: 'number.integer > 0',
  scope: "'inspection-only'",
  restoreSupported: 'false',
  activationAuthorized: 'false',
  workerExecutionAvailable: 'false',
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
const approval = type({ reviewSha256: hash, approvalNonce: hash, executionConsent: consent }).onUndeclaredKey('reject');
export type CoreLocalInspectionApproval = { reviewSha256: string; approvalNonce: string; executionConsent: unknown };
export type CoreLocalInspectionStatus = typeof prepared.infer | typeof authorized.infer | typeof held.infer;
const fail = () => new Error('The destination could not authorize this local core inspection. Existing server data was preserved.');

// The caller derives actor from the authenticated operator session; it must never come from the browser.
export async function callCoreLocalInspectionRoot(options: {
  action: 'prepare' | 'approve' | 'status';
  id: string;
  pointId: string;
  manifestSha256: string;
  actor: CorePortableActor;
  input?: CoreLocalInspectionApproval;
  signal: AbortSignal;
}): Promise<CoreLocalInspectionStatus> {
  const { id, pointId, actor, action, signal } = options;
  if (
    !['prepare', 'approve', 'status'].includes(action) ||
    !uuid.allows(id) ||
    !uuid.allows(pointId) ||
    !hash.allows(options.manifestSha256) ||
    !actor ||
    Object.keys(actor).sort().join(',') !== 'ownerId,securityBinding,sessionBinding' ||
    !Number.isSafeInteger(actor.ownerId) ||
    actor.ownerId < 1 ||
    !hash.allows(actor.sessionBinding) ||
    !hash.allows(actor.securityBinding) ||
    (action !== 'approve' && options.input !== undefined)
  )
    throw fail();
  const checked = action === 'approve' ? approval(options.input) : undefined;
  if (checked instanceof type.errors) throw fail();
  const body = {
    id,
    actor,
    ...(action === 'prepare' ? { pointId } : {}),
    ...(action === 'approve' ? { ...checked, action: 'authorize-core-inspection-only' } : {}),
  };
  const value = await callProtectedRetainedRoot(
    '/run/orbis/host.sock',
    `/v1/core-local-restore-inspection/${action}`,
    body,
    signal,
    2 * 1024 * 1024,
    200,
    action === 'prepare' ? 900_000 : 300_000,
  );
  const parsed = prepared.or(authorized).or(held)(value);
  if (parsed instanceof type.errors || parsed.id !== id || parsed.pointId !== pointId || parsed.ownerId !== actor.ownerId) throw fail();
  if (
    parsed.sourceManifestSha256 !== options.manifestSha256 &&
    !(parsed.sourceManifestSha256 === null && ['expired', 'recovery-required'].includes(parsed.phase))
  )
    throw fail();
  if (
    parsed.phase === 'awaiting-approval' &&
    (parsed.approvalExpiresAt <= Date.now() ||
      parsed.legacyRestrictions.join(',') !== 'legacy-create-intents-not-captured,legacy-effective-environment-not-captured')
  )
    throw fail();
  if (parsed.phase === 'inspection-authorized' && parsed.permitExpiresAt <= Date.now()) throw fail();
  if (action === 'approve' && parsed.phase !== 'inspection-authorized') throw fail();
  return parsed;
}
