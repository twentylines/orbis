import { afterEach, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { defaultTimeMachinePreferences } from '@runtipi/common/schemas/time-machine';
import {
  boundedBody,
  readHistoricalWallpaper,
  readOnboardingCapture,
  readTimeMachinePoints,
  reviewTimeMachinePoint,
  startOnboardingCapture,
  captureTimeMachine,
} from './time-machine-api';
import { saveTimeMachineEnabled } from './time-machine-preferences-query';
import { timeMachineRetentionSummary, timeMachineSettingsMode } from './time-machine-settings-state';
import { hasSeenTimeMachineNotice, markTimeMachineNoticeSeen, timeMachineNoticeKey } from './time-machine-notice';
import { historicalPoint, readyReview } from './time-machine.test-data';
import { readSetupCapture, reconcileSetupCapture, reserveSetupCapture } from '@/components/welcome/setup-capture';
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('manual capture uses the Orbis-only endpoint without default app data or password proof and preserves optional policy proof', async () => {
  const point = historicalPoint();
  const fetcher = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(point));
  globalThis.fetch = fetcher as unknown as typeof fetch;
  const signal = new AbortController().signal;
  await captureTimeMachine('Before updating Orbis', {}, signal);
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/system-backups/time-machine/core-captures');
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ label: 'Before updating Orbis' });
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  await captureTimeMachine('Protected capture', { password: 'unit-test-proof', totpCode: '123456' }, signal);
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
    label: 'Protected capture',
    password: 'unit-test-proof',
    totpCode: '123456',
  });
});

test('the actual preview conflict envelope surfaces the safe host-support requirement without trusting arbitrary server messages', async () => {
  const message = 'Update and verify the Orbis host service with controller configuration capture support before creating this restore point.';
  globalThis.fetch = mock(async () =>
    Response.json({ statusCode: 409, message, path: '/api/system-backups/time-machine/captures' }, { status: 409 }),
  ) as unknown as typeof fetch;
  await expect(captureTimeMachine('', {}, new AbortController().signal)).rejects.toMatchObject({
    status: 409,
    code: 'host-capture-support-required',
    message,
  });
  globalThis.fetch = mock(async () =>
    Response.json({ statusCode: 409, message: 'private server internals should not be displayed' }, { status: 409 }),
  ) as unknown as typeof fetch;
  await expect(captureTimeMachine('', {}, new AbortController().signal)).rejects.toThrow('could not safely continue');
});

test('bounded transport cancels oversized streamed bodies before accepting private metadata or assets', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(8));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(boundedBody(new Response(stream), 10)).rejects.toThrow('exceeded');
  expect(cancelled).toBe(true);
  await expect(boundedBody(new Response('x', { headers: { 'Content-Length': '999' } }), 10)).rejects.toThrow('exceeded');
});
test('enabling Time Machine persists the saved fields with the current revision', async () => {
  const current = defaultTimeMachinePreferences();
  const updated = { ...current, revision: current.revision + 1, enabled: true };
  const fetcher = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(updated));
  globalThis.fetch = fetcher as unknown as typeof fetch;

  const result = await saveTimeMachineEnabled(current, true, new AbortController().signal);

  const [, init] = fetcher.mock.calls[0] ?? [];
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  expect(result).toEqual(updated);
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/system-backups/time-machine/preferences');
  expect(init?.method).toBe('PUT');
  expect(body.expectedRevision).toBe(current.revision);
  expect(body.enabled).toBe(true);
  expect(body.schedule).toEqual(current.schedule);
  expect(body.excludedApps).toEqual(current.excludedApps);
  expect(body).not.toHaveProperty('revision');
  expect(body).not.toHaveProperty('version');
});
test('Time Machine settings presentation follows only the saved preference snapshot', () => {
  expect(timeMachineSettingsMode(null)).toBe('loading');
  expect(timeMachineSettingsMode({ enabled: false })).toBe('setup');
  expect(timeMachineSettingsMode({ enabled: true })).toBe('active');
});
test('retained summary reports captured archive data without presenting a capacity limit as free disk space', () => {
  expect(timeMachineRetentionSummary(0, 0, (value) => `${value} B`)).toBe('No captured points yet. Nothing is retained.');
  expect(timeMachineRetentionSummary(1, 2048, (value) => `${value} B`)).toBe('1 captured point · 2048 B retained.');
  expect(timeMachineRetentionSummary(3, 4096, (value) => `${value} B`)).toBe('3 captured points · 4096 B retained.');
});
test('the Experimental notice dismissal is scoped to both the account and server origin', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  const userId = `notice-test-${Date.now()}`;
  expect(hasSeenTimeMachineNotice(userId, 'https://server-a.example', storage)).toBe(false);
  markTimeMachineNoticeSeen(userId, 'https://server-a.example', storage);
  expect(values.get(timeMachineNoticeKey(userId, 'https://server-a.example'))).toBe('seen');
  expect(hasSeenTimeMachineNotice(userId, 'https://server-a.example', storage)).toBe(true);
  expect(hasSeenTimeMachineNotice(userId, 'https://server-b.example', storage)).toBe(false);
  expect(hasSeenTimeMachineNotice(`${userId}-other`, 'https://server-a.example', storage)).toBe(false);
});
test('historical assets use only point-bound identity URLs and enforce MIME, length and available content digest', async () => {
  const point = historicalPoint();
  if (!point.metadata?.preview.available) throw new Error('Fixture preview missing');
  const bytes = new Uint8Array([1, 2, 3]);
  const identity = createHash('sha256').update(bytes).digest('hex');
  point.metadata.preview.wallpaperAsset = {
    available: true,
    identity,
    cipherSha256: 'd'.repeat(64),
    bytes: 3,
    mime: 'image/png',
    width: 1,
    height: 1,
    source: 'captured-builtin',
  };
  const fetcher = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(bytes, { headers: { 'Content-Type': 'image/png' } }));
  globalThis.fetch = fetcher as unknown as typeof fetch;
  const blob = await readHistoricalWallpaper(point, new AbortController().signal);
  expect(blob.size).toBe(3);
  expect(fetcher.mock.calls[0]?.[0]).toBe(`/api/system-backups/time-machine/points/${point.id}/assets/${identity}`);
  expect(fetcher.mock.calls[0]?.[1]?.credentials).toBe('same-origin');
  expect(fetcher.mock.calls[0]?.[1]?.cache).toBe('no-store');
  globalThis.fetch = mock(async () => new Response(bytes, { headers: { 'Content-Type': 'text/html' } })) as unknown as typeof fetch;
  await expect(readHistoricalWallpaper(point, new AbortController().signal)).rejects.toThrow('type changed');
});
test('server review responses must bind the selected sealed point and exact archive digests', async () => {
  const review = readyReview();
  globalThis.fetch = mock(async () => Response.json({ version: 1, review })) as unknown as typeof fetch;
  expect((await reviewTimeMachinePoint(historicalPoint(), new AbortController().signal))?.reviewId).toBe(review.reviewId);
  globalThis.fetch = mock(async () => Response.json({ version: 1, review: { ...review, archiveSha256: 'e'.repeat(64) } })) as unknown as typeof fetch;
  await expect(reviewTimeMachinePoint(historicalPoint(), new AbortController().signal)).rejects.toThrow('point changed');
});

