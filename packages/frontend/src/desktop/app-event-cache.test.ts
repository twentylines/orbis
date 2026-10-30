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

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAppStatus } from '@/modules/app/helpers/use-app-status';
import { getAppQueryKey } from '@/api-client/@tanstack/react-query.gen';

const optimisticUrn = 'cache-app:fixture';
const applyStatusThroughHook = (client: QueryClient) => {
  function StatusChange() {
    useAppStatus().setOptimisticStatus('installing', optimisticUrn);
    return null;
  }
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(StatusChange)));
};

test('optimistic app status safely ignores an absent cache entry without inventing a partial app response', () => {
  const client = new QueryClient();
  expect(() => applyStatusThroughHook(client)).not.toThrow();
  expect(client.getQueryData(getAppQueryKey({ path: { urn: optimisticUrn } }))).toBeUndefined();
  expect(client.getQueryCache().getAll()).toHaveLength(0);
  client.clear();
});

test('a loaded not-installed response remains complete instead of acquiring a fake partial operational app', () => {
  const client = new QueryClient();
  const key = getAppQueryKey({ path: { urn: optimisticUrn } });
  const value = { info: { urn: optimisticUrn, name: 'Fixture' }, app: null, metadata: { localSubdomain: 'saved' } };
  client.setQueryData([...key], value);
  expect(() => applyStatusThroughHook(client)).not.toThrow();
  expect(client.getQueryData<typeof value>([...key])).toEqual(value);
  client.clear();
});

test('optimistic status changes preserve the real operational app, catalogue metadata and saved configuration', () => {
  const client = new QueryClient();
  const key = getAppQueryKey({ path: { urn: optimisticUrn } });
  const value = {
    info: { urn: optimisticUrn, name: 'Fixture' },
    app: { id: 9, status: 'stopped', config: { FIELD: 'preserved' } },
    metadata: { localSubdomain: 'saved' },
  };
  client.setQueryData([...key], value);
  applyStatusThroughHook(client);
  expect(client.getQueryData<typeof value>([...key])).toEqual({ ...value, app: { ...value.app, status: 'installing' } });
  expect(value.app?.status).toBe('stopped');
  client.clear();
});
