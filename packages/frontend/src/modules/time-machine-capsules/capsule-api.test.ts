import { expect, test } from 'bun:test';
import { capsuleJobSchema } from '@runtipi/common/schemas/time-machine-capsule';
import { capsuleEndpoint, capsuleRequest, uploadCapsule } from './capsule-api';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
test('capsule routes are fixed same-origin paths with exact UUID positions', () => {
  expect(capsuleEndpoint(`/points/${id}/export`)).toBe(`/api/system-backups/capsules/points/${id}/export`);
  expect(capsuleEndpoint(`/imports/${id}/review`)).toBe(`/api/system-backups/capsules/imports/${id}/review`);
  expect(capsuleEndpoint(`/${id}/remove`)).toBe(`/api/system-backups/capsules/${id}/remove`);
  for (const value of [
    `/imports/${id}/../file`,
    `//host.test/${id}`,
    `https://host.test/${id}`,
    `/points/${id}/export?url=elsewhere`,
    `/imports/${id}/activate`,
  ])
    expect(() => capsuleEndpoint(value)).toThrow();
});
test('capsule jobs never advertise restore support or allow a point secret', () => {
  const job = {
    id,
    capsuleId: id,
    kind: 'export',
    status: 'ready',
    createdAt: 1,
    completedBytes: 100,
    totalBytes: 100,
    bytes: 100,
    sha256: 'a'.repeat(64),
    restoreSupported: false,
  };
  expect(capsuleJobSchema.allows(job)).toBe(true);
  expect(capsuleJobSchema.allows({ ...job, pointKey: 'secret' })).toBe(false);
  expect(capsuleJobSchema.allows({ ...job, restoreSupported: true })).toBe(false);
});
test('requests reject oversized JSON and use authenticated no-store JSON without redirects', async () => {
  const original = globalThis.fetch;
  let options: RequestInit | undefined;
  try {
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      options = init;
      return new Response('x'.repeat(65537));
    }) as unknown as typeof fetch;
    await expect(capsuleRequest('/imports', 'POST', { password: 'fixture-only' }, new AbortController().signal)).rejects.toThrow();
    expect(options?.credentials).toBe('same-origin');
    expect(options?.cache).toBe('no-store');
    expect(options?.redirect).toBe('error');
  } finally {
    globalThis.fetch = original;
  }
});
test('invalid uploads are refused before a network request', async () => {
  await expect(uploadCapsule('invalid', new File(['example'], 'bad.orbis-tm'), new AbortController().signal)).rejects.toThrow();
});
