import { type } from 'arktype';
import { timeMachineHashSchema as hash, timeMachineIdSchema as uuid } from '@runtipi/common/schemas/time-machine';
import type { CorePortableActor } from '../time-machine-capsules/core-portable-root-client';
import { callProtectedRetainedRoot } from './time-machine-retained-phase-client';

const safePositiveInteger = '0 < number.integer <= 9007199254740991';
const image = /^sha256:[a-f0-9]{64}$/;
const consentFields = {
  schema: "'orbis.core-inspection-execution-consent.v4'",
  role: "'database'",
  imageAuthority: "'root-qualified-cached-image'",
  sandboxProfile: "'orbis.core-source-pg-inspection.v3'",
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
  evidenceScope: "'authenticated-bootstrap-source'",
} as const;
const consent = type({
  ...consentFields,
  executionProfile: "'pg17-alpine-arm64.v1'",
  imageId: "'sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24'",
  platform: type({ os: "'linux'", architecture: "'arm64'" }).onUndeclaredKey('reject'),
  postgresqlMajor: '17',
})
  .onUndeclaredKey('reject')
  .or(
    type({
      ...consentFields,
      executionProfile: "'pg14-debian-amd64.v1'",
      imageId: "'sha256:d462928b1898dd74b749ef486797968828c1e7fc9befb5e5ca03a33bfbc32d64'",
      platform: type({ os: "'linux'", architecture: "'amd64'" }).onUndeclaredKey('reject'),
      postgresqlMajor: '14',
    }).onUndeclaredKey('reject'),
  );
const inspectionFields = {
  schema: "'orbis.core-restore-inspection.v4'",
  version: '4',
  id: uuid,
  pointId: uuid,
  sourceManifestSha256: hash.or('null'),
  ownerId: safePositiveInteger,
  scope: "'inspection-only'",
  restoreSupported: 'false',
  activationAuthorized: 'false',
} as const;
const prepared = type({
  ...inspectionFields,
  phase: "'awaiting-approval'",
  workerExecutionAvailable: 'true',
  bootstrapCatalogAvailable: 'false',
  reviewSha256: hash,
  approvalNonce: hash,
  approvalExpiresAt: safePositiveInteger,
  executionConsent: consent,
  legacyRestrictions: "('legacy-create-intents-not-captured' | 'legacy-effective-environment-not-captured')[]",
}).onUndeclaredKey('reject');
const active = type({
  ...inspectionFields,
  phase: "'preparing' | 'authorizing' | 'inspecting'",
  workerExecutionAvailable: 'true',
  bootstrapCatalogAvailable: 'false',
}).onUndeclaredKey('reject');
// Root may expose an active authorized phase after its short permit has expired.
const authorized = type({
  ...inspectionFields,
  phase: "'inspection-authorized'",
  workerExecutionAvailable: 'true',
  bootstrapCatalogAvailable: 'false',
  'permitSha256?': hash,
  'permitExpiresAt?': safePositiveInteger,
}).onUndeclaredKey('reject');
const held = type({
  ...inspectionFields,
  phase: "'expired' | 'recovery-required'",
  workerExecutionAvailable: 'false',
  bootstrapCatalogAvailable: 'false',
}).onUndeclaredKey('reject');
const complete = type({
  ...inspectionFields,
  phase: "'inspection-complete'",
  workerExecutionAvailable: 'false',
  bootstrapCatalogAvailable: 'true',
}).onUndeclaredKey('reject');
const inspectionStatus = prepared.or(active).or(authorized).or(held).or(complete);
const approval = type({ reviewSha256: hash, approvalNonce: hash, executionConsent: consent }).onUndeclaredKey('reject');
export type CoreBootstrapInspectionApproval = { reviewSha256: string; approvalNonce: string; executionConsent: unknown };
export type CoreBootstrapInspectionStatus = typeof inspectionStatus.infer;
const fail = () => new Error('The destination could not verify this isolated restore preparation. Existing server data was preserved.');

function checkedActor(actor: CorePortableActor): CorePortableActor {
  if (
    !actor ||
    Object.keys(actor).sort().join(',') !== 'ownerId,securityBinding,sessionBinding' ||
    !Number.isSafeInteger(actor.ownerId) ||
    actor.ownerId < 1 ||
    !hash.allows(actor.sessionBinding) ||
    !hash.allows(actor.securityBinding)
  )
    throw fail();
  return { ownerId: actor.ownerId, sessionBinding: actor.sessionBinding, securityBinding: actor.securityBinding };
}

function freshExpiry(value: number) {
  const now = Date.now();
  return value > now && value <= now + 300_000;
}

