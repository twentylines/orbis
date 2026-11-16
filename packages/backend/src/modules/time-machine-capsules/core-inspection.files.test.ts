import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { coreCapsuleFixture } from './core-capsule.fixture';
import { callCoreInspectionRoot } from './core-inspection-root-client';
import { callCorePortableRoot } from './core-portable-root-client';

vi.mock('./core-portable-root-client', () => ({ callCorePortableRoot: vi.fn() }));
vi.mock('./core-inspection-root-client', () => ({ callCoreInspectionRoot: vi.fn() }));
const enrollment = vi.mocked(callCorePortableRoot);
const inspection = vi.mocked(callCoreInspectionRoot);
const fixtures: Awaited<ReturnType<typeof coreCapsuleFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  enrollment.mockReset();
  inspection.mockReset();
});
const consent = {
  schema: 'orbis.core-inspection-execution-consent.v1' as const,
  role: 'database' as const,
  imageId: `sha256:${'1'.repeat(64)}`,
  archiveSha256: '2'.repeat(64),
  platform: { os: 'linux' as const, architecture: 'arm64' as const },
  postgresqlMajor: 17,
  sandboxProfile: 'orbis.core-source-pg-inspection.v1' as const,
  authority: 'explicit-fresh-exact-bytes' as const,
  scope: 'inspection-only' as const,
};
async function fixture() {
  const f = await coreCapsuleFixture();
  fixtures.push(f);
  const exported = await f.capsules.startExport(1, f.request, f.credentials, f.point.id, f.passphrase);
  exported.start();
  await vi.waitFor(async () => expect((await f.capsules.list(1)).jobs.find((job) => job.id === exported.job.id)?.status).toBe('ready'), {
    timeout: 15000,
  });
  const imported = await vi.waitFor(() => f.capsules.createImport(1, f.request, f.credentials));
  const download = await f.capsules.download(exported.job.id, 1, f.request, f.credentials);
  await f.capsules.upload(imported.id, 1, download.stream, String(download.bytes), new AbortController().signal);
  const reviewed = await f.capsules.review(imported.id, 1, f.request, f.credentials, f.passphrase);
  reviewed.start();
  await vi.waitFor(async () => expect((await f.capsules.list(1)).jobs.find((job) => job.id === imported.id)?.status).toBe('verified'), {
    timeout: 15000,
  });
  const metadata = await f.store.metadata(f.point);
  if (metadata.version !== 3) throw new Error('Missing core metadata');
  enrollment.mockImplementation(async (options) =>
    options.action === 'prepare'
      ? {
          version: 1,
          id: options.id,
          phase: 'awaiting-approval',
          restoreSupported: false,
          reviewSha256: 'd'.repeat(64),
          approvalNonce: 'e'.repeat(64),
          approvalExpiresAt: Date.now() + 300000,
          pointId: f.point.id,
          sourceOwnerId: 1,
          ownerId: 1,
          metadata,
        }
      : {
          version: 1,
          id: options.id,
          phase: 'enrolled',
          restoreSupported: false,
          pointId: f.point.id,
          provenanceSha256: 'f'.repeat(64),
          created: true,
        },
  );
  const enrolled = await f.capsules.coreEnrollment(imported.id, 1, f.request, f.credentials, 'prepare', { passphrase: f.passphrase });
  await f.capsules.coreEnrollment(imported.id, 1, f.request, f.credentials, 'approve', {
    reviewSha256: 'd'.repeat(64),
    approvalNonce: 'e'.repeat(64),
  });
  const common = {
    schema: 'orbis.core-restore-inspection.v1' as const,
    version: 1 as const,
    scope: 'inspection-only' as const,
    restoreSupported: false as const,
    activationAuthorized: false as const,
    workerExecutionAvailable: false as const,
    pointId: f.point.id,
    ownerId: 1,
  };
  inspection.mockImplementation(async (options) =>
    options.action === 'prepare'
      ? {
          ...common,
          id: options.id,
          phase: 'awaiting-approval',
          reviewSha256: '3'.repeat(64),
          approvalNonce: '4'.repeat(64),
          approvalExpiresAt: Date.now() + 300000,
          executionConsent: consent,
          legacyRestrictions: ['legacy-create-intents-not-captured', 'legacy-effective-environment-not-captured'],
        }
      : {
          ...common,
          id: options.id,
          phase: 'inspection-authorized',
          permitSha256: '5'.repeat(64),
          permitExpiresAt: Date.now() + 300000,
        },
  );
  const directory = path.join(f.root, 'backups/capsules', imported.id);
  return {
    ...f,
    imported,
    enrolled,
    common,
    directory,
    binding: async () => JSON.parse(await fs.readFile(path.join(directory, 'core-inspection.json'), 'utf8')),
  };
}

