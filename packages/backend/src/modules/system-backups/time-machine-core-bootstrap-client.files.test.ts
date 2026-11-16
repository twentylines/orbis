import { afterEach, expect, it, vi } from 'vitest';
import {
  callCoreBootstrapInspectionRoot,
  callCoreCleanTargetPreparationRoot,
  callCoreCleanTargetReconciliationRoot,
  callCoreRestoreRuntimeRoot,
  type CoreBootstrapInspectionApproval,
} from './time-machine-core-bootstrap-client';
import { callProtectedRetainedRoot } from './time-machine-retained-phase-client';

vi.mock('./time-machine-retained-phase-client', () => ({ callProtectedRetainedRoot: vi.fn() }));
const root = vi.mocked(callProtectedRetainedRoot);
afterEach(() => root.mockReset());
const id = 'a71c77d2-f420-440e-951b-083209514e72';
const pointId = 'a71c77d2-f420-440e-951b-083209514e74';
const otherId = 'a71c77d2-f420-440e-951b-083209514e75';
const actor = { ownerId: 17, sessionBinding: '1'.repeat(64), securityBinding: '2'.repeat(64) };
const digest = '3'.repeat(64);
const consent = {
  schema: 'orbis.core-inspection-execution-consent.v4',
  role: 'database',
  imageAuthority: 'root-qualified-cached-image',
  imageId: 'sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24',
  platform: { os: 'linux', architecture: 'arm64' },
  postgresqlMajor: 17,
  sandboxProfile: 'orbis.core-source-pg-inspection.v3',
  profileSha256: digest,
  settingsSha256: digest,
  sourceWitnessSha256: digest,
  resourcesSha256: digest,
  sourceProjectionSha256: digest,
  configurationReceiptSha256: digest,
  destinationRevisionSha256: digest,
  coordinatorImageId: `sha256:${digest}`,
  coordinatorSha256: digest,
  executionPlanSha256: digest,
  overlaySha256: digest,
  authority: 'explicit-fresh-exact-bytes',
  scope: 'inspection-only',
  evidenceScope: 'authenticated-bootstrap-source',
  executionProfile: 'pg17-alpine-arm64.v1',
};
const base = {
  schema: 'orbis.core-restore-inspection.v4',
  version: 4,
  id,
  pointId,
  sourceManifestSha256: digest,
  ownerId: actor.ownerId,
  scope: 'inspection-only',
  restoreSupported: false,
  activationAuthorized: false,
};
const options = { id, pointId, manifestSha256: digest, actor, signal: new AbortController().signal };
const prepared = () => ({
  ...base,
  phase: 'awaiting-approval',
  workerExecutionAvailable: true,
  bootstrapCatalogAvailable: false,
  reviewSha256: digest,
  approvalNonce: digest,
  approvalExpiresAt: Date.now() + 300_000,
  executionConsent: consent,
  legacyRestrictions: ['legacy-create-intents-not-captured', 'legacy-effective-environment-not-captured'],
});
const complete = () => ({ ...base, phase: 'inspection-complete', workerExecutionAvailable: false, bootstrapCatalogAvailable: true });
const input: CoreBootstrapInspectionApproval = { reviewSha256: digest, approvalNonce: digest, executionConsent: consent };

it('sends fresh v4 inspection consent on the separate bootstrap endpoint and waits for Root completion', async () => {
  root.mockResolvedValueOnce(prepared());
  await expect(callCoreBootstrapInspectionRoot({ ...options, action: 'prepare' })).resolves.toMatchObject({ phase: 'awaiting-approval' });
  expect(root).toHaveBeenLastCalledWith(
    '/run/orbis/host.sock',
    '/v1/core-bootstrap-source-inspection/prepare',
    { id, pointId, actor },
    options.signal,
    2 * 1024 * 1024,
    200,
    1_900_000,
  );
  root.mockResolvedValueOnce(complete());
  await expect(callCoreBootstrapInspectionRoot({ ...options, action: 'approve', input })).resolves.toMatchObject({ bootstrapCatalogAvailable: true });
  expect(root).toHaveBeenLastCalledWith(
    '/run/orbis/host.sock',
    '/v1/core-bootstrap-source-inspection/approve',
    { id, actor, ...input, action: 'authorize-core-inspection-only' },
    options.signal,
    2 * 1024 * 1024,
    200,
    1_900_000,
  );
  root.mockResolvedValueOnce(complete());
  await expect(callCoreBootstrapInspectionRoot({ ...options, action: 'status' })).resolves.toMatchObject({ restoreSupported: false });
  expect(root).toHaveBeenLastCalledWith(
    '/run/orbis/host.sock',
    '/v1/core-bootstrap-source-inspection/status',
    { id, actor },
    options.signal,
    2 * 1024 * 1024,
    200,
    30_000,
  );
});

