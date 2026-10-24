import { expect, test } from 'bun:test';
import { newerOrbisRelease, includedOrbisReleases, orbisReleaseHistoryOptions, groupOrbisReleaseNotes, type OrbisRelease } from './orbis-release';
const release = (tag: string, imageManifestUrl: string | null = 'https://example.test/release.json'): OrbisRelease => ({
  tag,
  imageManifestUrl,
  publishedAt: null,
  body: '',
  url: '',
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
  const ready = orbisReleaseHistoryOptions('v0.1.0-beta.87', 'v0.1.0-beta.90');
  expect(ready.enabled).toBe(true);
  expect([...ready.queryKey]).toEqual(['orbis-release-history', 'v0.1.0-beta.87', 'v0.1.0-beta.90']);
  expect(ready.refetchOnWindowFocus).toBe(false);
  expect(ready.refetchOnReconnect).toBe(false);
  expect(ready.refetchOnMount).toBe(false);
  for (const installed of [undefined, 'development', 'v0.1.0-beta.90', 'v0.1.0-beta.91']) {
    expect(orbisReleaseHistoryOptions(installed, 'v0.1.0-beta.90').enabled).toBe(false);
  }
});

test('expands feature baselines and nests only their later maintenance revisions', () => {
  const feature = { ...release('v1.1.0-beta.0'), kind: 'feature' as const };
  const nextFeature = { ...release('v1.2.0-beta.0'), kind: 'feature' as const };
  const groups = groupOrbisReleaseNotes([release('v1.1.0-beta.2'), nextFeature, release('v1.1.0-beta.1'), feature, release('v1.2.0-beta.1')]);
  expect(groups.map((group) => group.feature?.tag)).toEqual(['v1.2.0-beta.0', 'v1.1.0-beta.0']);
  expect(groups[1]?.revisions.map((entry) => entry.tag)).toEqual(['v1.1.0-beta.2', 'v1.1.0-beta.1']);
  expect(groups.every((group) => !group.alreadyInstalled)).toBe(true);
  const installedBaseline = groupOrbisReleaseNotes([release('v1.1.0-beta.2')], feature);
  expect(installedBaseline[0]).toMatchObject({ feature, alreadyInstalled: true });
  expect(installedBaseline[0]?.revisions.map((entry) => entry.tag)).toEqual(['v1.1.0-beta.2']);
});

test('uses current catalogue significance when an older paired server omits release metadata', () => {
  const latest = release('v1.1.0-beta.0');
  const included = includedOrbisReleases(latest, 'v1.0.0', [{ ...latest, kind: 'feature' }]);
  expect(included[0]?.kind).toBe('feature');
  expect(groupOrbisReleaseNotes(included)[0]?.feature?.tag).toBe(latest.tag);
});
