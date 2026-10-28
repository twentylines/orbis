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
};

export function SystemGauges({ cpu, clockGHz, memoryUsed, memoryTotal, diskUsed, diskTotal, diskLabel }: Props) {
  const memoryPercent = usagePercent(memoryUsed, memoryTotal);
  const diskPercent = usagePercent(diskUsed, diskTotal);
  const readings = [
    { title: 'CPU', value: cpu, icon: IconCpu, hash: 'telemetry-cpu-title' },
    { title: 'Memory', value: memoryPercent, icon: IconDeviceDesktopAnalytics, hash: 'telemetry-memory-title' },
    {
      title: 'Storage',
      value: diskPercent,
      icon: IconDatabase,
      hash: diskLabel === 'Storage' ? 'host-storage-title' : 'telemetry-disks-title',
    },
  ];
  return (
    <div className="system-gauges-group">
      <div className="system-gauges">
        {readings.map(({ title, value, icon: Icon, hash }) => (
          <Link
            key={title}
            to={`/monitor#${hash}`}
            className="system-gauge"
            data-high={highUsage(value)}
            aria-label={`${title}, ${value === null ? 'unavailable' : `${value.toFixed(1)} percent${highUsage(value) ? ', high' : ''}`}`}
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
        {typeof clockGHz === 'number' && Number.isFinite(clockGHz) && clockGHz > 0 ? (
          <div title="Mean CPU clock reported by the host kernel in this sample; frequency varies with workload.">
            <dt>CPU clock</dt>
            <dd>{clockGHz.toFixed(2)} GHz</dd>
          </div>
        ) : null}
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
