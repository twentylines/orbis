/// <reference types="bun" />
import { expect, test } from 'bun:test';
import type { ContainerReading, ContainerTelemetry } from '@runtipi/common/schemas';
import { appDockerHealth, appHealthSnapshot, sameAppHealth } from './container-health';
const container = (health: ContainerReading['health'], state = 'running') => ({ health, state }) as ContainerReading;
test('shares per-app health work across tiles without retaining old CPU samples or masking health changes', () => {
  const sample = {
    available: true,
    containers: [
      { ...container('healthy'), appUrn: 'one:store' },
      { ...container('unhealthy'), appUrn: 'two:store' },
    ],
  } as ContainerTelemetry;
  const first = appHealthSnapshot(sample, 'one:store');
  expect(appHealthSnapshot(sample, 'one:store')).toBe(first);
  const cpuOnly = { ...sample, sampledAt: 'later' };
  expect(sameAppHealth(first, appHealthSnapshot(cpuOnly, 'one:store'))).toBe(true);
  expect(appHealthSnapshot(sample, 'two:store').state).toBe('unhealthy');
  const failed = { ...sample, containers: [{ ...sample.containers[0], health: 'unhealthy' }] } as ContainerTelemetry;
  expect(sameAppHealth(first, appHealthSnapshot(failed, 'one:store'))).toBe(false);
  expect(appHealthSnapshot(sample, 'one:store', true).label).toBe('Docker unavailable');
});
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