it('accepts the separately qualified PostgreSQL 14 execution recipe', async () => {
  const pg14 = {
    ...consent,
    executionProfile: 'pg14-debian-amd64.v1',
    imageId: 'sha256:d462928b1898dd74b749ef486797968828c1e7fc9befb5e5ca03a33bfbc32d64',
    platform: { os: 'linux', architecture: 'amd64' },
    postgresqlMajor: 14,
  };
  root.mockResolvedValueOnce({ ...prepared(), executionConsent: pg14 });
  await expect(callCoreBootstrapInspectionRoot({ ...options, action: 'prepare' })).resolves.toMatchObject({ executionConsent: pg14 });
  root.mockResolvedValueOnce(complete());
  await expect(
    callCoreBootstrapInspectionRoot({ ...options, action: 'approve', input: { ...input, executionConsent: pg14 } }),
  ).resolves.toBeDefined();
});

it.each([
  ['pointId', otherId],
  ['id', otherId],
  ['ownerId', 1],
  ['ownerId', Number.MAX_SAFE_INTEGER + 1],
  ['schema', 'orbis.core-restore-inspection.v2'],
  ['schema', 'orbis.core-restore-inspection.v3'],
  ['version', 3],
  ['sourceManifestSha256', 'f'.repeat(64)],
  ['sourceManifestSha256', null],
  ['scope', 'restore'],
  ['restoreSupported', true],
  ['activationAuthorized', true],
  ['workerExecutionAvailable', false],
  ['bootstrapCatalogAvailable', true],
  ['approvalExpiresAt', 1],
  ['approvalExpiresAt', Number.MAX_SAFE_INTEGER],
  ['legacyRestrictions', []],
  ['grant', digest],
])('rejects malformed or broadened prepared inspection field %s=%s', async (key, value) => {
  root.mockResolvedValueOnce({ ...prepared(), [key]: value });
  await expect(callCoreBootstrapInspectionRoot({ ...options, action: 'prepare' })).rejects.toThrow();
});

it.each([
  { schema: 'orbis.core-inspection-execution-consent.v2' },
  { schema: 'orbis.core-inspection-execution-consent.v3' },
  { executionProfile: 'pg18-alpine-arm64.v1' },
  { executionProfile: 'pg14-debian-amd64.v1' },
  { imageId: `sha256:${digest}` },
  { platform: { os: 'linux', architecture: 'amd64' } },
  { platform: { os: 'linux', architecture: 'arm64', restoreAuthority: true } },
  { postgresqlMajor: 14 },
  { sandboxProfile: 'orbis.core-source-pg-inspection.v2' },
  { evidenceScope: 'restore' },
  { scope: 'restore' },
  { authority: 'implicit' },
  { executionPlanSha256: 'invalid' },
  { restoreAuthority: true },
])('rejects unsupported or mismatched execution consent before dispatch: %j', async (patch) => {
  const executionConsent = { ...consent, ...patch };
  await expect(callCoreBootstrapInspectionRoot({ ...options, action: 'approve', input: { ...input, executionConsent } })).rejects.toThrow();
  expect(root).not.toHaveBeenCalled();
  root.mockResolvedValueOnce({ ...prepared(), executionConsent });
  await expect(callCoreBootstrapInspectionRoot({ ...options, action: 'prepare' })).rejects.toThrow();
});

it.each(['preparing', 'authorizing', 'inspection-authorized', 'inspecting'])(
  'observes active Root phase %s without inventing progress',
  async (phase) => {
    const value = { ...base, phase, workerExecutionAvailable: true, bootstrapCatalogAvailable: false };
    root.mockResolvedValueOnce(value);
    await expect(callCoreBootstrapInspectionRoot({ ...options, action: 'status' })).resolves.toEqual(value);
    root.mockResolvedValueOnce({ ...value, workerExecutionAvailable: false });
    await expect(callCoreBootstrapInspectionRoot({ ...options, action: 'status' })).rejects.toThrow();
  },
);

