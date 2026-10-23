import { expect, test } from 'bun:test';
import { newerOrbisRelease, type OrbisRelease } from './orbis-release';
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
