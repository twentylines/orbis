/// <reference types="bun" />
import { expect, test } from 'bun:test';
import type { ContainerReading, ContainerTelemetry } from '@runtipi/common/schemas';
import { appDockerHealth, appHealthSnapshot, sameAppHealth, containerHealthReason, displayedAppStatus } from './container-health';
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

test('exited containers cannot inherit stale starting or unhealthy check states', () => {
  for (const health of ['healthy', 'starting', 'unhealthy', 'unknown', 'not-configured'] as const) {
    expect(appDockerHealth([container(health, 'exited')]).state).toBe('stopped');
    expect(appDockerHealth([container('healthy'), container(health, 'exited')]).state).toBe('partial');
  }
  expect(appDockerHealth([container('starting')]).label).toBe('Readiness pending');
  expect(appDockerHealth([container('starting', 'restarting')]).label).toBe('Restarting');
});

test('live process state overrides an obsolete running app record without confusing readiness with lifecycle', () => {
  expect(displayedAppStatus('running', appDockerHealth([container('not-configured', 'restarting')]))).toBe('restarting');
  expect(displayedAppStatus('running', appDockerHealth([container('unhealthy', 'exited')]))).toBe('stopped');
  expect(displayedAppStatus('running', appDockerHealth([container('starting')]))).toBe('running');
  expect(displayedAppStatus('installing', appDockerHealth([container('healthy')]))).toBe('installing');
});

test('health explanations use safe structured evidence and distinguish readiness from process state', () => {
  const item = { ...container('unhealthy'), readiness: { failingStreak: 3, lastCheckExitCode: 1, intervalSeconds: 30 } } as ContainerReading;
  expect(containerHealthReason(item)).toContain('3 consecutive failed checks');
  expect(containerHealthReason(item)).toContain('last exit code 1');
  expect(containerHealthReason(container('starting'))).toContain('process is running');
  expect(containerHealthReason(container('unhealthy', 'exited'))).toBe('Container state: exited.');
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
