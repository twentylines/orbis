import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { coreCapsuleFixture } from './core-capsule.fixture';
import { callCorePortableRoot } from './core-portable-root-client';

vi.mock('./core-portable-root-client', () => ({ callCorePortableRoot: vi.fn() }));
const root = vi.mocked(callCorePortableRoot);
const fixtures: Awaited<ReturnType<typeof coreCapsuleFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  root.mockReset();
});
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
  const review = await f.capsules.review(imported.id, 1, f.request, f.credentials, f.passphrase);
  review.start();
  await vi.waitFor(async () => expect((await f.capsules.list(1)).jobs.find((job) => job.id === imported.id)?.status).toBe('verified'), {
    timeout: 15000,
  });
  const metadata = await f.store.metadata(f.point);
  if (metadata.version !== 3) throw new Error('Missing core metadata');
  return {
    ...f,
    imported,
    metadata,
    stored: async () => JSON.parse(await fs.readFile(path.join(f.root, 'backups/capsules', imported.id, 'job.json'), 'utf8')),
    binding: async () => {
      try {
        return JSON.parse(await fs.readFile(path.join(f.root, 'backups/capsules', imported.id, 'core-enrollment.json'), 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
  };
}
it('requires fresh account approval twice and binds the Root enrollment to the authenticated actor and persisted operation', async () => {
  const f = await fixture();
  root.mockImplementation(async (options) =>
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
          metadata: f.metadata,
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
  const before = f.auth.verifySensitiveAction.mock.calls.length;
  const prepared = await f.capsules.coreEnrollment(f.imported.id, 1, f.request, f.credentials, 'prepare', { passphrase: f.passphrase });
  expect(f.auth.verifySensitiveAction.mock.calls.length).toBe(before + 1);
  const stored = await f.stored();
  expect((await f.binding()).id).toBe(prepared.id);
  expect(stored).not.toHaveProperty('coreEnrollmentId');
  expect(JSON.stringify(stored)).not.toContain(f.passphrase);
  expect(root).toHaveBeenLastCalledWith(
    expect.objectContaining({
      id: prepared.id,
      action: 'prepare',
      actor: { ownerId: 1, sessionBinding: f.actor.sessionBinding, securityBinding: f.actor.securityBinding },
      input: { capsuleJobId: f.imported.id, capsuleSha256: stored.sha256, passphrase: f.passphrase },
    }),
  );
  await expect(
    f.capsules.coreEnrollment(f.imported.id, 1, f.request, f.credentials, 'approve', { reviewSha256: 'd'.repeat(64), approvalNonce: 'e'.repeat(64) }),
  ).resolves.toMatchObject({ phase: 'enrolled', restoreSupported: false });
  expect(f.auth.verifySensitiveAction.mock.calls.length).toBe(before + 2);
  expect((await f.stored()).pointId).toBe(f.point.id);
  expect((await f.capsules.list(1)).jobs.find((job) => job.id === f.imported.id)).not.toHaveProperty('coreEnrollmentId');
});
it('persists an ambiguous Root attempt and inspects it without creating another worker operation', async () => {
  const f = await fixture();
  root.mockRejectedValueOnce(new Error('Simulated disconnected Root response'));
  await expect(f.capsules.coreEnrollment(f.imported.id, 1, f.request, f.credentials, 'prepare', { passphrase: f.passphrase })).rejects.toThrow();
  const operation = (await f.binding()).id;
  expect(operation).toMatch(/^[a-f0-9-]{36}$/);
  await expect(f.capsules.coreEnrollment(f.imported.id, 1, f.request, f.credentials, 'prepare', { passphrase: f.passphrase })).rejects.toThrow();
  expect(root).toHaveBeenCalledTimes(1);
  root.mockResolvedValueOnce({ version: 1, id: operation, phase: 'recovery-required', restoreSupported: false });
  await expect(f.capsules.coreEnrollment(f.imported.id, 1, f.request, f.credentials, 'status')).resolves.toMatchObject({
    phase: 'recovery-required',
  });
  expect(root).toHaveBeenLastCalledWith(expect.objectContaining({ id: operation, action: 'status' }));
});
it('rejects account/session changes before Root dispatch and keeps source bytes unchanged', async () => {
  const f = await fixture();
  const file = path.join(f.root, 'backups/capsules', f.imported.id, 'capsule.orbis-tm');
  const before = await fs.readFile(file);
  f.auth.operatorActionContext.mockResolvedValueOnce(f.actor).mockResolvedValueOnce({ ...f.actor, securityBinding: 'f'.repeat(64) });
  await expect(f.capsules.coreEnrollment(f.imported.id, 1, f.request, f.credentials, 'prepare', { passphrase: f.passphrase })).rejects.toThrow();
  await expect(f.capsules.coreEnrollment(f.imported.id, 2, f.request, f.credentials, 'prepare', { passphrase: f.passphrase })).rejects.toThrow();
  expect(root).not.toHaveBeenCalled();
  expect(await f.binding()).toBeUndefined();
  expect(await fs.readFile(file)).toEqual(before);
});