it.each(['expired', 'recovery-required'])('observes held Root phase %s with a missing source manifest', async (phase) => {
  const value = { ...base, sourceManifestSha256: null, phase, workerExecutionAvailable: false, bootstrapCatalogAvailable: false };
  root.mockResolvedValueOnce(value);
  await expect(callCoreBootstrapInspectionRoot({ ...options, action: 'status' })).resolves.toEqual(value);
});

it('observes early preparation without a captured manifest and preserves an authorized permit only while fresh', async () => {
  root.mockResolvedValueOnce({
    ...base,
    sourceManifestSha256: null,
    phase: 'preparing',
    workerExecutionAvailable: true,
    bootstrapCatalogAvailable: false,
  });
  await expect(callCoreBootstrapInspectionRoot({ ...options, action: 'status' })).resolves.toMatchObject({ phase: 'preparing' });
  const value = { ...base, phase: 'inspection-authorized', workerExecutionAvailable: true, bootstrapCatalogAvailable: false };
  root.mockResolvedValueOnce({ ...value, permitSha256: digest, permitExpiresAt: Date.now() + 300_000 });
  await expect(callCoreBootstrapInspectionRoot({ ...options, action: 'status' })).resolves.toMatchObject({ permitSha256: digest });
  for (const fields of [{ permitSha256: digest }, { permitExpiresAt: Date.now() + 300_000 }, { permitSha256: digest, permitExpiresAt: 1 }]) {
    root.mockResolvedValueOnce({ ...value, ...fields });
    await expect(callCoreBootstrapInspectionRoot({ ...options, action: 'status' })).rejects.toThrow();
  }
});

it('requires verified catalog completion from synchronous approval and from repeated preparation', async () => {
  root.mockResolvedValueOnce({ ...base, phase: 'inspection-authorized', workerExecutionAvailable: true, bootstrapCatalogAvailable: false });
  await expect(callCoreBootstrapInspectionRoot({ ...options, action: 'approve', input })).rejects.toThrow();
  root.mockResolvedValueOnce(complete());
  await expect(callCoreBootstrapInspectionRoot({ ...options, action: 'prepare' })).resolves.toEqual(complete());
  root.mockResolvedValueOnce({ ...complete(), bootstrapCatalogAvailable: false });
  await expect(callCoreBootstrapInspectionRoot({ ...options, action: 'status' })).rejects.toThrow();
  root.mockResolvedValueOnce({ ...complete(), sourceManifestSha256: null });
  await expect(callCoreBootstrapInspectionRoot({ ...options, action: 'status' })).rejects.toThrow();
});

it('rejects malformed identity and approval input before reaching Root', async () => {
  const calls = [
    callCoreBootstrapInspectionRoot({ ...options, action: 'prepare', actor: { ...actor, ownerId: 0 } }),
    callCoreBootstrapInspectionRoot({ ...options, action: 'prepare', actor: { ...actor, ownerId: Number.MAX_SAFE_INTEGER + 1 } }),
    callCoreBootstrapInspectionRoot({ ...options, action: 'prepare', actor: { ...actor, sessionBinding: 'invalid' } }),
    callCoreBootstrapInspectionRoot({ ...options, action: 'prepare', actor: { ...actor, securityBinding: 'invalid' } }),
    callCoreBootstrapInspectionRoot({ ...options, action: 'prepare', actor: { ...actor, browserOwnerId: 1 } as typeof actor }),
    callCoreBootstrapInspectionRoot({ ...options, action: 'prepare', id: 'invalid' }),
    callCoreBootstrapInspectionRoot({ ...options, action: 'prepare', pointId: 'invalid' }),
    callCoreBootstrapInspectionRoot({ ...options, action: 'prepare', manifestSha256: 'invalid' }),
    callCoreBootstrapInspectionRoot({ ...options, action: 'restore' as 'prepare' }),
    callCoreBootstrapInspectionRoot({ ...options, action: 'prepare', input }),
    callCoreBootstrapInspectionRoot({ ...options, action: 'status', input }),
    callCoreBootstrapInspectionRoot({ ...options, action: 'approve' }),
    callCoreBootstrapInspectionRoot({ ...options, action: 'approve', input: { ...input, action: 'restore' } as CoreBootstrapInspectionApproval }),
  ];
  for (const call of calls) await expect(call).rejects.toThrow();
  expect(root).not.toHaveBeenCalled();
});

