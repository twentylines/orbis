import { expect, test } from 'bun:test';
import { appEventAffectsQuery } from './app-event-cache';

test('resynchronizes open app details and backups after missed events while keeping unrelated host queries cached', () => {
  for (const id of ['getApp', 'getAppBackups', 'getUserConfig'])
    expect(appEventAffectsQuery([{ _id: id, path: { urn: 'missed:store' } }], new Set(), true, true)).toBe(true);
  expect(appEventAffectsQuery(['orbis-host-update-inventory'], new Set(), true, true)).toBe(false);
});

test('refreshes app inventories and affected details without refetching unrelated monitoring and update inventories', () => {
  const urns = new Set(['test:store']);
  for (const key of [
    [{ _id: 'getInstalledApps' }],
    [{ _id: 'appContext' }],
    [{ _id: 'getApp', path: { urn: 'test:store' } }],
    ['tasks'],
    ['container-telemetry', '/api/system/containers'],
    ['cluster-server', 'server', 'apps'],
  ])
    expect(appEventAffectsQuery(key, urns, false)).toBe(true);
  for (const key of [
    [{ _id: 'getApp', path: { urn: 'other:store' } }],
    [{ _id: 'userContext' }],
    ['system-telemetry'],
    ['host-telemetry'],
    ['orbis-host-update-inventory'],
    ['metric-history'],
    [{ _id: 'searchApps' }],
  ])
    expect(appEventAffectsQuery(key, urns, false)).toBe(false);
  expect(appEventAffectsQuery([{ _id: 'searchApps', _infinite: true }], urns, true)).toBe(true);
});
