import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import * as Tabs from '@radix-ui/react-tabs';
import { metricHistoryRanges, type MetricHistoryRange } from '@runtipi/common/schemas/metric-history';
import type { HostTemperature } from '@runtipi/common/schemas/host-sensors';
import { IconActivity, IconArrowDown, IconArrowUp, IconCpu, IconDatabase, IconDeviceDesktopAnalytics, IconNetwork } from '@tabler/icons-react';
import { useMetricHistory } from '@/desktop/metric-history';
import { MonitorPerformance } from '../components/monitor-performance';
import { MetricChart } from '@/components/metric-chart/metric-chart';
import { hostCpuPercent, telemetryOptions } from '@/desktop/telemetry';
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
import { RouteHeaderStatus } from '@/desktop/route-header-status';
import { SettingsDirtyIndicator } from '@/modules/settings/pages/settings-save';
import { statusNetwork, usagePercent, cpuTemperature } from '../components/system-readings';
import { highTemperature, highUsage, temperatureLimit } from '../components/system-health';
import { sensorOptions, useObserveSystemHealth } from '../components/use-system-health';
import { MonitorDisclosure, MonitorUsage } from '../components/monitor-usage';
import { DriveHealthView } from '../components/drive-health';

import {
  MonitorChartLink,
  MonitorWorkspace,
  monitorMetricForHash,
  monitorSections,
  monitorSection,
  sectionForHash,
  useMonitorChartFocus,
} from './monitor-navigation';

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

function TemperatureReading({ sensor, stale }: { sensor: HostTemperature | null | undefined; stale: boolean }) {
  const critical = sensor ? highTemperature(sensor) : false;
  const limit = sensor ? temperatureLimit(sensor) : null;
  return (
    <dd data-critical={critical}>
      {sensor?.celsius != null ? `${sensor.celsius.toFixed(1)} °C` : 'Unavailable'}
      {critical ? (
        <span className="monitor-temperature-critical">
          {stale ? 'High in last sample' : 'High'} · {limit?.toFixed(0)} °C threshold
        </span>
      ) : null}
    </dd>
  );
}

export default function Monitor() {
  const { merged } = useCluster();
  return merged ? <ClusterOverview /> : <ServerMonitor />;
}