const preparationOptions = { id: otherId, sourceInspectionId: id, actor, signal: options.signal };
const preparationBase = {
  version: 1,
  id: otherId,
  sourceInspectionId: id,
  scope: 'prepare-isolated-clean-target-only',
  activation: false,
  environmentProved: false,
  restoreAuthority: false,
  sourceWrites: false,
};
const queued = () => ({ ...preparationBase, phase: 'queued', preparationActive: true, preparedTargetAvailable: false });
const targetComplete = () => ({ ...preparationBase, phase: 'preparation-complete', preparationActive: false, preparedTargetAvailable: true });

it('submits only explicit isolated preparation with HTTP 202 and observes with HTTP 200', async () => {
  root.mockResolvedValueOnce(queued());
  await expect(callCoreCleanTargetPreparationRoot({ ...preparationOptions, action: 'prepare' })).resolves.toEqual(queued());
  expect(root).toHaveBeenLastCalledWith(
    '/run/orbis/host.sock',
    '/v1/core-clean-target-preparation/prepare',
    { id: otherId, actor, sourceInspectionId: id, action: 'prepare-isolated-clean-target' },
    options.signal,
    32768,
    202,
    30_000,
  );
  root.mockResolvedValueOnce(targetComplete());
  await expect(callCoreCleanTargetPreparationRoot({ ...preparationOptions, action: 'status' })).resolves.toEqual(targetComplete());
  expect(root).toHaveBeenLastCalledWith(
    '/run/orbis/host.sock',
    '/v1/core-clean-target-preparation/status',
    { id: otherId, actor },
    options.signal,
    32768,
    200,
    30_000,
  );
});

it('waits for target preparation with the status-only body, HTTP 200 and a bounded long request lifetime', async () => {
  root.mockResolvedValueOnce(targetComplete());
  await expect(callCoreCleanTargetPreparationRoot({ ...preparationOptions, action: 'wait' })).resolves.toEqual(targetComplete());
  expect(root).toHaveBeenLastCalledWith(
    '/run/orbis/host.sock',
    '/v1/core-clean-target-preparation/wait',
    { id: otherId, actor },
    options.signal,
    32768,
    200,
    1_900_000,
  );
});

it('retains unavailable and mismatched terminal evidence from target wait', async () => {
  root.mockResolvedValueOnce({ ...preparationBase, phase: 'recovery-required', preparationActive: false, preparedTargetAvailable: false });
  await expect(callCoreCleanTargetPreparationRoot({ ...preparationOptions, action: 'wait' })).resolves.toMatchObject({
    phase: 'recovery-required',
    preparedTargetAvailable: false,
  });
  root.mockResolvedValueOnce({ ...targetComplete(), sourceInspectionId: otherId });
  await expect(callCoreCleanTargetPreparationRoot({ ...preparationOptions, action: 'wait' })).rejects.toThrow();
  root.mockRejectedValueOnce(new Error('unavailable'));
  await expect(callCoreCleanTargetPreparationRoot({ ...preparationOptions, action: 'wait' })).rejects.toThrow('unavailable');
});

it.each(['checking-source', 'preparing', 'initializing', 'verifying-preparation', 'a'.repeat(64)])(
  'preserves bounded active target phase %s',
  async (phase) => {
    root.mockResolvedValueOnce({ ...queued(), phase });
    await expect(callCoreCleanTargetPreparationRoot({ ...preparationOptions, action: 'status' })).resolves.toMatchObject({
      phase,
      preparationActive: true,
    });
  },
);

it.each(['checking', 'preparation-blocked', 'recovery-required'])('preserves unavailable target phase %s', async (phase) => {
  const value = { ...preparationBase, phase, preparationActive: false, preparedTargetAvailable: false };
  root.mockResolvedValueOnce(value);
  await expect(callCoreCleanTargetPreparationRoot({ ...preparationOptions, action: 'status' })).resolves.toEqual(value);
});

