import { expect, test } from 'bun:test';
import { formatOrbisVersion } from './orbis-version';

test('shows beta and release-candidate versions with readable stage labels', () => {
  expect(formatOrbisVersion('v1.0.1-beta.1')).toBe('1.0.1 beta 1');
  expect(formatOrbisVersion('1.1.0-beta.12')).toBe('1.1.0 beta 12');
  expect(formatOrbisVersion('v1.2.0-rc.3')).toBe('1.2.0 rc 3');
  expect(formatOrbisVersion('1.3.0-rc.10')).toBe('1.3.0 rc 10');
});

test('shows stable versions without a prerelease suffix', () => {
  expect(formatOrbisVersion('v1.0.1')).toBe('1.0.1');
  expect(formatOrbisVersion('1.0.1')).toBe('1.0.1');
});
