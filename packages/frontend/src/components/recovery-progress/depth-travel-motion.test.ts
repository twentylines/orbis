import { describe, expect, test } from 'bun:test';
import { depthCameraKeyframes, depthCameraZ, depthPlaneKeyframes } from './depth-travel-motion';

const z = (frame: Keyframe | undefined) => Number(/translateZ\(([-\d.e+]+)px\)/.exec(String(frame?.transform))?.[1]);

describe('depth plane keyframes', () => {
  test('includes opacity knots and linearly positioned transforms', () => {
    const frames = depthPlaneKeyframes(0, 1000, 1000);
    expect(frames.map((frame) => frame.offset)).toEqual([0, 0.15, 0.82, 1, 1]);
    expect(frames[1]?.opacity).toBeCloseTo(0.65);
    expect(frames[2]?.opacity).toBeCloseTo(0.9);
    expect(z(frames[1])).toBeCloseTo(-702);
    expect(frames.slice(-2).map(z)).toEqual([420, -900]);
  });

  test('keeps invisible jumps in both directions, including boundary endpoints', () => {
    const forward = depthPlaneKeyframes(900, 1100, 1000);
    expect(forward).toHaveLength(4);
    expect(forward[1]?.offset).toBeCloseTo(0.5);
    expect(forward[2]?.offset).toBe(forward[1]?.offset);
    expect(forward.slice(1, 3).map(z)).toEqual([420, -900]);
    expect(forward.slice(1, 3).map((frame) => frame.opacity)).toEqual([0, 0]);
    const reverse = depthPlaneKeyframes(1100, 900, 1000);
    expect(reverse.slice(1, 3).map(z)).toEqual([-900, 420]);
    expect(depthPlaneKeyframes(1000, 900, 1000).slice(0, 2).map(z)).toEqual([-900, 420]);
    expect(z(depthPlaneKeyframes(1100, 1000, 1000).at(-1))).toBe(-900);
  });

  test('rejects invalid and unbounded requests', () => {
    for (const args of [
      [Number.NaN, 1, 1000],
      [0, Number.POSITIVE_INFINITY, 1000],
      [0, 1, 0],
      [0, 5324801, 4800],
      [0, 10000, 0.01],
    ] as const) {
      expect(() => depthPlaneKeyframes(args[0], args[1], args[2])).toThrow(RangeError);
    }
    expect(depthPlaneKeyframes(0, 1024 * 5200, 4800).length).toBeLessThan(5000);
  });
});

describe('depth camera keyframes', () => {
  test('approximates the entire curve in either direction within 0.05 pixels', () => {
    for (const [origin, target] of [
      [0, 1024],
      [1024, 0],
      [3, 47],
      [5, 5],
    ] as const) {
      const frames = depthCameraKeyframes(origin, target);
      expect(frames.length).toBeLessThan(1000);
      expect(z(frames[0])).toBeCloseTo(depthCameraZ(origin), 10);
      expect(z(frames.at(-1))).toBeCloseTo(depthCameraZ(target), 10);
      let segment = 0;
      for (let i = 0; i <= 10000; i++) {
        const offset = i / 10000;
        while (segment < frames.length - 2 && Number(frames[segment + 1]?.offset) < offset) segment++;
        const a = frames[segment];
        const b = frames[segment + 1];
        if (!a || !b) throw new Error('Camera sample segment is missing');
        const fraction = (offset - Number(a.offset)) / (Number(b.offset) - Number(a.offset));
        const estimate = z(a) + (z(b) - z(a)) * fraction;
        expect(Math.abs(estimate - depthCameraZ(origin + (target - origin) * offset))).toBeLessThanOrEqual(0.05);
      }
    }
  });

  test('rejects nonfinite and out of range distances', () => {
    for (const value of [-1, 1025, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => depthCameraKeyframes(0, value)).toThrow(RangeError);
      expect(() => depthCameraZ(value)).toThrow(RangeError);
    }
  });
});
