import { describe, expect, test } from 'bun:test';
import type { QueryClient } from '@tanstack/react-query';
import { prepareNavigationData } from './navigation-data';

type Options = { queryKey: readonly [{ _id: string; _infinite?: boolean; query?: Record<string, unknown> }] };
const pending = () => {
  let resolve: (value: unknown) => void = () => {};
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('category data preparation', () => {
  test('starts both Apps suspense reads together rather than waiting for the installed list before links', async () => {
    const apps = pending();
    const links = pending();
    const calls: string[] = [];
    const client = {
      ensureQueryData(options: Options) {
        const id = options.queryKey[0]._id;
        calls.push(id);
        return id === 'getInstalledApps' ? apps.promise : links.promise;
      },
    } as unknown as QueryClient;
    const ready = prepareNavigationData(client, '/apps', { search: '' });
    expect(calls).toEqual(['getInstalledApps', 'getLinks']);
    links.resolve({ links: [] });
    apps.resolve({ installed: [{ info: { urn: 'available:store', available: true } }, { info: { urn: 'retained:store', available: false } }] });
    expect(await ready).toEqual(['available:store']);
  });

  test('prepares the store gate and first catalogue page in parallel for the bare dock destination', async () => {
    const stores = pending();
    const catalogue = pending();
    const calls: Options['queryKey'][number][] = [];
    const client = {
      ensureQueryData(options: Options) {
        calls.push(options.queryKey[0]);
        return stores.promise;
      },
      ensureInfiniteQueryData(options: Options) {
        calls.push(options.queryKey[0]);
        return catalogue.promise;
      },
    } as unknown as QueryClient;
    const ready = prepareNavigationData(client, '/app-store', { search: 'paper' });
    expect(calls.map((call) => call._id)).toEqual(['getEnabledAppStores', 'searchApps']);
    expect(calls[1]?._infinite).toBe(true);
    expect(calls[1]?.query).toEqual({ search: 'paper', storeId: undefined, pageSize: 24 });
    catalogue.resolve({ pages: [{ data: [{ urn: 'paper:store' }] }] });
    stores.resolve({ appStores: [] });
    expect(await ready).toEqual(['paper:store']);
  });

  test('a failed prerequisite remains a rejected warmup, while unsupported destinations perform no reads', async () => {
    const calls: string[] = [];
    const client = {
      ensureQueryData(options: Options) {
        const id = options.queryKey[0]._id;
        calls.push(id);
        return id === 'getLinks' ? Promise.reject(new Error('Links unavailable')) : Promise.resolve({ installed: [] });
      },
    } as unknown as QueryClient;
    await expect(prepareNavigationData(client, '/apps', { search: '' })).rejects.toThrow('Links unavailable');
    expect(calls).toHaveLength(2);
    expect(await prepareNavigationData(client, '/monitor', { search: '' })).toEqual([]);
    expect(calls).toHaveLength(2);
  });
});
