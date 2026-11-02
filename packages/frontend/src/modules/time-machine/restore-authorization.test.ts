import { expect, test } from 'bun:test';
import { restoreAuthorizationAvailable } from './restore-authorization';
import { historicalPoint, readyReview } from './time-machine.test-data';

test('the actual authorize control requires server capability, current point digest and unexpired ready review together', () => {
  const point = historicalPoint();
  const review = readyReview();
  expect(restoreAuthorizationAvailable(point, review, true, 1000)).toBe(true);
  expect(restoreAuthorizationAvailable(point, review, false, 1000)).toBe(false);
  expect(restoreAuthorizationAvailable(undefined, review, true, 1000)).toBe(false);
  expect(restoreAuthorizationAvailable(point, null, true, 1000)).toBe(false);
  expect(restoreAuthorizationAvailable(point, review, true, 10000)).toBe(false);
  if (!point.metadata) throw new Error('Fixture metadata missing');
  expect(restoreAuthorizationAvailable({ ...point, metadata: { ...point.metadata, manifestSha256: 'e'.repeat(64) } }, review, true, 1000)).toBe(
    false,
  );
  expect(restoreAuthorizationAvailable({ ...point, status: 'capturing', metadata: null }, review, true, 1000)).toBe(false);
});

test('provisional eligibility permits authorization without claiming verified readiness', () => {
  const point = historicalPoint();
  const review = {
    ...readyReview(),
    status: 'eligible' as const,
    ready: false,
    progress: { stage: 'checking' as const, completedBytes: 0, totalBytes: null },
  };
  expect(restoreAuthorizationAvailable(point, review, true, 1000)).toBe(true);
  expect(restoreAuthorizationAvailable(point, review, false, 1000)).toBe(true);
  expect(restoreAuthorizationAvailable(point, review, true, 10000)).toBe(false);
  expect(restoreAuthorizationAvailable({ ...point, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }, review, true, 1000)).toBe(false);
});
