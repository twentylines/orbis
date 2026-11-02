import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TimeMachinePointDetails } from './time-machine-settings';
import { historicalPoint, readyReview } from './time-machine.test-data';

test('provisional host checks and verified readiness use distinct existing status text', () => {
  const point = historicalPoint();
  const ready = { ...readyReview(), expiresAt: Date.now() + 60_000 };
  const eligible = {
    ...ready,
    status: 'eligible' as const,
    ready: false,
    progress: { stage: 'checking' as const, completedBytes: 0, totalBytes: null },
  };
  const capabilities = { restore: { supported: true } } as never;
  const provisional = renderToStaticMarkup(<TimeMachinePointDetails point={point} capabilities={capabilities} review={eligible} />);
  const verified = renderToStaticMarkup(<TimeMachinePointDetails point={point} capabilities={capabilities} review={ready} />);
  expect(provisional).toContain('Host compatibility is not yet confirmed.');
  expect(provisional).not.toContain('Point verified.');
  expect(verified).toContain('Point verified. Fresh authorization is required.');
  expect(verified).not.toContain('Host compatibility is not yet confirmed.');
});
