import type { ReactNode } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import type { HostSensors, HostTelemetry, MetricHistory } from '@runtipi/common/schemas';
import { IconCpu, IconDeviceDesktopAnalytics, IconNetwork, IconCircuitResistor } from '@tabler/icons-react';
import type { Telemetry } from '@/desktop/telemetry';
import { SelectionGroup } from '@/components/ui/SelectionGroup/SelectionGroup';
import { MetricChart } from '@/components/metric-chart/metric-chart';
import { CpuPerformance, CpuRecordedChart } from './cpu-performance';
import { LiveMetricChart, useLiveSamples } from './live-metric-chart';
import { percentReading, rateReading } from './logical-processor-history';
import { GpuReadings } from './gpu-readings';
import { statusBytes, statusNetwork, usagePercent } from './system-readings';
import { highUsage } from './system-health';
import { monitorMetricForHash } from '../pages/monitor-navigation';

const resources = [
  { value: 'cpu', label: 'CPU', Icon: IconCpu },
  { value: 'memory', label: 'Memory', Icon: IconCircuitResistor },
  { value: 'network', label: 'Network', Icon: IconNetwork },
  { value: 'gpu', label: 'GPU', Icon: IconDeviceDesktopAnalytics },
] as const;
const rate = (value?: number | null) => (rateReading(value ?? null) === null ? 'Unavailable' : `${statusBytes(value ?? null)}/s`);

function GpuLiveChart({ sampledAt, utilisation }: { sampledAt: string; utilisation: number | null }) {
  const samples = useLiveSamples(sampledAt, 'gpu', [percentReading(utilisation)]);
  return samples.some((point) => point.values[0] != null) ? <LiveMetricChart label="Live GPU utilisation" samples={samples} gapMs={45_000} /> : null;
}

