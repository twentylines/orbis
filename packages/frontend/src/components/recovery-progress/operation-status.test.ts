import { expect, test } from 'bun:test';
import {
  confirmResetSnapshot,
  markResetAccepted,
  hasAcceptedReset,
  clearAcceptedReset,
  resetSceneVisible,
  rollbackCanContinue,
  parseOperationStatus,
  readOperationStatus,
  operationSnapshotAfter,
  operationAllowsDeparture,
  operationIsWaiting,
  operationUsesSpace,
  operationShowsContent,
  operationBootIsReady,
  type OperationStatusTransport,
} from './operation-status';

test('a reloaded operation releases its boot after a fresh matching success and idle authority', () => {
  const marker = { phase: 'booting', jobId: 'accepted', operation: 'update' };
  const job = { id: 'accepted', operation: 'update', status: 'succeeded', needsRecovery: false };
  const authority = { state: 'idle' as const, supported: true };
  expect(operationBootIsReady(marker, job, authority)).toBe(true);
  expect(operationShowsContent(authority, false, !operationBootIsReady(marker, job, authority), false)).toBe(true);
  for (const altered of [
    { ...job, id: 'historical' },
    { ...job, operation: 'restore' },
    { ...job, status: 'running' },
    { ...job, needsRecovery: true },
  ])
    expect(operationBootIsReady(marker, altered, authority)).toBe(false);
  for (const altered of [
    { ...authority, supported: false },
    { ...authority, unavailable: true },
    { ...authority, state: 'checking' as const },
  ])
    expect(operationBootIsReady(marker, job, altered)).toBe(false);
  expect(operationBootIsReady({ ...marker, phase: 'running' }, job, authority)).toBe(false);
  expect(operationBootIsReady(null, job, authority)).toBe(false);
});

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

test('accepted reset marker survives a gate remount and clears only when asked', () => {
  const values = new Map<string, string>();
  const storage = {
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  expect(hasAcceptedReset(storage)).toBe(false);
  markResetAccepted(storage);
  expect(hasAcceptedReset(storage)).toBe(true);
  expect(operationAllowsDeparture({ state: 'checking', supported: true, unavailable: true })).toBe(false);
  expect(hasAcceptedReset(storage)).toBe(true);
  clearAcceptedReset(storage);
  expect(hasAcceptedReset(storage)).toBe(false);
  const unavailable = {
    setItem: () => {
      throw Error();
    },
    getItem: () => {
      throw Error();
    },
    removeItem: () => {
      throw Error();
    },
  };
  expect(() => markResetAccepted(unavailable)).not.toThrow();
  expect(hasAcceptedReset(unavailable)).toBe(false);
  expect(() => clearAcceptedReset(unavailable)).not.toThrow();
});

test('an accepted reset keeps its scene through startup, active reset and reconnect without claiming idle completion', () => {
  expect(resetSceneVisible(null, true)).toBe(true);
  expect(resetSceneVisible({ state: 'resetting', supported: true }, true)).toBe(true);
  expect(resetSceneVisible({ state: 'checking', supported: true, unavailable: true }, true)).toBe(true);
  expect(resetSceneVisible({ state: 'idle', supported: true }, true)).toBe(false);
  expect(resetSceneVisible(null, false)).toBe(false);
  expect(resetSceneVisible({ state: 'checking', supported: true }, false)).toBe(false);
});

test('a cached idle cannot complete an accepted reset without a fresh supported idle', async () => {
  const shared = { state: 'idle' as const, supported: true };
  for (const fresh of [
    { state: 'resetting' as const, supported: true },
    { state: 'checking' as const, supported: true, unavailable: true },
    { state: 'idle' as const, supported: false },
  ]) {
    const result = await confirmResetSnapshot(shared, true, async () => fresh);
    expect(operationAllowsDeparture(result)).toBe(false);
    expect(resetSceneVisible(result, true)).toBe(true);
  }
  const failed = await confirmResetSnapshot(shared, true, async () => {
    throw Error('offline');
  });
  expect(operationAllowsDeparture(failed)).toBe(false);
  expect(resetSceneVisible(failed, true)).toBe(true);
  expect(await confirmResetSnapshot(shared, true, async () => shared)).toEqual(shared);
  let called = false;
  expect(
    await confirmResetSnapshot(shared, false, async () => {
      called = true;
      return shared;
    }),
  ).toEqual(shared);
  expect(called).toBe(false);
});

test('rollback Continue requires the matching failed restore and fresh supported idle', () => {
  const job = { id: 'job', status: 'rolled-back', needsRecovery: false };
  const idle = { state: 'idle' as const, supported: true };
  expect(rollbackCanContinue(job, 'job', idle)).toBe(true);
  expect(rollbackCanContinue(job, 'other', idle)).toBe(false);
  expect(rollbackCanContinue({ ...job, needsRecovery: true }, 'job', idle)).toBe(false);
  expect(rollbackCanContinue({ ...job, status: 'succeeded' }, 'job', idle)).toBe(false);
  expect(rollbackCanContinue(job, 'job', { state: 'checking', supported: true, unavailable: true })).toBe(false);
  expect(rollbackCanContinue(job, 'job', { state: 'idle', supported: false })).toBe(false);
});

test('returned core boot requires matching identity and supported idle, while recovery and restore returns stay locked', () => {
  const authority = { state: 'idle' as const, supported: true };
  for (const operation of ['update', 'downgrade']) {
    const marker = { phase: 'booting', jobId: 'accepted', operation };
    const job = { id: 'accepted', operation, status: 'returned', needsRecovery: false };
    expect(operationBootIsReady(marker, job, authority)).toBe(true);
    for (const altered of [
      { ...job, id: 'other' },
      { ...job, needsRecovery: true },
      { ...job, status: 'failed' },
      { ...job, status: 'interrupted' },
      { ...job, status: 'rolled-back' },
    ])
      expect(operationBootIsReady(marker, altered, authority)).toBe(false);
    for (const snapshot of [
      null,
      { ...authority, supported: false },
      { ...authority, unavailable: true },
      { ...authority, state: 'recovery' as const },
      { ...authority, state: 'checking' as const },
    ])
      expect(operationBootIsReady(marker, job, snapshot)).toBe(false);
  }
  expect(
    operationBootIsReady(
      { phase: 'booting', jobId: 'accepted', operation: 'restore' },
      { id: 'accepted', operation: 'restore', status: 'returned', needsRecovery: false },
      authority,
    ),
  ).toBe(false);
});
