import { useServerPath } from '@/desktop/cluster-data';
import { useQuery } from '@tanstack/react-query';
import { IconChevronRight } from '@tabler/icons-react';
import type { HostSensors, HostSensorStatus } from '@runtipi/common/schemas';
import { useEffect, useRef } from 'react';
import { useWindowVisible } from '@/desktop/window-visibility';
import { resourceBytes } from '@/components/container-resources/container-resources';
import './host-sensors.css';
import { sensorRefreshInterval } from './system-readings';

async function loadSensors(signal: AbortSignal, path: string): Promise<HostSensors> {
  const response = await fetch(path, { credentials: 'include', signal });
  if (!response.ok) throw new Error('Unable to read hardware sensors');
  return response.json();
}

const sensorState: Record<HostSensorStatus, string> = {
  available: '',
  fault: 'Sensor fault',
  disabled: 'Disabled',
  unavailable: 'Unavailable',
};
const temperature = (value: number) => `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} °C`;

function SensorCoverage({ omitted, unavailable }: { omitted: number; unavailable: boolean }) {
  return omitted || unavailable ? (
    <p className="host-sensor-coverage">
      {unavailable ? 'Some readings could not be read. ' : ''}
      {omitted ? `${omitted.toLocaleString()} additional ${omitted === 1 ? 'item is' : 'items are'} not shown.` : ''}
    </p>
  ) : null;
}

