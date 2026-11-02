import { expect, test } from 'bun:test';
import { retryErrorPage } from './error-page';

test('Retry resets the boundary and reloads the current document', () => {
  const events: string[] = [];
  retryErrorPage(() => events.push('reset'), {
    reload: () => events.push('reload'),
  });
  expect(events).toEqual(['reset', 'reload']);
});
test('Retry reloads even if resetting the boundary itself throws', () => {
  const events: string[] = [];
  expect(() =>
    retryErrorPage(
      () => {
        events.push('reset');
        throw new Error('reset failed');
      },
      {
        reload: () => events.push('reload'),
      },
    ),
  ).toThrow('reset failed');
  expect(events).toEqual(['reset', 'reload']);
});
