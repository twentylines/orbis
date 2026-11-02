import { expect, test } from 'bun:test';
import { restoreAfterReview, reviewForRestore } from './review-for-restore';
import type { ImportJob } from './contracts';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const job = (): ImportJob => ({
  id,
  createdAt: 1,
  updatedAt: 2,
  message: '',
  status: 'reviewed',
  stage: 'complete',
  completedBytes: 52,
  totalBytes: 52,
  uploadedBytes: 52,
  reviewExpiresAt: Date.now() + 60_000,
  review: {
    formatVersion: 1,
    createdAt: 1,
    orbisVersion: '1.0',
    runtipiVersion: '1.0',
    architecture: 'arm64',
    fileCount: 1,
    appCount: 0,
    expandedBytes: 52,
    manifestSha256: 'a'.repeat(64),
    databaseValidation: 'validated',
    compatibility: { compatible: true, blockers: [], architectureChanged: false },
  },
});

test('verification submits only the archive key and returns the same unexpired manifest', async () => {
  const calls: unknown[][] = [];
  const request = async (...args: unknown[]) => {
    calls.push(args);
    return args[1] === 'POST' ? {} : { available: true, retentionHours: 24, jobs: [job()] };
  };
  const result = await reviewForRestore(id, '12345678', new AbortController().signal, request);
  expect(result.id).toBe(id);
  expect(result.review?.manifestSha256).toBe('a'.repeat(64));
  expect(calls[0]?.slice(0, 3)).toEqual([`/imports/${id}/review`, 'POST', { passphrase: '12345678' }]);
});

test('failed, expired, incompatible or missing review never authorizes restore', async () => {
  const review = job().review;
  if (!review) throw new Error('Missing review fixture');
  for (const changed of [
    { ...job(), status: 'failed' as const },
    { ...job(), reviewExpiresAt: 1 },
    { ...job(), review: { ...review, compatibility: { compatible: false, blockers: ['newer-orbis' as const], architectureChanged: false } } },
    { ...job(), id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
  ]) {
    let restoreRequests = 0;
    const request = async (path: string, method = 'GET') => {
      if (path === '/restores') restoreRequests++;
      return method === 'POST' ? {} : { available: true, retentionHours: 24, jobs: [changed] };
    };
    let submitted = false;
    await expect(
      restoreAfterReview(id, '12345678', { password: 'password' }, new AbortController().signal, request, () => {
        submitted = true;
      }),
    ).rejects.toThrow();
    expect(restoreRequests).toBe(0);
    expect(submitted).toBe(false);
  }
});

test('restores only after verification using its manifest and the fresh operator proof', async () => {
  const calls: unknown[][] = [];
  const request = async (...args: unknown[]) => {
    calls.push(args);
    if (args[0] === '/imports') return { available: true, retentionHours: 24, jobs: [job()] };
    return { ok: true };
  };
  let submitted = false;
  await restoreAfterReview(id, 'separate-key', { password: 'account-key', totpCode: '123456' }, new AbortController().signal, request, () => {
    submitted = true;
  });
  expect(submitted).toBe(true);
  expect(calls.map((entry) => entry[0])).toEqual([`/imports/${id}/review`, '/imports', '/restores']);
  expect(calls[0]?.[2]).toEqual({ passphrase: 'separate-key' });
  expect(calls[2]?.[2]).toEqual({
    password: 'account-key',
    totpCode: '123456',
    importId: id,
    manifestSha256: 'a'.repeat(64),
    confirmation: 'replace-server',
  });
});

test('session-authorized restore sends no fabricated account proof', async () => {
  const calls: unknown[][] = [];
  const request = async (...args: unknown[]) => {
    calls.push(args);
    return args[0] === '/imports' ? { available: true, retentionHours: 24, jobs: [job()] } : {};
  };
  await restoreAfterReview(id, '12345678', { password: '' }, new AbortController().signal, request);
  expect(calls[2]?.[2]).toEqual({ importId: id, manifestSha256: 'a'.repeat(64), confirmation: 'replace-server' });
});
