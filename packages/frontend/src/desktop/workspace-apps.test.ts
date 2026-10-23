/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { homeApps, maximumHomePins, moveHomePin, placeHomePin, validHomePins, workspaceRows } from './workspace-apps';

const apps = Array.from({ length: 35 }, (_, index) => ({ info: { urn: `app-${index}:store` } }));
test('shows more than twelve pins in saved order without changing installed or saved arrays', () => {
  const pins = apps
    .slice(0, 20)
    .map(({ info }) => info.urn)
    .reverse();
  const original = [...pins];
  expect(homeApps(apps, pins, false).map(({ info }) => info.urn)).toEqual(pins);
  expect(pins).toEqual(original);
  expect(apps[0]?.info.urn).toBe('app-0:store');
});
test('keeps unavailable pin identities and orders available apps before unpinned apps', () => {
  const pins = ['missing:store', 'app-4:store', 'app-1:store'];
  expect(homeApps(apps, pins, false).map(({ info }) => info.urn)).toEqual(['app-4:store', 'app-1:store', 'app-0:store']);
  expect(homeApps(apps, pins, true)).toHaveLength(35);
  expect(pins[0]).toBe('missing:store');
});
test('keyboard moves and drag placement preserve every pin exactly once', () => {
  const pins = ['a:store', 'b:store', 'c:store', 'd:store'];
  expect(moveHomePin(pins, 'b:store', -1)).toEqual(['b:store', 'a:store', 'c:store', 'd:store']);
  expect(moveHomePin(pins, 'b:store', 1)).toEqual(['a:store', 'c:store', 'b:store', 'd:store']);
  expect(placeHomePin(pins, 'd:store', 'b:store')).toEqual(['a:store', 'd:store', 'b:store', 'c:store']);
  expect(moveHomePin(pins, 'a:store', -1)).toBe(pins);
  expect(placeHomePin(pins, 'missing:store', 'a:store')).toBe(pins);
  expect(pins).toEqual(['a:store', 'b:store', 'c:store', 'd:store']);
});
test('accepts a bounded large pin order and rejects duplicate or malformed identities', () => {
  const pins = Array.from({ length: maximumHomePins }, (_, i) => `app-${i}:store`);
  expect(validHomePins(pins)).toBe(true);
  expect(validHomePins([...pins, 'overflow:store'])).toBe(false);
  expect(validHomePins(['a:store', 'a:store'])).toBe(false);
  expect(validHomePins([':store'])).toBe(false);
});

test('drops can move a pin to the end and reject outside or duplicate targets', () => {
  const pins = ['a:store', 'b:store', 'c:store'];
  expect(placeHomePin(pins, 'a:store', null)).toEqual(['b:store', 'c:store', 'a:store']);
  expect(placeHomePin(pins, 'c:store', null)).toBe(pins);
  expect(placeHomePin(pins, 'outside:store', null)).toBe(pins);
  expect(placeHomePin(pins, 'a:store', 'outside:store')).toBe(pins);
  expect(placeHomePin(pins, 'a:store', 'a:store')).toBe(pins);
  expect(pins).toEqual(['a:store', 'b:store', 'c:store']);
});
test('widget rows keep saved semantic order without a half-row gap before a wide widget', () => {
  const widgets = ['attention', 'applications', 'activity', 'storage'];
  const rows = workspaceRows(widgets, ['applications']);
  expect(rows).toEqual([['attention'], ['applications'], ['activity', 'storage']]);
  expect(rows.flat()).toEqual(widgets);
  expect(workspaceRows(['activity', 'storage', 'attention'], [])).toEqual([['activity', 'storage'], ['attention']]);
  expect(workspaceRows([], ['applications'])).toEqual([]);
  expect(widgets).toEqual(['attention', 'applications', 'activity', 'storage']);
});
