import { expect, test } from 'bun:test';
import { installRecoveryReviewSchema } from '@runtipi/common/schemas/install-recovery-review';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppInstallRecoveryNotice } from './app-operations';

const base = { appUrn: 'demo:store', sampledAt: '2026-11-21T00:00:00Z' };

test('keeps regular operations free of an install recovery notice when no hold is observed', () => {
  const review = installRecoveryReviewSchema.assert({ ...base, state: 'clear', hold: null });
  expect(renderToStaticMarkup(<AppInstallRecoveryNotice review={review} />)).toBe('');
});

test('shows the held request and stopped-runtime evidence requirement without a confirmation action', () => {
  const requestId = 'f0a70163-7ce0-4d40-80df-72fbb6ecfd9c';
  const review = installRecoveryReviewSchema.assert({ ...base, state: 'held', hold: { requestId, phase: 'spent', reservation: 'changed' } });
  const view = renderToStaticMarkup(<AppInstallRecoveryNotice review={review} />);
  expect(view).toContain('Interrupted install');
  expect(view).toContain(requestId);
  expect(view).toContain('Consumed receipt');
  expect(view).toContain('Database reservation changed');
  expect(view).toContain('verify that the app is stopped on the Docker host');
  expect(view).toContain('any retained data');
  expect(view).not.toContain('<button');
  expect(view).not.toContain('<form');
  const stale = renderToStaticMarkup(<AppInstallRecoveryNotice review={review} stale />);
  expect(stale).toContain('could not be verified');
  expect(stale).not.toContain(requestId);
});

test('reports the busy or unverified observation without inventing a hold identity', () => {
  const busy = renderToStaticMarkup(<AppInstallRecoveryNotice review={installRecoveryReviewSchema.assert({ ...base, state: 'busy', hold: null })} />);
  const invalid = renderToStaticMarkup(
    <AppInstallRecoveryNotice review={installRecoveryReviewSchema.assert({ ...base, state: 'unverified', hold: null })} />,
  );
  expect(busy).toContain('current operation finishes');
  expect(invalid).toContain('could not be verified');
  expect(busy + invalid).not.toContain('<dl>');
});
