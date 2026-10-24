/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { advanceCoreUpdate, claimCoreRefresh, coreWatchIsActive, coreUpdateTitle, type CoreUpdateStatus } from './core-update-state';
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
  test.each(['failed', 'interrupted', 'rolled-back'])('terminal %s stops observation without refreshing', (state) => {
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
      expect(watch?.message).toBe('Orbis is restarting. Reconnecting automatically.');
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