// actor is supplied by the authenticated backend caller, never by the browser request.
export async function callCoreBootstrapInspectionRoot(options: {
  action: 'prepare' | 'approve' | 'status';
  id: string;
  pointId: string;
  manifestSha256: string;
  actor: CorePortableActor;
  input?: CoreBootstrapInspectionApproval;
  signal: AbortSignal;
}): Promise<CoreBootstrapInspectionStatus> {
  const { action, id, pointId, signal } = options;
  const actor = checkedActor(options.actor);
  if (
    !['prepare', 'approve', 'status'].includes(action) ||
    !uuid.allows(id) ||
    !uuid.allows(pointId) ||
    !hash.allows(options.manifestSha256) ||
    (action !== 'approve' && options.input !== undefined)
  )
    throw fail();
  const checked = action === 'approve' ? approval(options.input) : undefined;
  if (checked instanceof type.errors) throw fail();
  const value = await callProtectedRetainedRoot(
    '/run/orbis/host.sock',
    `/v1/core-bootstrap-source-inspection/${action}`,
    {
      id,
      actor,
      ...(action === 'prepare' ? { pointId } : {}),
      ...(action === 'approve' ? { ...checked, action: 'authorize-core-inspection-only' } : {}),
    },
    signal,
    2 * 1024 * 1024,
    200,
    action === 'status' ? 30_000 : 1_900_000,
  );
  const parsed = inspectionStatus(value);
  if (parsed instanceof type.errors || parsed.id !== id || parsed.pointId !== pointId || parsed.ownerId !== actor.ownerId) throw fail();
  if (
    parsed.sourceManifestSha256 !== options.manifestSha256 &&
    !(parsed.sourceManifestSha256 === null && ['preparing', 'expired', 'recovery-required'].includes(parsed.phase))
  )
    throw fail();
  if (
    parsed.phase === 'awaiting-approval' &&
    (!freshExpiry(parsed.approvalExpiresAt) ||
      parsed.legacyRestrictions.join(',') !== 'legacy-create-intents-not-captured,legacy-effective-environment-not-captured')
  )
    throw fail();
  if (
    parsed.phase === 'inspection-authorized' &&
    ((parsed.permitSha256 === undefined) !== (parsed.permitExpiresAt === undefined) ||
      (parsed.permitExpiresAt !== undefined && !freshExpiry(parsed.permitExpiresAt)))
  )
    throw fail();
  if (action === 'approve' && parsed.phase !== 'inspection-complete') throw fail();
  return parsed;
}

const preparationFields = {
  version: '1',
  id: uuid,
  sourceInspectionId: uuid,
  scope: "'prepare-isolated-clean-target-only'",
  activation: 'false',
  environmentProved: 'false',
  restoreAuthority: 'false',
  sourceWrites: 'false',
} as const;
const preparing = type({
  ...preparationFields,
  phase: /^[a-z][a-z0-9-]{0,63}$/,
  preparationActive: 'true',
  preparedTargetAvailable: 'false',
}).onUndeclaredKey('reject');
const preparationHeld = type({
  ...preparationFields,
  phase: "'checking' | 'recovery-required' | 'preparation-blocked'",
  preparationActive: 'false',
  preparedTargetAvailable: 'false',
}).onUndeclaredKey('reject');
const preparationComplete = type({
  ...preparationFields,
  phase: "'preparation-complete'",
  preparationActive: 'false',
  preparedTargetAvailable: 'true',
}).onUndeclaredKey('reject');
const preparationStatus = preparing.or(preparationHeld).or(preparationComplete);
export type CoreCleanTargetPreparationStatus = typeof preparationStatus.infer;

export async function callCoreCleanTargetPreparationRoot(options: {
  action: 'prepare' | 'status' | 'wait';
  id: string;
  sourceInspectionId: string;
  actor: CorePortableActor;
  signal: AbortSignal;
}): Promise<CoreCleanTargetPreparationStatus> {
  const { action, id, sourceInspectionId, signal } = options;
  const actor = checkedActor(options.actor);
  if (!['prepare', 'status', 'wait'].includes(action) || !uuid.allows(id) || !uuid.allows(sourceInspectionId) || id === sourceInspectionId)
    throw fail();
  const value = await callProtectedRetainedRoot(
    '/run/orbis/host.sock',
    `/v1/core-clean-target-preparation/${action}`,
    { id, actor, ...(action === 'prepare' ? { sourceInspectionId, action: 'prepare-isolated-clean-target' } : {}) },
    signal,
    32768,
    action === 'prepare' ? 202 : 200,
    action === 'wait' ? 1_900_000 : 30_000,
  );
  const parsed = preparationStatus(value);
  if (parsed instanceof type.errors || parsed.id !== id || parsed.sourceInspectionId !== sourceInspectionId) throw fail();
  return parsed;
}

