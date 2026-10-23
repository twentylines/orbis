export const startupCycle = 1400;

export function startupCycleRemaining(elapsed: number) {
  const time = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  return Math.max(0, Math.ceil(Math.max(1, time) / startupCycle) * startupCycle - time);
}
