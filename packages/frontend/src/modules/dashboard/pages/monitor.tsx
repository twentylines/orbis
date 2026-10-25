import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import * as Tabs from '@radix-ui/react-tabs';
import { metricHistoryRanges, type MetricHistoryRange } from '@runtipi/common/schemas/metric-history';
import type { HostSensors } from '@runtipi/common/schemas/host-sensors';
import { IconActivity, IconArrowDown, IconArrowUp, IconCpu, IconDatabase, IconDeviceDesktopAnalytics, IconNetwork } from '@tabler/icons-react';
import { useMetricHistory } from '@/desktop/metric-history';
import { MetricChart } from '@/components/metric-chart/metric-chart';
import { telemetryOptions } from '@/desktop/telemetry';
import { formatUptime } from '@/desktop/uptime';
import './monitor.css';
import { useWindowVisible } from '@/desktop/window-visibility';
import { HostDevices, useHostReadings } from '../components/host-devices';
import { HostDeviceHistoryView } from '../components/host-device-history';
import { HostSensorsView } from '../components/host-sensors';
import { ServerRack, useCluster } from '@/desktop/cluster';
import { useServerPath } from '@/desktop/cluster-data';
import { ClusterOverview } from '@/desktop/cluster-views';
import { useDesktopPreferences } from '@/desktop/preferences';
import { statusNetwork, usagePercent, cpuTemperature, sensorRefreshInterval } from '../components/system-readings';
import { MonitorDisclosure, MonitorUsage } from '../components/monitor-usage';

const monitorSections = [
  ['usage', 'Usage'],
  ['performance', 'Performance'],
  ['devices', 'Devices'],
  ['sensors', 'Sensors'],
] as const;
type MonitorSection = (typeof monitorSections)[number][0];
const sectionForHash = (hash: string): MonitorSection | null => {
  if (['#telemetry-cpu-title', '#telemetry-memory-title'].includes(hash)) return 'performance';
  if (
    [
      '#host-storage-title',
      '#host-network-title',
      '#host-disk-activity-title',
      '#device-history',
      '#telemetry-disks-title',
      '#telemetry-network-title',
    ].includes(hash)
  )
    return 'devices';
  if (['#sensors', '#host-temperatures-title', '#host-fans-title', '#host-gpus-title'].includes(hash)) return 'sensors';
  if (['#containers', '#processes'].includes(hash)) return 'usage';
  return null;
};

