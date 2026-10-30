import { expect, test } from 'bun:test';
import {
  createRestoreRequest,
  approveRestoreRequest,
  startRestoreRequest,
  readRestoreRequests,
  RestoreRequestApiError,
  RestoreRequestScope,
  outgoingRestoreSchema,
  restoreRequestEndpoint,
  type IncomingRestoreRequest,
} from './receiver-request-api';
import { type } from 'arktype';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const incoming: IncomingRestoreRequest = {
  version: 1,
  id,
  nonce: id,
  sourceFingerprint: 'a'.repeat(64),
  destinationFingerprint: 'b'.repeat(64),
  status: 'awaiting-approval',
  expiresAt: Date.now() + 60000,
  totalBytes: null,
  completedBytes: 0,
};
const { nonce: _nonce, ...incomingFields } = incoming;
const outgoing = {
  ...incomingFields,
  importId: id,
  sourceOrigin: 'https://source.home.arpa',
  status: 'awaiting-source-approval' as const,
  message: 'Waiting for source approval.',
  requiresReview: true as const,
  canStart: true,
};
async function withFetch(response: Response, action: (calls: { url: string; init?: RequestInit }[]) => Promise<void>) {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return response;
  }) as typeof fetch;
  try {
    await action(calls);
  } finally {
    globalThis.fetch = original;
  }
}
test('receiver requests use local fresh credentials and no code or source-password field', async () => {
  await withFetch(Response.json(outgoing), async (calls) => {
    await createRestoreRequest(outgoing.sourceOrigin, { password: 'local-only' }, null);
    expect(calls[0]?.url).toBe('/api/system-backups/transfers/requests');
    expect(calls[0]?.init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ sourceOrigin: outgoing.sourceOrigin, confirmRequest: true, password: 'local-only' });
  });
});
test('source approval binds destination fingerprint and explicit account encryption, with fresh local MFA', async () => {
  await withFetch(Response.json(incoming), async (calls) => {
    await approveRestoreRequest(incoming, { password: 'source-only', totpCode: '123456' }, 'source-account-password', undefined);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      password: 'source-only',
      totpCode: '123456',
      destinationFingerprint: incoming.destinationFingerprint,
      encryption: 'source-account-password',
    });
  });
});
test('public certificate trust remains explicit and is never inferred from discovery', async () => {
  await expect(
    createRestoreRequest(outgoing.sourceOrigin, { password: 'local' }, { pem: 'public-only', sha256: 'a'.repeat(64), confirmed: false }),
  ).rejects.toThrow('Compare the certificate fingerprint');
  await expect(createRestoreRequest('http://192.168.1.2', { password: 'local' }, null)).rejects.toThrow();
});
test('fingerprint start contains neither archive password nor account credentials', async () => {
  await withFetch(Response.json(outgoing), async (calls) => {
    await startRestoreRequest(outgoing);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ sourceFingerprint: outgoing.sourceFingerprint, confirmReceive: true });
  });
});
test('strict payloads reject secret fields, fake completion and invalid action paths', () => {
  for (const value of [
    { ...outgoing, token: 'forbidden' },
    { ...outgoing, status: 'complete', totalBytes: 100, completedBytes: 90, encryption: 'source-account-password', canStart: false },
    { ...outgoing, status: 'receiving', canStart: true, totalBytes: 100, encryption: 'source-account-password' },
  ])
    expect(outgoingRestoreSchema(value)).toBeInstanceOf(type.errors);
  for (const path of ['/incoming/../approve', `/outgoing/${id}/approve`, `/incoming/${id}/start`, `/incoming/${id}/approve?token=secret`])
    expect(() => restoreRequestEndpoint(path)).toThrow();
});
test.each([
  ['AUTH_ERROR_INVALID_PASSWORD', 'account password'],
  ['AUTH_ERROR_TOTP_INVALID_CODE', 'authentication code'],
])('actual400 authentication key %s has safe guidance', async (key, copy) => {
  await withFetch(Response.json({ message: key, private: 'not displayed' }, { status: 400 }), async () => {
    await expect(readRestoreRequests()).rejects.toThrow(copy);
  });
});
test('unsupported old APIs and malformed or oversized responses fail boundedly', async () => {
  await withFetch(new Response('Unavailable', { status: 404 }), async () => {
    await expect(readRestoreRequests()).rejects.toBeInstanceOf(RestoreRequestApiError);
  });
  await withFetch(new Response('x'.repeat(128 * 1024 + 1)), async () => {
    await expect(readRestoreRequests()).rejects.toThrow('could not be read');
  });
  await withFetch(Response.json({ version: 1, incoming: [], outgoing: [], token: 'private' }), async () => {
    await expect(readRestoreRequests()).rejects.toThrow('could not be verified');
  });
});
test('deferred account/session/host/unmount work cannot update a replacement authority', async () => {
  for (const boundary of ['account', 'same-id-new-username', 'session', 'host', 'unmount']) {
    const scope = new RestoreRequestScope();
    const token = scope.begin();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writes = 0;
    const finish = pending.then(() => {
      if (scope.current(token)) writes++;
    });
    scope.invalidate();
    release();
    await finish;
    expect(writes).toBe(0);
    expect(scope.current(scope.begin())).toBe(true);
    expect(boundary).toBeTruthy();
  }
});
