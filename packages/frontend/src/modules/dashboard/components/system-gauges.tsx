import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import { IconCpu, IconDatabase, IconDeviceDesktopAnalytics } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { Telemetry } from '@/desktop/telemetry';
import { statusBytes, usagePercent } from './system-readings';
import './system-gauges.css';
import { highUsage } from './system-health';

type Props = {
  cpu: number | null;
  clockGHz?: number | null;
  memoryUsed: number | null;
  memoryTotal: number | null;
  memoryScope?: Telemetry['memory']['scope'];
  diskUsed: number | null;
  diskTotal: number | null;
  diskLabel: string;
  gpus?: { id: string; label: string; utilizationPercent: number | null; simulated?: boolean }[];
};

export function SystemGauges({ cpu, clockGHz, memoryUsed, memoryTotal, memoryScope, diskUsed, diskTotal, diskLabel, gpus = [] }: Props) {
  const { t } = useTranslation();
  const memoryLabel = memoryScope === 'cgroup' ? 'LXC memory' : memoryScope === 'runtime' ? 'Core memory' : 'Memory';
  const estimated = memoryScope === 'containers' ? t('DASHBOARD_MEMORY_ESTIMATED', { defaultValue: 'estimated' }) : undefined;
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
    caption?: string;
  }[] = [
    { id: 'cpu', title: 'CPU', value: cpu, icon: IconCpu, hash: 'telemetry-cpu-title' },
    {
      id: 'memory',
      title: memoryLabel,
      value: memoryPercent,
      icon: IconDeviceDesktopAnalytics,
      hash: 'telemetry-memory-title',
      description: memoryScope === 'containers' ? 'Estimated Docker container memory' : memoryScope === 'cgroup' ? 'LXC memory limit' : undefined,
      caption: estimated,
    },
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
  const gpuReadings: typeof readings = reportedGpus.map((gpu, index) => ({
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
        {[...readings.slice(0, 1), ...gpuReadings, ...readings.slice(1)].map(
          ({ id, title, value, icon: Icon, hash, description, simulated, caption }) => (
            <Link
              key={id}
              to={hash === 'gpu' ? '/monitor?section=performance&metric=gpu' : `/monitor#${hash}`}
              className="system-gauge"
              data-high={highUsage(value)}
              aria-label={`${title}, ${value === null ? 'unavailable' : `${value.toFixed(1)} percent${highUsage(value) ? ', high' : ''}`}${caption ? `, ${caption}` : ''}${simulated ? ', simulated preview' : ''}${description && description !== title ? `, ${description}` : ''}`}
            >
              <span className="system-dial" style={{ '--dial-progress': `${Math.max(0, Math.min(100, value ?? 0))}%` } as CSSProperties}>
                <Icon size={16} aria-hidden="true" />
                <strong>{value === null ? '—' : `${value.toFixed(value < 10 ? 1 : 0)}%`}</strong>
              </span>
              <span className="system-gauge-label">
                {title}
                {caption ? <small>{caption}</small> : null}
              </span>
            </Link>
          ),
        )}
      </div>
      <dl className="system-capacities">
        <div>
          <dt>CPU clock</dt>
          <dd>{reportedClock === null ? 'Unavailable' : `${reportedClock.toFixed(2)} GHz`}</dd>
        </div>
        <div>
          <dt>
            {memoryLabel}
            {estimated ? ` · ${estimated}` : ''}
          </dt>
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
