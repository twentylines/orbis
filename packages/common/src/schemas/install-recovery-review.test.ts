import { expect, test } from 'bun:test';
import { installRecoveryReviewSchema } from './install-recovery-review.js';

const sample = { appUrn: 'demo:catalogue', sampledAt: '2026-11-21T00:00:00.000Z', state: 'clear', hold: null };
test('accepts actual namespaced app identifiers and a canonical UTC sample', () => {
  expect(installRecoveryReviewSchema.allows(sample)).toBe(true);
  expect(installRecoveryReviewSchema.allows({ ...sample, appUrn: 'My-App_1:store-2_test' })).toBe(true);
});
for (const appUrn of ['plain', ':catalogue', 'demo:', 'demo:store:other', 'demo/name:catalogue', 'demo:with space']) {
  test(`rejects malformed app identity ${appUrn}`, () => expect(installRecoveryReviewSchema.allows({ ...sample, appUrn })).toBe(false));
}
for (const sampledAt of ['2026', '2026-11-21', '2026-02-31T00:00:00.000Z', '2026-11-21T24:00:00.000Z', 'not a date']) {
  test(`rejects incomplete or normalized sample time ${sampledAt}`, () =>
    expect(installRecoveryReviewSchema.allows({ ...sample, sampledAt })).toBe(false));
}
