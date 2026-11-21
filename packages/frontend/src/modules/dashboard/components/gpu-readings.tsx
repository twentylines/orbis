import type { ReactNode } from 'react';
import type { HostGpu, HostSensors } from '@runtipi/common/schemas';
import { IconDeviceDesktopAnalytics } from '@tabler/icons-react';
import { Link } from 'react-router';
import './gpu-readings.css';
import { statusBytes, usagePercent } from './system-readings';

export function GpuReadings({
  data,
  stale = false,
  compact = false,
  renderLiveChart,
}: {
  data?: HostSensors;
  stale?: boolean;
  compact?: boolean;
  renderLiveChart?: (gpu: HostGpu) => ReactNode;
}) {
  const gpus = data?.available ? data.gpus : [];
  if (compact && !gpus.length) return null;
  return (
    <section className={compact ? 'workspace-gpus' : 'monitor-gpus'} aria-label="GPU utilisation">
      {compact ? (
        <Link className="workspace-gpu-heading" to="/monitor?section=performance&metric=gpu">
          <IconDeviceDesktopAnalytics size={17} aria-hidden="true" /> GPU
        </Link>
      ) : (
        <header className="monitor-resource-heading">
          <div>
            <h2>GPU</h2>
            <p>Graphics processors reported by this host</p>
          </div>
          <span className="monitor-sample-label">
            {stale
              ? 'Last reported readings'
              : data?.available
                ? 'Hardware sample · every 30 seconds'
                : data
                  ? 'Hardware readings unavailable'
                  : 'Reading hardware…'}
          </span>
        </header>
      )}
      {renderLiveChart && gpus.some((gpu) => gpu.utilizationPercent !== null) ? (
        <p className="monitor-processor-caption">Last 60 seconds · one GPU sample every 30 seconds. Gaps mean missing readings.</p>
      ) : null}
      {stale ? <p className="monitor-resource-note">Readings delayed. Values below are from the last hardware sample.</p> : null}
      <div className="monitor-gpu-grid">
        {gpus.map((gpu, index) => {
          const utilisation = gpu.utilizationPercent;
          const reported = utilisation !== null && Number.isFinite(utilisation) && utilisation >= 0 && utilisation <= 100;
          const memory = usagePercent(gpu.memoryUsedBytes, gpu.memoryTotalBytes);
          return (
            <article className="monitor-gpu-card" key={gpu.id}>
              <header>
                <span className="monitor-resource-eyebrow">GPU {index}</span>
                <h3 title={gpu.label}>{gpu.label}</h3>
                {compact ? null : <p>{[gpu.vendor, gpu.driver].filter(Boolean).join(' · ') || 'Driver not reported'}</p>}
              </header>
              <dl className="monitor-resource-facts">
                <div>
                  <dt>Utilisation</dt>
                  <dd>{reported ? `${utilisation.toFixed(1)}%` : 'Not reported'}</dd>
                </div>
                {compact ? null : (
                  <div>
                    <dt>GPU memory</dt>
                    <dd>
                      {gpu.memoryUsedBytes === null ? 'Not reported' : `${statusBytes(gpu.memoryUsedBytes)} / ${statusBytes(gpu.memoryTotalBytes)}`}
                    </dd>
                  </div>
                )}
              </dl>
              {renderLiveChart?.(gpu)}
              {reported && !renderLiveChart ? <meter min={0} max={100} value={utilisation} aria-label={`${gpu.label} utilisation`} /> : null}
              {!compact && memory !== null ? <meter min={0} max={100} value={memory} aria-label={`${gpu.label} memory usage`} /> : null}
            </article>
          );
        })}
      </div>
      {gpus.length ? (
        compact ? null : (
          <p className="monitor-resource-note">Utilisation and GPU memory depend on driver support. Unreported metrics are not treated as zero.</p>
        )
      ) : (
        <p className="monitor-resource-empty">
          {data ? (data.available ? 'No graphics processors are reported by this host.' : data.reason) : 'Reading GPU hardware…'}
        </p>
      )}
    </section>
  );
}