it.each([
  ['version', 2],
  ['id', id],
  ['sourceInspectionId', otherId],
  ['scope', 'restore'],
  ['activation', true],
  ['environmentProved', true],
  ['restoreAuthority', true],
  ['sourceWrites', true],
  ['phase', 'a'.repeat(65)],
  ['phase', 'Starting'],
  ['phase', ''],
  ['preparationActive', false],
  ['preparedTargetAvailable', true],
  ['progress', 100],
  ['ownerId', actor.ownerId],
])('rejects malformed or broadened target field %s=%s', async (key, value) => {
  root.mockResolvedValueOnce({ ...queued(), [key]: value });
  await expect(callCoreCleanTargetPreparationRoot({ ...preparationOptions, action: 'status' })).rejects.toThrow();
});

it('does not infer a prepared target from an incomplete terminal response', async () => {
  root.mockResolvedValueOnce({ ...targetComplete(), preparedTargetAvailable: false });
  await expect(callCoreCleanTargetPreparationRoot({ ...preparationOptions, action: 'status' })).rejects.toThrow();
  root.mockResolvedValueOnce({ ...preparationBase, phase: 'unknown', preparationActive: false, preparedTargetAvailable: false });
  await expect(callCoreCleanTargetPreparationRoot({ ...preparationOptions, action: 'status' })).rejects.toThrow();
});

it('rejects invalid or overlapping preparation identifiers and unauthenticated actors before dispatch', async () => {
  await expect(callCoreCleanTargetPreparationRoot({ ...preparationOptions, action: 'prepare', id })).rejects.toThrow();
  await expect(callCoreCleanTargetPreparationRoot({ ...preparationOptions, action: 'prepare', id: 'invalid' })).rejects.toThrow();
  await expect(callCoreCleanTargetPreparationRoot({ ...preparationOptions, action: 'prepare', sourceInspectionId: 'invalid' })).rejects.toThrow();
  await expect(callCoreCleanTargetPreparationRoot({ ...preparationOptions, action: 'restore' as 'prepare' })).rejects.toThrow();
  await expect(callCoreCleanTargetPreparationRoot({ ...preparationOptions, action: 'status', actor: { ...actor, ownerId: 0 } })).rejects.toThrow();
  expect(root).not.toHaveBeenCalled();
});

it('keeps unavailable Root transport unavailable for source and target work', async () => {
  root.mockRejectedValueOnce(new Error('unavailable'));
  await expect(callCoreBootstrapInspectionRoot({ ...options, action: 'prepare' })).rejects.toThrow('unavailable');
  root.mockRejectedValueOnce(new Error('unavailable'));
  await expect(callCoreCleanTargetPreparationRoot({ ...preparationOptions, action: 'prepare' })).rejects.toThrow('unavailable');
});

it.each([null, undefined, {}, 'unavailable'])('rejects missing or non-object Root status %j', async (value) => {
  root.mockResolvedValueOnce(value);
  await expect(callCoreBootstrapInspectionRoot({ ...options, action: 'status' })).rejects.toThrow();
  root.mockResolvedValueOnce(value);
  await expect(callCoreCleanTargetPreparationRoot({ ...preparationOptions, action: 'status' })).rejects.toThrow();
});

it('rejects omitted execution profile and omitted authority-denial flags', async () => {
  const { executionProfile: _profile, ...unboundConsent } = consent;
  await expect(
    callCoreBootstrapInspectionRoot({ ...options, action: 'approve', input: { ...input, executionConsent: unboundConsent } }),
  ).rejects.toThrow();
  expect(root).not.toHaveBeenCalled();
  const { activationAuthorized: _activation, ...incompleteSource } = complete();
  root.mockResolvedValueOnce(incompleteSource);
  await expect(callCoreBootstrapInspectionRoot({ ...options, action: 'status' })).rejects.toThrow();
  const { restoreAuthority: _restore, ...incompleteTarget } = targetComplete();
  root.mockResolvedValueOnce(incompleteTarget);
  await expect(callCoreCleanTargetPreparationRoot({ ...preparationOptions, action: 'status' })).rejects.toThrow();
});

