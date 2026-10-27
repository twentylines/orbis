/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { canJoinDockPills, dockFlightTargetLeft } from './dock-motion-geometry';

test('resting pills do not retain a neck when zoom rounds the 12px gap down', () => {
  expect(canJoinDockPills(11.996, false)).toBe(false);
  expect(canJoinDockPills(11.996, true)).toBe(false);
  expect(canJoinDockPills(0, false)).toBe(false);
});
test('a splitting or joining pill retains its connection until the gap opens', () => {
  expect(canJoinDockPills(-8, true)).toBe(true);
  expect(canJoinDockPills(6, true)).toBe(true);
  expect(canJoinDockPills(12, true)).toBe(false);
});

test('the first app lands at the final icon position measured after the tray splits', () => {
  expect(dockFlightTargetLeft({ center: 720, mainWidth: 564, leftSpace: 0, trayWidth: 134, gap: 12, offset: 13 })).toBe(954);
});
test('the fourth app uses the contracted navigation width', () => {
  expect(dockFlightTargetLeft({ center: 720, mainWidth: 348, leftSpace: 0, trayWidth: 506, gap: 12, offset: 385 })).toBe(1032);
});
test('a task pill on the opposite side contributes to the final dock position', () => {
  expect(dockFlightTargetLeft({ center: 720, mainWidth: 564, leftSpace: 327, trayWidth: 134, gap: 12, offset: 13 })).toBe(1117.5);
});
test('the destination follows a resized viewport and available tray width', () => {
  expect(dockFlightTargetLeft({ center: 576, mainWidth: 348, leftSpace: 0, trayWidth: 382, gap: 12, offset: 13 })).toBe(578);
});
