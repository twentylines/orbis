import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { metricHistoryRanges, type MetricHistoryRange } from '@runtipi/common/schemas';
import { useMetricHistory } from '@/desktop/metric-history';
import { MetricChart } from '@/components/metric-chart/metric-chart';
import { loadTelemetry, telemetryQueryKey, type Telemetry } from '@/desktop/telemetry';
import './monitor.css';
import { ContainerResources } from '@/components/container-resources/container-resources';
import { useWindowVisible } from '@/desktop/window-visibility';

const bytes = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) return 'Unavailable';
  if (value < 1024) return `${value.toFixed(0)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let index = -1;
  do {
    amount /= 1024;
    index++;
  } while (amount >= 1024 && index < units.length - 1);
  return `${amount.toFixed(amount < 10 ? 1 : 0)} ${units[index]}`;
};
const percent = (value: number | null) => (value === null ? 'Unavailable' : `${value.toFixed(1)}%`);
const width = (value: number | null) => `${Math.min(100, Math.max(0, value ?? 0))}%`;

export default function Monitor() {
  const visible = useWindowVisible();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedRange = searchParams.get('range');
  const range: MetricHistoryRange = selectedRange && Object.hasOwn(metricHistoryRanges, selectedRange) ? (selectedRange as MetricHistoryRange) : '1h';
  const history = useMetricHistory(range);
  const telemetry = useQuery<Telemetry>({
    enabled: visible,
    queryKey: telemetryQueryKey,
    queryFn: ({ signal }) => loadTelemetry(signal),
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  });
  const sample = telemetry.data;
  const usedMemory =
    sample?.memory.totalBytes !== null &&
    sample?.memory.availableBytes !== null &&
    sample?.memory.totalBytes !== undefined &&
    sample?.memory.availableBytes !== undefined
      ? sample.memory.totalBytes - sample.memory.availableBytes
      : null;
  const usedSwap =
    sample?.memory.swapTotalBytes !== null &&
    sample?.memory.swapFreeBytes !== null &&
    sample?.memory.swapTotalBytes !== undefined &&
    sample?.memory.swapFreeBytes !== undefined
      ? sample.memory.swapTotalBytes - sample.memory.swapFreeBytes
      : null;
  const memoryPercent = usedMemory !== null && sample?.memory.totalBytes ? (usedMemory / sample.memory.totalBytes) * 100 : null;

  return (
    <div className="desktop-monitor">
      <p className="desktop-monitor-scope">Filesystem and network readings cover the Orbis core container.</p>
      <div className="desktop-monitor-live-status">
        <span className={telemetry.isError ? 'desktop-live-dot desktop-live-dot-stale' : 'desktop-live-dot'} />
        <strong>{telemetry.isError ? 'Connection interrupted' : 'Live readings'}</strong>
        <span>Updates every 5 seconds</span>
      </div>
      {telemetry.isError ? (
        <div className="workspace-message" role="alert">
          The server did not return a telemetry sample. Last values may be stale.{' '}
          <button type="button" onClick={() => telemetry.refetch()}>
            Retry
          </button>
        </div>
      ) : null}
      {telemetry.isPending ? <p>Loading system status…</p> : null}
      {sample ? (
        <>
          <output className="desktop-monitor-time">
            Sampled {new Date(sample.sampledAt).toLocaleString()}
            {telemetry.isError ? ' · Disconnected' : ''}
          </output>
          <section className="desktop-host-overview" aria-labelledby="desktop-host-overview-title">
            <div className="desktop-host-overview-copy">
              <h2 id="desktop-host-overview-title">System status</h2>
              <div className="desktop-host-overview-readings">
                <div>
                  <span>{sample.cpu.scope === 'host-proc' ? 'Host CPU' : 'Core CPU'}</span>
                  <strong>{percent(sample.cpu.totalPercent)}</strong>
                </div>
                <div>
                  <span>Host memory</span>
                  <strong>{percent(memoryPercent)}</strong>
                </div>
                <div>
                  <span>Host uptime</span>
                  <strong>
                    {sample.cpu.uptimeSeconds === null
                      ? 'Unavailable'
                      : `${Math.floor(sample.cpu.uptimeSeconds / 86400)}d ${Math.floor((sample.cpu.uptimeSeconds % 86400) / 3600)}h`}
                  </strong>
                </div>
              </div>
            </div>
            <div className="desktop-host-visual" aria-hidden="true">
              <div className="desktop-host-shadow" />
              <div className="desktop-host-machine">
                <div className="desktop-host-machine-top" />
                <div className="desktop-host-machine-side" />
                <div className="desktop-host-machine-front">
                  <div className="desktop-host-machine-head">
                    <span className="desktop-host-machine-mark">O</span>
                    <span>ORBIS / LOCAL</span>
                    <i className={telemetry.isError ? 'desktop-host-machine-led is-stale' : 'desktop-host-machine-led'} />
                  </div>
                  <div className="desktop-host-machine-bay">
                    <span>CPU</span>
                    <b>{percent(sample.cpu.totalPercent)}</b>
                    <i>
                      <span style={{ width: width(sample.cpu.totalPercent) }} />
                    </i>
                  </div>
                  <div className="desktop-host-machine-bay">
                    <span>MEMORY</span>
                    <b>{percent(memoryPercent)}</b>
                    <i>
                      <span style={{ width: width(memoryPercent) }} />
                    </i>
                  </div>
                  <div className="desktop-host-machine-base">
                    <span>01</span>
                    <span>SERVER MODULE</span>
                  </div>
                </div>
              </div>
            </div>
          </section>
          <div className="monitor-history-toolbar">
            <fieldset className="monitor-history-ranges">
              <legend className="visually-hidden">History time range</legend>
              {(
                [
                  ['5m', '5 min'],
                  ['1h', '1 hour'],
                  ['24h', '24 hours'],
                  ['7d', '7 days'],
                ] as const
              ).map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={range === value}
                  onClick={() => {
                    const next = new URLSearchParams(searchParams);
                    next.set('range', value);
                    setSearchParams(next, { replace: true });
                  }}
                >
                  {label}
                </button>
              ))}
            </fieldset>
            <span className="monitor-history-resolution">
              {range === '5m' ? 'Recent samples' : range === '1h' ? '1 min averages' : range === '24h' ? '5 min averages' : '30 min averages'}
            </span>
            <details className="monitor-history-info">
              <summary>Recorded on this server</summary>
              <p>
                Ten-second collection continues when this view is closed. Minute summaries are saved for seven days; longer ranges show sample
                averages and peaks. Gaps mean no reading was recorded.
              </p>
              {history.data?.persistedThrough ? (
                <p>Saved through {new Date(history.data.persistedThrough).toLocaleString()}.</p>
              ) : (
                <p>The first minute has not been saved yet.</p>
              )}
            </details>
          </div>
          {history.isError ? (
            <p className="workspace-message" role="alert">
              History could not be refreshed. Previous chart samples may be stale.{' '}
              <button type="button" onClick={() => history.refetch()}>
                Retry
              </button>
            </p>
          ) : null}
          {history.data?.storage === 'unavailable' ? (
            <p className="workspace-message" role="alert">
              History storage is unavailable. Recent readings remain in memory and may be lost on restart.
            </p>
          ) : null}
          {history.data && !history.data.collectorAvailable ? (
            <output className="workspace-message">History collection is interrupted. Charts contain the last recorded samples.</output>
          ) : null}
          <div className="desktop-telemetry-grid">
            <section className="desktop-telemetry-cpu" aria-labelledby="telemetry-cpu-title">
              <h2 id="telemetry-cpu-title">CPU</h2>
              <div className="desktop-telemetry-lead">
                <strong>{percent(sample.cpu.totalPercent)}</strong>
                <span>{sample.cpu.scope === 'host-proc' ? 'Host load' : 'Core container load'}</span>
              </div>
              <MetricChart history={history.data} field="cpu" label="CPU utilisation" color="#d1a172" loading={history.isPending} />
              {sample.cpu.perCorePercent.length ? (
                <div className="desktop-core-grid">
                  {sample.cpu.perCorePercent.map((core, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: Core position identifies the processor across samples.
                    <div key={index}>
                      <span>Core {index + 1}</span>
                      <strong>{percent(core)}</strong>
                      <div className="workspace-meter">
                        <span style={{ width: width(core) }} />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p>Per-core readings unavailable.</p>
              )}
              {sample.cpu.uptimeSeconds !== null ? (
                <p className="desktop-telemetry-foot">
                  Uptime {Math.floor(sample.cpu.uptimeSeconds / 86400)}d {Math.floor((sample.cpu.uptimeSeconds % 86400) / 3600)}h
                </p>
              ) : null}
            </section>
            <section className="desktop-telemetry-memory" aria-labelledby="telemetry-memory-title">
              <h2 id="telemetry-memory-title">Host memory</h2>
              <div className="desktop-telemetry-lead">
                <strong>{bytes(usedMemory)}</strong>
                <span>used of {bytes(sample.memory.totalBytes)}</span>
              </div>
              <MetricChart history={history.data} field="memory" label="Host memory used" color="#9fc0ad" loading={history.isPending} />
              <div className="workspace-meter">
                <span
                  style={{ width: width(usedMemory !== null && sample.memory.totalBytes ? (usedMemory / sample.memory.totalBytes) * 100 : null) }}
                />
              </div>
              <div className="desktop-telemetry-pair">
                <span>Available</span>
                <strong>{bytes(sample.memory.availableBytes)}</strong>
              </div>
              <div className="desktop-telemetry-pair">
                <span>Swap used</span>
                <strong>{bytes(usedSwap)}</strong>
              </div>
              <div className="desktop-telemetry-pair">
                <span>Swap total</span>
                <strong>{bytes(sample.memory.swapTotalBytes)}</strong>
              </div>
            </section>
            <section className="desktop-telemetry-disks" aria-labelledby="telemetry-disks-title">
              <h2 id="telemetry-disks-title">Runtime filesystems</h2>
              {sample.filesystems.length ? (
                <div className="desktop-telemetry-list">
                  {sample.filesystems.map((disk) => (
                    <div className="desktop-disk" key={`${disk.mount}-${disk.filesystem}`}>
                      <div>
                        <strong>{disk.mount}</strong>
                        <small>{disk.filesystem}</small>
                      </div>
                      <span>
                        {bytes(disk.usedBytes)} / {bytes(disk.sizeBytes)}
                      </span>
                      <div className="workspace-meter">
                        <span style={{ width: width(disk.usedBytes !== null && disk.sizeBytes ? (disk.usedBytes / disk.sizeBytes) * 100 : null) }} />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p>No filesystem readings available.</p>
              )}
            </section>
            <section className="desktop-telemetry-network" aria-labelledby="telemetry-network-title">
              <h2 id="telemetry-network-title">Runtime network</h2>
              <div className="desktop-network-charts">
                <div>
                  <h3>↓ Download</h3>
                  <MetricChart history={history.data} field="download" label="Core network download" color="#9fc0ad" loading={history.isPending} />
                </div>
                <div>
                  <h3>↑ Upload</h3>
                  <MetricChart history={history.data} field="upload" label="Core network upload" color="#d1a172" loading={history.isPending} />
                </div>
              </div>
              {sample.network.length ? (
                <div className="desktop-telemetry-list">
                  {sample.network.map((item) => (
                    <div className="desktop-network" key={item.interface}>
                      <strong>{item.interface}</strong>
                      <div className="desktop-telemetry-pair">
                        <span>Download</span>
                        <strong>{item.rxBytesPerSecond === null ? 'Unavailable' : `${bytes(item.rxBytesPerSecond)}/s`}</strong>
                      </div>
                      <div className="desktop-telemetry-pair">
                        <span>Upload</span>
                        <strong>{item.txBytesPerSecond === null ? 'Unavailable' : `${bytes(item.txBytesPerSecond)}/s`}</strong>
                      </div>
                      <small>
                        Received {bytes(item.receivedBytes)} · Sent {bytes(item.transmittedBytes)}
                      </small>
                    </div>
                  ))}
                </div>
              ) : (
                <p>No network interface readings available.</p>
              )}
            </section>
          </div>
          <ContainerResources />
        </>
      ) : null}
    </div>
  );
}
