import { expect, test } from 'bun:test';
import { QueryObserver } from '@tanstack/react-query';
import type { OrbisReleaseChannel } from '@runtipi/common/schemas/orbis-release-channel';
import { createAppQueryClient } from '@/lib/query-client';
import { formatOrbisVersion } from './orbis-version';
import {
  newerOrbisRelease,
  includedOrbisReleases,
  orbisReleaseHistoryOptions,
  orbisReleasesOptions,
  orbisPublishedReleasesOptions,
  orbisUpdateNoticeOptions,
  groupOrbisReleaseNotes,
  type OrbisRelease,
} from './orbis-release';
const release = (tag: string, imageManifestUrl: string | null = 'https://example.test/release.json'): OrbisRelease => ({
  tag,
  imageManifestUrl,
  publishedAt: null,
  body: '',
  url: '',
});
test('uses spaced beta numbers for display while retaining release identities for comparisons', () => {
  expect(formatOrbisVersion('v1.0.1-beta.1')).toBe('1.0.1 beta 1');
  expect(formatOrbisVersion('v1.1.0-beta.12')).toBe('1.1.0 beta 12');
  expect(formatOrbisVersion('1.0.1-beta.2+abc123')).toBe('1.0.1 beta 2');
  expect(formatOrbisVersion('v0.1.0-beta.112')).toBe('0.1.0 beta 112');
  expect(formatOrbisVersion('v1.0.0')).toBe('1.0.0');
  expect(formatOrbisVersion('1.1.0')).toBe('1.1.0');
  expect(formatOrbisVersion('development')).toBe('development');
  expect(newerOrbisRelease(release('v1.0.1-beta.10'), 'v1.0.1-beta.9')).toBe(true);
});
test('offers only a complete newer Orbis release with numeric prerelease ordering', () => {
  expect(newerOrbisRelease(release('v0.1.0-beta.82'), 'v0.1.0-beta.9')).toBe(true);
  expect(newerOrbisRelease(release('v0.1.0'), 'v0.1.0-beta.82')).toBe(true);
  expect(newerOrbisRelease(release('v0.1.0-beta.82'), 'v0.1.0-beta.82')).toBe(false);
  expect(newerOrbisRelease(release('v0.1.0-beta.81'), 'v0.1.0-beta.82')).toBe(false);
  expect(newerOrbisRelease(release('v0.1.0-beta.82', null), 'v0.1.0-beta.81')).toBe(false);
  expect(newerOrbisRelease(release('invalid'), 'v0.1.0-beta.81')).toBe(false);
  expect(newerOrbisRelease(release('v0.1.0-beta.82'), 'development')).toBe(false);
  expect(newerOrbisRelease(undefined, undefined)).toBe(false);
});

test('groups only the skipped releases and target with the authoritative latest note first', () => {
  const latest = { ...release('v0.1.0-beta.90'), body: 'Latest checked note' };
  const grouped = includedOrbisReleases(latest, 'v0.1.0-beta.87', [
    release('v0.1.0-beta.89'),
    release('v0.1.0-beta.91'),
    release('v0.1.0-beta.87'),
    release('invalid'),
    release('v0.1.0-beta.88'),
    { ...latest, body: 'Cached old note' },
    release('v0.1.0-beta.88'),
  ]);
  expect(grouped.map((entry) => entry.tag)).toEqual(['v0.1.0-beta.90', 'v0.1.0-beta.89', 'v0.1.0-beta.88']);
  expect(grouped[0]?.body).toBe('Latest checked note');
  expect(includedOrbisReleases(latest, 'development', grouped)).toEqual([latest]);
  expect(includedOrbisReleases(latest, latest.tag, grouped)).toEqual([latest]);
});
test('requests history only for a valid forward update and does not poll in the background', () => {
  const ready = orbisReleaseHistoryOptions('v0.1.0-beta.87', 'v0.1.0-beta.90', 'stable');
  expect(ready.enabled).toBe(true);
  expect([...ready.queryKey]).toEqual(['orbis-release-history', 'v0.1.0-beta.87', 'v0.1.0-beta.90', 'stable']);
  expect(ready.refetchOnWindowFocus).toBe(false);
  expect(ready.refetchOnReconnect).toBe(false);
  expect(ready.refetchOnMount).toBe(false);
  for (const installed of [undefined, 'development', 'v0.1.0-beta.90', 'v0.1.0-beta.91']) {
    expect(orbisReleaseHistoryOptions(installed, 'v0.1.0-beta.90', 'stable').enabled).toBe(false);
  }
});

