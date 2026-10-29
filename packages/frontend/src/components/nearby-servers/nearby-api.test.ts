/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { nearbyInterfaces, nearbyOrigin, parseNearby, scanNearby } from './nearby-api';

test('nearby hints cannot assert trust or provide non-HTTPS credential-bearing origins', () => {
  const candidate = {
    id: 'a'.repeat(32),
    origin: 'https://192.168.50.20',
    address: '192.168.50.20',
    port: 443,
    expiresAt: '2026-01-01T00:00:10Z',
    verified: false,
  };
  expect(parseNearby({ available: true, candidates: [candidate] }, 'scan')).toMatchObject({ available: true, candidates: [{ verified: false }] });
  expect(() => parseNearby({ available: true, candidates: [{ ...candidate, verified: true }] }, 'scan')).toThrow();
  expect(() => parseNearby({ available: true, candidates: Array(17).fill(candidate) }, 'scan')).toThrow();
  for (const value of ['http://192.168.50.20', 'https://u:p@source.example', 'https://source.example/path', 'https://source.example?token=x'])
    expect(() => nearbyOrigin(value)).toThrow();
  expect(parseNearby({ available: false, reason: 'private diagnostics' }, 'interfaces')).toEqual({ available: false });
});

test('requests only go to the local discovery API and searching is an explicit POST', async () => {
  const original = globalThis.fetch;
  const calls: { input: unknown; method: string | undefined }[] = [];
  globalThis.fetch = (async (input, options) => {
    calls.push({ input, method: options?.method });
    return Response.json({ available: false });
  }) as typeof fetch;
  try {
    expect(calls).toHaveLength(0);
    await nearbyInterfaces();
    await scanNearby('eth0');
    expect(calls).toEqual([
      { input: '/api/nearby-discovery/interfaces', method: 'GET' },
      { input: '/api/nearby-discovery/scan', method: 'POST' },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});
