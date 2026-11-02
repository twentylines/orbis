import { expect, test } from 'bun:test';
import { resetPayload, submitReset } from './reset-api';
const proof = { method: 'password' as const, password: 'test-only' };
test('requires an explicit account choice and exact final confirmation', () => {
  expect(() => resetPayload('keep', 'reset orbis', proof)).toThrow();
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
