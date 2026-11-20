import { expect, test } from 'bun:test';
import { previewGpu } from './home-gpu-preview';

test('simulated GPU requires an explicitly enabled named preview build', () => {
  for (const [snapshot, enabled] of [
    [undefined, undefined],
    ['preview', undefined],
    [undefined, '1'],
    ['', '1'],
    ['preview', '0'],
  ]) {
    expect(previewGpu(snapshot, enabled, undefined)).toBeNull();
  }
  const result = previewGpu('snapshot.20261121', '1', '2026-11-20T17:00:00Z');
  expect(result?.[0]?.label).toContain('simulated');
  expect(result?.[0]?.utilizationPercent).toBeGreaterThan(0);
  expect(result?.[0]?.utilizationPercent).toBeLessThan(100);
});
