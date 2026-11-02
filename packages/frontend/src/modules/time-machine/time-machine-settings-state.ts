import type { TimeMachineSnapshot } from './contracts';

export type TimeMachineSettingsMode = 'loading' | 'setup' | 'active';

export function timeMachineSettingsMode(preferences: Pick<TimeMachineSnapshot['preferences'], 'enabled'> | null): TimeMachineSettingsMode {
  if (!preferences) return 'loading';
  return preferences.enabled ? 'active' : 'setup';
}

export function timeMachineRetentionSummary(count: number, bytes: number, formatBytes: (value: number) => string) {
  const captured = Math.max(0, Math.trunc(count));
  if (captured === 0) return 'No captured points yet. Nothing is retained.';
  return `${captured} captured ${captured === 1 ? 'point' : 'points'} · ${formatBytes(Math.max(0, bytes))} retained.`;
}
