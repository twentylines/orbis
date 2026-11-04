/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  advanceCoreUpdate,
  claimCoreRefresh,
  coreWatchIsActive,
  coreUpdateTitle,
  resumeCoreUpdate,
  type CoreUpdateStatus,
} from './core-update-state';
const id = 'd8b4a1ec-f912-4e14-8e20-58d2754a0130';
const other = '28a2fc8f-a725-42f2-a143-b26fce7b7ad7';
const targetTag = 'v0.1.0-beta.79';
const status = (state: string, overrides: Partial<CoreUpdateStatus> = {}): CoreUpdateStatus => ({
  available: true,
  enrolled: true,
  imageMatches: true,
  coreState: 'running',
  coreHealth: 'healthy',
  currentTag: targetTag,
  job: { id, state, targetTag },
  ...overrides,
});
const accepted = () => advanceCoreUpdate(null, { type: 'accepted', id, targetTag });

describe('reviewed downgrade lifecycle', () => {
  test('keeps the downgrade identity through restart and refreshes only the healthy target', () => {
    let watch = advanceCoreUpdate(null, { type: 'accepted', id, targetTag, operation: 'downgrade' });
    expect(coreUpdateTitle(watch?.phase ?? 'failed', watch?.operation)).toBe('Downgrading Orbis');
    watch = advanceCoreUpdate(watch, { type: 'unavailable' });
    expect(coreUpdateTitle(watch?.phase ?? 'failed', watch?.operation)).toBe('Restarting Orbis');
    expect(watch?.operation).toBe('downgrade');
    watch = advanceCoreUpdate(watch, { type: 'status', status: status('complete'), buildTag: 'v0.1.0-beta.99' });
    expect(claimCoreRefresh(watch, new Set()).refresh).toBe(false);
    watch = advanceCoreUpdate(watch, { type: 'status', status: status('complete'), buildTag: targetTag });
    expect(claimCoreRefresh(watch, new Set()).refresh).toBe(true);
  });
  test('recognises a downgrade started from another client without arming completed history', () => {
    const watch = advanceCoreUpdate(null, { type: 'status', status: status('running', { currentTag: 'v0.1.0-beta.99' }) });
    expect(watch?.operation).toBe('downgrade');
    expect(advanceCoreUpdate(null, { type: 'status', status: status('complete'), buildTag: targetTag })).toBeNull();
  });
});
describe('observing a single accepted Orbis update', () => {
  test('historical completed jobs never arm a reload', () => {
    const watch = advanceCoreUpdate(null, { type: 'status', status: status('complete'), buildTag: targetTag });
    expect(watch).toBeNull();
    expect(claimCoreRefresh(watch, new Set()).refresh).toBe(false);
  });
  test('accepted update survives downtime and refreshes only after exact healthy target build', () => {
    let watch = accepted();
    watch = advanceCoreUpdate(watch, { type: 'unavailable' });
    expect(watch?.phase).toBe('offline');
    watch = advanceCoreUpdate(watch, { type: 'status', status: status('complete'), buildTag: 'v0.1.0-beta.78' });
    expect(watch?.phase).toBe('checking');
    expect(claimCoreRefresh(watch, new Set()).refresh).toBe(false);
    watch = advanceCoreUpdate(watch, { type: 'status', status: status('complete'), buildTag: targetTag });
    const claimed = claimCoreRefresh(watch, new Set());
    expect(claimed.refresh).toBe(true);
    expect(coreWatchIsActive(claimed.watch)).toBe(false);
    expect(claimCoreRefresh(claimed.watch, new Set()).refresh).toBe(false);
  });
  test.each([{ coreState: 'exited' }, { coreHealth: 'starting' }, { imageMatches: false }, { enrolled: false }, { currentTag: 'v0.1.0-beta.78' }])(
    'never refreshes while target verification is incomplete: %p',
    (overrides) => {
      const watch = advanceCoreUpdate(accepted(), { type: 'status', status: status('complete', overrides), buildTag: targetTag });
      expect(claimCoreRefresh(watch, new Set()).refresh).toBe(false);
    },
  );
  test('a running job observed after navigation can be followed, without issuing any update command', () => {
    let watch = advanceCoreUpdate(null, { type: 'status', status: status('running') });
    expect(coreWatchIsActive(watch)).toBe(true);
    watch = advanceCoreUpdate(watch, { type: 'status', status: status('complete'), buildTag: targetTag });
    expect(claimCoreRefresh(watch, new Set()).refresh).toBe(true);
  });
  test.each(['failed', 'interrupted'])('terminal %s stops observation without refreshing', (state) => {
    const watch = advanceCoreUpdate(accepted(), { type: 'status', status: status(state), buildTag: targetTag });
    expect(watch?.phase).toBe('failed');
    expect(coreWatchIsActive(watch)).toBe(false);
    expect(claimCoreRefresh(watch, new Set()).refresh).toBe(false);
  });
  test('another job completion cannot satisfy the accepted job', () => {
    const watch = advanceCoreUpdate(accepted(), {
      type: 'status',
      status: status('complete', { job: { id: other, state: 'complete', targetTag } }),
      buildTag: targetTag,
    });
    expect(watch?.id).toBe(id);
    expect(watch?.phase).toBe('updating');
    expect(claimCoreRefresh(watch, new Set()).refresh).toBe(false);
  });
  test('session refresh guard suppresses repeat reloads after returning to the updated site', () => {
    const ready = advanceCoreUpdate(accepted(), { type: 'status', status: status('complete'), buildTag: targetTag });
    const claimed = claimCoreRefresh(ready, new Set([id]));
    expect(claimed.refresh).toBe(false);
    expect(coreWatchIsActive(claimed.watch)).toBe(false);
  });
  test('invalid ids and untrusted version text cannot arm a refresh', () => {
    expect(advanceCoreUpdate(null, { type: 'accepted', id: 'not-a-job', targetTag })).toBeNull();
    expect(advanceCoreUpdate(null, { type: 'accepted', id, targetTag: 'https://elsewhere.invalid' })).toBeNull();
  });
  test('a disconnected helper retains the accepted operation without accepting an unrelated completion', () => {
    const watch = advanceCoreUpdate(accepted(), { type: 'status', status: { available: false, job: null } });
    expect(watch?.phase).toBe('offline');
    expect(watch?.id).toBe(id);
    expect(claimCoreRefresh(watch, new Set()).refresh).toBe(false);
  });
  test('normal disconnected browsing does not become an update', () => {
    expect(advanceCoreUpdate(null, { type: 'unavailable' })).toBeNull();
  });
  test('restart states explain reconnection instead of repeating an obsolete installation message', () => {
    for (const event of [
      { type: 'unavailable' } as const,
      { type: 'status', status: status('running', { available: false, reason: 'Host service unavailable' }) } as const,
      {
        type: 'status',
        status: status('running', { coreState: 'exited', job: { id, state: 'running', targetTag, message: 'Image downloaded' } }),
      } as const,
    ]) {
      const watch = advanceCoreUpdate(accepted(), event);
      if (!watch) throw new Error('The accepted update must remain visible while restarting.');
      expect(watch?.phase).toBe('offline');
      expect(watch?.message).toBe('The page will reload automatically when Orbis is ready.');
      expect(coreUpdateTitle(watch.phase)).toBe('Restarting Orbis');
      expect(claimCoreRefresh(watch, new Set()).refresh).toBe(false);
    }
  });
});

