import { expect, test } from 'bun:test';
import { appSnapTarget, canSplitAppWindows, clampAppBounds, resizeAppBounds, splitAppBounds, type ResizeEdge } from './app-window-layout';

const area = { x: 24, y: 104, width: 1392, height: 760 };
const bounds = { x: 224, y: 204, width: 800, height: 500 };

test('every resize edge moves the intended edge while keeping the opposite edge fixed', () => {
  for (const edge of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as ResizeEdge[]) {
    const next = resizeAppBounds(bounds, edge, 40, 30, area);
    expect(next.x).toBe(edge.includes('w') ? 264 : 224);
    expect(next.y).toBe(edge.includes('n') ? 234 : 204);
    expect(next.x + next.width).toBe(edge.includes('e') ? 1064 : 1024);
    expect(next.y + next.height).toBe(edge.includes('s') ? 734 : 704);
  }
});

test('resizing from the left or top cannot cross the opposite edge or escape the usable screen', () => {
  expect(resizeAppBounds(bounds, 'nw', 10000, 10000, area)).toEqual({ x: 604, y: 404, width: 420, height: 300 });
  expect(resizeAppBounds(bounds, 'nw', -10000, -10000, area)).toEqual({ x: 24, y: 104, width: 1000, height: 600 });
  expect(resizeAppBounds(bounds, 'se', 10000, 10000, area)).toEqual({ x: 224, y: 204, width: 1192, height: 660 });
});

test('split panes fill the usable screen with one shared gap and keep both apps usable at extreme ratios', () => {
  for (const width of [1052, 1392, 2205]) {
    const screen = { ...area, width };
    expect(canSplitAppWindows(screen)).toBe(true);
    for (const ratio of [0.01, 0.5, 0.99]) {
      const left = splitAppBounds('left', screen, ratio);
      const right = splitAppBounds('right', screen, ratio);
      expect(left.x).toBe(screen.x);
      expect(left.width).toBeGreaterThanOrEqual(420);
      expect(right.width).toBeGreaterThanOrEqual(420);
      expect(right.x - left.x - left.width).toBe(16);
      expect(right.x + right.width).toBe(screen.x + screen.width);
      expect(left.y).toBe(right.y);
      expect(left.height).toBe(right.height);
    }
  }
});

test('snap targets use screen edges, and narrow browser sizes keep windows inside the available area', () => {
  expect(appSnapTarget(24, 300, area)).toBe('left');
  expect(appSnapTarget(1416, 300, area)).toBe('right');
  expect(appSnapTarget(700, 104, area)).toBe('maximized');
  expect(appSnapTarget(700, 300, area)).toBeNull();
  const narrow = { x: 16, y: 140, width: 288, height: 240 };
  expect(canSplitAppWindows(narrow)).toBe(false);
  expect(clampAppBounds(bounds, narrow)).toEqual(narrow);
});
