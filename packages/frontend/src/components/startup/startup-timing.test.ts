import { expect, test } from 'bun:test';
import { startupCycleRemaining } from './startup-timing';

test('finishes the current boot cycle without restarting or waiting for an extra cycle', () => {
  for (const [elapsed, remaining] of [
    [0, 1400],
    [600, 800],
    [1399, 1],
    [1400, 0],
    [1401, 1399],
    [4200, 0],
  ] as const) {
    expect(startupCycleRemaining(elapsed)).toBe(remaining);
  }
});
