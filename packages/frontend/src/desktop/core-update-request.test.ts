import { expect, test } from 'bun:test';
import { coreUpdateRequestPending, duringCoreUpdateRequest } from './core-update-request';
import { coreUpdateIsPending } from './host-update-watch';

test('the page is protected before preparation starts and through the Host acknowledgement', async () => {
  let acknowledge!: () => void;
  const response = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const steps: boolean[] = [];
  const request = duringCoreUpdateRequest(async () => {
    steps.push(coreUpdateRequestPending());
    expect(coreUpdateIsPending()).toBe(true);
    await response;
    steps.push(coreUpdateRequestPending());
    return 'accepted';
  });
  expect(coreUpdateRequestPending()).toBe(true);
  acknowledge();
  expect(await request).toBe('accepted');
  expect(steps).toEqual([true, true]);
  expect(coreUpdateRequestPending()).toBe(false);
  expect(coreUpdateIsPending()).toBe(false);
});

test('one completed request cannot release the guard for another pending request', async () => {
  let finish!: () => void;
  const first = duringCoreUpdateRequest(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await duringCoreUpdateRequest(async () => undefined);
  expect(coreUpdateRequestPending()).toBe(true);
  finish();
  await first;
  expect(coreUpdateRequestPending()).toBe(false);
});

test('a preparation failure releases the guard and does not replay the request', async () => {
  let calls = 0;
  await expect(
    duringCoreUpdateRequest(async () => {
      calls += 1;
      expect(coreUpdateRequestPending()).toBe(true);
      throw new Error('Preparation unavailable');
    }),
  ).rejects.toThrow('Preparation unavailable');
  expect(calls).toBe(1);
  expect(coreUpdateRequestPending()).toBe(false);
});
