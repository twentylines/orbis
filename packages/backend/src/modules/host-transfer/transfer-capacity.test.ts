import { expect, it } from 'vitest';
import { TransferCapacity } from './transfer-capacity';

it('counts source reservations synchronously, retains bounded terminal records, and releases only its own slot', () => {
  const capacity = new TransferCapacity();
  const states = Array.from({ length: 4 }, () => ({ active: true }));
  const releases = states.map((state) => capacity.reserveSource(() => state.active));
  expect(() => capacity.reserveSource(() => true)).toThrow();
  const firstState = states[0];
  if (!firstState) throw new Error('Expected reserved state');
  firstState.active = false;
  const fifth = capacity.reserveSource(() => true);
  expect(() => capacity.reserveSource(() => true)).toThrow();
  fifth();
  fifth();
  states.forEach((state) => {
    state.active = false;
  });
  const extra = Array.from({ length: 12 }, () => capacity.reserveSource(() => false));
  expect(() => capacity.reserveSource(() => false)).toThrow();
  const firstRelease = releases[0];
  if (!firstRelease) throw new Error('Expected source release');
  firstRelease();
  const replacement = capacity.reserveSource(() => true);
  releases.forEach((release) => {
    release();
  });
  extra.forEach((release) => {
    release();
  });
  replacement();
});
it('bounds retained destination records and shares a one-operation receiving lease without stale release races', () => {
  const capacity = new TransferCapacity();
  const records = Array.from({ length: 16 }, () => capacity.reserveDestination());
  expect(() => capacity.reserveDestination()).toThrow();
  const firstRecord = records[0];
  if (!firstRecord) throw new Error('Expected destination release');
  firstRecord();
  firstRecord();
  const replacement = capacity.reserveDestination();
  expect(() => capacity.reserveDestination()).toThrow();
  const first = capacity.reserveTransfer();
  expect(() => capacity.reserveTransfer()).toThrow();
  first();
  const second = capacity.reserveTransfer();
  first();
  expect(() => capacity.reserveTransfer()).toThrow();
  second();
  capacity.reserveTransfer()();
  records.forEach((release) => {
    release();
  });
  replacement();
});

it('prunes retained slots across protocols without releasing an active receiving lease or pending reservation', () => {
  const capacity = new TransferCapacity();
  const retained = Array.from({ length: 16 }, () => capacity.reserveDestination());
  let expired = false;
  const unregister = capacity.registerRetentionCleanup(() => {
    if (expired)
      retained.forEach((release) => {
        release();
      });
  });
  const activeLease = capacity.reserveTransfer();
  expect(() => capacity.reserveDestination()).toThrow();
  expired = true;
  const fresh = capacity.reserveDestination();
  expect(() => capacity.reserveTransfer()).toThrow('current transfer');
  unregister();
  fresh();
  activeLease();
  const pending = Array.from({ length: 4 }, () => capacity.reserveSource(() => true));
  capacity.registerRetentionCleanup(() => undefined);
  expect(() => capacity.reserveSource(() => true)).toThrow();
  pending.forEach((release) => {
    release();
  });
});
