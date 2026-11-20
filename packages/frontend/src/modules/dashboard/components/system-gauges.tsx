import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import { IconCpu, IconDatabase, IconDeviceDesktopAnalytics } from '@tabler/icons-react';
import { statusBytes, usagePercent } from './system-readings';
import './system-gauges.css';
import { highUsage } from './system-health';

type Props = {
  cpu: number | null;
  clockGHz?: number | null;
  memoryUsed: number | null;
  memoryTotal: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
  diskLabel: string;
  gpus?: { id: string; label: string; utilizationPercent: number | null; simulated?: boolean }[];
};

export function SystemGauges({ cpu, clockGHz, memoryUsed, memoryTotal, diskUsed, diskTotal, diskLabel, gpus = [] }: Props) {
  const reportedClock = typeof clockGHz === 'number' && Number.isFinite(clockGHz) && clockGHz > 0 ? clockGHz : null;
  const memoryPercent = usagePercent(memoryUsed, memoryTotal);
  const diskPercent = usagePercent(diskUsed, diskTotal);
  const readings: {
    id: string;
    title: string;
    value: number | null;
    icon: typeof IconCpu;
    hash: string;
    description?: string;
    simulated?: boolean;
  }[] = [
    { id: 'cpu', title: 'CPU', value: cpu, icon: IconCpu, hash: 'telemetry-cpu-title' },
    { id: 'memory', title: 'Memory', value: memoryPercent, icon: IconDeviceDesktopAnalytics, hash: 'telemetry-memory-title' },
    {
      id: 'storage',
      title: 'Storage',
      value: diskPercent,
      icon: IconDatabase,
      hash: diskLabel === 'Storage' ? 'host-storage-title' : 'telemetry-disks-title',
    },
  ];
  const reportedGpus = gpus.filter(
    ({ utilizationPercent: value }) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100,
  );
  const gpuReadings = reportedGpus.map((gpu, index) => ({
    id: `gpu:${gpu.id}`,
    title: reportedGpus.length === 1 ? 'GPU' : `GPU ${index + 1}`,
    value: gpu.utilizationPercent,
    icon: IconDeviceDesktopAnalytics,
    hash: 'gpu',
    description: gpu.label,
    simulated: gpu.simulated,
  }));
  return (
    <div className="system-gauges-group">
      <div className="system-gauges">
        {[...readings.slice(0, 1), ...gpuReadings, ...readings.slice(1)].map(({ id, title, value, icon: Icon, hash, description, simulated }) => (
          <Link
            key={id}
            title={description}
            to={hash === 'gpu' ? '/monitor?section=performance&metric=gpu' : `/monitor#${hash}`}
            className="system-gauge"
            data-high={highUsage(value)}
            aria-label={`${title}, ${value === null ? 'unavailable' : `${value.toFixed(1)} percent${highUsage(value) ? ', high' : ''}`}${simulated ? ', simulated preview' : ''}`}
          >
            <span className="system-dial" style={{ '--dial-progress': `${Math.max(0, Math.min(100, value ?? 0))}%` } as CSSProperties}>
              <Icon size={16} aria-hidden="true" />
              <strong>{value === null ? '—' : `${value.toFixed(value < 10 ? 1 : 0)}%`}</strong>
            </span>
            <span>{title}</span>
          </Link>
        ))}
      </div>
      <dl className="system-capacities">
        <div title="Mean CPU clock reported by the host kernel in this sample; frequency varies with workload.">
          <dt>CPU clock</dt>
          <dd>{reportedClock === null ? 'Unavailable' : `${reportedClock.toFixed(2)} GHz`}</dd>
        </div>
        <div>
          <dt>Memory</dt>
          <dd>
            {memoryPercent === null ? (
              <span>Unavailable</span>
            ) : (
              <>
                <span>{statusBytes(memoryUsed)}</span>
                <span aria-hidden="true"> / </span>
                <span>{statusBytes(memoryTotal)}</span>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>{diskLabel}</dt>
          <dd>
            {diskPercent === null ? (
              <span>Unavailable</span>
            ) : (
              <>
                <span>{statusBytes(diskUsed)}</span>
                <span aria-hidden="true"> / </span>
                <span>{statusBytes(diskTotal)}</span>
              </>
            )}
          </dd>
        </div>
      </dl>
    </div>
  );
}
