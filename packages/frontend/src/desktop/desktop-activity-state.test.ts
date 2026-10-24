/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { TaskRecord } from '@runtipi/common/schemas';
import { desktopActivity } from './desktop-activity-state';
import { advanceCoreUpdate } from './core-update-state';
const task = (id: string, urn: string, action: TaskRecord['action'] = 'update', status: TaskRecord['status'] = 'running', time = 1): TaskRecord => ({
  id,
  appUrn: urn as TaskRecord['appUrn'],
  action,
  status,
  createdAt: new Date(time * 1000).toISOString(),
  updatedAt: new Date(time * 1000).toISOString(),
  startedAt: null,
  finishedAt: null,
});
const names = new Map([
  ['photos:store', 'Photos'],
  ['media:store', 'Media'],
]);
describe('dock activity describes actual active work', () => {
  test('completed history does not create an ongoing task', () => {
    expect(desktopActivity([task('old', 'photos:store', 'update', 'succeeded')], names, null, null)).toBeNull();
  });
  test('one app shows its actual name and icon source', () => {
    const value = desktopActivity([task('a', 'photos:store')], names, null, null);
    expect(value).toMatchObject({ title: 'Updating', detail: 'Photos', appUrn: 'photos:store', count: 1 });
  });
  test('installation keeps the complete app name on its own line without inventing progress', () => {
    const value = desktopActivity(
      [{ ...task('a', 'actual:store', 'install'), displayName: 'Actual Budget for household and family' }],
      names,
      null,
      null,
    );
    expect(value).toMatchObject({ title: 'Installing', detail: 'Actual Budget for household and family' });
    expect(value?.title).not.toContain('%');
    expect(value?.items[0]).toMatchObject({ title: 'Installing Actual Budget for household and family', detail: 'In progress' });
  });
  test('batch label counts distinct apps while detail retains every operation', () => {
    const value = desktopActivity([task('a', 'photos:store'), task('b', 'media:store'), task('c', 'photos:store')], names, null, null);
    expect(value).toMatchObject({ title: 'Updating', detail: '2 apps · 3 operations', appUrn: undefined, count: 3 });
    expect(value?.items).toHaveLength(3);
  });
  test('latest action determines summary without calling unrelated operations updates', () => {
    const value = desktopActivity([task('a', 'photos:store'), task('b', 'media:store', 'backup', 'running', 2)], names, null, null);
    expect(value).toMatchObject({ title: 'Backing up', detail: 'Media' });
    expect(value?.count).toBe(2);
  });
  test('queued work is identified and completed packages are excluded', () => {
    const value = desktopActivity([task('a', 'photos:store', 'install', 'queued')], names, null, {
      id: 'past',
      state: 'complete',
      operationCount: 3,
    });
    expect(value).toMatchObject({ title: 'Installing · Queued', detail: 'Photos', count: 1 });
  });
  test('system package operation counts remain separate from app counts', () => {
    const value = desktopActivity([task('a', 'photos:store')], names, null, { id: 'apt', state: 'running', operationCount: 7 });
    expect(value).toMatchObject({ title: 'Updating', detail: '7 system packages', kind: 'packages', count: 2 });
  });
  test('package list refresh is distinct from an installation in the tasks pill', () => {
    const value = desktopActivity([], names, null, { id: 'refresh', kind: 'refresh', state: 'running' });
    expect(value).toMatchObject({ title: 'Refreshing', detail: 'System package lists', kind: 'packages', count: 1 });
    expect(value?.items[0]?.title).toBe('Refreshing package lists');
  });
  test('accepted Orbis restart remains visible when ordinary app task reads stop', () => {
    const id = 'd8b4a1ec-f912-4e14-8e20-58d2754a0130';
    const watch = advanceCoreUpdate(advanceCoreUpdate(null, { type: 'accepted', id, targetTag: 'v0.1.0-beta.79' }), { type: 'unavailable' });
    expect(desktopActivity([], names, watch, null)).toMatchObject({ title: 'Restarting Orbis', kind: 'core', count: 1 });
  });
});

test('compatibility reviews appear in the tasks pill without creating an app operation', () => {
  const result = desktopActivity([], new Map(), null, null, [{ id: 'review-1', target: 'v0.1.0-beta.91', operation: 'downgrade' }]);
  expect(result?.title).toBe('Checking compatibility');
  expect(result?.detail).toBe('Downgrade to v0.1.0-beta.91');
  expect(result?.items[0]?.kind).toBe('core');
  expect(desktopActivity([], new Map(), null, null, [])).toBeNull();
});