const bytes = (value: number | null) => {
  if (value === null || !Number.isFinite(value) || value < 0) return 'Unavailable';
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
const percent = (value: number | null) => (value === null || !Number.isFinite(value) ? 'Unavailable' : `${value.toFixed(1)}%`);
const width = (value: number | null) => `${Math.min(100, Math.max(0, value ?? 0))}%`;
const rate = (value: number | null | undefined) => (value === null || value === undefined ? 'Unavailable' : `${bytes(value)}/s`);
export default function Monitor() {
  const { merged } = useCluster();
  return merged ? <ClusterOverview /> : <ServerMonitor />;
}

function ServerMonitor() {
  const visible = useWindowVisible();
  const { selectedServer, selectedId } = useCluster();
  const { preferences } = useDesktopPreferences();
  const telemetryPath = useServerPath()('/api/system/telemetry');
  const sensorsPath = useServerPath()('/api/system/host-sensors');
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const requestedSection = searchParams.get('section');
  const section =
    sectionForHash(location.hash) ?? (monitorSections.some(([value]) => value === requestedSection) ? (requestedSection as MonitorSection) : 'usage');
  useEffect(() => {
    const linkedSection = sectionForHash(location.hash);
    if (!linkedSection || requestedSection === linkedSection) return;
    const next = new URLSearchParams(searchParams);
    next.set('section', linkedSection);
    navigate(
      { pathname: location.pathname, search: next.toString(), hash: location.hash },
      { replace: true, preventScrollReset: true, state: location.state },
    );
  }, [location.hash, location.pathname, location.state, navigate, requestedSection, searchParams]);
  const changeSection = (value: string) => {
    if (!monitorSections.some(([section]) => section === value)) return;
    const next = new URLSearchParams(searchParams);
    next.set('section', value);
    navigate({ pathname: location.pathname, search: next.toString(), hash: '' }, { replace: true, preventScrollReset: true });
  };
  const selectedRange = searchParams.get('range');
  const range: MetricHistoryRange = selectedRange && Object.hasOwn(metricHistoryRanges, selectedRange) ? (selectedRange as MetricHistoryRange) : '1h';
  const history = useMetricHistory(range);
  const telemetry = useQuery(telemetryOptions(visible, telemetryPath, selectedId));
  const sample = telemetry.data;
  const sensors = useQuery<HostSensors>({
    queryKey: ['host-sensors', sensorsPath],
    queryFn: async ({ signal }) => {
      const response = await fetch(sensorsPath, { credentials: 'include', signal });
      if (!response.ok) throw new Error('Hardware readings are unavailable');
      return response.json();
    },
    enabled: visible,
    refetchInterval: (query) => sensorRefreshInterval(query.state.data),
    refetchIntervalInBackground: false,
  });
  const cpuSensor = cpuTemperature(sensors.data);
  const delayedTemperature = sensors.isError || Boolean(sensors.data?.available && sensors.data.stale);
  const host = useHostReadings();
  const currentHost = host.data?.available && !host.data.stale && !host.isError ? host.data : null;
  const hostDisk = currentHost?.filesystems.find((disk) => disk.mount === '/');
  const disk = hostDisk ?? sample?.filesystems.find((disk) => disk.mount === '/') ?? sample?.filesystems[0];
  const usedMemory =
    sample?.memory.totalBytes !== null &&
    sample?.memory.availableBytes !== null &&
    sample?.memory.totalBytes !== undefined &&
    sample?.memory.availableBytes !== undefined
      ? sample.memory.totalBytes - sample.memory.availableBytes
      : null;
  const memoryPercent = usagePercent(usedMemory, sample?.memory.totalBytes ?? null);
  const storagePercent = usagePercent(disk?.usedBytes ?? null, disk?.sizeBytes ?? null);
  const network = statusNetwork(currentHost ?? undefined, sample);
  const serverName = selectedServer && !selectedServer.local ? selectedServer.name : preferences.serverName;
  const usedSwap =
    sample?.memory.swapTotalBytes !== null &&
    sample?.memory.swapFreeBytes !== null &&
    sample?.memory.swapTotalBytes !== undefined &&
    sample?.memory.swapFreeBytes !== undefined
      ? sample.memory.swapTotalBytes - sample.memory.swapFreeBytes
      : null;

  return (
    <div className="desktop-monitor">
      <header className="monitor-page-heading">
        <div>
          <h2>System overview</h2>
          <p title={serverName}>{serverName}</p>
        </div>
        <div
          className="desktop-monitor-live-status"
          title="CPU and memory update every second. Other hardware readings keep their own sampling rate."
        >
          <span className={telemetry.isError ? 'desktop-live-dot desktop-live-dot-stale' : 'desktop-live-dot'} aria-hidden="true" />
          <span>{telemetry.isError ? 'Readings delayed' : telemetry.isPending ? 'Connecting' : 'Live · every second'}</span>
        </div>
      </header>
      {telemetry.isError ? (
        <div className="workspace-message" role="alert">
          The server did not return a telemetry sample. Last values may be stale.{' '}
          <button type="button" onClick={() => telemetry.refetch()}>
            Retry
          </button>
        </div>
      ) : null}
      {telemetry.isPending ? <p>Loading system status…</p> : null}
      <section className="desktop-host-overview" aria-label="Current system readings">
        <div className="desktop-host-overview-copy" key={selectedId}>
          <dl className="monitor-summary-grid">
            <div className="monitor-summary-stat">
              <dt>
                <IconCpu size={18} aria-hidden="true" />
                CPU
              </dt>
              <dd className="monitor-summary-value">{percent(sample?.cpu.totalPercent ?? null)}</dd>
              <dd className="monitor-summary-detail">{sample?.cpu.scope === 'runtime' ? 'Core container load' : 'Total utilisation'}</dd>
              <dd className="workspace-meter" aria-hidden="true">
                <span style={{ width: width(sample?.cpu.totalPercent ?? null) }} />
              </dd>
            </div>
            <div className="monitor-summary-stat">
              <dt>
                <IconDeviceDesktopAnalytics size={18} aria-hidden="true" />
                Memory
              </dt>
              <dd className="monitor-summary-value">{percent(memoryPercent)}</dd>
              <dd className="monitor-summary-detail">
                {bytes(usedMemory)} / {bytes(sample?.memory.totalBytes ?? null)}
              </dd>
              <dd className="workspace-meter" aria-hidden="true">
                <span style={{ width: width(memoryPercent) }} />
              </dd>
            </div>
            <div className="monitor-summary-stat">
              <dt>
                <IconDatabase size={18} aria-hidden="true" />
                {hostDisk ? 'Storage' : 'Core storage'}
              </dt>
              <dd className="monitor-summary-value">{percent(storagePercent)}</dd>
              <dd className="monitor-summary-detail">
                {bytes(disk?.usedBytes ?? null)} / {bytes(disk?.sizeBytes ?? null)}
              </dd>
              <dd className="workspace-meter" aria-hidden="true">
                <span style={{ width: width(storagePercent) }} />
              </dd>
            </div>
            <div className="monitor-summary-stat monitor-summary-network">
              <dt>
                <IconNetwork size={18} aria-hidden="true" />
                {network?.label ?? 'Network'}
              </dt>
              <dd className="monitor-summary-rate">
                <IconArrowDown size={16} aria-hidden="true" />
                <span className="visually-hidden">Download </span>
                {rate(network?.rxBytesPerSecond)}
              </dd>
              <dd className="monitor-summary-rate">
                <IconArrowUp size={16} aria-hidden="true" />
                <span className="visually-hidden">Upload </span>
                {rate(network?.txBytesPerSecond)}
              </dd>
              <dd className="monitor-summary-interface" title={network?.interface}>
                {network?.interface ?? 'No interface reading'}
              </dd>
            </div>
          </dl>
          <dl className="monitor-system-facts">
            <div>
              <dt>Uptime</dt>
              <dd>{formatUptime(sample?.cpu.uptimeSeconds)}</dd>
            </div>
            <div>
              <dt>CPU clock</dt>
              <dd>
                {typeof sample?.cpu.reportedClockGHz === 'number' && Number.isFinite(sample.cpu.reportedClockGHz)
                  ? `${sample.cpu.reportedClockGHz.toFixed(2)} GHz`
                  : 'Unavailable'}
              </dd>
            </div>
            <div>
              <dt>Logical CPUs</dt>
              <dd>{sample?.cpu.perCorePercent.length || 'Unavailable'}</dd>
            </div>
          </dl>
        </div>
        <div className="monitor-rack-panel">
          <span className="monitor-rack-label">
            <IconActivity size={15} aria-hidden="true" />
            Server selector
          </span>
          <ServerRack cpu={sample?.cpu.totalPercent ?? null} memory={memoryPercent} online={telemetry.isPending ? undefined : !telemetry.isError} />
        </div>
      </section>
      <div className="monitor-temperature-strip">
        <dl>
          <div>
            <dt>CPU temperature</dt>
            <dd>{cpuSensor?.celsius !== null && cpuSensor?.celsius !== undefined ? `${cpuSensor.celsius.toFixed(1)} °C` : 'Unavailable'}</dd>
          </div>
        </dl>
        <p className="monitor-temperature-description">
          {sensors.isPending
            ? 'Reading hardware sensors…'
            : sensors.isError || (sensors.data?.available && sensors.data.stale)
              ? `Last reading${sensors.data?.available ? ` at ${new Date(sensors.data.sampledAt).toLocaleTimeString()}` : ''}. Refreshing hardware sensors…`
              : sensors.data?.available === false
                ? sensors.data.reason
                : cpuSensor
                  ? `${/package id|tctl|tdie/i.test(cpuSensor.label) ? 'CPU package' : cpuSensor.label} · ${cpuSensor.chip}`
                  : 'No CPU temperature sensor is reported by this host.'}
        </p>
        {delayedTemperature && cpuSensor ? <span className="monitor-temperature-age">Readings delayed</span> : null}
        <button type="button" className="monitor-detail-action" onClick={() => changeSection('sensors')}>
          Hardware details
        </button>
      </div>
      <Tabs.Root className="monitor-sections" value={section} onValueChange={changeSection}>
        <Tabs.List className="monitor-section-tabs" aria-label="Monitor sections">
          {monitorSections.map(([value, label]) => (
            <Tabs.Trigger className="monitor-section-tab" key={value} value={value}>
              {label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content className="monitor-section-panel" value="usage">
          <MonitorUsage key={telemetryPath} />
        </Tabs.Content>
        <Tabs.Content className="monitor-section-panel" value="performance">
          {sample ? (
            <>
              <div className="monitor-history-toolbar">
                <h2>Performance history</h2>
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
                        setSearchParams(next, { replace: true, preventScrollReset: true });
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
                    Readings are collected every ten seconds while Orbis is in use. Minute summaries are saved for seven days; longer ranges show
                    sample averages and peaks. Idle periods appear as gaps.
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
                    <span>{sample.cpu.scope === 'host-proc' ? 'Utilisation' : 'Core container load'}</span>
                  </div>
                  <MetricChart history={history.data} field="cpu" label="CPU utilisation" color="var(--desktop-accent)" loading={history.isPending} />
                  {sample.cpu.perCorePercent.length ? (
                    <MonitorDisclosure title={`Logical processors (${sample.cpu.perCorePercent.length})`}>
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
                    </MonitorDisclosure>
                  ) : (
                    <p>Per-core readings unavailable.</p>
                  )}
                </section>
                <section className="desktop-telemetry-memory" aria-labelledby="telemetry-memory-title">
                  <h2 id="telemetry-memory-title">Memory</h2>
                  <div className="desktop-telemetry-lead">
                    <strong className="desktop-memory-total">
                      <span>{bytes(usedMemory)}</span>
                      <span aria-hidden="true"> / </span>
                      <span>{bytes(sample.memory.totalBytes)}</span>
                    </strong>
                  </div>
                  <MetricChart
                    history={history.data}
                    field="memory"
                    label="Memory used"
                    color="color-mix(in srgb, var(--desktop-accent) 60%, var(--desktop-positive))"
                    loading={history.isPending}
                  />
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
              </div>
            </>
          ) : (
            <p>CPU and memory readings are unavailable.</p>
          )}
        </Tabs.Content>
        <Tabs.Content className="monitor-section-panel monitor-devices-panel" value="devices">
          <HostDevices />
          <MonitorDisclosure title="Recorded device history" openRequest={location.hash === '#device-history' ? location.key : undefined}>
            <HostDeviceHistoryView section="devices" />
          </MonitorDisclosure>
          <MonitorDisclosure
            title="Orbis core storage and network"
            openRequest={['#telemetry-disks-title', '#telemetry-network-title'].includes(location.hash) ? location.key : undefined}
          >
            {sample ? (
              <div className="desktop-telemetry-grid">
                <section className="desktop-telemetry-disks" aria-labelledby="telemetry-disks-title">
                  <h2 id="telemetry-disks-title">Orbis core storage</h2>
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
                            <span
                              style={{ width: width(disk.usedBytes !== null && disk.sizeBytes ? (disk.usedBytes / disk.sizeBytes) * 100 : null) }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p>No filesystem readings available.</p>
                  )}
                </section>
                <section className="desktop-telemetry-network" aria-labelledby="telemetry-network-title">
                  <h2 id="telemetry-network-title">Orbis core network</h2>
                  <div className="desktop-network-charts">
                    <div>
                      <h3>↓ Download</h3>
                      <MetricChart
                        history={history.data}
                        field="download"
                        label="Core network download"
                        color="color-mix(in srgb, var(--desktop-accent) 60%, var(--desktop-positive))"
                        loading={history.isPending}
                      />
                    </div>
                    <div>
                      <h3>↑ Upload</h3>
                      <MetricChart
                        history={history.data}
                        field="upload"
                        label="Core network upload"
                        color="var(--desktop-accent)"
                        loading={history.isPending}
                      />
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
            ) : (
              <p>Core storage and network readings are unavailable.</p>
            )}
          </MonitorDisclosure>
        </Tabs.Content>
        <Tabs.Content className="monitor-section-panel" value="sensors">
          <HostSensorsView />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
