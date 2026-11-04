import { describe, expect, it } from 'bun:test';
import { appCpuPercent } from './whole-host-cpu';

const row = (cpuPercent: number | null, statsAvailable = true) => ({ cpuPercent, statsAvailable });

describe('whole-host application CPU', () => {
  it('sums comparable container readings without dividing again', () => {
    expect(appCpuPercent([row(12.5), row(12.5)])).toBe(25);
    expect(appCpuPercent([row(50), row(50)])).toBe(100);
    expect(appCpuPercent([row(0)])).toBe(0);
  });
  it('returns unknown for incomplete, invalid or incompatible sample windows', () => {
    for (const rows of [[], [row(null)], [row(1, false)], [row(Number.NaN)], [row(-1)], [row(101)], [row(80), row(30)]]) {
      expect(appCpuPercent(rows)).toBeNull();
    }
  });
});
