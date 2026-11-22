import { expect, it, vi } from 'vitest';
import type { OwnershipGrant } from './host-broker';
import { OwnershipWriteError, OwnershipWriteLease } from './ownership-authority';

const requestId = 'c'.repeat(64);
const grant: OwnershipGrant = Object.freeze({
  operationId: 'b'.repeat(64),
  requestId,
  purpose: 'first-registration',
  admissionBinding: 'a'.repeat(64),
  state: 'pending',
});
function fixture() {
  const broker = {
    ownershipPrepare: vi.fn(async () => grant),
    ownershipCheck: vi.fn(async () => grant),
    ownershipComplete: vi.fn(async () => ({ ...grant, state: 'completed' as const })),
  };
  const prepare = () => OwnershipWriteLease.prepare(broker, 'first-registration', requestId);
  return { broker, prepare };
}
function deferred() {
  let resolve!: (value: OwnershipGrant) => void;
  const promise = new Promise<OwnershipGrant>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('retains a Root hold across rechecks and possible writes, completing only after Main confirms success', async () => {
  const f = fixture();
  const lease = await f.prepare();
  expect(f.broker.ownershipPrepare).toHaveBeenCalledWith({ requestId, purpose: 'first-registration' });
  await lease.verifyCurrent();
  await lease.beforeWrite();
  expect(lease.outcome).toEqual({ requestId, operationId: grant.operationId, writes: 'uncertain', authority: 'pending' });
  expect(f.broker.ownershipCheck).toHaveBeenCalledTimes(2);
  expect(await lease.cancelUnwritten()).toBe(false);
  expect(f.broker.ownershipComplete).not.toHaveBeenCalled();
  await lease.finishCommitted();
  expect(f.broker.ownershipComplete).toHaveBeenCalledExactlyOnceWith(grant, 'committed');
  expect(lease.outcome.writes).toBe('committed');
  expect(lease.outcome.authority).toBe('completed');
  expect(Object.isFrozen(lease.outcome)).toBe(true);
  expect(await lease.cancelUnwritten()).toBe(false);
  await expect(lease.beforeWrite()).rejects.toBeInstanceOf(OwnershipWriteError);
  await expect(lease.verifyCurrent()).rejects.toBeInstanceOf(OwnershipWriteError);
  expect(f.broker.ownershipComplete).toHaveBeenCalledTimes(1);
});

it.each([{ state: 'completed' }, { requestId: 'd'.repeat(64) }, { purpose: 'account-removal' }])(
  'does not grant Main writes from completed or crossed preparation %#',
  async (patch) => {
    const f = fixture();
    f.broker.ownershipPrepare.mockResolvedValue({ ...grant, ...patch } as OwnershipGrant);
    await expect(f.prepare()).rejects.toMatchObject({ outcome: { writes: 'not-started', authority: 'unknown' } });
    expect(f.broker.ownershipCheck).not.toHaveBeenCalled();
    expect(f.broker.ownershipComplete).not.toHaveBeenCalled();
  },
);

it('keeps an unavailable or ambiguous prepare unknown without retry or cleanup', async () => {
  const f = fixture();
  f.broker.ownershipPrepare.mockRejectedValue(new Error('private transport detail'));
  const error = await f.prepare().catch((value: unknown) => value);
  expect(error).toBeInstanceOf(OwnershipWriteError);
  expect(String(error)).not.toContain('private transport detail');
  expect(f.broker.ownershipPrepare).toHaveBeenCalledTimes(1);
  expect(f.broker.ownershipComplete).not.toHaveBeenCalled();
});

it('only releases an unwritten grant once and never reopens the closed lease', async () => {
  const f = fixture();
  const lease = await f.prepare();
  expect(await lease.cancelUnwritten()).toBe(true);
  expect(await lease.cancelUnwritten()).toBe(true);
  expect(f.broker.ownershipComplete).toHaveBeenCalledExactlyOnceWith(grant, 'not-written');
  await expect(lease.beforeWrite()).rejects.toBeInstanceOf(OwnershipWriteError);
  await expect(lease.finishCommitted()).rejects.toBeInstanceOf(OwnershipWriteError);
  expect(f.broker.ownershipCheck).not.toHaveBeenCalled();
});

it('failed revalidation prevents the first write and preserves unknown authority', async () => {
  const f = fixture();
  const lease = await f.prepare();
  f.broker.ownershipCheck.mockRejectedValue(new Error('changed authority'));
  await expect(lease.beforeWrite()).rejects.toMatchObject({ outcome: { writes: 'not-started', authority: 'unknown' } });
  expect(f.broker.ownershipComplete).not.toHaveBeenCalled();
});

it('failed Main work cannot clear its hold or claim not-written', async () => {
  const f = fixture();
  const lease = await f.prepare();
  await lease.beforeWrite();
  // A rejected SQL operation can already have taken effect; callers retain this lease.
  expect(await lease.cancelUnwritten()).toBe(false);
  expect(lease.outcome.writes).toBe('uncertain');
  expect(f.broker.ownershipComplete).not.toHaveBeenCalled();
});

it('lost completion preserves committed Main writes and never claims rollback', async () => {
  const f = fixture();
  const lease = await f.prepare();
  await lease.beforeWrite();
  f.broker.ownershipComplete.mockRejectedValue(new Error('reply lost'));
  await expect(lease.finishCommitted()).rejects.toMatchObject({ outcome: { writes: 'committed', authority: 'unknown' } });
  expect(await lease.cancelUnwritten()).toBe(false);
  await expect(lease.finishCommitted()).rejects.toBeInstanceOf(OwnershipWriteError);
  expect(f.broker.ownershipComplete).toHaveBeenCalledTimes(1);
});

it('cannot complete before writes begin', async () => {
  const f = fixture();
  const lease = await f.prepare();
  await expect(lease.finishCommitted()).rejects.toBeInstanceOf(OwnershipWriteError);
  expect(f.broker.ownershipComplete).not.toHaveBeenCalled();
  expect(lease.outcome.writes).toBe('not-started');
});

it('resumed pending preparation conservatively retains prior writes and cannot retire as unwritten', async () => {
  const f = fixture();
  const lease = await OwnershipWriteLease.resume(f.broker, 'first-registration', requestId);
  expect(lease.outcome.writes).toBe('uncertain');
  expect(await lease.cancelUnwritten()).toBe(false);
  expect(f.broker.ownershipComplete).not.toHaveBeenCalled();
  await lease.verifyCurrent();
  await lease.finishCommitted();
  expect(f.broker.ownershipComplete).toHaveBeenCalledExactlyOnceWith(grant, 'committed');
});

it.each(['completed', 'unavailable'])('failed %s resumption never claims earlier writes were not started', async (state) => {
  const f = fixture();
  if (state === 'completed') f.broker.ownershipPrepare.mockResolvedValue({ ...grant, state: 'completed' });
  else f.broker.ownershipPrepare.mockRejectedValue(new Error('reply lost'));
  await expect(OwnershipWriteLease.resume(f.broker, 'first-registration', requestId)).rejects.toMatchObject({
    outcome: { requestId, writes: 'uncertain', authority: 'unknown' },
  });
  expect(f.broker.ownershipComplete).not.toHaveBeenCalled();
});

it.each(['write', 'cancel', 'finish', 'verify'])('rejects concurrent %s while first-write revalidation is pending', async (kind) => {
  const f = fixture();
  const lease = await f.prepare();
  const wait = deferred();
  f.broker.ownershipCheck.mockReturnValue(wait.promise);
  const first = lease.beforeWrite();
  const second =
    kind === 'write'
      ? lease.beforeWrite()
      : kind === 'cancel'
        ? lease.cancelUnwritten()
        : kind === 'finish'
          ? lease.finishCommitted()
          : lease.verifyCurrent();
  await expect(second).rejects.toBeInstanceOf(OwnershipWriteError);
  expect(f.broker.ownershipComplete).not.toHaveBeenCalled();
  wait.resolve(grant);
  await first;
  expect(lease.outcome.writes).toBe('uncertain');
  expect(f.broker.ownershipCheck).toHaveBeenCalledTimes(1);
  await expect(lease.beforeWrite()).rejects.toBeInstanceOf(OwnershipWriteError);
});

it('a pending unwritten cancellation excludes a concurrent first writer', async () => {
  const f = fixture();
  const lease = await f.prepare();
  const wait = deferred();
  f.broker.ownershipComplete.mockReturnValue(wait.promise as Promise<OwnershipGrant & { state: 'completed' }>);
  const cancel = lease.cancelUnwritten();
  await expect(lease.beforeWrite()).rejects.toBeInstanceOf(OwnershipWriteError);
  expect(f.broker.ownershipCheck).not.toHaveBeenCalled();
  wait.resolve({ ...grant, state: 'completed' });
  expect(await cancel).toBe(true);
});
