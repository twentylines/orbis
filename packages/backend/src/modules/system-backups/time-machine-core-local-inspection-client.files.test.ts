import { afterEach, expect, it, vi } from 'vitest';
import { callCoreLocalInspectionRoot, type CoreLocalInspectionApproval } from './time-machine-core-local-inspection-client';
import { callProtectedRetainedRoot } from './time-machine-retained-phase-client';

vi.mock('./time-machine-retained-phase-client', () => ({ callProtectedRetainedRoot: vi.fn() }));
const root = vi.mocked(callProtectedRetainedRoot);
afterEach(() => root.mockReset());
const id = 'a71c77d2-f420-440e-951b-083209514e72';
const pointId = 'a71c77d2-f420-440e-951b-083209514e74';
const otherPoint = 'a71c77d2-f420-440e-951b-083209514e75';
const actor = { ownerId: 17, sessionBinding: '1'.repeat(64), securityBinding: '2'.repeat(64) };
const digest = '3'.repeat(64);
const image = `sha256:${digest}`;
const base = {
  schema: 'orbis.core-restore-inspection.v2',
  version: 2,
  id,
  pointId,
  sourceManifestSha256: digest,
  ownerId: actor.ownerId,
  scope: 'inspection-only',
  restoreSupported: false,
  activationAuthorized: false,
  workerExecutionAvailable: false,
};
const consent = {
  schema: 'orbis.core-inspection-execution-consent.v2',
  role: 'database',
  imageAuthority: 'root-qualified-cached-image',
  imageId: image,
  platform: { os: 'linux', architecture: 'arm64' },
  postgresqlMajor: 17,
  sandboxProfile: 'orbis.core-source-pg-inspection.v2',
  profileSha256: digest,
  settingsSha256: digest,
  sourceWitnessSha256: digest,
  resourcesSha256: digest,
  sourceProjectionSha256: digest,
  configurationReceiptSha256: digest,
  destinationRevisionSha256: digest,
  coordinatorImageId: image,
  coordinatorSha256: digest,
  executionPlanSha256: digest,
  overlaySha256: digest,
  authority: 'explicit-fresh-exact-bytes',
  scope: 'inspection-only',
};
const options = { id, pointId, manifestSha256: digest, actor, signal: new AbortController().signal };
const prepared = () => ({
  ...base,
  phase: 'awaiting-approval',
  reviewSha256: digest,
  approvalNonce: digest,
  approvalExpiresAt: Date.now() + 300000,
  executionConsent: consent,
  legacyRestrictions: ['legacy-create-intents-not-captured', 'legacy-effective-environment-not-captured'],
});
const authorized = () => ({ ...base, phase: 'inspection-authorized', permitSha256: digest, permitExpiresAt: Date.now() + 300000 });
const input = { reviewSha256: digest, approvalNonce: digest, executionConsent: consent };

it('binds prepared and authorized replies to the authenticated point manifest', async () => {
  root.mockResolvedValueOnce({ ...prepared(), sourceManifestSha256: 'f'.repeat(64) });
  await expect(callCoreLocalInspectionRoot({ ...options, action: 'prepare' })).rejects.toThrow();
  root.mockResolvedValueOnce({ ...authorized(), sourceManifestSha256: null });
  await expect(callCoreLocalInspectionRoot({ ...options, action: 'status' })).rejects.toThrow();
});

it('observes an already admitted request without requiring a new preparation', async () => {
  root.mockResolvedValueOnce(authorized());
  expect((await callCoreLocalInspectionRoot({ ...options, action: 'prepare' })).phase).toBe('inspection-authorized');
  root.mockResolvedValueOnce({ ...base, sourceManifestSha256: null, phase: 'recovery-required' });
  expect((await callCoreLocalInspectionRoot({ ...options, action: 'prepare' })).phase).toBe('recovery-required');
});

it('sends the local point and exact consent on the distinct v2 protocol', async () => {
  root.mockResolvedValueOnce(prepared());
  await expect(callCoreLocalInspectionRoot({ ...options, action: 'prepare' })).resolves.toMatchObject({ pointId, scope: 'inspection-only' });
  expect(root).toHaveBeenLastCalledWith(
    '/run/orbis/host.sock',
    '/v1/core-local-restore-inspection/prepare',
    { id, pointId, actor },
    options.signal,
    2 * 1024 * 1024,
    200,
    900_000,
  );
  root.mockResolvedValueOnce(authorized());
  await expect(callCoreLocalInspectionRoot({ ...options, action: 'approve', input })).resolves.toMatchObject({ activationAuthorized: false });
  expect(root.mock.calls.at(-1)?.[2]).toEqual({ id, actor, ...input, action: 'authorize-core-inspection-only' });
  root.mockResolvedValueOnce({ ...base, phase: 'recovery-required' });
  await expect(callCoreLocalInspectionRoot({ ...options, action: 'status' })).resolves.toMatchObject({ phase: 'recovery-required' });
  expect(root.mock.calls.at(-1)?.[2]).toEqual({ id, actor });
});

it.each(['point', 'id', 'owner', 'v1', 'restore', 'activation', 'worker', 'unknown', 'expired', 'restrictions', 'consentExtra'] as const)(
  'rejects a prepared response with invalid %s',
  async (kind) => {
    const value = prepared() as Record<string, unknown>;
    if (kind === 'point') value.pointId = otherPoint;
    if (kind === 'id') value.id = otherPoint;
    if (kind === 'owner') value.ownerId = 1;
    if (kind === 'v1') {
      value.schema = 'orbis.core-restore-inspection.v1';
      value.version = 1;
    }
    if (kind === 'restore') value.restoreSupported = true;
    if (kind === 'activation') value.activationAuthorized = true;
    if (kind === 'worker') value.workerExecutionAvailable = true;
    if (kind === 'unknown') value.grant = digest;
    if (kind === 'expired') value.approvalExpiresAt = 1;
    if (kind === 'restrictions') value.legacyRestrictions = [];
    if (kind === 'consentExtra') value.executionConsent = { ...consent, restoreAuthority: true };
    root.mockResolvedValueOnce(value);
    await expect(callCoreLocalInspectionRoot({ ...options, action: 'prepare' })).rejects.toThrow();
  },
);
it.each(['approve', 'status'] as const)('rejects a cross-point %s response', async (action) => {
  root.mockResolvedValueOnce({ ...authorized(), pointId: otherPoint });
  await expect(callCoreLocalInspectionRoot({ ...options, action, ...(action === 'approve' ? { input } : {}) })).rejects.toThrow();
});
it('rejects expired authorization even on status', async () => {
  root.mockResolvedValueOnce({ ...authorized(), permitExpiresAt: 1 });
  await expect(callCoreLocalInspectionRoot({ ...options, action: 'status' })).rejects.toThrow();
});
it('rejects malformed and broadened consent before dispatch', async () => {
  const invalid: CoreLocalInspectionApproval = { ...input, executionConsent: { ...consent, scope: 'restore' } };
  await expect(callCoreLocalInspectionRoot({ ...options, action: 'approve', input: invalid })).rejects.toThrow();
  await expect(callCoreLocalInspectionRoot({ ...options, action: 'approve', input: { ...input, executionConsent: undefined } })).rejects.toThrow();
  await expect(callCoreLocalInspectionRoot({ ...options, action: 'prepare', actor: { ...actor, ownerId: 0 } })).rejects.toThrow();
  expect(root).not.toHaveBeenCalled();
});
