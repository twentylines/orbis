export function appCpuPercent(containers: ReadonlyArray<{ statsAvailable: boolean; cpuPercent: number | null }>): number | null {
  if (!containers.length) return null;
  let total = 0;
  for (const container of containers) {
    const value = container.cpuPercent;
    if (!container.statsAvailable || value === null || !Number.isFinite(value) || value < 0 || value > 100) return null;
    total += value;
  }
  // Independent container sample windows can overlap differently; an impossible total is not a measurement.
  return total <= 100 ? total : null;
}
