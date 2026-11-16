import { afterEach, expect, it, vi } from 'vitest';
import { callProtectedRetainedRoot } from '../system-backups/time-machine-retained-phase-client';
import { callCoreInspectionRoot, type CoreInspectionApproval } from './core-inspection-root-client';

vi.mock('../system-backups/time-machine-retained-phase-client', () => ({ callProtectedRetainedRoot: vi.fn() }));
const root = vi.mocked(callProtectedRetainedRoot);
afterEach(() => root.mockReset());
const id = 'a71c77d2-f420-440e-951b-083209514e72';
const enrollmentId = 'a71c77d2-f420-440e-951b-083209514e73';
const pointId = 'a71c77d2-f420-440e-951b-083209514e74';
const actor = { ownerId: 17, sessionBinding: '1'.repeat(64), securityBinding: '2'.repeat(64) };
const base = {
  schema: 'orbis.core-restore-inspection.v1',
  version: 1,
  id,
  pointId,
  ownerId: actor.ownerId,
  scope: 'inspection-only',
  restoreSupported: false,
  activationAuthorized: false,
  workerExecutionAvailable: false,
};
const consent = {
  schema: 'orbis.core-inspection-execution-consent.v1',
  role: 'database',
  imageId: `sha256:${'3'.repeat(64)}`,
  archiveSha256: '4'.repeat(64),
  platform: { os: 'linux', architecture: 'arm64' },
  postgresqlMajor: 17,
  sandboxProfile: 'orbis.core-source-pg-inspection.v1',
  authority: 'explicit-fresh-exact-bytes',
  scope: 'inspection-only',
};
const options = { id, enrollmentId, actor, signal: new AbortController().signal };
const prepared = () => ({
  ...base,
  phase: 'awaiting-approval',
  reviewSha256: '5'.repeat(64),
  approvalNonce: '6'.repeat(64),
  approvalExpiresAt: Date.now() + 300000,
  executionConsent: consent,
  legacyRestrictions: ['legacy-create-intents-not-captured', 'legacy-effective-environment-not-captured'],
});
it('uses the distinct inspection protocol and transmits exact consent without legacy restore grants', async () => {
  root.mockResolvedValueOnce(prepared());
  await expect(callCoreInspectionRoot({ ...options, action: 'prepare' })).resolves.toMatchObject({ scope: 'inspection-only' });
  expect(root).toHaveBeenLastCalledWith(
    '/run/orbis/host.sock',
    '/v1/core-restore-inspection/prepare',
    { id, enrollmentId, actor },
    options.signal,
    2 * 1024 * 1024,
    200,
    900_000,
  );
  const input = { reviewSha256: '5'.repeat(64), approvalNonce: '6'.repeat(64), executionConsent: consent };
  root.mockResolvedValueOnce({ ...base, phase: 'inspection-authorized', permitSha256: '7'.repeat(64), permitExpiresAt: Date.now() + 300000 });
  await expect(callCoreInspectionRoot({ ...options, action: 'approve', input })).resolves.toMatchObject({ workerExecutionAvailable: false });
  expect(root.mock.calls.at(-1)?.[2]).toEqual({ id, actor, ...input, action: 'authorize-core-inspection-only' });
});
it.each(['activationAuthorized', 'restoreSupported', 'workerExecutionAvailable', 'owner', 'scope', 'unknown', 'expired', 'restrictions'] as const)(
  'rejects a Root response that changes %s authority or identity',
  async (attack) => {
    const value = prepared() as Record<string, unknown>;
    if (['activationAuthorized', 'restoreSupported', 'workerExecutionAvailable'].includes(attack)) value[attack] = true;
    if (attack === 'owner') value.ownerId = 1;
    if (attack === 'scope') value.scope = 'restore';
    if (attack === 'unknown') value.token = 'legacy grant';
    if (attack === 'expired') value.approvalExpiresAt = 1;
    if (attack === 'restrictions') value.legacyRestrictions = [];
    root.mockResolvedValueOnce(value);
    await expect(callCoreInspectionRoot({ ...options, action: 'prepare' })).rejects.toThrow();
  },
);
it('rejects a missing or broadened explicit execution consent before Root dispatch', async () => {
  const input: CoreInspectionApproval = { reviewSha256: '5'.repeat(64), approvalNonce: '6'.repeat(64), executionConsent: undefined };
  await expect(callCoreInspectionRoot({ ...options, action: 'approve', input })).rejects.toThrow();
  input.executionConsent = { ...consent, role: 'controller' };
  await expect(callCoreInspectionRoot({ ...options, action: 'approve', input })).rejects.toThrow();
  expect(root).not.toHaveBeenCalled();
});
