import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TimeMachineCaptureReview } from '@runtipi/common/schemas/time-machine';
import { captureChoices, CaptureStorageChoicesView } from './capture-storage-choices';

const data = 'a'.repeat(64);
const media = 'b'.repeat(64);
const review: TimeMachineCaptureReview = {
  version: 1,
  reviewId: '11111111-1111-4111-8111-111111111111',
  reviewSha256: 'c'.repeat(64),
  apps: [
    {
      urn: 'jellyfin:_user',
      mounts: [
        {
          id: data,
          service: 'jellyfin',
          destination: '/config',
          source: '/fixture/app-data/jellyfin',
          classification: 'app-data',
          requiresExplicitInclusion: true,
          type: 'bind',
          writable: true,
        },
        {
          id: media,
          service: 'jellyfin',
          destination: '/media',
          source: '/fixture/media/movies',
          classification: 'media',
          requiresExplicitInclusion: true,
          type: 'bind',
          writable: false,
        },
      ],
    },
  ],
};
test('the default is Orbis only and selected apps cannot submit without explicit storage choices', () => {
  expect(captureChoices(undefined, [], new Set(), false)).toEqual({ ready: true });
  expect(captureChoices(review, ['jellyfin:_user'], new Set(), false)).toEqual({ ready: false });
  expect(captureChoices(review, ['jellyfin:_user'], new Set([data]), true)).toEqual({ ready: false });
});
test('selection uses only reviewed opaque mount identifiers and media remains omitted until explicitly checked', () => {
  expect(captureChoices(review, ['jellyfin:_user'], new Set([data, '/private/unreviewed/path']), false)).toEqual({
    ready: true,
    selection: { version: 1, reviewId: review.reviewId, reviewSha256: review.reviewSha256, apps: [{ urn: 'jellyfin:_user', mountIds: [data] }] },
  });
  expect(captureChoices(review, ['jellyfin:_user'], new Set([data, media]), false).selection?.apps[0]?.mountIds).toEqual([data, media]);
  expect(captureChoices(review, ['another:_user'], new Set([data]), false).ready).toBe(false);
});
test('the real form exposes each storage mount and reviews only checked content with no native snapshot choice', () => {
  const html = renderToStaticMarkup(
    <CaptureStorageChoicesView
      installed={[{ urn: 'jellyfin:_user', name: 'Jellyfin' }]}
      selected={['jellyfin:_user']}
      review={review}
      mounts={new Set([data])}
      reading={false}
      disabled={false}
      onApp={() => {}}
      onMount={() => {}}
      onRetry={() => {}}
    />,
  );
  expect(html).toContain('Orbis snapshot');
  expect(html).toContain('Included content review');
  expect(html).toContain('/fixture/media/movies');
  expect(html).toContain('Media files');
  expect(html.match(/checked=""/g)?.length).toBe(2);
  expect(html).toContain('Restoring these combined captures is not available yet.');
  expect(html).not.toContain('Operating system snapshot');
  const summary = html.slice(html.indexOf('aria-label="Included content review"'));
  expect(summary).toContain('Jellyfin: jellyfin /config');
  expect(summary).not.toContain('/media');
});
