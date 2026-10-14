import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { loadTelemetry, telemetryQueryKey, type Telemetry } from '@/desktop/telemetry';
import './monitor.css';

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

type HistoryPoint = { at: string; cpu: number | null; memory: number | null; download: number | null; upload: number | null };

function LiveChart({
  points,
  field,
  max,
  label,
  color,
}: {
  points: HistoryPoint[];
  field: 'cpu' | 'memory' | 'download' | 'upload';
  max: number;
  label: string;
  color: string;
}) {
  const values = points.map((point) => point[field]);
  const available = values.filter((value): value is number => value !== null);
  const coordinates = values
    .map((value, index) => {
      if (value === null) return null;
      const x = values.length === 1 ? 0 : (index / (values.length - 1)) * 600;
      return `${x.toFixed(1)},${(112 - (Math.min(max, value) / max) * 104).toFixed(1)}`;
    })
    .filter((point): point is string => point !== null);

  return (
    <div className="desktop-live-chart" role="img" aria-label={`${label}: ${available.length} live samples collected in this view`}>
      <div className="desktop-live-chart-grid" aria-hidden="true">
        <span>{field === 'cpu' || field === 'memory' ? '100%' : `${bytes(max)}/s`}</span>
        <span>{field === 'cpu' || field === 'memory' ? '50%' : `${bytes(max / 2)}/s`}</span>
        <span>0</span>
      </div>
      <svg viewBox="0 0 600 120" preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" x2="600" y1="8" y2="8" />
        <line x1="0" x2="600" y1="60" y2="60" />
        <line x1="0" x2="600" y1="112" y2="112" />
        {coordinates.length > 1 ? <polyline points={coordinates.join(' ')} stroke={color} /> : null}
        {coordinates.length === 1 ? <circle cx="0" cy={coordinates[0]?.split(',')[1] ?? 112} r="4" fill={color} /> : null}
      </svg>
      {coordinates.length === 0 ? <span className="desktop-live-chart-empty">Waiting for a live reading</span> : null}
      {coordinates.length === 1 ? <span className="desktop-live-chart-empty">Collecting the next sample</span> : null}
    </div>
  );
}

export default function Monitor() {
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const telemetry = useQuery<Telemetry>({
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

  useEffect(() => {
    if (!sample) return;
    const memoryPercent =
      sample.memory.totalBytes && sample.memory.availableBytes !== null
        ? ((sample.memory.totalBytes - sample.memory.availableBytes) / sample.memory.totalBytes) * 100
        : null;
    const activeInterfaces = sample.network.filter((item) => item.interface !== 'lo');
    const rate = (field: 'rxBytesPerSecond' | 'txBytesPerSecond') =>
      activeInterfaces.length && activeInterfaces.every((item) => item[field] !== null)
        ? activeInterfaces.reduce((total, item) => total + (item[field] ?? 0), 0)
        : null;
    setHistory((current) => {
      if (current.at(-1)?.at === sample.sampledAt) return current;
      return [
        ...current,
        {
          at: sample.sampledAt,
          cpu: sample.cpu.totalPercent,
          memory: memoryPercent,
          download: rate('rxBytesPerSecond'),
          upload: rate('txBytesPerSecond'),
        },
      ].slice(-60);
    });
  }, [sample]);

  const networkMax = Math.max(1024, ...history.flatMap((point) => [point.download ?? 0, point.upload ?? 0])) * 1.15;

  return (
    <div className="desktop-monitor">
      <div className="desktop-view-heading">
        <div>
          <p>System</p>
          <h1>Monitor</h1>
        </div>
        <Link to="/dashboard">Back to workspace</Link>
      </div>
      <p className="desktop-monitor-scope">
        Current readings only. CPU uses host /proc when available; memory reads the host mount. Filesystems and network describe the Orbis core
        container. No history is inferred before collection starts.
      </p>
      <div className="desktop-monitor-live-status">
        <span className={telemetry.isError ? 'desktop-live-dot desktop-live-dot-stale' : 'desktop-live-dot'} />
        <strong>{telemetry.isError ? 'Connection interrupted' : 'Live readings'}</strong>
        <span>Every 5 seconds while this tab is active · {history.length} of 60 recent samples</span>
      </div>
      {telemetry.isError ? (
        <div className="workspace-message" role="alert">
          The server did not return a telemetry sample. Last values may be stale.{' '}
          <button type="button" onClick={() => telemetry.refetch()}>
            Retry
          </button>
        </div>
      ) : null}
      {telemetry.isPending ? <p>Loading current system readings…</p> : null}
      {sample ? (
        <>
          <output className="desktop-monitor-time">
            Sampled {new Date(sample.sampledAt).toLocaleString()}
            {telemetry.isError ? ' · Disconnected' : ''}
          </output>
          <section className="desktop-host-overview" aria-labelledby="desktop-host-overview-title">
            <div className="desktop-host-overview-copy">
              <span className="desktop-host-overview-kicker">LOCAL SERVER · 01</span>
              <h2 id="desktop-host-overview-title">The machine behind your workspace</h2>
              <p>One server, sampled live. The hardware view follows the readings below; it does not estimate missing data.</p>
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
          <div className="desktop-telemetry-grid">
            <section className="desktop-telemetry-cpu" aria-labelledby="telemetry-cpu-title">
              <h2 id="telemetry-cpu-title">CPU</h2>
              <div className="desktop-telemetry-lead">
                <strong>{percent(sample.cpu.totalPercent)}</strong>
                <span>{sample.cpu.scope === 'host-proc' ? 'Host load' : 'Core container load'}</span>
              </div>
              <LiveChart points={history} field="cpu" max={100} label="CPU load" color="#d1a172" />
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
              <LiveChart points={history} field="memory" max={100} label="Host memory used" color="#9fc0ad" />
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
              <div className="desktop-network-legend">
                <span>↓ Download</span>
                <span>↑ Upload</span>
              </div>
              <div className="desktop-network-charts">
                <LiveChart points={history} field="download" max={networkMax} label="Network download" color="#9fc0ad" />
                <LiveChart points={history} field="upload" max={networkMax} label="Network upload" color="#d1a172" />
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
        </>
      ) : null}
    </div>
  );
}
