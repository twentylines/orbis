import { describe, expect, it } from 'vitest';
import { canSnapWindow, clampWindowBounds, defaultWindowBounds, placedWindowBounds } from '../../../../frontend/src/desktop/window-geometry';

describe('desktop window bounds', () => {
  const area = { x: 64, y: 108, width: 1312, height: 760 };
  it('keeps a window reachable after moving from a larger display', () => {
    const result = clampWindowBounds({ x: 3500, y: 1800, width: 1600, height: 1200 }, area);
    expect(result).toEqual(area);
    expect(clampWindowBounds({ x: -100, y: -100, width: 700, height: 500 }, area)).toEqual({ ...area, width: 700, height: 500 });
  });
  it('respects useful minimum sizes and fits a shorter available area', () => {
    expect(clampWindowBounds({ x: 64, y: 108, width: 1, height: 1 }, area)).toEqual({ x: 64, y: 108, width: 520, height: 320 });
    const small = { x: 20, y: 98, width: 400, height: 240 };
    expect(defaultWindowBounds(small)).toEqual(small);
  });
  it('snaps to equal halves without covering the central gap or system chrome', () => {
    expect(canSnapWindow(area)).toBe(true);
    const left = placedWindowBounds('left', defaultWindowBounds(area), area);
    const right = placedWindowBounds('right', defaultWindowBounds(area), area);
    expect(left.width).toBe(right.width);
    expect(right.x - left.x - left.width).toBe(16);
    expect(right.x + right.width).toBe(area.x + area.width);
    expect(left.y).toBe(area.y);
    expect(left.height).toBe(area.height);
    expect(placedWindowBounds('maximized', left, area)).toEqual(area);
  });
  it('falls back to a reachable floating placement when a snapped window loses room', () => {
    const smaller = { ...area, width: 900 };
    expect(canSnapWindow(smaller)).toBe(false);
    const bounds = { x: 1000, y: 200, width: 600, height: 500 };
    expect(placedWindowBounds('right', bounds, smaller)).toEqual(clampWindowBounds(bounds, smaller));
  });
});
