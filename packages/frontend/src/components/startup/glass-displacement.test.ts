import { expect, test } from 'bun:test';
import { glassDisplacement } from './glass-displacement';

test('refraction bends opposite edges in opposite directions and leaves the centre undistorted', () => {
  const width = 320;
  const height = 240;
  const map = glassDisplacement(width, height);
  const pixel = (x: number, y: number) => {
    const offset = (Math.floor((y / height) * map.height) * map.width + Math.floor((x / width) * map.width)) * 4;
    return [...map.data.slice(offset, offset + 4)];
  };
  expect(pixel(160, 120)).toEqual([128, 128, 128, 255]);
  expect(pixel(12, 120)[0]).toBeLessThan(128);
  expect(pixel(308, 120)[0]).toBeGreaterThan(128);
  expect(pixel(160, 12)[1]).toBeLessThan(128);
  expect(pixel(160, 228)[1]).toBeGreaterThan(128);
  expect(pixel(12, 12)[0]).toBeLessThan(128);
  expect(pixel(12, 12)[1]).toBeLessThan(128);
});

test('large-screen refraction textures stay bounded and opaque', () => {
  const map = glassDisplacement(7680, 4320);
  expect(map.width).toBeLessThanOrEqual(1600);
  expect(map.height).toBeLessThanOrEqual(1000);
  expect(map.data.byteLength).toBe(map.width * map.height * 4);
  for (let index = 3; index < map.data.length; index += 4000) expect(map.data[index]).toBe(255);
});
