import { expect, test } from 'bun:test';
import {
  parseOperationStatus,
  readOperationStatus,
  operationSnapshotAfter,
  operationAllowsDeparture,
  operationIsWaiting,
  operationUsesSpace,
  operationShowsContent,
  type OperationStatusTransport,
} from './operation-status';

test('public restore status accepts only generic sanitized state and measured progress', () => {
  for (const state of ['idle', 'restoring', 'updating', 'downgrading', 'recovery', 'checking'] as const)
    expect(parseOperationStatus({ state }).state).toBe(state);
  expect(parseOperationStatus({ state: 'restoring', stage: 'preparing', progress: 99 }).progress).toBe(99);
  for (const value of [
    { state: 'complete' },
    { state: 'restoring', stage: 'private-path' },
    { state: 'restoring', progress: 100 },
    { state: 'restoring', progress: -1 },
    { state: 'restoring', progress: Number.NaN },
    { state: 'idle', jobId: 'private' },
  ])
    expect(() => parseOperationStatus(value)).toThrow();
});
test('fresh unsupported hosts can start normally, but 404 never unlocks an observed server lock', () => {
  const unsupported = { state: 'idle' as const, supported: false };
  expect(operationSnapshotAfter(false, unsupported)).toEqual(unsupported);
  expect(operationSnapshotAfter(true, unsupported)).toEqual({ state: 'checking', supported: true, unavailable: true });
  expect(operationSnapshotAfter(true, { state: 'idle', supported: true })).toEqual({ state: 'idle', supported: true });
});
test('the status reader uses the public no-store same-origin endpoint and rejects unavailable/malformed status', async () => {
  let called = false;
  const transport = (async (url: string | URL | Request, options?: RequestInit) => {
    expect(url).toBe('/api/system/operation-status');
    expect(options?.credentials).toBe('same-origin');
    expect(options?.cache).toBe('no-store');
    expect(options?.redirect).toBe('error');
    called = true;
    return Response.json({ state: 'restoring', stage: 'restoring' });
  }) as OperationStatusTransport;
  expect(await readOperationStatus(undefined, transport)).toEqual({ state: 'restoring', stage: 'restoring', supported: true });
  expect(called).toBe(true);
  for (const response of [
    new Response('', { status: 401 }),
    new Response('', { status: 403 }),
    new Response('', { status: 503 }),
    Response.json({ state: 'idle', details: 'private' }),
    new Response('x'.repeat(2049)),
  ]) {
    await expect(readOperationStatus(undefined, (async () => response) as OperationStatusTransport)).rejects.toThrow();
  }
  expect(await readOperationStatus(undefined, (async () => new Response('', { status: 404 })) as OperationStatusTransport)).toEqual({
    state: 'idle',
    supported: false,
  });
});

test('waiting never exposes sign in and a confirmed idle response resumes content automatically', () => {
  const waiting = { state: 'checking' as const, supported: true, unavailable: true };
  expect(operationIsWaiting(waiting)).toBe(true);
  expect(operationShowsContent(null, true, false, false)).toBe(false);
  expect(operationShowsContent(waiting, true, false, false)).toBe(false);
  for (const state of ['restoring', 'updating', 'downgrading'] as const)
    expect(operationShowsContent({ state, supported: true }, true, false, false)).toBe(false);
  expect(operationShowsContent({ state: 'idle', supported: true }, true, false, false)).toBe(true);
  expect(operationShowsContent({ state: 'idle', supported: true }, false, false, false)).toBe(true);
  expect(operationShowsContent({ state: 'idle', supported: true, unavailable: true }, false, false, false)).toBe(false);
});

test('only supported authoritative idle permits a terminal departure, never checking, outage or an unsupported response', () => {
  expect(operationAllowsDeparture({ state: 'idle', supported: true })).toBe(true);
  for (const state of ['restoring', 'updating', 'downgrading', 'recovery', 'checking'] as const)
    expect(operationAllowsDeparture({ state, supported: true })).toBe(false);
  expect(operationAllowsDeparture({ state: 'idle', supported: false })).toBe(false);
  expect(operationAllowsDeparture({ state: 'idle', supported: true, unavailable: true })).toBe(false);
});
test('reset is a server lock and accepts only its generic stage', () => {
  expect(parseOperationStatus({ state: 'resetting', stage: 'resetting' })).toEqual({ state: 'resetting', stage: 'resetting' });
  expect(operationAllowsDeparture({ state: 'resetting', supported: true })).toBe(false);
  expect(() => parseOperationStatus({ state: 'resetting', accounts: 'remove', users: [7] })).toThrow();
});

test('ordinary startup uses wallpaper while confirmed waits and maintenance use space', () => {
  expect(operationUsesSpace(null, false)).toBe(false);
  expect(operationUsesSpace({ state: 'idle', supported: true }, false)).toBe(false);
  expect(operationUsesSpace({ state: 'idle', supported: false }, false)).toBe(false);
  expect(operationUsesSpace({ state: 'checking', supported: true }, false)).toBe(true);
  expect(operationUsesSpace({ state: 'checking', supported: true, unavailable: true }, false)).toBe(true);
  expect(operationUsesSpace({ state: 'idle', supported: true, unavailable: true }, false)).toBe(true);
  expect(operationUsesSpace({ state: 'checking', supported: true, unavailable: true }, true)).toBe(true);
  expect(operationUsesSpace(null, true)).toBe(true);
  for (const state of ['restoring', 'updating', 'downgrading', 'resetting', 'recovery'] as const)
    expect(operationUsesSpace({ state, supported: true }, false)).toBe(true);
});
