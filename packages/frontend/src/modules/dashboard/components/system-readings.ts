import type { HostTelemetry } from '@runtipi/common/schemas';
import type { Telemetry } from '@/desktop/telemetry';

export const statusBytes = (value: number | null) => {
  if (value === null || !Number.isFinite(value) || value < 0) return 'Unavailable';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log2(Math.max(1, value)) / 10));
  return `${(value / 1024 ** index).toFixed(index > 0 && value / 1024 ** index < 100 ? 1 : 0)} ${units[index]}`;
};
export const usagePercent = (used: number | null, total: number | null) =>
  used !== null && total !== null && Number.isFinite(used) && Number.isFinite(total) && total > 0 && used >= 0 && used <= total
    ? (used / total) * 100
    : null;

export function statusNetwork(host: HostTelemetry | undefined, core: Telemetry | undefined) {
  const current = host?.available && !host.stale ? host : null;
  const candidate = current?.network
    .filter((item) => item.state === 'up' && !/^(?:lo$|veth|docker|br-)/.test(item.interface))
    .sort((left, right) => Number(right.speedMbps !== null) - Number(left.speedMbps !== null) || left.interface.localeCompare(right.interface))[0];
  if (candidate) return { ...candidate, label: 'Network', scope: 'host' as const };
  const fallback = core?.network.find((item) => item.interface !== 'lo');
  return fallback ? { ...fallback, label: 'Orbis core network', speedMbps: null, scope: 'runtime' as const } : null;
}
