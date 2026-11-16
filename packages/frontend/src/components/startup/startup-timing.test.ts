import { expect, test } from 'bun:test';
import { setupPreparationMinimum, startupCycleRemaining, startupPhaseDelay, waitForStartupFormation } from './startup-timing';

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

test('workspace and setup wait for actual cluster completion and can cancel their handover', async () => {
  let finish = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const surface = { querySelectorAll: () => [{ getAnimations: () => [{ finished }] }] } as unknown as HTMLElement;
  let opened = 0;
  waitForStartupFormation(surface, () => opened++);
  await Promise.resolve();
  expect(opened).toBe(0);
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(opened).toBe(1);
  const stop = waitForStartupFormation(surface, () => opened++);
  stop();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(opened).toBe(1);
  waitForStartupFormation(null, () => opened++);
  expect(opened).toBe(2);
});

test('every Home landing blends for1200ms and other destinations use420ms, with no reduced-motion delay', () => {
  expect(setupPreparationMinimum).toBe(1600);
  expect(startupPhaseDelay('circle', true, false)).toBe(1700);
  expect(startupPhaseDelay('finishing', true, false)).toBe(200);
  expect(startupPhaseDelay('revealing', true, false)).toBe(1200);
  expect(startupPhaseDelay('revealing', false, false)).toBe(420);
  for (const landing of [false, true])
    for (const phase of ['circle', 'finishing', 'revealing'] as const) expect(startupPhaseDelay(phase, landing, true)).toBe(0);
});

test('a replaced dot animation must finish before the loader can depart', async () => {
  let cancelFirst: (reason: Error) => void = () => undefined;
  let finishReplacement: () => void = () => undefined;
  const first = new Promise<void>((_resolve, reject) => {
    cancelFirst = reject;
  });
  const replacement = new Promise<void>((resolve) => {
    finishReplacement = resolve;
  });
  let current = first;
  let opened = 0;
  const surface = { querySelectorAll: () => [{ getAnimations: () => [{ finished: current }] }] } as unknown as HTMLElement;
  const stop = waitForStartupFormation(surface, () => opened++);
  current = replacement;
  cancelFirst(new Error('Superseded'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(opened).toBe(0);
  finishReplacement();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(opened).toBe(1);
  stop();
});