test('expands feature baselines and nests only their later maintenance revisions', () => {
  const feature = { ...release('v1.1.0-beta.0'), kind: 'feature' as const };
  const nextFeature = { ...release('v1.2.0-beta.0'), kind: 'feature' as const };
  const groups = groupOrbisReleaseNotes([release('v1.1.0-beta.2'), nextFeature, release('v1.1.0-beta.1'), feature, release('v1.2.0-beta.1')]);
  expect(groups.map((group) => group.feature?.tag)).toEqual(['v1.2.0-beta.0', 'v1.1.0-beta.0']);
  expect(groups[1]?.revisions.map((entry) => entry.tag)).toEqual(['v1.1.0-beta.2', 'v1.1.0-beta.1']);
  const revisions = groupOrbisReleaseNotes([release('v1.1.0-beta.2')]);
  expect(revisions[0]?.feature).toBeNull();
  expect(revisions[0]?.revisions.map((entry) => entry.tag)).toEqual(['v1.1.0-beta.2']);
});

test('excludes the installed feature from update notes even when history contains it', () => {
  const installed = { ...release('v0.1.0-beta.97'), kind: 'feature' as const };
  const latest = release('v0.1.0-beta.103');
  const included = includedOrbisReleases(latest, installed.tag, [installed, release('v0.1.0-beta.99'), release('v0.1.0-beta.102')]);
  expect(included.map((entry) => entry.tag)).toEqual([latest.tag, 'v0.1.0-beta.102', 'v0.1.0-beta.99']);
  expect(groupOrbisReleaseNotes(included).every((group) => group.feature === null)).toBe(true);
});

test('uses current catalogue significance when an older paired server omits release metadata', () => {
  const latest = release('v1.1.0-beta.0');
  const included = includedOrbisReleases(latest, 'v1.0.0', [{ ...latest, kind: 'feature' }]);
  expect(included[0]?.kind).toBe('feature');
  expect(groupOrbisReleaseNotes(included)[0]?.feature?.tag).toBe(latest.tag);
});

function noticeScope({
  stale = false,
  failure = false,
  channel = 'nightly',
}: {
  stale?: boolean;
  failure?: boolean;
  channel?: OrbisReleaseChannel;
} = {}) {
  const client = createAppQueryClient();
  const options = orbisUpdateNoticeOptions(false, channel);
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async (input) => {
    expect(input).toBe(`/api/system/orbis-release?channel=${channel}`);
    requests++;
    return Response.json(failure ? { message: 'Unavailable' } : release('v0.1.0-beta.91'), { status: failure ? 503 : 200 });
  }) as typeof fetch;
  client.setQueryData(options.queryKey, [release('v0.1.0-beta.90')], { updatedAt: Date.now() - (stale ? 11 * 60_000 : 0) });
  client.setQueryData(['apps'], 'unchanged');
  const subscriptions: Array<() => void> = [];
  return {
    client,
    requests: () => requests,
    watch(visible: boolean) {
      const observer = new QueryObserver(client, orbisUpdateNoticeOptions(visible, channel));
      subscriptions.push(observer.subscribe(() => undefined));
      return observer;
    },
    close() {
      for (const unsubscribe of subscriptions) unsubscribe();
      client.clear();
      globalThis.fetch = originalFetch;
    },
  };
}

test('a hidden notice does not fetch stale releases and catches up once when visible', async () => {
  const scope = noticeScope({ stale: true });
  try {
    const observer = scope.watch(false);
    await Bun.sleep(0);
    expect(scope.requests()).toBe(0);
    observer.setOptions(orbisUpdateNoticeOptions(true, 'nightly'));
    await Bun.sleep(0);
    expect(scope.requests()).toBe(1);
    expect(observer.getCurrentResult().data?.[0]?.tag).toBe('v0.1.0-beta.91');
    expect(scope.client.getQueryState(['apps'])).toMatchObject({ data: 'unchanged', isInvalidated: false });
  } finally {
    scope.close();
  }
});

test('fresh release data survives notice remounts and visibility changes without another request', async () => {
  const scope = noticeScope();
  try {
    const observer = scope.watch(true);
    observer.setOptions(orbisUpdateNoticeOptions(false, 'nightly'));
    observer.setOptions(orbisUpdateNoticeOptions(true, 'nightly'));
    scope.watch(true);
    await Bun.sleep(0);
    expect(scope.requests()).toBe(0);
  } finally {
    scope.close();
  }
});

test('stale notices sharing the release cache deduplicate discovery requests', async () => {
  const scope = noticeScope({ stale: true });
  try {
    const first = scope.watch(true);
    const second = scope.watch(true);
    await Bun.sleep(0);
    expect(scope.requests()).toBe(1);
    expect(first.getCurrentResult().data).toEqual(second.getCurrentResult().data);
    expect(first.getCurrentResult().data?.[0]?.tag).toBe('v0.1.0-beta.91');
  } finally {
    scope.close();
  }
});

