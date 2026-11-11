import { expect, test } from 'bun:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { appContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import type { AppContextDto } from '@/api-client';
import { patchAppContext } from './app-context-cache';

const fixture = (): AppContextDto => ({
  apps: [],
  updatesAvailable: 2,
  user: {
    id: 1,
    username: 'fixture',
    locale: 'en',
    operator: true,
    totpEnabled: false,
    hasSeenWelcome: false,
  },
  userSettings: {
    advancedSettings: false,
    allowAutoThemes: false,
    allowErrorMonitoring: false,
    appDataPath: '/fixture',
    appsRepoUrl: 'https://example.invalid/apps',
    demoMode: false,
    dnsIp: '',
    domain: '',
    eventsTimeout: 30,
    forwardAuthUrl: '',
    guestDashboard: false,
    internalIp: '127.0.0.1',
    listenIp: '127.0.0.1',
    localDomain: '',
    logLevel: 'info',
    maxBackups: 3,
    persistTraefikConfig: false,
    port: 80,
    postgresPort: 5432,
    sslPort: 443,
    timeZone: 'UTC',
  },
  version: { body: '', current: '0.8.0-beta.3', latest: '0.8.0-beta.3', releases: [] },
});

test('updates the generated context query observed by every consumer', () => {
  const client = new QueryClient();
  const key = appContextQueryKey();
  const original = fixture();
  client.setQueryData(key, original);
  const seen: number[][] = [[], []];
  const subscriptions = seen.map((values) =>
    new QueryObserver<AppContextDto>(client, {
      queryKey: key,
      enabled: false,
    }).subscribe((result) => {
      if (result.data) values.push(result.data.updatesAvailable);
    }),
  );
  patchAppContext(client, { updatesAvailable: 0 }, original);
  expect(client.getQueryData<AppContextDto>(key)?.updatesAvailable).toBe(0);
  expect(client.getQueryData(['appContext'])).toBeUndefined();
  for (const values of seen) expect(values.at(-1)).toBe(0);
  for (const unsubscribe of subscriptions) unsubscribe();
  client.clear();
});

test('consecutive changes merge with the latest cache rather than the captured render', () => {
  const client = new QueryClient();
  const original = fixture();
  client.setQueryData(appContextQueryKey(), original);
  patchAppContext(client, { updatesAvailable: 0 }, original);
  patchAppContext(client, { user: { ...original.user, hasSeenWelcome: true } }, original);
  expect(client.getQueryData<AppContextDto>(appContextQueryKey())).toEqual({
    ...original,
    updatesAvailable: 0,
    user: { ...original.user, hasSeenWelcome: true },
  });
  client.clear();
});

test('uses the loaded context when its cache has been evicted', () => {
  const client = new QueryClient();
  const original = fixture();
  patchAppContext(client, { updatesAvailable: 0 }, original);
  expect(client.getQueryData(appContextQueryKey())).toEqual({ ...original, updatesAvailable: 0 });
  client.clear();
});
