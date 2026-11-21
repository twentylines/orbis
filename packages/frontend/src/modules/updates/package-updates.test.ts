import { expect, test } from 'bun:test';
import { packageRestartRequired, selectedPackageNames, startPackageUpdate, type PackageUpdateRequest } from './package-updates';

const selected = [
  { name: 'libexample', installedVersion: '1.0', candidateVersion: '1.1', ready: true },
  { name: 'example-tools', installedVersion: '2.0', candidateVersion: '2.2', ready: true },
] as const;
const planId = '00000000-0000-4000-8000-000000000001';
const time = 1_800_000_000;
const plan = () => ({
  planId,
  createdAt: time,
  expiresAt: time + 900,
  selected: selected.map((item) => ({ ...item })),
  operations: selected.map((item) => ({ ...item, action: 'upgrade' })),
});

test('ready packages are selected by default and user deselection survives refreshed inventory', () => {
  expect(selectedPackageNames(selected, null)).toEqual(['libexample', 'example-tools']);
  expect(
    selectedPackageNames(
      selected.map((item) => ({ ...item })),
      ['example-tools'],
    ),
  ).toEqual(['example-tools']);
  expect(selectedPackageNames(selected, [])).toEqual([]);
  expect(selectedPackageNames(selected.slice(1), ['libexample', 'example-tools'])).toEqual(['example-tools']);
  const filtered = [
    { ...selected[0], ready: false },
    { ...selected[1], ready: undefined },
  ];
  expect(selectedPackageNames(filtered, null)).toEqual([]);
  expect(
    selectedPackageNames(
      filtered,
      selected.map((item) => item.name),
    ),
  ).toEqual([]);
  const large = Array.from({ length: 300 }, (_, index) => ({ name: `example-${index}`, installedVersion: '1', candidateVersion: '2', ready: true }));
  expect(selectedPackageNames(large, null)).toHaveLength(250);
});

test('one action obtains a fresh verified plan before applying exactly that plan once', async () => {
  const calls: Array<{ path: string; body: object }> = [];
  const stages: string[] = [];
  const request: PackageUpdateRequest = async <T>(path: string, body: object) => {
    calls.push({ path, body });
    return (path === 'packages/plan' ? plan() : { jobId: planId, state: 'queued' }) as T;
  };
  expect(
    await startPackageUpdate(
      selected,
      request,
      (stage) => stages.push(stage),
      () => time * 1000,
    ),
  ).toEqual({ jobId: planId, state: 'queued' });
  expect(calls).toEqual([
    { path: 'packages/plan', body: { names: ['libexample', 'example-tools'] } },
    { path: 'packages/apply', body: { planId } },
  ]);
  expect(stages).toEqual(['checking', 'starting']);
});

test('changed versions, expiry, missing or extra selections and removals never reach apply', async () => {
  const changed = {
    ...plan(),
    selected: selected.map((item, index) => ({ ...item, candidateVersion: index === 0 ? '1.2' : item.candidateVersion })),
  };
  for (const response of [
    changed,
    { ...plan(), expiresAt: time },
    { ...plan(), selected: [selected[0], selected[0]] },
    { ...plan(), selected: selected.slice(1) },
    { ...plan(), selected: [...selected, { ...selected[0], name: 'unexpected' }] },
    { ...plan(), operations: [...plan().operations, { name: 'example-server', action: 'remove', candidateVersion: '1' }] },
    { ...plan(), operations: [] },
    { ...plan(), planId: 'invalid' },
    null,
  ]) {
    const calls: string[] = [];
    const request: PackageUpdateRequest = async <T>(path: string) => {
      calls.push(path);
      return response as T;
    };
    await expect(startPackageUpdate(selected, request, undefined, () => time * 1000)).rejects.toThrow();
    expect(calls).toEqual(['packages/plan']);
  }
});

test('a delayed plan is checked at acceptance time and an ambiguous apply is never retried', async () => {
  let now = time * 1000;
  const delayed: PackageUpdateRequest = async <T>() => {
    now += 901_000;
    return plan() as T;
  };
  await expect(startPackageUpdate(selected, delayed, undefined, () => now)).rejects.toThrow('could not be verified');
  const calls: string[] = [];
  const uncertain: PackageUpdateRequest = async <T>(path: string) => {
    calls.push(path);
    if (path === 'packages/apply') throw new Error('Response unavailable');
    return plan() as T;
  };
  await expect(startPackageUpdate(selected, uncertain, undefined, () => time * 1000)).rejects.toThrow('Response unavailable');
  expect(calls).toEqual(['packages/plan', 'packages/apply']);
});

test('restart requires a current affirmative inventory and an available restart service that agrees', () => {
  const ready = { available: true, rebootRequired: true };
  expect(packageRestartRequired(ready, ready)).toBe(true);
  for (const missing of [undefined, { available: false, rebootRequired: true }, { available: true }, { available: true, rebootRequired: false }]) {
    expect(packageRestartRequired(missing, ready)).toBe(false);
    expect(packageRestartRequired(ready, missing)).toBe(false);
  }
});

test('an unrelated or incomplete start acknowledgment cannot report this update as started', async () => {
  for (const response of [null, { jobId: '00000000-0000-4000-8000-000000000002', state: 'queued' }, { jobId: planId, state: 'complete' }]) {
    const calls: string[] = [];
    const request: PackageUpdateRequest = async <T>(path: string) => {
      calls.push(path);
      return (path === 'packages/plan' ? plan() : response) as T;
    };
    await expect(startPackageUpdate(selected, request, undefined, () => time * 1000)).rejects.toThrow('not confirmed');
    expect(calls).toEqual(['packages/plan', 'packages/apply']);
  }
});
