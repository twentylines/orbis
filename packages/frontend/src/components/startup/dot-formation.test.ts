import { expect, test } from 'bun:test';
import { formationAmount, formationElapsed, formationProgress } from './dot-formation';
import { sessionOrbBounds } from './session-morph';

test('one document keeps its original formation clock through handovers and remounts', () => {
  const page = {};
  expect(formationElapsed(page, 100)).toBe(0);
  expect(formationElapsed(page, 600)).toBe(500);
  expect(formationElapsed(page, 2100)).toBe(2000);
  expect(formationElapsed({}, 2100)).toBe(0);
  expect(formationElapsed(page, 2100, 'setup')).toBe(0);
  expect(formationElapsed(page, 2600, 'setup')).toBe(500);
  expect(formationElapsed(page, 2600)).toBe(2500);
});

test('unknown progress stays unknown; measured progress fills core-to-arm groups without wrapping', () => {
  for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) expect(formationProgress(value)).toBeUndefined();
  expect(formationProgress(-10)).toBe(0);
  expect(formationProgress(150)).toBe(100);
  for (const percentage of [0, 12.5, 25, 50, 75, 100]) {
    const groups = Array.from({ length: 16 }, (_, index) => formationAmount(percentage, index));
    expect(groups.reduce((sum, amount) => sum + amount, 0)).toBe((16 * percentage) / 100);
    for (let index = 1; index < groups.length; index++) expect(groups[index]).toBeLessThanOrEqual(groups[index - 1] ?? 0);
  }
});

test('loading emblem grows on 4k displays while short and narrow screens keep their gutters', () => {
  expect(sessionOrbBounds(1920, 1080).width).toBe(176);
  expect(sessionOrbBounds(3840, 2160).width).toBe(352);
  expect(sessionOrbBounds(7680, 4320).width).toBe(352);
  expect(sessionOrbBounds(320, 740).width).toBe(176);
  expect(sessionOrbBounds(3840, 240).height).toBe(80);
});
