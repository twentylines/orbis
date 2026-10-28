import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { IconArrowsDownUp, IconClock, IconDeviceDesktopAnalytics } from '@tabler/icons-react';
import { ContainerResources } from '@/components/container-resources/container-resources';
import { telemetryOptions } from '@/desktop/telemetry';
import { formatUptime } from '@/desktop/uptime';
import { useWindowVisible } from '@/desktop/window-visibility';
import { useHostReadings } from './host-devices';
import { SystemGauges } from './system-gauges';
import { statusBytes, statusNetwork } from './system-readings';
import { sensorOptions, useObserveSystemHealth } from './use-system-health';

const rate = (value: number | null) => {
  if (value === null) return 'Unavailable';
  if (value < 1024) return `${value.toFixed(0)} B/s`;
  const units = ['KB/s', 'MB/s', 'GB/s'];
  let amount = value;
  let index = -1;
  do {
    amount /= 1024;
    index++;
  } while (amount >= 1024 && index < units.length - 1);
  return `${amount.toFixed(amount < 10 ? 1 : 0)} ${units[index]}`;
};

export function HomeSystemStatus() {
  const visible = useWindowVisible();
  const system = useQuery(telemetryOptions(visible));
  const sensors = useQuery(sensorOptions(visible));
  useObserveSystemHealth({ telemetry: system.data, sensors: sensors.data, telemetryError: system.isError, sensorsError: sensors.isError });
  const host = useHostReadings();
  const currentHost = host.data?.available && !host.data.stale && !host.isError ? host.data : null;
  const hostDisk = currentHost?.filesystems.find((filesystem) => filesystem.mount === '/');
  const disk = hostDisk ?? system.data?.filesystems.find((filesystem) => filesystem.mount === '/') ?? system.data?.filesystems[0];
  const diskLabel = hostDisk ? 'Storage' : 'Core storage';
  const memoryTotal = system.data?.memory.totalBytes;
  const memoryFree = system.data?.memory.availableBytes;
  const memoryAvailable =
    typeof memoryTotal === 'number' &&
    Number.isFinite(memoryTotal) &&
    memoryTotal > 0 &&
    typeof memoryFree === 'number' &&
    Number.isFinite(memoryFree) &&
    memoryFree >= 0 &&
    memoryFree <= memoryTotal;
  const memoryUsed = memoryAvailable ? memoryTotal - memoryFree : null;
  const cpuPercent = system.data?.cpu.totalPercent;
  const network = statusNetwork(host.isError ? undefined : host.data, system.data);
  return (
    <section className="workspace-activity" aria-labelledby="workspace-activity-title">
      <div className="workspace-section-heading">
        <div>
          <h2 id="workspace-activity-title">System status</h2>
        </div>
        <Link to="/monitor" aria-label="Expand System status">
          <IconDeviceDesktopAnalytics size={21} aria-hidden="true" />
        </Link>
      </div>
      {system.isError ? (
        <div className="workspace-message" role="alert">
          System readings are unavailable.{' '}
          <button type="button" onClick={() => system.refetch()}>
            Retry
          </button>
        </div>
      ) : (
        <div className="workspace-metrics">
          <SystemGauges
            cpu={cpuPercent ?? null}
            clockGHz={system.data?.cpu.reportedClockGHz}
            memoryUsed={memoryUsed}
            memoryTotal={memoryAvailable ? memoryTotal : null}
            diskUsed={disk?.usedBytes ?? null}
            diskTotal={disk?.sizeBytes ?? null}
            diskLabel={diskLabel}
          />
          <div className="workspace-uptime">
            <span>
              <IconClock size={18} aria-hidden="true" /> Uptime
            </span>
            <strong>{system.data ? formatUptime(system.data.cpu.uptimeSeconds) : '—'}</strong>
          </div>
          <section className="workspace-network" aria-label={network?.label ?? 'Network'}>
            <span className="workspace-network-heading">
              <IconArrowsDownUp size={17} aria-hidden="true" /> {network?.label ?? 'Network'}
            </span>
            {network ? (
              <strong className="workspace-network-interface" title={network.interface}>
                {network.interface}
                {network.speedMbps !== null ? (
                  <small>{network.speedMbps >= 1000 ? `${(network.speedMbps / 1000).toFixed(1)} Gbps` : `${network.speedMbps} Mbps`} link</small>
                ) : null}
              </strong>
            ) : null}
            <div className="workspace-network-direction">
              <small>Download</small>
              <strong className="workspace-network-rate">{rate(network?.rxBytesPerSecond ?? null)}</strong>
              {network ? <small>{statusBytes(network.receivedBytes)} received</small> : null}
            </div>
            <div className="workspace-network-direction">
              <small>Upload</small>
              <strong className="workspace-network-rate">{rate(network?.txBytesPerSecond ?? null)}</strong>
              {network ? <small>{statusBytes(network.transmittedBytes)} sent</small> : null}
            </div>
          </section>
        </div>
      )}
      <ContainerResources compact />
    </section>
  );
}
