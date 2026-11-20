import { expect, test } from 'bun:test';
import type { TaskCentreRecord } from './task-centre-model';
import {
  activityIsHidden,
  activityVisibilityKey,
  canDismissActivity,
  clearCompletedActivity,
  dismissActivity,
  emptyActivityVisibility as empty,
  readActivityVisibility,
  undoCompletedActivity,
} from './task-centre-visibility';

const record = (patch: Partial<TaskCentreRecord> = {}): TaskCentreRecord => ({
  key: 'app:task-1',
  title: 'Update app',
  source: 'App',
  sourceKey: 'app:main',
  status: 'Completed',
  bucket: 'recent',
  outcome: 'succeeded',
  finishedAt: 100,
  time: 100,
  actions: [],
  ...patch,
});

test('dismissal is isolated by account and controller origin, with malformed data failing open', () => {
  expect(activityVisibilityKey('1', 'http://one')).not.toBe(activityVisibilityKey('2', 'http://one'));
  expect(activityVisibilityKey('1', 'http://one')).not.toBe(activityVisibilityKey('1', 'http://two'));
  for (const value of [
    '{',
    '{"version":2,"completedBefore":100,"hidden":[]}',
    '{"version":1,"completedBefore":-1,"hidden":[]}',
    '{"version":1,"completedBefore":0,"hidden":[17]}',
  ])
    expect(readActivityVisibility(value)).toEqual(empty);
});

test('active, unresolved and stale outcomes remain visible regardless of prior clear or dismissal attempts', () => {
  const cleared = clearCompletedActivity(empty, [record()], 1000).state;
  for (const outcome of ['active', 'review', 'interrupted', 'unconfirmed'] as const) {
    const changed = record({ outcome, bucket: outcome === 'active' ? 'active' : 'review' });
    expect(canDismissActivity(changed)).toBe(false);
    expect(activityIsHidden(changed, cleared)).toBe(false);
    expect(dismissActivity(empty, [changed])).toEqual(empty);
  }
  expect(activityIsHidden(record({ stale: true }), cleared)).toBe(false);
});

test('explicit dismissal can hide a terminal review notification while a changed result returns to activity', () => {
  const failed = record({ outcome: 'failed', bucket: 'review' });
  expect(canDismissActivity(failed)).toBe(true);
  const state = dismissActivity(empty, [failed]);
  expect(activityIsHidden(failed, state)).toBe(true);
  expect(activityIsHidden({ ...failed, finishedAt: 101 }, state)).toBe(false);
  expect(activityIsHidden({ ...failed, outcome: 'unconfirmed' }, state)).toBe(false);
  expect(activityIsHidden({ ...failed, dismissed: true }, empty)).toBe(true);
});

test('Clear all hides known recent records, leaving review, future discoveries and unrelated activity visible', () => {
  const all = [record(), record({ key: 'other-app', finishedAt: 200 }), record({ key: 'undated', finishedAt: undefined, time: undefined })];
  const review = record({ key: 'failed', outcome: 'failed', bucket: 'review' });
  const rejection = record({ key: 'rejected', outcome: 'cancelled', bucket: 'review' });
  const result = clearCompletedActivity(empty, [...all, review, rejection], 1000);
  for (const item of all) expect(activityIsHidden(item, result.state)).toBe(true);
  expect(activityIsHidden(review, result.state)).toBe(false);
  expect(activityIsHidden(rejection, result.state)).toBe(false);
  expect(activityIsHidden(record({ key: 'older-unseen', finishedAt: 300 }), result.state)).toBe(false);
  expect(activityIsHidden(record({ key: 'new-result', finishedAt: 1001 }), result.state)).toBe(false);
  expect(result.undo.expiresAt).toBe(11_000);
  expect(undoCompletedActivity(result.state, result.undo)).toEqual(empty);
});

test('preexisting bulk cutoff is still respected and cannot hide needs-attention records', () => {
  const state = readActivityVisibility('{"version":1,"completedBefore":100,"hidden":[]}');
  expect(activityIsHidden(record(), state)).toBe(true);
  expect(activityIsHidden(record({ bucket: 'review', outcome: 'failed' }), state)).toBe(false);
  const { undo } = clearCompletedActivity(state, [record()], 1000);
  expect(undo.added).toEqual([]);
  expect(undoCompletedActivity(state, undo)).toEqual(state);
});

test('an active task that began before clearing reappears when it completes afterward; updated revisions are not hidden', () => {
  const active = record({ outcome: 'active', bucket: 'active', startedAt: 10, finishedAt: undefined, time: 10 });
  const result = clearCompletedActivity(empty, [active], 1000);
  expect(activityIsHidden(active, result.state)).toBe(false);
  expect(activityIsHidden(record({ startedAt: 10, finishedAt: 1001 }), result.state)).toBe(false);
  const dismissed = dismissActivity(empty, [record()]);
  expect(activityIsHidden(record(), dismissed)).toBe(true);
  expect(activityIsHidden(record({ finishedAt: 101 }), dismissed)).toBe(false);
  // Capture/export/core feeds can report creation time without a completion timestamp.
  const newlyFinishedCapture = record({ key: 'point:new', finishedAt: undefined, time: 10 });
  expect(activityIsHidden(newlyFinishedCapture, result.state)).toBe(false);
  const knownCapture = clearCompletedActivity(empty, [newlyFinishedCapture], 1000);
  expect(activityIsHidden(newlyFinishedCapture, knownCapture.state)).toBe(true);
});

test('Undo restores bulk-hidden items while preserving earlier and later individual dismissals', () => {
  const earlier = record({ key: 'earlier' });
  const later = record({ key: 'later', finishedAt: 1001 });
  const initial = dismissActivity(empty, [earlier]);
  const result = clearCompletedActivity(initial, [record(), earlier], 1000);
  const state = dismissActivity(result.state, [later]);
  const undone = undoCompletedActivity(state, result.undo);
  expect(activityIsHidden(record(), undone)).toBe(false);
  expect(activityIsHidden(earlier, undone)).toBe(true);
  expect(activityIsHidden(later, undone)).toBe(true);
});