it('requires separate fresh inspection consent and preserves the legacy job schema and encrypted source', async () => {
  const f = await fixture();
  const source = await fs.readFile(path.join(f.directory, 'capsule.orbis-tm'));
  const before = f.auth.verifySensitiveAction.mock.calls.length;
  const prepared = await f.capsules.coreInspection(f.imported.id, 1, f.request, f.credentials, 'prepare');
  expect(f.auth.verifySensitiveAction.mock.calls.length).toBe(before + 1);
  expect(prepared.id).not.toBe(f.enrolled.id);
  expect((await f.binding()).id).toBe(prepared.id);
  expect(inspection).toHaveBeenLastCalledWith(
    expect.objectContaining({
      id: prepared.id,
      enrollmentId: f.enrolled.id,
      actor: { ownerId: 1, sessionBinding: f.actor.sessionBinding, securityBinding: f.actor.securityBinding },
    }),
  );
  const approval = { reviewSha256: '3'.repeat(64), approvalNonce: '4'.repeat(64), executionConsent: consent };
  const result = await f.capsules.coreInspection(f.imported.id, 1, f.request, f.credentials, 'approve', approval);
  expect(f.auth.verifySensitiveAction.mock.calls.length).toBe(before + 2);
  expect(result).toMatchObject({
    phase: 'inspection-authorized',
    activationAuthorized: false,
    restoreSupported: false,
    workerExecutionAvailable: false,
  });
  expect(inspection.mock.calls.at(-1)?.[0].input).toEqual(approval);
  expect(JSON.stringify(inspection.mock.calls)).not.toContain(f.credentials.password);
  expect(JSON.stringify(inspection.mock.calls)).not.toContain(f.passphrase);
  const job = JSON.parse(await fs.readFile(path.join(f.directory, 'job.json'), 'utf8'));
  expect(job).not.toHaveProperty('coreInspectionId');
  expect(job).not.toHaveProperty('coreEnrollmentId');
  expect(
    createHash('sha256')
      .update(await fs.readFile(path.join(f.directory, 'capsule.orbis-tm')))
      .digest('hex'),
  ).toBe(createHash('sha256').update(source).digest('hex'));
});

it('retains an ambiguous admission operation and never retries it as a new prepare', async () => {
  const f = await fixture();
  inspection.mockRejectedValueOnce(new Error('Synthetic disconnected admission response'));
  await expect(f.capsules.coreInspection(f.imported.id, 1, f.request, f.credentials, 'prepare')).rejects.toThrow();
  const binding = await f.binding();
  await expect(f.capsules.coreInspection(f.imported.id, 1, f.request, f.credentials, 'prepare')).rejects.toThrow();
  expect(inspection).toHaveBeenCalledTimes(1);
  inspection.mockResolvedValueOnce({ ...f.common, id: binding.id, phase: 'recovery-required' });
  await expect(f.capsules.coreInspection(f.imported.id, 1, f.request, f.credentials, 'status')).resolves.toMatchObject({
    phase: 'recovery-required',
  });
  expect(inspection).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'status', id: binding.id, enrollmentId: f.enrolled.id }));
});

it('refuses fresh authentication and security-context failures before Root dispatch', async () => {
  const f = await fixture();
  f.auth.verifySensitiveAction.mockRejectedValueOnce(new Error('Synthetic wrong fresh password'));
  await expect(f.capsules.coreInspection(f.imported.id, 1, f.request, f.credentials, 'prepare')).rejects.toThrow();
  expect(inspection).not.toHaveBeenCalled();
  f.auth.operatorActionContext.mockResolvedValueOnce(f.actor).mockResolvedValueOnce({ ...f.actor, sessionBinding: 'e'.repeat(64) });
  await expect(f.capsules.coreInspection(f.imported.id, 1, f.request, f.credentials, 'prepare')).rejects.toThrow();
  expect(inspection).not.toHaveBeenCalled();
  await expect(fs.stat(path.join(f.directory, 'core-inspection.json'))).rejects.toThrow();
});