const runtimeOptions = { id, actor, signal: options.signal };
const runtimeBase = {
  version: 1,
  id,
  scope: 'verified-current-runtime-only',
  activation: false,
  environmentProved: false,
  restoreAuthority: false,
  sourceWrites: false,
};
const runtimeInstalled = () => ({ ...runtimeBase, phase: 'installed', enrollmentActive: false, runtimeAvailable: true });

it.each(['prepare', 'status', 'wait'] as const)('uses the exact runtime %s body, HTTP status and request lifetime', async (action) => {
  root.mockResolvedValueOnce(runtimeInstalled());
  await expect(callCoreRestoreRuntimeRoot({ ...runtimeOptions, action })).resolves.toEqual(runtimeInstalled());
  expect(root).toHaveBeenLastCalledWith(
    '/run/orbis/host.sock',
    `/v1/core-restore-runtime/${action}`,
    { id, actor, ...(action === 'prepare' ? { action: 'ensure-current-restore-runtime' } : {}) },
    options.signal,
    32768,
    action === 'prepare' ? 202 : 200,
    action === 'wait' ? 1_900_000 : 30_000,
  );
});

it.each(['preparing', 'checking', 'not-supported', 'recovery-required'] as const)(
  'preserves runtime %s without inferring availability',
  async (phase) => {
    const value = { ...runtimeBase, phase, enrollmentActive: phase === 'preparing', runtimeAvailable: false };
    root.mockResolvedValueOnce(value);
    await expect(callCoreRestoreRuntimeRoot({ ...runtimeOptions, action: 'status' })).resolves.toEqual(value);
  },
);

it.each([
  ['id', otherId],
  ['version', 2],
  ['phase', 'complete'],
  ['scope', 'restore'],
  ['activation', true],
  ['environmentProved', true],
  ['restoreAuthority', true],
  ['sourceWrites', true],
  ['enrollmentActive', true],
  ['runtimeAvailable', false],
  ['grant', digest],
])('rejects mismatched or broadened installed runtime field %s=%s', async (key, value) => {
  root.mockResolvedValueOnce({ ...runtimeInstalled(), [key]: value });
  await expect(callCoreRestoreRuntimeRoot({ ...runtimeOptions, action: 'status' })).rejects.toThrow();
});

it('rejects runtime identity/action before dispatch and leaves unavailable transport unavailable', async () => {
  await expect(callCoreRestoreRuntimeRoot({ ...runtimeOptions, action: 'prepare', id: 'invalid' })).rejects.toThrow();
  await expect(
    callCoreRestoreRuntimeRoot({ ...runtimeOptions, action: 'prepare', actor: { ...actor, securityBinding: 'invalid' } }),
  ).rejects.toThrow();
  await expect(callCoreRestoreRuntimeRoot({ ...runtimeOptions, action: 'restore' as 'prepare' })).rejects.toThrow();
  expect(root).not.toHaveBeenCalled();
  root.mockRejectedValueOnce(new Error('unavailable'));
  await expect(callCoreRestoreRuntimeRoot({ ...runtimeOptions, action: 'wait' })).rejects.toThrow('unavailable');
});

it('requires runtime activity and availability to agree with the reported phase', async () => {
  for (const phase of ['preparing', 'checking', 'not-supported', 'recovery-required']) {
    root.mockResolvedValueOnce({ ...runtimeBase, phase, enrollmentActive: phase === 'preparing', runtimeAvailable: true });
    await expect(callCoreRestoreRuntimeRoot({ ...runtimeOptions, action: 'wait' })).rejects.toThrow();
    root.mockResolvedValueOnce({ ...runtimeBase, phase, enrollmentActive: phase !== 'preparing', runtimeAvailable: false });
    await expect(callCoreRestoreRuntimeRoot({ ...runtimeOptions, action: 'status' })).rejects.toThrow();
  }
});

