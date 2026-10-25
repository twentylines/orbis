import { describe, expect, it } from 'vitest';
import { cpuUsage, parseHostCpuStat, reportedCpuClockGHz, reportedCpuModel } from '../host-cpu';

describe('host CPU snapshots', () => {
  it('reads a host model on x86 or ARM without exposing unrelated cpuinfo fields', () => {
    expect(reportedCpuModel('processor : 0\nmodel name : Intel(R)  Core(TM) i7\nprocessor : 1\nmodel name : Intel(R) Core(TM) i7\n')).toBe(
      'Intel(R) Core(TM) i7',
    );
    expect(reportedCpuModel('processor : 0\nProcessor : AArch64 Processor rev 4 (aarch64)\nHardware : ARM board\nSerial : private\n')).toBe(
      'AArch64 Processor rev 4 (aarch64)',
    );
    expect(reportedCpuModel('Hardware : ARM board\nSerial : private\n')).toBeNull();
    expect(reportedCpuModel('CPU implementer : 0x41\nSerial : private\n')).toBeNull();
    expect(reportedCpuModel('model name : \nSerial : private\n')).toBeNull();
    expect(reportedCpuModel(null)).toBeNull();
  });
  it('reports the mean kernel CPU MHz sample without substituting a model name or nominal clock', () => {
    expect(reportedCpuClockGHz('model name : CPU @ 9.90GHz\ncpu MHz\t: 2400.0\ncpu MHz\t: 3600.0\n')).toBe(3);
    expect(reportedCpuClockGHz('model name : CPU @ 9.90GHz\n')).toBeNull();
    expect(reportedCpuClockGHz('cpu MHz : 0\n')).toBeNull();
    expect(reportedCpuClockGHz(null)).toBeNull();
  });
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