test('the actual image-pull stage appears as a download and preserves the target identity', () => {
  const watch = advanceCoreUpdate(accepted(), {
    type: 'status',
    status: status('running', { job: { id, targetTag, state: 'running', phase: 'downloading' } }),
  });
  expect(watch?.phase).toBe('downloading');
  expect(coreUpdateTitle(watch?.phase ?? 'failed')).toBe('Downloading Orbis');
  expect(watch?.message).toContain(targetTag);
  expect(coreWatchIsActive(watch)).toBe(true);
});

test('durable restart and healthcheck phases replace installation copy without claiming completion', () => {
  for (const [phase, expected] of [
    ['restarting', 'offline'],
    ['verifying', 'checking'],
  ] as const) {
    const watch = advanceCoreUpdate(accepted(), { type: 'status', status: status('running', { job: { id, targetTag, state: 'running', phase } }) });
    expect(watch?.phase).toBe(expected);
    expect(claimCoreRefresh(watch, new Set()).refresh).toBe(false);
  }
  expect(coreUpdateTitle('checking')).toBe('Starting Orbis');
  expect(coreUpdateTitle('ready')).toBe('Starting Orbis');
  expect(
    advanceCoreUpdate(accepted(), {
      type: 'status',
      status: status('running', {
        coreHealth: 'starting',
        job: { id, targetTag, state: 'running', phase: 'verifying' },
      }),
    })?.phase,
  ).toBe('checking');
});

test('refresh restores the recorded target and stage but requires fresh readiness verification', () => {
  const marker = { jobId: id, operation: 'update', targetTag, corePhase: 'offline' as const };
  expect(resumeCoreUpdate(marker)?.phase).toBe('offline');
  const watch = resumeCoreUpdate({ ...marker, corePhase: 'ready' });
  expect(watch?.phase).toBe('checking');
  expect(claimCoreRefresh(watch, new Set()).refresh).toBe(false);
  expect(resumeCoreUpdate({ ...marker, targetTag: 'https://untrusted.invalid' })).toBeNull();
  expect(resumeCoreUpdate({ ...marker, operation: 'restore' })).toBeNull();
  const changedTarget = advanceCoreUpdate(watch, {
    type: 'status',
    status: status('complete', { job: { id, state: 'complete', targetTag: 'v0.1.0-beta.80' } }),
    buildTag: targetTag,
  });
  expect(changedTarget?.phase).toBe('checking');
  expect(claimCoreRefresh(changedTarget, new Set()).refresh).toBe(false);
  const ready = advanceCoreUpdate(watch, { type: 'status', status: status('complete'), buildTag: targetTag });
  expect(ready?.phase).toBe('ready');
  const unrelated = advanceCoreUpdate(ready, {
    type: 'status',
    status: status('complete', {
      job: { id: other, state: 'complete', targetTag },
    }),
    buildTag: targetTag,
  });
  expect(unrelated?.phase).toBe('checking');
  expect(claimCoreRefresh(unrelated, new Set()).refresh).toBe(false);
});

