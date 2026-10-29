import { expect, test } from 'bun:test';
import { NearbyRequestState } from './nearby-request-state';

test('results are scoped to an explicitly chosen interface with no default', () => {
  const selection = new NearbyRequestState();
  expect(selection.selectedInterface()).toBe('');
  selection.select('eth0');
  const scan = selection.begin();
  expect(scan.interface).toBe('eth0');
  expect(selection.current(scan)).toBe(true);
  selection.select('wlan0');
  expect(selection.current(scan)).toBe(false);
});
test('an old scan resolving after an interface change cannot replace current candidates', async () => {
  const selection = new NearbyRequestState();
  selection.select('eth0');
  let finishOld: (() => void) | undefined;
  let displayed: string[] = [];
  const old = selection.begin();
  const pending = new Promise<void>((resolve) => {
    finishOld = resolve;
  }).then(() => {
    if (selection.current(old)) displayed = ['old-address'];
  });
  selection.select('wlan0');
  displayed = [];
  const current = selection.begin();
  if (selection.current(current)) displayed = ['current-address'];
  finishOld?.();
  await pending;
  expect(displayed).toEqual(['current-address']);
});
test('refreshing the inventory or reselecting an interface invalidates earlier scan generations', () => {
  const selection = new NearbyRequestState();
  selection.select('eth0');
  const old = selection.begin();
  selection.select('');
  const inventory = selection.begin();
  expect(selection.current(old)).toBe(false);
  selection.select('eth0');
  expect(selection.current(inventory)).toBe(false);
  expect(selection.current(selection.begin())).toBe(true);
});
