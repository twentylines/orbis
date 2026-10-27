import { expect, test } from 'bun:test';
import { appMinimizeCrossfade } from './app-window-transition';

function opacityAt(frames: { offset: number; opacity: number }[], progress: number) {
  for (let index = 1; index < frames.length; index++) {
    const previous = frames[index - 1];
    const next = frames[index];
    if (previous && next && progress <= next.offset)
      return previous.opacity + ((next.opacity - previous.opacity) * (progress - previous.offset)) / (next.offset - previous.offset);
  }
  return frames.at(-1)?.opacity ?? 0;
}

test('minimization transfers visibility while both window and icon are still mounted', () => {
  const frames = appMinimizeCrossfade();
  for (const progress of [0.45, 0.6, 0.8]) {
    expect(opacityAt(frames.window, progress)).toBeGreaterThan(0);
    expect(opacityAt(frames.icon, progress)).toBeGreaterThan(0);
  }
  expect(opacityAt(frames.icon, 0.85)).toBe(1);
  expect(opacityAt(frames.window, 0.92)).toBe(0);
  expect(opacityAt(frames.window, 1)).toBe(0);
  expect(opacityAt(frames.icon, 1)).toBe(1);
});

test('automatic or interrupted departures retain their captured opacity without an initial visibility jump', () => {
  const frames = appMinimizeCrossfade(0.35);
  expect(opacityAt(frames.window, 0)).toBe(0.35);
  expect(opacityAt(frames.window, 0.4)).toBe(0.35);
  expect(opacityAt(frames.window, 0.7)).toBeLessThan(0.35);
  expect(opacityAt(frames.window, 1)).toBe(0);
});
