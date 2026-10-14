import { describe, expect, it } from 'vitest';
import { cpuUsage, parseHostCpuStat } from '../host-cpu';

describe('host CPU snapshots', () => {
  it('calculates aggregate and ordered per-core load from counter deltas', () => {
    const before = parseHostCpuStat('cpu 10 0 10 80 0 0 0 0 0 0\ncpu1 5 0 5 40\ncpu0 5 0 5 40\n');
    const after = parseHostCpuStat('cpu 20 0 20 160 0 0 0 0 0 0\ncpu1 10 0 10 80\ncpu0 10 0 10 80\n');

    expect(cpuUsage(before, after)).toEqual({ totalPercent: 20, perCorePercent: [20, 20] });
  });

  it('withholds a reading until a valid second sample exists', () => {
    const first = parseHostCpuStat('cpu 10 0 10 80\ncpu0 5 0 5 40\n');
    const reset = parseHostCpuStat('cpu 1 0 1 8\ncpu0 1 0 1 8\n');

    expect(cpuUsage(null, first)).toEqual({ totalPercent: null, perCorePercent: [null] });
    expect(cpuUsage(first, reset)).toEqual({ totalPercent: null, perCorePercent: [null] });
  });
});
