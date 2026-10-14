type CpuCounter = { total: number; idle: number };
export type CpuSnapshot = Map<string, CpuCounter>;

export function parseHostCpuStat(input: string): CpuSnapshot {
  const counters: CpuSnapshot = new Map();
  for (const line of input.split('\n')) {
    const fields = line.trim().split(/\s+/);
    const name = fields[0];
    if (!name || !/^cpu\d*$/.test(name)) continue;
    const values = fields.slice(1, 9).map(Number);
    if (values.length < 4 || values.some((value) => !Number.isFinite(value) || value < 0)) continue;
    counters.set(name, {
      total: values.reduce((sum, value) => sum + value, 0),
      idle: (values[3] ?? 0) + (values[4] ?? 0),
    });
  }
  return counters;
}

export function cpuUsage(previous: CpuSnapshot | null, current: CpuSnapshot): { totalPercent: number | null; perCorePercent: (number | null)[] } {
  const usage = (name: string): number | null => {
    const before = previous?.get(name);
    const now = current.get(name);
    if (!before || !now) return null;
    const elapsed = now.total - before.total;
    const idle = now.idle - before.idle;
    if (elapsed <= 0 || idle < 0 || idle > elapsed) return null;
    return Math.min(100, Math.max(0, ((elapsed - idle) / elapsed) * 100));
  };
  return {
    totalPercent: usage('cpu'),
    perCorePercent: [...current.keys()]
      .filter((name) => name !== 'cpu')
      .sort((left, right) => Number(left.slice(3)) - Number(right.slice(3)))
      .map(usage),
  };
}
