import { expect, test } from 'bun:test';
import { claimPreloadRetry } from './preload-retry';

test('persistent chunk failures get one automatic reload across documents', () => {
  let value: string | null = null;
  const storage = {
    getItem: () => value,
    setItem: (_: string, next: string) => {
      value = next;
    },
  };
  expect(claimPreloadRetry(storage, 100_000)).toBe(true);
  expect(claimPreloadRetry(storage, 101_000)).toBe(false);
  expect(claimPreloadRetry(storage, 161_000)).toBe(true);
});

test('unavailable storage cannot cause a reload loop', () => {
  expect(
    claimPreloadRetry(
      {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => undefined,
      },
      100_000,
    ),
  ).toBe(false);
  expect(claimPreloadRetry({ getItem: () => null, setItem: () => undefined }, 100_000)).toBe(false);
});
