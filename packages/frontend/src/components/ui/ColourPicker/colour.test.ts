import { expect, test } from 'bun:test';
import { hexToHSV, hsvToHex } from './colour';

test.each(['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#e2b4ce', '#914725', '#808080', '#17a4f2'])(
  'colour controls preserve %s through HSV conversion',
  (hex) => {
    expect(hsvToHex(hexToHSV(hex))).toBe(hex);
  },
);
test('hue wraps without changing brightness or saturation', () => {
  expect(hsvToHex({ hue: 360, saturation: 100, brightness: 100 })).toBe('#ff0000');
  expect(hsvToHex({ hue: -120, saturation: 100, brightness: 100 })).toBe('#0000ff');
});
