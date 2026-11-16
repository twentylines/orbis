import { afterEach, expect, it, vi } from 'vitest';
import { callCoreRestorationReviewRoot } from './time-machine-core-restoration-review-client';
import { callProtectedRetainedRoot } from './time-machine-retained-phase-client';
vi.mock('./time-machine-retained-phase-client', () => ({ callProtectedRetainedRoot: vi.fn() }));
const root = vi.mocked(callProtectedRetainedRoot);
afterEach(() => root.mockReset());
const id = '182f73f3-abed-47d4-a486-adb203d6eb21';
const reconciliationId = '182f73f3-abed-47d4-a486-adb203d6eb22';
const actor = { ownerId: 7, sessionBinding: '1'.repeat(64), securityBinding: '2'.repeat(64) };
const options = () => ({ id, reconciliationId, actor: { ...actor }, signal: new AbortController().signal });
const observed = () => ({
  version: 1,
  id,
  reconciliationId,
  phase: 'installation-observed',
  reviewAvailable: true,
  scope: 'current-installation-observation-only',
  logicalConsistencyProved: false,
  writerQuiescenceProved: false,
  activation: false,
  environmentProved: false,
  restoreAuthority: false,
  sourceWrites: false,
});

it.each(['review', 'status'] as const)('uses the fixed %s route, bounded transport and exact immutable identities', async (action) => {
  root.mockResolvedValue(observed());
  const input = options();
  expect(await callCoreRestorationReviewRoot({ ...input, action })).toEqual(observed());
  expect(root).toHaveBeenCalledExactlyOnceWith(
    '/run/orbis/host.sock',
    `/v1/core-restoration-review/${action}`,
    { id, actor, ...(action === 'review' ? { reconciliationId, action: 'review-current-installation-core-restoration' } : {}) },
    input.signal,
    16384,
    200,
    330_000,
  );
});
it.each(['checking', 'recovery-required'] as const)('preserves unavailable %s evidence', async (phase) => {
  root.mockResolvedValue({ ...observed(), phase, reviewAvailable: false });
  const result = await callCoreRestorationReviewRoot({ ...options(), action: 'status' });
  expect(result.phase).toBe(phase);
  expect(result.reviewAvailable).toBe(false);
  expect(result.activation).toBe(false);
});
it.each([
  { id: reconciliationId },
  { reconciliationId: id },
  { version: 2 },
  { phase: 'ready-to-restore' },
  { reviewAvailable: false },
  { phase: 'checking', reviewAvailable: true },
  { phase: 'recovery-required', reviewAvailable: true },
  { logicalConsistencyProved: true },
  { writerQuiescenceProved: true },
  { activation: true },
  { environmentProved: true },
  { restoreAuthority: true },
  { sourceWrites: true },
  { scope: 'restore' },
  { snapshot: {} },
  { path: '/private' },
  { actor },
] as const)('rejects wrong identity, promoted authority or private response fields %#', async (drift) => {
  root.mockResolvedValue({ ...observed(), ...drift });
  await expect(callCoreRestorationReviewRoot({ ...options(), action: 'review' })).rejects.toThrow();
});
it.each([null, {}, [], 'ready', undefined])('rejects missing or malformed Root evidence %#', async (value) => {
  root.mockResolvedValue(value);
  await expect(callCoreRestorationReviewRoot({ ...options(), action: 'status' })).rejects.toThrow();
});
it.each([
  { id: '../outside' },
  { reconciliationId: id },
  { reconciliationId: '' },
  { action: 'activate' },
  { actor: { ...actor, ownerId: true } },
  { actor: { ...actor, ownerId: 0 } },
  { actor: { ...actor, sessionBinding: 'bad' } },
  { actor: { ...actor, securityBinding: 'bad' } },
  { actor: { ...actor, secret: 'extra' } },
])('refuses malformed input before contacting Root %#', async (drift) => {
  await expect(callCoreRestorationReviewRoot({ ...options(), action: 'review', ...drift } as never)).rejects.toThrow();
  expect(root).not.toHaveBeenCalled();
});
it('does not start cancelled work or reinterpret transport failure as an observed installation', async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(callCoreRestorationReviewRoot({ ...options(), signal: cancelled.signal, action: 'review' })).rejects.toThrow();
  expect(root).not.toHaveBeenCalled();
  root.mockRejectedValue(new Error('missing service'));
  await expect(callCoreRestorationReviewRoot({ ...options(), action: 'review' })).rejects.toThrow('missing service');
});
