/// <reference types="bun" />
import { expect, test } from 'bun:test';
import type { ContainerReading } from '@runtipi/common/schemas';
import { appDockerHealth } from './container-health';
const container = (health: ContainerReading['health'], state = 'running') => ({ health, state }) as ContainerReading;
test('counts configured checks without treating unchecked auxiliary containers as failed coverage', () => {
  const result = appDockerHealth([container('healthy'), ...Array.from({ length: 4 }, () => container('not-configured'))]);
  expect(result).toEqual({ state: 'healthy', label: 'Healthy', checked: 1, total: 5 });
});
test('keeps apps with no configured checks distinct from healthy checks', () => {
  expect(appDockerHealth([container('not-configured')])).toMatchObject({ state: 'running', label: 'Running', checked: 0 });
  expect(appDockerHealth([container('healthy')])).toMatchObject({ state: 'healthy', checked: 1 });
});
test('never masks failed, unknown, starting or stopped containers behind one healthy service', () => {
  for (const [health, state, expected] of [
    ['unhealthy', 'running', 'unhealthy'],
    ['unknown', 'running', 'unknown'],
    ['starting', 'running', 'starting'],
    ['not-configured', 'exited', 'partial'],
  ] as const)
    expect(appDockerHealth([container('healthy'), container(health, state)]).state).toBe(expected);
  expect(appDockerHealth([container('not-configured', 'exited')]).state).toBe('stopped');
  expect(appDockerHealth([]).state).toBe('unknown');
});