export function MonitorPerformance({
  sample,
  telemetryPending = false,
  host,
  sensors,
  delayed,
  sensorsDelayed,
  history,
  loading,
  historyControls,
  logicalProcessors,
  onLogicalProcessorsChange,
  savingLogicalProcessors,
}: {
  sample?: Telemetry;
  telemetryPending?: boolean;
  host?: HostTelemetry;
  sensors?: HostSensors;
  delayed: boolean;
  sensorsDelayed: boolean;
  history?: MetricHistory;
  loading: boolean;
  historyControls: ReactNode;
  logicalProcessors?: boolean;
  onLogicalProcessorsChange?: (checked: boolean) => void;
  savingLogicalProcessors?: boolean;
}) {
  const [params, setParams] = useSearchParams();
  const { hash } = useLocation();
  const resource = monitorMetricForHash(hash) ?? resources.find(({ value }) => value === params.get('metric'))?.value ?? 'cpu';
  const total = sample?.memory.totalBytes ?? null;
  const available = sample?.memory.availableBytes ?? null;
  const used = total !== null && available !== null && usagePercent(total - available, total) !== null ? total - available : null;
  const usedPercent = usagePercent(used, total);
  const swapTotal = sample?.memory.swapTotalBytes ?? null;
  const swapFree = sample?.memory.swapFreeBytes ?? null;
  const swapUsed = swapTotal !== null && swapFree !== null && swapFree <= swapTotal ? swapTotal - swapFree : null;
  const network = statusNetwork(host, sample);
  const memorySamples = useLiveSamples(sample?.sampledAt, sample?.memory.scope ?? '', [usedPercent]);
  const networkTime = network?.scope === 'host' && host?.available ? host.sampledAt : sample?.sampledAt;
  const networkIdentity = JSON.stringify([network?.scope, network?.interface, network && 'historyId' in network ? network.historyId : null]);
  const networkSamples = useLiveSamples(networkTime, networkIdentity, [
    rateReading(network?.rxBytesPerSecond ?? null),
    rateReading(network?.txBytesPerSecond ?? null),
  ]);
  const resourceDelayed = resource === 'network' && network?.scope === 'host' ? false : delayed;
  return (
    <div className="monitor-performance">
      <SelectionGroup as="fieldset" className="monitor-resource-tabs">
        <legend className="visually-hidden">Performance resource</legend>
        {resources.map(({ value, label, Icon }) => (
          <button
            type="button"
            key={value}
            aria-pressed={resource === value}
            onClick={() =>
              setParams(
                (previous) => {
                  const next = new URLSearchParams(previous);
                  next.set('metric', value);
                  return next;
                },
                { replace: true, preventScrollReset: true },
              )
            }
          >
            <Icon size={18} aria-hidden="true" /> {label}
          </button>
        ))}
      </SelectionGroup>
      {resource !== 'gpu' && resourceDelayed ? (
        <output className="monitor-resource-note">Live readings are delayed. Values are from the last received sample.</output>
      ) : null}
      <div className="monitor-performance-live" hidden={resource !== 'cpu'}>
        {sample ? (
          <CpuPerformance
            sample={sample}
            history={history}
            loading={loading}
            historyControls={resource === 'cpu' ? historyControls : null}
            logicalProcessors={logicalProcessors}
            onLogicalProcessorsChange={onLogicalProcessorsChange}
            savingLogicalProcessors={savingLogicalProcessors}
          />
        ) : (
          <section aria-labelledby="telemetry-cpu-title">
            <h2 id="telemetry-cpu-title">CPU</h2>
            <p className="monitor-resource-empty">{telemetryPending ? 'Loading CPU readings…' : 'CPU readings are unavailable.'}</p>
            {resource === 'cpu' ? historyControls : null}
            <CpuRecordedChart history={history} loading={loading} />
          </section>
        )}
      </div>
      {resource === 'memory' ? (
        <section className="monitor-memory" data-high={highUsage(usedPercent)} aria-labelledby="telemetry-memory-title">
          <header className="monitor-resource-heading">
            <div>
              <h2 id="telemetry-memory-title">Memory</h2>
              <p>{total === null ? 'Host memory capacity not reported' : `${statusBytes(total)} total system memory`}</p>
            </div>
            <span className="monitor-sample-label">{resourceDelayed ? 'Last reported' : 'Live · every second'}</span>
          </header>
          <div className="desktop-telemetry-lead" data-high={highUsage(usedPercent)}>
            <strong>{usedPercent === null ? 'Unavailable' : `${usedPercent.toFixed(1)}%`}</strong>
            <span>In use · {statusBytes(used)}</span>
          </div>
          <p className="monitor-processor-caption">Last 60 seconds · 0–100%. Gaps mean missing readings.</p>
          <LiveMetricChart label="Live memory utilisation" samples={memorySamples} />
          <dl className="monitor-resource-facts">
            <div>
              <dt>In use</dt>
              <dd>{statusBytes(used)}</dd>
            </div>
            <div>
              <dt>Available</dt>
              <dd>{statusBytes(available)}</dd>
            </div>
            <div>
              <dt>Installed capacity</dt>
              <dd>{statusBytes(total)}</dd>
            </div>
            <div>
              <dt>Swap used</dt>
              <dd>{statusBytes(swapUsed)}</dd>
            </div>
            <div>
              <dt>Swap capacity</dt>
              <dd>{statusBytes(swapTotal)}</dd>
            </div>
          </dl>
          {historyControls}
          <MetricChart history={history} field="memory" label="Host memory utilisation" color="var(--desktop-accent)" loading={loading} />
        </section>
      ) : null}
      {resource === 'network' ? (
        <section aria-labelledby="monitor-network-title">
          <header className="monitor-resource-heading">
            <div>
              <h2 id="monitor-network-title">Network</h2>
              <p>
                {network?.interface ?? 'No interface reported'}
                {network?.speedMbps != null ? ` · ${network.speedMbps.toLocaleString()} Mbps link` : ''}
              </p>
            </div>
            <span className="monitor-sample-label">{resourceDelayed ? 'Last reported' : 'Live · every second'}</span>
          </header>
          <dl className="monitor-resource-facts monitor-network-live">
            <div>
              <dt>Download</dt>
              <dd>{rate(network?.rxBytesPerSecond)}</dd>
            </div>
            <div>
              <dt>Upload</dt>
              <dd>{rate(network?.txBytesPerSecond)}</dd>
            </div>
            <div>
              <dt>Received</dt>
              <dd>{statusBytes(network?.receivedBytes ?? null)}</dd>
            </div>
            <div>
              <dt>Sent</dt>
              <dd>{statusBytes(network?.transmittedBytes ?? null)}</dd>
            </div>
          </dl>
          <p className="monitor-resource-note">
            {network?.scope === 'host'
              ? 'Live counters are for the named host interface.'
              : 'Host interface readings are unavailable. These readings cover Orbis traffic.'}
          </p>
          <p className="monitor-processor-caption">Last 60 seconds · gaps mean missing readings.</p>
          <div className="monitor-live-chart-grid">
            <LiveMetricChart label="Live download" samples={networkSamples} unit="rate" />
            <LiveMetricChart label="Live upload" samples={networkSamples} index={1} unit="rate" />
          </div>
          <h3 id="monitor-network-history-title" className="monitor-chart-subtitle">
            Network history
          </h3>
          {historyControls}
          <p className="monitor-resource-note">History records Orbis traffic, which may differ from the live host interface above.</p>
          <div className="desktop-network-charts">
            <MetricChart history={history} field="download" label="Network download" color="var(--desktop-accent)" loading={loading} />
            <MetricChart history={history} field="upload" label="Network upload" color="var(--desktop-positive)" loading={loading} />
          </div>
        </section>
      ) : null}
      <div className="monitor-performance-live" hidden={resource !== 'gpu'}>
        <GpuReadings
          data={sensors}
          stale={sensorsDelayed}
          renderLiveChart={(gpu) => (sensors?.available ? <GpuLiveChart sampledAt={sensors.sampledAt} utilisation={gpu.utilizationPercent} /> : null)}
        />
        <section className="monitor-gpu-history" aria-labelledby="monitor-gpu-history-title">
          <h3 id="monitor-gpu-history-title" className="monitor-chart-subtitle">
            Recorded history
          </h3>
          <p className="monitor-resource-note">GPU utilisation history is unavailable.</p>
        </section>
      </div>
    </div>
  );
}