const runtimeFields = {
  version: '1',
  id: uuid,
  scope: "'verified-current-runtime-only'",
  activation: 'false',
  environmentProved: 'false',
  restoreAuthority: 'false',
  sourceWrites: 'false',
} as const;
const runtimePreparing = type({
  ...runtimeFields,
  phase: "'preparing'",
  enrollmentActive: 'true',
  runtimeAvailable: 'false',
}).onUndeclaredKey('reject');
const runtimeHeld = type({
  ...runtimeFields,
  phase: "'checking' | 'not-supported' | 'recovery-required'",
  enrollmentActive: 'false',
  runtimeAvailable: 'false',
}).onUndeclaredKey('reject');
const runtimeInstalled = type({
  ...runtimeFields,
  phase: "'installed'",
  enrollmentActive: 'false',
  runtimeAvailable: 'true',
}).onUndeclaredKey('reject');
const runtimeStatus = runtimePreparing.or(runtimeHeld).or(runtimeInstalled);
export type CoreRestoreRuntimeStatus = typeof runtimeStatus.infer;

export async function callCoreRestoreRuntimeRoot(options: {
  action: 'prepare' | 'status' | 'wait';
  id: string;
  actor: CorePortableActor;
  signal: AbortSignal;
}): Promise<CoreRestoreRuntimeStatus> {
  const { action, id, signal } = options;
  const actor = checkedActor(options.actor);
  if (!['prepare', 'status', 'wait'].includes(action) || !uuid.allows(id)) throw fail();
  const value = await callProtectedRetainedRoot(
    '/run/orbis/host.sock',
    `/v1/core-restore-runtime/${action}`,
    { id, actor, ...(action === 'prepare' ? { action: 'ensure-current-restore-runtime' } : {}) },
    signal,
    32768,
    action === 'prepare' ? 202 : 200,
    action === 'wait' ? 1_900_000 : 30_000,
  );
  const parsed = runtimeStatus(value);
  if (parsed instanceof type.errors || parsed.id !== id) throw fail();
  return parsed;
}

const reconciliationFields = {
  version: '1',
  id: uuid,
  sourcePreparationId: uuid,
  destinationInspectionId: uuid,
  scope: "'prepare-isolated-reconciled-target-only'",
  activation: 'false',
  environmentProved: 'false',
  restoreAuthority: 'false',
  sourceWrites: 'false',
} as const;
const reconciling = type({
  ...reconciliationFields,
  phase: /^(?!reconciliation-complete$)[a-z][a-z0-9-]{0,63}$/,
  reconciliationActive: 'true',
  reconciledTargetAvailable: 'false',
}).onUndeclaredKey('reject');
const reconciliationHeld = type({
  ...reconciliationFields,
  phase: "'checking' | 'recovery-required' | 'reconciliation-blocked'",
  reconciliationActive: 'false',
  reconciledTargetAvailable: 'false',
}).onUndeclaredKey('reject');
const reconciled = type({
  ...reconciliationFields,
  phase: "'reconciliation-complete'",
  reconciliationActive: 'false',
  reconciledTargetAvailable: 'true',
}).onUndeclaredKey('reject');
const reconciliationStatus = reconciling.or(reconciliationHeld).or(reconciled);
export type CoreCleanTargetReconciliationStatus = typeof reconciliationStatus.infer;

export async function callCoreCleanTargetReconciliationRoot(options: {
  action: 'prepare' | 'status' | 'wait';
  id: string;
  sourcePreparationId: string;
  destinationInspectionId: string;
  actor: CorePortableActor;
  signal: AbortSignal;
}): Promise<CoreCleanTargetReconciliationStatus> {
  const { action, id, sourcePreparationId, destinationInspectionId, signal } = options;
  const actor = checkedActor(options.actor);
  if (
    !['prepare', 'status', 'wait'].includes(action) ||
    ![id, sourcePreparationId, destinationInspectionId].every((value) => uuid.allows(value)) ||
    new Set([id, sourcePreparationId, destinationInspectionId]).size !== 3
  )
    throw fail();
  const value = await callProtectedRetainedRoot(
    '/run/orbis/host.sock',
    `/v1/core-clean-target-reconciliation/${action}`,
    { id, actor, ...(action === 'prepare' ? { sourcePreparationId, destinationInspectionId, action: 'prepare-isolated-reconciled-target' } : {}) },
    signal,
    32768,
    action === 'prepare' ? 202 : 200,
    action === 'wait' ? 1_900_000 : 30_000,
  );
  const parsed = reconciliationStatus(value);
  if (
    parsed instanceof type.errors ||
    parsed.id !== id ||
    parsed.sourcePreparationId !== sourcePreparationId ||
    parsed.destinationInspectionId !== destinationInspectionId
  )
    throw fail();
  return parsed;
}
