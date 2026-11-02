import { afterEach, expect, mock, test } from 'bun:test';
import type { AuthenticationResponseJSON } from '@simplewebauthn/browser';
import {
  activateTimeMachinePoint,
  authorizeTimeMachineWithPassword,
  authorizeTimeMachineWithPasskey,
  timeMachinePasskeyOptions,
} from './time-machine-api';
import { historicalPoint, readyReview } from './time-machine.test-data';
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const currentReview = () => ({ ...readyReview(), expiresAt: Date.now() + 60000 });
const currentGrant = () => {
  const { status: _status, ready: _ready, blockers: _blockers, progress: _progress, ...binding } = currentReview();
  return { ...binding, grantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', expiresAt: Date.now() + 30000 };
};
const acceptedJob = {
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  status: 'running',
  stage: 'checking',
  phase: 'preparing',
  message: 'Preparing selected point',
  needsRecovery: false,
  progressUnavailable: false,
  canCancel: false,
  canRecover: false,
};
const signal = () => new AbortController().signal;

test('fresh password authorization posts only to the selected point and validates the exact grant binding', async () => {
  const point = historicalPoint();
  const review = currentReview();
  const grant = currentGrant();
  const transport = mock(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json(grant));
  globalThis.fetch = transport as unknown as typeof fetch;
  expect((await authorizeTimeMachineWithPassword(point, review, { password: 'synthetic-test-value', totpCode: '123456' }, signal())).grantId).toBe(
    grant.grantId,
  );
  expect(transport.mock.calls[0]?.[0]).toBe(`/api/system-backups/time-machine/points/${point.id}/restore-auth/verify`);
  const request = transport.mock.calls[0]?.[1];
  expect(JSON.parse(String(request?.body))).toEqual({
    reviewId: review.reviewId,
    method: 'password',
    password: 'synthetic-test-value',
    totpCode: '123456',
  });
  expect(request?.credentials).toBe('same-origin');
  expect(request?.cache).toBe('no-store');
  expect(request?.redirect).toBe('error');
  for (const patch of [
    { pointId: acceptedJob.id },
    { reviewId: acceptedJob.id },
    { machineId: 'e'.repeat(64) },
    { archiveSha256: 'e'.repeat(64) },
    { manifestSha256: 'e'.repeat(64) },
    { expiresAt: Date.now() - 1 },
    { expiresAt: review.expiresAt + 1 },
  ]) {
    globalThis.fetch = mock(async () => Response.json({ ...grant, ...patch })) as unknown as typeof fetch;
    await expect(authorizeTimeMachineWithPassword(point, review, { password: 'synthetic-test-value' }, signal())).rejects.toThrow('Authorization');
  }
});
test('expired or mismatched reviews cannot request authority, even with fresh credentials', async () => {
  const transport = mock(async () => Response.json(currentGrant()));
  globalThis.fetch = transport as unknown as typeof fetch;
  for (const review of [
    { ...currentReview(), expiresAt: Date.now() - 1 },
    { ...currentReview(), pointId: acceptedJob.id },
    { ...currentReview(), archiveSha256: 'e'.repeat(64) },
  ])
    await expect(authorizeTimeMachineWithPassword(historicalPoint(), review, { password: 'synthetic-test-value' }, signal())).rejects.toThrow(
      'Verify this exact point',
    );
  expect(transport).not.toHaveBeenCalled();
});
test('activation has only the common four fields, returns real accepted job and cannot reuse authority after dispatch', async () => {
  const point = historicalPoint();
  const review = currentReview();
  const grant = currentGrant();
  const transport = mock(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ job: acceptedJob }));
  globalThis.fetch = transport as unknown as typeof fetch;
  expect((await activateTimeMachinePoint(point, review, grant, signal())).id).toBe(acceptedJob.id);
  expect(transport.mock.calls[0]?.[0]).toBe(`/api/system-backups/time-machine/points/${point.id}/activate`);
  expect(JSON.parse(String(transport.mock.calls[0]?.[1]?.body))).toEqual({
    reviewId: review.reviewId,
    grantId: grant.grantId,
    manifestSha256: review.manifestSha256,
    confirmation: 'replace-server',
  });
  await expect(activateTimeMachinePoint(point, review, grant, signal())).rejects.toThrow('already used');
  expect(transport).toHaveBeenCalledTimes(1);
  const uncertainGrant = currentGrant();
  globalThis.fetch = mock(async () => {
    throw new TypeError('network unavailable');
  }) as unknown as typeof fetch;
  await expect(activateTimeMachinePoint(point, review, uncertainGrant, signal())).rejects.toThrow();
  await expect(activateTimeMachinePoint(point, review, uncertainGrant, signal())).rejects.toThrow('already used');
});
test('a legacy receipt or empty job never becomes accepted restore progress', async () => {
  for (const response of [{ restoreId: acceptedJob.id }, { job: null }, { job: { ...acceptedJob, id: 'invalid' } }]) {
    globalThis.fetch = mock(async () => Response.json(response)) as unknown as typeof fetch;
    await expect(activateTimeMachinePoint(historicalPoint(), currentReview(), currentGrant(), signal())).rejects.toThrow();
  }
});
test('passkey challenge stays review-bound and sends the browser response plus required TOTP without credentials in activation', async () => {
  const point = historicalPoint();
  const review = currentReview();
  const options = {
    version: 1 as const,
    method: 'passkey' as const,
    reviewId: review.reviewId,
    challengeId: acceptedJob.id,
    expiresAt: Date.now() + 20000,
    requiresTotp: true,
    options: {
      challenge: 'AQ',
      rpId: 'orbis.example',
      timeout: 30000,
      userVerification: 'required' as const,
      allowCredentials: [{ type: 'public-key' as const, id: 'AQ' }],
    },
  };
  globalThis.fetch = mock(async () => Response.json(options)) as unknown as typeof fetch;
  expect((await timeMachinePasskeyOptions(point, review, signal())).challengeId).toBe(options.challengeId);
  const response: AuthenticationResponseJSON = {
    id: 'AQ',
    rawId: 'AQ',
    type: 'public-key',
    response: { authenticatorData: 'AQ', clientDataJSON: 'AQ', signature: 'AQ' },
    clientExtensionResults: {},
  };
  const transport = mock(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json(currentGrant()));
  globalThis.fetch = transport as unknown as typeof fetch;
  await expect(authorizeTimeMachineWithPasskey(point, review, options, response, undefined, signal())).rejects.toThrow('authentication code');
  expect(transport).not.toHaveBeenCalled();
  await authorizeTimeMachineWithPasskey(point, review, options, response, '123456', signal());
  expect(JSON.parse(String(transport.mock.calls[0]?.[1]?.body))).toEqual({
    reviewId: review.reviewId,
    method: 'passkey',
    challengeId: options.challengeId,
    response,
    totpCode: '123456',
  });
  await expect(authorizeTimeMachineWithPasskey(point, review, { ...options, reviewId: point.id }, response, '123456', signal())).rejects.toThrow(
    'expired',
  );
});
