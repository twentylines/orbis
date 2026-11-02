import { afterEach, expect, spyOn, test } from 'bun:test';
import { isTimeMachineStorageLow, readTimeMachineStorage, timeMachineLowStorageBytes } from './time-machine-storage-api';

const storage = {
  version: 1 as const,
  totalBytes: 100 * 1024 ** 3,
  usedBytes: 94 * 1024 ** 3,
  availableBytes: 4 * 1024 ** 3,
  retainedBytes: 100,
  retainedLimitBytes: 128 * 1024 ** 3,
};
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('warns only for measured available space below the 5 GiB threshold', () => {
  expect(isTimeMachineStorageLow(storage)).toBe(true);
  expect(isTimeMachineStorageLow({ ...storage, availableBytes: timeMachineLowStorageBytes })).toBe(false);
});

test('reads only a valid bounded authenticated response and never substitutes zero', async () => {
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(storage));
  expect(await readTimeMachineStorage(new AbortController().signal)).toEqual(storage);
  expect(fetch.mock.calls[0]?.[0]).toBe('/api/system-backups/time-machine/storage');
  fetch.mockResolvedValueOnce(Response.json({}, { status: 403 }));
  await expect(readTimeMachineStorage(new AbortController().signal)).rejects.toThrow();
  fetch.mockResolvedValueOnce(new Response('x'.repeat(4097)));
  await expect(readTimeMachineStorage(new AbortController().signal)).rejects.toThrow();
  fetch.mockResolvedValueOnce(Response.json({ ...storage, availableBytes: -1 }));
  await expect(readTimeMachineStorage(new AbortController().signal)).rejects.toThrow();
});
