import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { applyControllerHandoff, ControllerHandoffError, parseControllerHandoff, reviewControllerHandoff } from './controller-handoff';

const portal = 'https://independent.example:8443/sentinel/recovery/';
const now = 1800000000000;
const plan = {
  planId: '11111111-2222-4333-8444-555555555555',
  state: 'planned',
  phase: 'planned',
  portalUrl: portal,
  expiresAtMs: now + 300000,
} as const;
const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
  mock.restore();
});
const respond = (body: unknown, status = 200) => {
  const fetch = mock(async () => Response.json(body, { status }));
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
  return fetch;
};

test('review and apply use fixed same-origin paths and only the exact reviewed ID', async () => {
  const fetch = respond(plan);
  const signal = new AbortController().signal;
  const reviewed = await reviewControllerHandoff(portal, signal, now);
  expect(fetch).toHaveBeenCalledWith(
    '/api/system/sentinel/controller-handoff/plan',
    expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  respond({ ...plan, state: 'accepted', phase: 'accepted' });
  expect(await applyControllerHandoff(reviewed, signal)).toMatchObject({ planId: plan.planId, state: 'accepted' });
  expect(globalThis.fetch).toHaveBeenCalledWith(
    '/api/system/sentinel/controller-handoff/apply',
    expect.objectContaining({ body: JSON.stringify({ planId: plan.planId }) }),
  );
});

test('malformed IDs never become outgoing URLs or request bodies', async () => {
  const fetch = respond(plan);
  await expect(applyControllerHandoff({ ...plan, planId: '../other' }, new AbortController().signal)).rejects.toBeInstanceOf(ControllerHandoffError);
  expect(fetch).not.toHaveBeenCalled();
});

test('the response cannot switch portal, operation identity or authority fields', () => {
  for (const change of [
    { portalUrl: 'https://other.example/sentinel/recovery/' },
    { planId: `${plan.planId}/status` },
    { command: 'restart' },
    { phase: 'unknown' },
    { state: 'healthy' },
    { expiresAtMs: true },
  ]) {
    expect(() => parseControllerHandoff({ ...plan, ...change }, portal)).toThrow();
  }
  expect(() => parseControllerHandoff({ ...plan, planId: '21111111-2222-4333-8444-555555555555' }, portal, plan.planId)).toThrow();
});

test('insecure, credential-bearing or malformed portal URLs are refused', () => {
  for (const url of [
    'http://independent.example/sentinel/recovery/',
    'https://user:password@independent.example/sentinel/recovery/',
    `${portal}?command=start`,
    `${portal}#different`,
    `${portal}\n`,
    'https://independent.example/other/',
  ]) {
    expect(() => parseControllerHandoff({ ...plan, portalUrl: url }, url)).toThrow();
  }
});

test('review requires a current planned state within the host review lifetime', async () => {
  for (const body of [
    { ...plan, expiresAtMs: now },
    { ...plan, expiresAtMs: now + 300001 },
    { ...plan, state: 'attention' },
    { ...plan, state: 'accepted', phase: 'accepted' },
  ]) {
    respond(body);
    await expect(reviewControllerHandoff(portal, new AbortController().signal, now)).rejects.toBeInstanceOf(ControllerHandoffError);
  }
});

test('expiry is assessed after the asynchronous response, rather than before waiting', async () => {
  const clock = mock(() => now + 10);
  spyOn(Date, 'now').mockImplementation(clock);
  respond({ ...plan, expiresAtMs: now + 1 });
  await expect(reviewControllerHandoff(portal, new AbortController().signal)).rejects.toBeInstanceOf(ControllerHandoffError);
  expect(clock).toHaveBeenCalled();
});

test('authorization errors expose sign-in guidance and suppress server diagnostics', async () => {
  respond({ error: '/private/diagnostic' }, 401);
  await expect(reviewControllerHandoff(portal, new AbortController().signal, now)).rejects.toThrow('Sign in again');
});

test('a lost apply reply is never retried automatically', async () => {
  const fetch = mock(async () => {
    throw new TypeError('reply lost');
  });
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
  await expect(applyControllerHandoff(plan, new AbortController().signal)).rejects.toThrow('reply lost');
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('oversized bodies are cancelled before JSON is accepted', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(4097));
    },
    cancel() {
      cancelled = true;
    },
  });
  globalThis.fetch = mock(async () => new Response(body)) as unknown as typeof globalThis.fetch;
  await expect(reviewControllerHandoff(portal, new AbortController().signal, now)).rejects.toBeInstanceOf(ControllerHandoffError);
  expect(cancelled).toBe(true);
});

test('an aborted caller signal reaches the request and cannot yield a new review', async () => {
  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = mock(async (_input: RequestInfo | URL, options?: RequestInit) => {
    expect(options?.signal?.aborted).toBe(true);
    throw new DOMException('aborted', 'AbortError');
  }) as unknown as typeof globalThis.fetch;
  await expect(reviewControllerHandoff(portal, controller.signal, now)).rejects.toThrow('aborted');
});