const restoredTag = 'v0.1.0-beta.78';
const returnedStatus = (state = 'rolled-back', phase?: string | null) =>
  status(state, { currentTag: restoredTag, job: { id, state, targetTag, phase, message: 'The requested update failed.' } });

test.each(['rolled-back', 'aborted'] as const)(
  'a verified %s returns to the current build without relabeling the requested release as installed',
  (outcome) => {
    const observed = returnedStatus(outcome === 'aborted' ? 'failed' : 'rolled-back', outcome === 'aborted' ? 'aborted' : null);
    const watch = advanceCoreUpdate(accepted(), { type: 'status', status: observed, buildTag: restoredTag });
    expect(watch?.phase).toBe('returned');
    expect(watch?.outcome).toBe(outcome);
    expect(watch?.targetTag).toBe(targetTag);
    expect(watch?.returnedTag).toBe(restoredTag);
    expect(watch?.message).toContain(outcome === 'rolled-back' ? 'was restored' : 'stopped before restart');
    expect(watch?.message).not.toContain('update is ready');
    expect(coreUpdateTitle('returned')).toBe('Starting Orbis');
    expect(observed.job?.state).toBe(outcome === 'aborted' ? 'failed' : 'rolled-back');
    expect(observed.job?.message).toBe('The requested update failed.');
    expect(claimCoreRefresh(watch, new Set()).refresh).toBe(true);
    expect(advanceCoreUpdate(null, { type: 'status', status: observed, buildTag: restoredTag })).toBeNull();
  },
);

test('rollback proof must be fresh, enrolled, healthy and bound to the exact job and requested target', () => {
  for (const overrides of [
    { available: false },
    { enrolled: false },
    { enrolled: undefined },
    { imageMatches: false },
    { coreState: 'exited' },
    { coreHealth: 'starting' },
    { currentTag: null },
    { currentTag: 'v999999999999999999999999.0.0' },
    { currentTag: 'private' },
    { job: { id: other, state: 'rolled-back', targetTag } },
    { job: { id, state: 'rolled-back', targetTag: restoredTag } },
  ]) {
    const watch = advanceCoreUpdate(accepted(), { type: 'status', status: { ...returnedStatus(), ...overrides }, buildTag: restoredTag });
    expect(watch?.phase).not.toBe('returned');
    expect(claimCoreRefresh(watch, new Set()).refresh).toBe(false);
  }
  for (const buildTag of [undefined, targetTag, 'private']) {
    const watch = advanceCoreUpdate(accepted(), { type: 'status', status: returnedStatus(), buildTag });
    expect(watch?.phase).toBe('failed');
    expect(claimCoreRefresh(watch, new Set()).refresh).toBe(false);
  }
});

test('only positively aborted failures can return; interrupted or missing stages remain recovery outcomes', () => {
  for (const [state, phase] of [
    ['failed', undefined],
    ['failed', null],
    ['failed', 'staged'],
    ['interrupted', 'aborted'],
  ] as const) {
    const watch = advanceCoreUpdate(accepted(), { type: 'status', status: returnedStatus(state, phase), buildTag: restoredTag });
    expect(watch?.phase).toBe('failed');
    expect(claimCoreRefresh(watch, new Set()).refresh).toBe(false);
  }
});

test('a provisional failed observation can return only after new matching proof, and refresh never trusts a cached returned phase', () => {
  const failed = advanceCoreUpdate(accepted(), { type: 'status', status: returnedStatus() });
  expect(failed?.phase).toBe('failed');
  const returned = advanceCoreUpdate(failed, { type: 'status', status: returnedStatus(), buildTag: restoredTag });
  expect(returned?.phase).toBe('returned');
  const resumed = resumeCoreUpdate({ jobId: id, operation: 'update', targetTag, corePhase: 'returned' });
  expect(resumed?.phase).toBe('checking');
  expect(resumed?.returnedTag).toBeUndefined();
  expect(claimCoreRefresh(resumed, new Set()).refresh).toBe(false);
  for (const observed of [
    returnedStatus('interrupted'),
    returnedStatus('failed'),
    status('complete', { job: { id: other, state: 'complete', targetTag } }),
  ]) {
    const watch = advanceCoreUpdate(returned, { type: 'status', status: observed, buildTag: restoredTag });
    expect(watch?.phase).not.toBe('returned');
    expect(claimCoreRefresh(watch, new Set()).refresh).toBe(false);
  }
});
