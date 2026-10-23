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
    expect(value).toMatchObject({ title: 'Updating Photos', detail: 'In progress', appUrn: 'photos:store', count: 1 });
  });
  test('batch label counts distinct apps while detail retains every operation', () => {
    const value = desktopActivity([task('a', 'photos:store'), task('b', 'media:store'), task('c', 'photos:store')], names, null, null);
    expect(value).toMatchObject({ title: 'Updating 2 apps', detail: '3 operations', appUrn: undefined, count: 3 });
    expect(value?.items).toHaveLength(3);
  });
  test('latest action determines summary without calling unrelated operations updates', () => {
    const value = desktopActivity([task('a', 'photos:store'), task('b', 'media:store', 'backup', 'running', 2)], names, null, null);
    expect(value?.title).toBe('Backing up Media');
    expect(value?.count).toBe(2);
  });
  test('queued work is identified and completed packages are excluded', () => {
    const value = desktopActivity([task('a', 'photos:store', 'install', 'queued')], names, null, {
      id: 'past',
      state: 'complete',
      operationCount: 3,
    });
    expect(value).toMatchObject({ title: 'Installing Photos', detail: 'Queued', count: 1 });
  });
  test('system package operation counts remain separate from app counts', () => {
    const value = desktopActivity([task('a', 'photos:store')], names, null, { id: 'apt', state: 'running', operationCount: 7 });
    expect(value).toMatchObject({ title: 'Updating 7 system packages', kind: 'packages', count: 2 });
  });
  test('accepted Orbis restart remains visible when ordinary app task reads stop', () => {
    const id = 'd8b4a1ec-f912-4e14-8e20-58d2754a0130';
    const watch = advanceCoreUpdate(advanceCoreUpdate(null, { type: 'accepted', id, targetTag: 'v0.1.0-beta.79' }), { type: 'unavailable' });
    expect(desktopActivity([], names, watch, null)).toMatchObject({ title: 'Orbis is restarting', kind: 'core', count: 1 });
  });
});
