import { expect, test } from 'bun:test';
import { restoreAfterReview, reviewForRestore } from './review-for-restore';
import type { ImportJob } from './contracts';
import type { RestoreJob } from './contracts';
import { cancelImportBeforeRestore } from './cancel-backup-preparation';
import { restoreCanResume } from './restore-attempt';

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

test('cancelling verification stops only its import and dismisses only after fresh idle proof', async () => {
  let state: ImportJob['status'] = 'reviewing';
  const calls: string[] = [];
  let allowIdle: (value: { state: 'idle'; supported: true }) => void = () => undefined;
  const idle = new Promise<{ state: 'idle'; supported: true }>((resolve) => {
    allowIdle = resolve;
  });
  const request = async (path: string, method = 'GET') => {
    calls.push(`${method} ${path}`);
    if (method === 'POST') {
      state = 'cancelled';
      return { ...job(), status: state };
    }
    return { available: true, retentionHours: 24, jobs: [{ ...job(), status: state }] };
  };
  let dismissed = false;
  const pending = cancelImportBeforeRestore(id, request, () => idle).then(() => {
    dismissed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).toEqual(['GET /imports', `POST /imports/${id}/cancel`, 'GET /imports']);
  expect(dismissed).toBe(false);
  allowIdle({ state: 'idle', supported: true });
  await pending;
  expect(dismissed).toBe(true);
  expect(calls.some((call) => call.includes('/restores'))).toBe(false);
});

test('unknown cancellation, accepted restore preparation and non-idle authority never dismiss', async () => {
  for (const status of ['preparing', 'reviewing'] as const) {
    const request = async (_path: string, method = 'GET') =>
      method === 'POST' ? { ...job(), status } : { available: true, retentionHours: 24, jobs: [{ ...job(), status }] };
    await expect(cancelImportBeforeRestore(id, request, async () => ({ state: 'idle', supported: true }))).rejects.toThrow();
  }
  const read = async () => ({ available: true, retentionHours: 24, jobs: [{ ...job(), status: 'cancelled' as const }] });
  for (const authority of [
    { state: 'restoring', supported: true },
    { state: 'checking', supported: true },
    { state: 'idle', supported: false },
    { state: 'idle', supported: true, unavailable: true },
  ] as const) {
    await expect(cancelImportBeforeRestore(id, read, async () => authority)).rejects.toThrow('not confirmed');
  }
  await expect(cancelImportBeforeRestore(id, async () => ({ available: false, jobs: [] }))).rejects.toThrow('could not be checked');
});

test('a settled rollback unlocks only after genuine idle and never ignores a recovery hold', () => {
  const restore: RestoreJob = {
    id,
    status: 'rolled-back',
    stage: 'complete',
    phase: 'rolled-back',
    message: 'Original server recovered; uploaded backup not applied.',
    needsRecovery: false,
    progressUnavailable: false,
    canCancel: false,
    canRecover: false,
  };
  expect(restoreCanResume(restore, { state: 'idle', supported: true })).toBe(true);
  expect(restoreCanResume({ ...restore, needsRecovery: true }, { state: 'idle', supported: true })).toBe(false);
  for (const authority of [
    undefined,
    { state: 'idle', supported: false },
    { state: 'recovery', supported: true },
    { state: 'idle', supported: true, unavailable: true },
  ] as const)
    expect(restoreCanResume(restore, authority)).toBe(false);
  expect(restoreCanResume({ ...restore, status: 'running' }, { state: 'idle', supported: true })).toBe(false);
});

test('cancelling after verification cannot dispatch or mark an accepted restore', async () => {
  const abort = new AbortController();
  let accepted = false;
  const calls: string[] = [];
  const request = async (path: string, method = 'GET') => {
    calls.push(path);
    if (method === 'GET') {
      abort.abort();
      return { available: true, retentionHours: 24, jobs: [job()] };
    }
    return {};
  };
  await expect(
    restoreAfterReview(id, 'archive key', { password: '' }, abort.signal, request, () => {
      accepted = true;
    }),
  ).rejects.toThrow();
  expect(accepted).toBe(false);
  expect(calls).not.toContain('/restores');
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
