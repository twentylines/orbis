import { expect, test } from 'bun:test';
import { freshSetupSteps, nextSetupStep, previousSetupStep, setupCanFinish, setupPosition, setupStepCopy, type SetupStep } from './setup-navigation';

test('entry requires an explicit fresh or restore choice', () => {
  expect(nextSetupStep('choose', null)).toBeNull();
  expect(nextSetupStep('choose', 'fresh')).toBe('server');
  expect(nextSetupStep('choose', 'restore')).toBe('restore');
  expect(nextSetupStep('choose', 'transfer')).toBe('transfer');
});

test('fresh setup preserves every existing personalisation and update step in order', () => {
  const visited: SetupStep[] = ['choose'];
  let next = nextSetupStep('choose', 'fresh');
  while (next) {
    visited.push(next);
    next = nextSetupStep(next, 'fresh');
  }
  expect(visited).toEqual(['choose', 'server', 'colour', 'wallpaper', 'performance', 'updates', 'ready']);
  expect(visited).toEqual([...freshSetupSteps]);
});

test('back from restore returns to the choice and never skips into the fresh completion step', () => {
  expect(previousSetupStep('restore')).toBe('choose');
  expect(previousSetupStep('transfer')).toBe('choose');
  expect(nextSetupStep('transfer', 'transfer')).toBeNull();
  expect(nextSetupStep('restore', 'restore')).toBeNull();
  expect(previousSetupStep('choose')).toBeNull();
  expect(previousSetupStep('server')).toBe('choose');
  expect(previousSetupStep('ready')).toBe('updates');
});

test('restore and failed or incomplete setup cannot acknowledge fresh onboarding', () => {
  for (const step of [...freshSetupSteps, 'restore', 'transfer'] as const) {
    expect(setupCanFinish(step, 'restore')).toBe(false);
    expect(setupCanFinish(step, null)).toBe(false);
    expect(setupCanFinish(step, 'transfer')).toBe(false);
    expect(setupCanFinish(step, 'fresh')).toBe(step === 'ready');
  }
});

test('every fresh step has copy and a stable bounded position for directional transitions', () => {
  for (const [index, step] of freshSetupSteps.entries()) {
    expect(setupPosition(step)).toEqual({ current: index + 1, total: 7 });
    expect(setupStepCopy[step].title.length).toBeGreaterThan(0);
    expect(setupStepCopy[step].description.length).toBeGreaterThan(0);
  }
  expect(setupPosition('restore')).toEqual({ current: 2, total: 2 });
  expect(setupPosition('transfer')).toEqual({ current: 2, total: 2 });
  expect(setupStepCopy.restore.title).not.toContain('Ready');
});