function ServerMonitor() {
  const visible = useWindowVisible();
  const { selectedServer, selectedId, data: cluster } = useCluster();
  const { preferences, commit, syncState } = useDesktopPreferences();
  const [logicalEdit, setLogicalEdit] = useState<{ checked: boolean; pending: boolean } | null>(null);
  const saveLogicalProcessors = (checked: boolean) => {
    if (logicalEdit?.pending) return;
    setLogicalEdit({ checked, pending: true });
    void commit({ showLogicalProcessors: checked }).then(
      () => setLogicalEdit(null),
      () => setLogicalEdit({ checked, pending: false }),
    );
  };
  const telemetryPath = useServerPath()('/api/system/telemetry');
  const sensorsPath = useServerPath()('/api/system/host-sensors');
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const requestedSection = searchParams.get('section');
  const requestedMetric = searchParams.get('metric');
  const section = monitorSection(requestedSection, location.hash);
  useEffect(() => {
    const linkedSection = sectionForHash(location.hash);
    const linkedMetric = monitorMetricForHash(location.hash);
    if (!linkedSection || (requestedSection === linkedSection && (!linkedMetric || requestedMetric === linkedMetric))) return;
    const next = new URLSearchParams(searchParams);
    next.set('section', linkedSection);
    if (linkedMetric) next.set('metric', linkedMetric);
    navigate(
      { pathname: location.pathname, search: next.toString(), hash: location.hash },
      { replace: true, preventScrollReset: true, state: location.state },
    );
  }, [location.hash, location.pathname, location.state, navigate, requestedMetric, requestedSection, searchParams]);
  const changeSection = (value: string) => {
    if (!monitorSections.some((section) => section.value === value)) return;
    const next = new URLSearchParams(searchParams);
    next.set('section', value);
    navigate({ pathname: location.pathname, search: next.toString(), hash: '' }, { replace: true, preventScrollReset: true });
  };
  const selectedRange = searchParams.get('range');
  const range: MetricHistoryRange = selectedRange && Object.hasOwn(metricHistoryRanges, selectedRange) ? (selectedRange as MetricHistoryRange) : '1h';
  const history = useMetricHistory(range);
  const telemetry = useQuery(telemetryOptions(visible, telemetryPath, selectedId));
  const sample = telemetry.data;
  const cpuPercent = hostCpuPercent(sample?.cpu);
  const sensors = useQuery(sensorOptions(visible, sensorsPath));
  useObserveSystemHealth(
    { telemetry: sample, sensors: sensors.data, telemetryError: telemetry.isError, sensorsError: sensors.isError },
    telemetryPath,
  );
  const cpuSensor = cpuTemperature(sensors.data);
  const thermalReadings = sensors.data?.available
    ? sensors.data.temperatures.filter((sensor) => sensor.status === 'available' && sensor.celsius !== null)
    : [];
  const hottest = (pattern: RegExp) =>
    thermalReadings
      .filter((sensor) => pattern.test(`${sensor.chip} ${sensor.label}`))
      .sort((left, right) => (right.celsius ?? 0) - (left.celsius ?? 0))[0];
  const gpuTemperature = hottest(/amdgpu|nouveau|nvidia|radeon/i);
  const storageTemperature = hottest(/nvme|drivetemp|sata|disk/i);
  const delayedTemperature = sensors.isError || Boolean(sensors.data?.available && sensors.data.stale);
  const host = useHostReadings();
  const monitor = useRef<HTMLDivElement>(null);
  const cpuPreferencePending = syncState === 'loading';
  useMonitorChartFocus(monitor, section, host.isPending, cpuPreferencePending);
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

  return (
    <div className="desktop-monitor" data-cpu-preference-pending={cpuPreferencePending || undefined} ref={monitor}>
      <RouteHeaderStatus>
        <SettingsDirtyIndicator
          dirty={visible && logicalEdit !== null && !logicalEdit.pending}
          pending={visible && (syncState === 'saving' || logicalEdit?.pending === true)}
          loading={visible && syncState === 'loading'}
        />
      </RouteHeaderStatus>
      <MonitorWorkspace section={section} onSection={changeSection}>
        <Tabs.Content className="monitor-section-panel monitor-overview-panel" value="overview">
          <header className="monitor-page-heading">
            <div>
              <h2>Overview</h2>
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
          <section className="desktop-host-overview" data-multiple-servers={(cluster?.servers.length ?? 0) > 1} aria-label="Current system readings">
            <div className="desktop-host-overview-copy" key={selectedId}>
              <dl className="monitor-summary-grid">
                <div className="monitor-summary-stat" data-high={highUsage(cpuPercent)}>
                  <dt>
                    <MonitorChartLink resource="cpu">
                      <IconCpu size={18} aria-hidden="true" />
                      CPU
                    </MonitorChartLink>
                  </dt>
                  <dd className="monitor-summary-value" data-unavailable={cpuPercent === null}>
                    {percent(cpuPercent)}
                  </dd>
                  <dd className="monitor-summary-model">{sample?.cpu.model || 'CPU model not reported'}</dd>
                  <dd className="monitor-summary-detail">Total utilisation</dd>
                  <dd className="workspace-meter" aria-hidden="true">
                    <span style={{ width: width(cpuPercent) }} />
                  </dd>
                </div>
                <div className="monitor-summary-stat" data-high={highUsage(memoryPercent)}>
                  <dt>
                    <MonitorChartLink resource="memory">
                      <IconDeviceDesktopAnalytics size={18} aria-hidden="true" />
                      Memory
                    </MonitorChartLink>
                  </dt>
                  <dd className="monitor-summary-value" data-unavailable={memoryPercent === null}>
                    {percent(memoryPercent)}
                  </dd>
                  {memoryPercent !== null ? (
                    <dd className="monitor-summary-detail">
                      {bytes(usedMemory)} / {bytes(sample?.memory.totalBytes ?? null)}
                    </dd>
                  ) : null}
                  <dd className="workspace-meter" aria-hidden="true">
                    <span style={{ width: width(memoryPercent) }} />
                  </dd>
                </div>
                <div className="monitor-summary-stat" data-high={highUsage(storagePercent)}>
                  <dt>
                    <MonitorChartLink resource="storage" coreStorage={!hostDisk}>
                      <IconDatabase size={18} aria-hidden="true" />
                      {hostDisk ? 'Storage' : 'Core storage'}
                    </MonitorChartLink>
                  </dt>
                  <dd className="monitor-summary-value" data-unavailable={storagePercent === null}>
                    {percent(storagePercent)}
                  </dd>
                  {storagePercent !== null ? (
                    <dd className="monitor-summary-detail">
                      {bytes(disk?.usedBytes ?? null)} / {bytes(disk?.sizeBytes ?? null)}
                    </dd>
                  ) : null}
                  <dd className="workspace-meter" aria-hidden="true">
                    <span style={{ width: width(storagePercent) }} />
                  </dd>
                </div>
                <div className="monitor-summary-stat monitor-summary-network">
                  <dt>
                    <MonitorChartLink resource="network">
                      <IconNetwork size={18} aria-hidden="true" />
                      {network?.label ?? 'Network'}
                    </MonitorChartLink>
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
                  <dt>Logical processors</dt>
                  <dd>{sample?.cpu.perCorePercent.length || 'Unavailable'}</dd>
                </div>
              </dl>
            </div>
            {(cluster?.servers.length ?? 0) > 1 ? (
              <div className="monitor-rack-panel">
                <span className="monitor-rack-label">
                  <IconActivity size={15} aria-hidden="true" />
                  Server selector
                </span>
                <ServerRack cpu={cpuPercent} memory={memoryPercent} online={telemetry.isPending ? undefined : !telemetry.isError} />
              </div>
            ) : null}
          </section>
          <div className="monitor-temperature-strip">
            <dl>
              <div>
                <dt>CPU temperature</dt>
                <TemperatureReading sensor={cpuSensor} stale={delayedTemperature} />
              </div>
              {gpuTemperature ? (
                <div>
                  <dt>GPU temperature</dt>
                  <TemperatureReading sensor={gpuTemperature} stale={delayedTemperature} />
                </div>
              ) : null}
              {storageTemperature ? (
                <div>
                  <dt>Warmest drive</dt>
                  <TemperatureReading sensor={storageTemperature} stale={delayedTemperature} />
                </div>
              ) : null}
            </dl>
            <p className="monitor-temperature-description">
              {sensors.isPending
                ? 'Reading hardware sensors…'
                : sensors.isError || (sensors.data?.available && sensors.data.stale)
                  ? `Last reading${sensors.data?.available ? ` at ${new Date(sensors.data.sampledAt).toLocaleTimeString()}` : ''}. Refreshing hardware sensors…`
                  : sensors.data?.available === false
                    ? sensors.data.reason
                    : cpuSensor
                      ? `${/package id|tctl|tdie/i.test(cpuSensor.label) ? 'CPU package' : cpuSensor.label}${cpuSensor.criticalCelsius !== null ? ` · Critical at ${cpuSensor.criticalCelsius.toFixed(0)} °C` : ''}`
                      : 'No CPU temperature sensor is reported by this host.'}
            </p>
            {delayedTemperature && cpuSensor ? <span className="monitor-temperature-age">Readings delayed</span> : null}
            <button type="button" className="monitor-detail-action" onClick={() => changeSection('sensors')}>
              Hardware details
            </button>
          </div>
        </Tabs.Content>
        <Tabs.Content className="monitor-section-panel" value="usage">
          <MonitorUsage key={telemetryPath} />
        </Tabs.Content>
        <Tabs.Content className="monitor-section-panel" value="drives">
          <DriveHealthView key={selectedServer && !selectedServer.local ? selectedServer.id : 'local'} />
        </Tabs.Content>
        <Tabs.Content className="monitor-section-panel" value="performance">
          <MonitorPerformance
            key={telemetryPath}
            sample={sample}
            telemetryPending={telemetry.isPending}
            host={currentHost ?? undefined}
            sensors={sensors.data}
            delayed={telemetry.isError}
            sensorsDelayed={delayedTemperature}
            history={history.data}
            loading={history.isPending}
            logicalProcessors={logicalEdit?.checked ?? preferences.showLogicalProcessors ?? true}
            onLogicalProcessorsChange={saveLogicalProcessors}
            savingLogicalProcessors={logicalEdit?.pending}
            historyControls={
              <>
                <div className="monitor-history-toolbar">
                  <h3>Recorded history</h3>
                  <SelectionGroup as="fieldset" className="monitor-history-ranges">
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
                  </SelectionGroup>
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
                <p className="monitor-history-caption">Gaps indicate missing readings or a change in source.</p>
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
              </>
            }
          />
        </Tabs.Content>
        <Tabs.Content className="monitor-section-panel monitor-devices-panel" value="devices">
          <HostDevices />
          <MonitorDisclosure title="Recorded device history" openRequest={location.hash === '#device-history' ? location.key : undefined}>
            <HostDeviceHistoryView section="devices" layoutReady={!host.isPending} host={currentHost ?? undefined} />
          </MonitorDisclosure>
          <MonitorDisclosure
            title="Additional storage and network readings"
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
                  <h2 id="telemetry-network-title">Network</h2>
                  <div className="desktop-network-charts">
                    <div>
                      <h3>↓ Download</h3>
                      <MetricChart
                        history={history.data}
                        field="download"
                        label="Network download"
                        color="color-mix(in srgb, var(--desktop-accent) 60%, var(--desktop-positive))"
                        loading={history.isPending}
                      />
                    </div>
                    <div>
                      <h3>↑ Upload</h3>
                      <MetricChart
                        history={history.data}
                        field="upload"
                        label="Network upload"
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
            ) : telemetry.isPending ? (
              <p>Loading core storage and network readings…</p>
            ) : (
              <section className="desktop-telemetry-disks" aria-labelledby="telemetry-disks-title">
                <h2 id="telemetry-disks-title">Orbis core storage</h2>
                <p>Core storage and network readings are unavailable.</p>
              </section>
            )}
          </MonitorDisclosure>
        </Tabs.Content>
        <Tabs.Content className="monitor-section-panel" value="sensors">
          <HostSensorsView />
        </Tabs.Content>
      </MonitorWorkspace>
    </div>
  );
}
import { SelectionGroup } from '@/components/ui/SelectionGroup/SelectionGroup';