export function HostSensorsView() {
  const visible = useWindowVisible();
  const path = useServerPath()('/api/system/host-sensors');
  const query = useQuery({
    queryKey: ['host-sensors', path],
    queryFn: ({ signal }) => loadSensors(signal, path),
    enabled: visible,
    refetchInterval: (query) => sensorRefreshInterval(query.state.data),
    refetchIntervalInBackground: false,
  });
  const data = query.data;
  const ready = data?.available ? data : null;
  const stale = query.isError || Boolean(ready?.stale);
  const heading = useRef<HTMLHeadingElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (query.isFetching || !restoreFocus.current) return;
    restoreFocus.current = false;
    if (document.activeElement !== document.body && document.activeElement !== retry.current) return;
    (ready && !query.isError ? heading.current : retry.current)?.focus({ preventScroll: true });
  }, [query.isFetching, query.isError, ready]);

  return (
    <section className="host-sensors" id="sensors" aria-labelledby="host-sensors-title">
      <header className="host-sensors-heading">
        <h2 id="host-sensors-title" tabIndex={-1} ref={heading}>
          Hardware sensors
        </h2>
        <span className="host-sensors-state" data-stale={stale}>
          {ready ? (stale ? 'Readings delayed' : 'Updates every 30 seconds') : 'Temperatures, fans and GPUs'}
        </span>
      </header>
      {query.isPending ? <output>Loading hardware readings…</output> : null}
      {query.isError || data?.available === false ? (
        <div className="host-sensors-notice" role={query.isError ? 'alert' : 'status'}>
          <p>{query.isError ? 'Hardware readings could not be refreshed.' : data?.available === false ? data.reason : ''}</p>
          <button
            type="button"
            className="btn btn-secondary"
            ref={retry}
            disabled={query.isFetching}
            onClick={() => {
              restoreFocus.current = document.activeElement === retry.current;
              void query.refetch();
            }}
          >
            {query.isFetching ? 'Checking…' : 'Retry'}
          </button>
        </div>
      ) : null}
      {ready ? (
        <>
          {stale ? (
            <output className="host-sensors-stale">
              Last hardware sample: <time dateTime={ready.sampledAt}>{new Date(ready.sampledAt).toLocaleString()}</time>. Values may be stale.
            </output>
          ) : null}
          {ready.limited || ready.unreadable > 0 ? (
            <p className="host-sensor-coverage">
              {ready.limited ? 'The hardware scan reached its limit; some readings may be missing. ' : ''}
              {ready.unreadable ? `${ready.unreadable.toLocaleString()} hardware attributes could not be read.` : ''}
            </p>
          ) : null}
          {!ready.temperatures.length &&
          !ready.fans.length &&
          !ready.gpus.length &&
          !ready.unavailable.length &&
          !ready.limited &&
          !ready.unreadable &&
          !Object.values(ready.omitted).some(Boolean) ? (
            <p className="host-sensors-empty">This host exposes no temperature sensors, fans or GPUs.</p>
          ) : (
            <div className="host-sensor-groups">
              <section aria-labelledby="host-temperatures-title">
                <h3 id="host-temperatures-title">Temperatures</h3>
                <div className="host-sensor-list">
                  {ready.temperatures.map((sensor) => {
                    const critical = sensor.celsius !== null && sensor.criticalCelsius !== null && sensor.celsius >= sensor.criticalCelsius;
                    return (
                      <article className="host-sensor-card" key={sensor.id} data-sensor-id={sensor.id}>
                        <h4 title={sensor.label}>{sensor.label}</h4>
                        <p className="host-sensor-chip" title={sensor.chip}>
                          {sensor.chip}
                        </p>
                        <strong className="host-sensor-reading" data-status={sensor.status} data-warning={critical || sensor.status === 'fault'}>
                          {sensor.celsius === null ? sensorState[sensor.status] || 'Unavailable' : temperature(sensor.celsius)}
                        </strong>
                        {sensor.criticalCelsius !== null ? (
                          <p className="host-sensor-threshold">
                            Critical threshold {temperature(sensor.criticalCelsius)}
                            {critical ? ' · Reached' : ''}
                          </p>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
                {ready.temperatures.length ? null : <p className="host-sensor-empty">No temperature readings returned.</p>}
                <SensorCoverage omitted={ready.omitted.temperatures} unavailable={ready.unavailable.includes('temperatures')} />
              </section>
              <section aria-labelledby="host-fans-title">
                <h3 id="host-fans-title">Fans</h3>
                <div className="host-sensor-list">
                  {ready.fans.map((sensor) => (
                    <article className="host-sensor-card" key={sensor.id} data-sensor-id={sensor.id}>
                      <h4 title={sensor.label}>{sensor.label}</h4>
                      <p className="host-sensor-chip" title={sensor.chip}>
                        {sensor.chip}
                      </p>
                      <strong className="host-sensor-reading" data-status={sensor.status} data-warning={sensor.status === 'fault'}>
                        {sensor.rpm === null ? sensorState[sensor.status] || 'Unavailable' : `${sensor.rpm.toLocaleString()} RPM`}
                      </strong>
                    </article>
                  ))}
                </div>
                {ready.fans.length ? null : <p className="host-sensor-empty">No fan readings returned.</p>}
                <SensorCoverage omitted={ready.omitted.fans} unavailable={ready.unavailable.includes('fans')} />
              </section>
              <section aria-labelledby="host-gpus-title">
                <h3 id="host-gpus-title">GPUs</h3>
                <div className="host-sensor-list">
                  {ready.gpus.map((gpu) => (
                    <article className="host-sensor-card" key={gpu.id} data-sensor-id={gpu.id}>
                      <h4 title={gpu.label}>{gpu.label}</h4>
                      <p
                        className="host-sensor-chip"
                        data-fallback={!gpu.vendor && !gpu.driver}
                        title={[gpu.vendor, gpu.driver].filter(Boolean).join(' · ') || 'Driver not reported'}
                      >
                        {[gpu.vendor, gpu.driver].filter(Boolean).join(' · ') || 'Driver not reported'}
                      </p>
                      <dl className="host-gpu-facts">
                        <div>
                          <dt>Activity</dt>
                          <dd>{gpu.utilizationPercent === null ? 'Unavailable' : `${gpu.utilizationPercent.toFixed(1)}%`}</dd>
                        </div>
                        <div>
                          <dt>VRAM used</dt>
                          <dd>{gpu.memoryUsedBytes === null ? 'Unavailable' : resourceBytes(gpu.memoryUsedBytes)}</dd>
                        </div>
                        <div>
                          <dt>VRAM capacity</dt>
                          <dd>{gpu.memoryTotalBytes === null ? 'Unavailable' : resourceBytes(gpu.memoryTotalBytes)}</dd>
                        </div>
                      </dl>
                    </article>
                  ))}
                </div>
                {ready.gpus.length ? null : <p className="host-sensor-empty">No GPUs reported.</p>}
                <SensorCoverage omitted={ready.omitted.gpus} unavailable={ready.unavailable.includes('gpus')} />
              </section>
            </div>
          )}
        </>
      ) : null}
      <details className="host-sensors-about">
        <summary>
          <IconChevronRight size={16} aria-hidden="true" />
          <span>About these readings</span>
        </summary>
        <p>Readings come from sensors exposed by the Linux kernel. Virtual machines and some hardware drivers may not provide them.</p>
        <p>GPU activity and VRAM are available for AMDGPU where supported. Other GPUs show their identity with unavailable metrics.</p>
        <p>These are current readings, without recorded sensor history. Fan speed is read only; Orbis does not change fan or temperature settings.</p>
      </details>
    </section>
  );
}
