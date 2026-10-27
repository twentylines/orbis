import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  downgradeAllowedOnChannel,
  isPublishedOrbisReleaseTag,
  isStableOrbisReleaseTag,
  orbisVersionOrder,
  parseOrbisVersion,
  releaseAllowedOnChannel,
  type OrbisReleaseChannel,
} from './orbis-release-channel.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/orbis-release-policy.json', import.meta.url), 'utf8')) as {
  versions: Array<{
    version: string;
    parsed: ReturnType<typeof parseOrbisVersion>;
    published: boolean;
    stable: boolean;
    nightly: boolean;
  }>;
  order: Array<{ first: string; second: string; result: number | null }>;
  downgrades: Array<{ target: string; installed: string; channel: string; allowed: boolean }>;
};

test('matches the shared published-tag, installed-version and channel classification fixtures', () => {
  for (const fixture of fixtures.versions) {
    expect(parseOrbisVersion(fixture.version), fixture.version).toEqual(fixture.parsed);
    expect(isPublishedOrbisReleaseTag(fixture.version), fixture.version).toBe(fixture.published);
    expect(isStableOrbisReleaseTag(fixture.version), fixture.version).toBe(fixture.stable);
    expect(releaseAllowedOnChannel(fixture.version, 'stable'), fixture.version).toBe(fixture.stable);
    expect(releaseAllowedOnChannel(fixture.version, 'nightly'), fixture.version).toBe(fixture.nightly);
  }
  expect(parseOrbisVersion('1.0.1')).toEqual({ base: '1.0.1', numbers: [1, 0, 1], prerelease: null, iteration: null });
});

test('matches the shared semver order fixtures', () => {
  for (const fixture of fixtures.order) {
    expect(orbisVersionOrder(fixture.first, fixture.second), `${fixture.first} vs ${fixture.second}`).toBe(fixture.result);
  }
});

test('matches shared downgrade fixtures and enforces channel base boundaries', () => {
  for (const fixture of fixtures.downgrades) {
    expect(
      downgradeAllowedOnChannel(fixture.target, fixture.installed, fixture.channel as OrbisReleaseChannel),
      `${fixture.channel}: ${fixture.target} from ${fixture.installed}`,
    ).toBe(fixture.allowed);
  }

  expect(downgradeAllowedOnChannel('v1.0.0-beta.12', 'v1.0.1-beta.1', 'nightly')).toBe(false);
  expect(downgradeAllowedOnChannel('v1.0.1-beta.9', 'v1.0.1-beta.10', 'nightly')).toBe(true);
  expect(downgradeAllowedOnChannel('v1.0.0', 'v1.0.1-beta.1', 'nightly')).toBe(true);
  expect(downgradeAllowedOnChannel('v1.0.0-beta.12', 'v1.0.1-beta.1', 'stable')).toBe(false);
  expect(downgradeAllowedOnChannel('v1.0.1-rc.1', 'v1.0.1-rc.2', 'stable')).toBe(false);
});
