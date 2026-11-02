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