test('capture export lists use the bounded authenticated Time Machine endpoint and validate saved points', async () => {
  const list = { version: 1 as const, available: true, activeCaptureId: null, points: [historicalPoint()] };
  const fetcher = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(list));
  globalThis.fetch = fetcher as unknown as typeof fetch;
  expect(await readTimeMachinePoints(new AbortController().signal)).toEqual(list);
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/system-backups/time-machine/points');
  expect(fetcher.mock.calls[0]?.[1]?.credentials).toBe('same-origin');
  expect(fetcher.mock.calls[0]?.[1]?.cache).toBe('no-store');
  expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('error');
  globalThis.fetch = mock(async () => Response.json({ ...list, points: [{ ...historicalPoint(), metadata: null }] })) as unknown as typeof fetch;
  await expect(readTimeMachinePoints(new AbortController().signal)).rejects.toThrow('unsupported Time Machine response');
});

test('onboarding capture uses its session-only POST and reconciles the same authenticated owner-bound UUID by GET', async () => {
  const point = historicalPoint();
  const fetcher = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(point));
  globalThis.fetch = fetcher as unknown as typeof fetch;
  const signal = new AbortController().signal;
  await startOnboardingCapture(point.id, signal);
  await readOnboardingCapture(point.id, signal);
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/system-backups/time-machine/onboarding-captures');
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
    attemptId: point.id,
    label: 'After setup',
  });
  expect(fetcher.mock.calls[1]?.[0]).toBe(`/api/system-backups/time-machine/onboarding-captures/${point.id}`);
  expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  expect(fetcher.mock.calls[1]?.[1]?.body).toBeUndefined();
  await expect(startOnboardingCapture('invalid-id', signal)).rejects.toThrow('receipt');
  expect(fetcher.mock.calls).toHaveLength(2);
});

test('onboarding responses cannot accept another attempt and owner/machine lookup conflicts stay explicit', async () => {
  const point = historicalPoint();
  globalThis.fetch = mock(async () => Response.json(point)) as unknown as typeof fetch;
  await expect(readOnboardingCapture('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', new AbortController().signal)).rejects.toThrow(
    'different setup capture',
  );
  globalThis.fetch = mock(async () =>
    Response.json({ code: 'point-not-found', message: 'Not available' }, { status: 409 }),
  ) as unknown as typeof fetch;
  await expect(readOnboardingCapture(point.id, new AbortController().signal)).rejects.toMatchObject({ status: 409, code: 'point-not-found' });
});

test.each([false, true])('onboarding starts the same missing attempt through the real HTTP error envelope (code retained: %s)', async (withCode) => {
  const point = historicalPoint();
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
  const receipt = reserveSetupCapture(1, storage, () => point.id);
  const fetcher = mock(async (_input: RequestInfo | URL, init?: RequestInit) =>
    init?.method === 'POST'
      ? Response.json(point)
      : Response.json(
          {
            statusCode: 409,
            message: 'This restore point is not available.',
            path: `/api/system-backups/time-machine/onboarding-captures/${point.id}`,
            ...(withCode ? { code: 'point-not-found' } : {}),
          },
          { status: 409 },
        ),
  );
  globalThis.fetch = fetcher as unknown as typeof fetch;
  await expect(reconcileSetupCapture(1, receipt, true, new AbortController().signal, storage)).resolves.toMatchObject({ id: point.id });
  expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'POST']);
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ label: 'After setup', attemptId: receipt.attemptId });
  expect(readSetupCapture(1, storage)?.phase).toBe('accepted');
});

test('unknown structured issue codes are not reclassified from their message', async () => {
  globalThis.fetch = mock(async () =>
    Response.json({ statusCode: 409, code: 'unknown-conflict', message: 'This restore point is not available.' }, { status: 409 }),
  ) as unknown as typeof fetch;
  await expect(readOnboardingCapture(historicalPoint().id, new AbortController().signal)).rejects.toMatchObject({ code: undefined, status: 409 });
});
