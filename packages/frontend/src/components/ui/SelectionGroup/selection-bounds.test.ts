import { expect, test } from 'bun:test';
import { selectionBounds } from './selection-bounds';

test('keeps the selector in its group when an app window is scaled or moving', () => {
  expect(
    selectionBounds(
      { x: 180, y: 90, width: 600, height: 100 },
      { x: 392, y: 102, width: 180, height: 76 },
      { width: 300, height: 50, borderX: 1, borderY: 1, scrollX: 0, scrollY: 0 },
    ),
  ).toEqual({ x: 105, y: 5, width: 90, height: 38 });
});
test('tracks wrapped rows and scroll offsets without using viewport coordinates as local positions', () => {
  expect(
    selectionBounds(
      { x: 24, y: 100, width: 320, height: 104 },
      { x: 30, y: 156, width: 130, height: 42 },
      { width: 320, height: 104, borderX: 1, borderY: 1, scrollX: 14, scrollY: 20 },
    ),
  ).toEqual({ x: 19, y: 75, width: 130, height: 42 });
});
test('does not invent a selector position for a hidden group', () => {
  expect(
    selectionBounds(
      { x: 0, y: 0, width: 0, height: 0 },
      { x: 0, y: 0, width: 0, height: 0 },
      { width: 0, height: 0, borderX: 0, borderY: 0, scrollX: 0, scrollY: 0 },
    ),
  ).toBeNull();
});
