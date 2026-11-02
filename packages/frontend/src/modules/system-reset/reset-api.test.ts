import { markResetAccepted } from '@/components/recovery-progress/operation-status';
import { operationContinuityStorageName } from '@/components/recovery-progress/operation-continuity';
import { expect, test } from 'bun:test';
import { resetPayload, submitReset } from './reset-api';
import { resetCompletion, rememberResetCompletion, clearCompletedResetContinuity } from './reset-completion';
const proof = { method: 'password' as const, password: 'test-only' };
test('requires an explicit account choice and the confirmation words, ignoring case and outer whitespace', () => {
  expect(() => resetPayload('keep', 'reset', proof)).toThrow();
  for (const confirmation of ['reset orbis', ' ReSeT oRbIs  ', '\tRESET ORBIS\n'])
    expect(resetPayload('keep', confirmation, proof)).toEqual({ accounts: 'keep', confirmation: 'RESET ORBIS', ...proof });
  for (const confirmation of ['reset orbis now', 'reset  orbis', 'resetorbis']) expect(() => resetPayload('keep', confirmation, proof)).toThrow();
  expect(() => resetPayload('invalid' as 'keep', 'RESET ORBIS', proof)).toThrow();
  expect(resetPayload('remove', 'RESET ORBIS', proof)).toEqual({ accounts: 'remove', confirmation: 'RESET ORBIS', ...proof });
});
test('does not send malformed authentication codes or empty passwords', () => {
  expect(() => resetPayload('keep', 'RESET ORBIS', { ...proof, password: '' })).toThrow();
  expect(() => resetPayload('keep', 'RESET ORBIS', { ...proof, totpCode: '123' })).toThrow();
  const passkey = { method: 'passkey' as const, challengeId: 'test-challenge', response: {} as never, totpCode: '123456' };
  expect(resetPayload('keep', 'RESET ORBIS', passkey)).toEqual({ accounts: 'keep', confirmation: 'RESET ORBIS', ...passkey });
});
test('acceptance requires a valid server job; arbitrary responses do not confirm reset', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 202 })) as unknown as typeof fetch;
    await expect(submitReset('keep', 'RESET ORBIS', proof, new AbortController().signal)).rejects.toThrow();
  } finally {
    globalThis.fetch = original;
  }
});

test('reset uses registered passkeys when available and falls back to password', async () => {
  const { resetProofMethod } = await import('./reset-api');
  let calls = 0;
  const registered = async () => {
    calls++;
    return { available: true, credentials: [{}] };
  };
  expect(await resetProofMethod(false, null, registered)).toBe('passkey');
  expect(await resetProofMethod(false, 'unsupported', registered)).toBe('password');
  expect(await resetProofMethod(true, null, registered)).toBe('password');
  expect(calls).toBe(1);
  expect(await resetProofMethod(false, null, () => new Promise(() => undefined), 1)).toBe('password');
  expect(await resetProofMethod(false, null, async () => ({ available: true, credentials: [] }))).toBe('password');
  expect(
    await resetProofMethod(false, null, async () => {
      throw new Error('unavailable');
    }),
  ).toBe('password');
});

test('duplicate reset completion polls cause only one final navigation', () => {
  let clears = 0;
  let navigations = 0;
  const finish = resetCompletion(
    () => clears++,
    () => navigations++,
  );
  finish();
  finish();
  expect([clears, navigations]).toEqual([1, 1]);
});

test('reset completion navigates when browser storage is blocked and permits a failed navigation to retry', () => {
  let navigations = 0;
  const finish = resetCompletion(
    () => {
      throw new Error('Storage is unavailable');
    },
    () => {
      if (++navigations === 1) throw new Error('Navigation interrupted');
    },
  );
  expect(finish).toThrow('Navigation interrupted');
  finish();
  finish();
  expect(navigations).toBe(2);
});

const resetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const oldId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const idle = { state: 'idle' as const, supported: true };
function resetStorage(operation: 'restore' | 'update' | 'downgrade' = 'restore') {
  const entries = new Map<string, string>();
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  };
  const prior = JSON.stringify({ version: 1, jobId: oldId, operation, phase: 'departing', savedAt: 1000 });
  storage.setItem(operationContinuityStorageName, prior);
  rememberResetCompletion({ id: resetId, state: 'resetting' }, storage, 2000);
  markResetAccepted(storage);
  return { storage, prior };
}
test('confirmed reset completion clears only the exact prior browser operation bound to its accepted receipt', () => {
  for (const operation of ['restore', 'update', 'downgrade'] as const) {
    const { storage } = resetStorage(operation);
    expect(clearCompletedResetContinuity(idle, resetId, storage, 3000)).toBe(true);
    expect(storage.getItem(operationContinuityStorageName)).toBeNull();
    expect(storage.getItem('orbis-reset-accepted')).toBeNull();
    expect(clearCompletedResetContinuity(idle, resetId, storage, 3000)).toBe(false);
  }
});
test('unknown, held, unsupported and unavailable authority cannot clear browser continuity', () => {
  for (const authority of [
    { state: 'checking' as const, supported: true },
    { state: 'recovery' as const, supported: true },
    { state: 'restoring' as const, supported: true },
    { state: 'updating' as const, supported: true },
    { state: 'idle' as const, supported: false },
    { state: 'idle' as const, supported: true, unavailable: true },
  ]) {
    const { storage, prior } = resetStorage();
    expect(clearCompletedResetContinuity(authority, resetId, storage, 3000)).toBe(false);
    expect(storage.getItem(operationContinuityStorageName)).toBe(prior);
    expect(storage.getItem('orbis-reset-accepted')).toBe('1');
  }
});
test('a different reset receipt or a changed/newer browser operation is never cleared as the previous operation', () => {
  const { storage, prior } = resetStorage();
  expect(clearCompletedResetContinuity(idle, oldId, storage, 3000)).toBe(false);
  expect(storage.getItem(operationContinuityStorageName)).toBe(prior);
  const newer = JSON.stringify({ version: 1, jobId: resetId, operation: 'restore', phase: 'running', savedAt: 2500 });
  storage.setItem(operationContinuityStorageName, newer);
  expect(clearCompletedResetContinuity(idle, resetId, storage, 3000)).toBe(true);
  expect(storage.getItem(operationContinuityStorageName)).toBe(newer);
});