test('a failed automatic check retains the last known update without immediate retries', async () => {
  const scope = noticeScope({ stale: true, failure: true });
  try {
    const observer = scope.watch(true);
    await Bun.sleep(20);
    expect(scope.requests()).toBe(1);
    expect(observer.getCurrentResult().isError).toBe(true);
    expect(observer.getCurrentResult().data?.[0]?.tag).toBe('v0.1.0-beta.90');
    expect(scope.client.getQueryState(['apps'])?.isInvalidated).toBe(false);
  } finally {
    scope.close();
  }
});

test('Stable and Nightly release queries use distinct keys, request URLs, and cached values', async () => {
  const client = createAppQueryClient();
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    requests.push(url);
    if (url === '/api/system/orbis-release?channel=stable') return Response.json(release('v1.0.0'));
    if (url === '/api/system/orbis-release?channel=nightly') return Response.json(release('v1.1.0-beta.1'));
    if (url === '/api/system/orbis-releases?channel=stable') return Response.json({ releases: [release('v1.0.0')], complete: true });
    if (url === '/api/system/orbis-releases?channel=nightly') return Response.json({ releases: [release('v1.1.0-beta.1')], complete: true });
    if (url.includes('/api/system/orbis-release-history?') && url.endsWith('channel=stable'))
      return Response.json({ releases: [release('v1.0.0')], complete: true, truncated: false });
    if (url.includes('/api/system/orbis-release-history?') && url.endsWith('channel=nightly'))
      return Response.json({ releases: [release('v1.1.0-beta.1')], complete: true, truncated: false });
    throw new Error(`unexpected release request: ${url}`);
  }) as typeof fetch;
  try {
    const stableLatest = orbisReleasesOptions('stable');
    const nightlyLatest = orbisReleasesOptions('nightly');
    const stableCatalog = orbisPublishedReleasesOptions('stable');
    const nightlyCatalog = orbisPublishedReleasesOptions('nightly');
    const stableHistory = orbisReleaseHistoryOptions('v0.1.0-beta.90', 'v1.0.0', 'stable');
    const nightlyHistory = orbisReleaseHistoryOptions('v0.1.0-beta.90', 'v1.1.0-beta.1', 'nightly');

    expect(stableLatest.queryKey.join('/')).toBe('orbis-github-releases/stable');
    expect(nightlyLatest.queryKey.join('/')).toBe('orbis-github-releases/nightly');
    expect(stableCatalog.queryKey.join('/')).toBe('orbis-published-releases/stable');
    expect(nightlyCatalog.queryKey.join('/')).toBe('orbis-published-releases/nightly');
    expect(stableHistory.queryKey.join('/')).toBe('orbis-release-history/v0.1.0-beta.90/v1.0.0/stable');
    expect(nightlyHistory.queryKey.join('/')).toBe('orbis-release-history/v0.1.0-beta.90/v1.1.0-beta.1/nightly');
    expect(stableLatest.refetchInterval).toBeUndefined();
    expect(nightlyLatest.refetchInterval).toBeUndefined();
    expect(orbisUpdateNoticeOptions(true, 'nightly').refetchIntervalInBackground).toBe(false);

    const [stableValue, nightlyValue, stableCatalogValue, nightlyCatalogValue, stableHistoryValue, nightlyHistoryValue] = await Promise.all([
      client.fetchQuery(stableLatest),
      client.fetchQuery(nightlyLatest),
      client.fetchQuery(stableCatalog),
      client.fetchQuery(nightlyCatalog),
      client.fetchQuery(stableHistory),
      client.fetchQuery(nightlyHistory),
    ]);
    expect(stableValue[0]?.tag).toBe('v1.0.0');
    expect(nightlyValue[0]?.tag).toBe('v1.1.0-beta.1');
    expect(stableCatalogValue.releases[0]?.tag).toBe('v1.0.0');
    expect(nightlyCatalogValue.releases[0]?.tag).toBe('v1.1.0-beta.1');
    expect(stableHistoryValue.releases[0]?.tag).toBe('v1.0.0');
    expect(nightlyHistoryValue.releases[0]?.tag).toBe('v1.1.0-beta.1');
    expect(requests).toHaveLength(6);
    expect(requests).toContain('/api/system/orbis-release?channel=stable');
    expect(requests).toContain('/api/system/orbis-release?channel=nightly');
    expect(requests).toContain('/api/system/orbis-releases?channel=stable');
    expect(requests).toContain('/api/system/orbis-releases?channel=nightly');
    expect(requests.some((url) => url.includes('channel=stable'))).toBe(true);
    expect(requests.some((url) => url.includes('channel=nightly'))).toBe(true);

    await client.fetchQuery(stableLatest);
    await client.fetchQuery(nightlyLatest);
    expect(requests).toHaveLength(6);
  } finally {
    client.clear();
    globalThis.fetch = originalFetch;
  }
});