const reconciliationBase = {
  version: 1,
  id,
  sourcePreparationId: otherId,
  destinationInspectionId: pointId,
  scope: 'prepare-isolated-reconciled-target-only',
  activation: false,
  environmentProved: false,
  restoreAuthority: false,
  sourceWrites: false,
};
const reconciliationComplete = () => ({
  ...reconciliationBase,
  phase: 'reconciliation-complete',
  reconciliationActive: false,
  reconciledTargetAvailable: true,
});
const reconciliationOptions = { id, sourcePreparationId: otherId, destinationInspectionId: pointId, actor, signal: new AbortController().signal };
it.each(['prepare', 'status', 'wait'] as const)(
  'binds reconciliation %s to both selected operations without requesting activation',
  async (action) => {
    root.mockResolvedValueOnce(reconciliationComplete());
    await expect(callCoreCleanTargetReconciliationRoot({ ...reconciliationOptions, action })).resolves.toEqual(reconciliationComplete());
    expect(root).toHaveBeenCalledExactlyOnceWith(
      '/run/orbis/host.sock',
      `/v1/core-clean-target-reconciliation/${action}`,
      {
        id,
        actor,
        ...(action === 'prepare'
          ? { sourcePreparationId: otherId, destinationInspectionId: pointId, action: 'prepare-isolated-reconciled-target' }
          : {}),
      },
      reconciliationOptions.signal,
      32768,
      action === 'prepare' ? 202 : 200,
      action === 'wait' ? 1_900_000 : 30_000,
    );
  },
);
it.each(['queued', 'checking-source', 'allocating', 'writing', 'verifying-reconciliation'])(
  'preserves active reconciliation phase %s without claiming a restored server',
  async (phase) => {
    const status = { ...reconciliationBase, phase, reconciliationActive: true, reconciledTargetAvailable: false };
    root.mockResolvedValueOnce(status);
    await expect(callCoreCleanTargetReconciliationRoot({ ...reconciliationOptions, action: 'status' })).resolves.toEqual(status);
  },
);
it.each(['checking', 'recovery-required', 'reconciliation-blocked'])('keeps inactive reconciliation %s unavailable', async (phase) => {
  const status = { ...reconciliationBase, phase, reconciliationActive: false, reconciledTargetAvailable: false };
  root.mockResolvedValueOnce(status);
  await expect(callCoreCleanTargetReconciliationRoot({ ...reconciliationOptions, action: 'wait' })).resolves.toEqual(status);
});
it.each([
  ['id', pointId],
  ['sourcePreparationId', pointId],
  ['destinationInspectionId', otherId],
  ['version', 2],
  ['phase', 'preparation-complete'],
  ['phase', 'unknown'],
  ['scope', 'restore'],
  ['activation', true],
  ['environmentProved', true],
  ['restoreAuthority', true],
  ['sourceWrites', true],
  ['reconciliationActive', true],
  ['reconciledTargetAvailable', false],
  ['command', 'untrusted'],
  ['destinationInspectionId', undefined],
  ['receipt', digest],
])('rejects mismatched or broadened reconciliation field %s=%s', async (key, value) => {
  root.mockResolvedValueOnce({ ...reconciliationComplete(), [key]: value });
  await expect(callCoreCleanTargetReconciliationRoot({ ...reconciliationOptions, action: 'status' })).rejects.toThrow();
});
it('refuses malformed or aliased operation identities before dispatch', async () => {
  for (const change of [
    { id: 'invalid' },
    { sourcePreparationId: 'invalid' },
    { destinationInspectionId: 'invalid' },
    { sourcePreparationId: id },
    { destinationInspectionId: id },
    { destinationInspectionId: otherId },
    { actor: { ...actor, ownerId: 0 } },
    { action: 'activate' },
  ])
    await expect(callCoreCleanTargetReconciliationRoot({ ...reconciliationOptions, action: 'prepare', ...change } as never)).rejects.toThrow();
  expect(root).not.toHaveBeenCalled();
});
it('does not convert inspection, preparation, missing service or transport errors into reconciliation proof', async () => {
  for (const value of [prepared(), complete(), targetComplete(), null, {}, 'reconciliation-complete']) {
    root.mockResolvedValueOnce(value);
    await expect(callCoreCleanTargetReconciliationRoot({ ...reconciliationOptions, action: 'status' })).rejects.toThrow();
  }
  root.mockRejectedValueOnce(new Error('unavailable'));
  await expect(callCoreCleanTargetReconciliationRoot({ ...reconciliationOptions, action: 'wait' })).rejects.toThrow('unavailable');
});
