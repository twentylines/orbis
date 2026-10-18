import { useQuery } from '@tanstack/react-query';
import { Fragment, useEffect, useRef } from 'react';
import type { HostTelemetry } from '@runtipi/common/schemas';
import { Link, useSearchParams } from 'react-router';
import { useWindowVisible } from '@/desktop/window-visibility';
import './host-devices.css';

function bytes(value: number | null) {
  if (value === null) return 'Unavailable';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const index = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log(Math.max(1, value)) / Math.log(1024))));
  const amount = value / 1024 ** index;
  return `${amount.toFixed(index && amount < 10 ? 1 : 0)} ${units[index]}`;
}
const rate = (value: number | null) => (value === null ? 'Unavailable' : `${bytes(value)}/s`);

function HistoryLink({ kind, name }: { kind: 'network' | 'disk'; name: string }) {
  const [params] = useSearchParams();
  const next = new URLSearchParams(params);
  next.set('hostDevice', `${kind}:${name}`);
  return (
    <Link
      className="btn btn-secondary host-device-history-action"
      to={{ search: next.toString(), hash: '#device-history' }}
      preventScrollReset
      state={{ focusHostHistory: true }}
      aria-label={`View history for ${name}`}
    >
      View history
    </Link>
  );
}

async function loadHostDevices(signal: AbortSignal): Promise<HostTelemetry> {
  const response = await fetch('/api/system/host-telemetry', { credentials: 'include', signal });
  if (!response.ok) throw new Error('Unable to read host devices');
  return response.json();
}

function Facts({ values }: { values: [string, string][] }) {
  return (
    <dl className="host-device-facts">
      {values.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Coverage({ omitted, unavailable }: { omitted: number; unavailable: boolean }) {
  return omitted || unavailable ? (
    <p className="host-device-coverage">
      {unavailable ? 'Some readings are unavailable. ' : ''}
      {omitted ? `${omitted} additional ${omitted === 1 ? 'item is' : 'items are'} not shown.` : ''}
    </p>
  ) : null;
}

function MountPath({ mount }: { mount: string }) {
  const segments = mount.match(/[^/]+\/?|\/+/g) ?? [mount];
  if (segments.length > 1 && /^\/+$/.test(segments[0] ?? '')) segments.splice(0, 2, `${segments[0]}${segments[1]}`);
  if (segments.length > 32) segments.splice(31, segments.length - 31, segments.slice(31).join(''));
  let offset = 0;
  return (
    <h4 className="host-device-identifier host-device-mount" title={mount}>
      {segments.map((segment) => {
        offset += segment.length;
        return (
          <Fragment key={offset}>
            <span className="host-device-segment" title={segment}>
              {segment}
            </span>
            <wbr />
          </Fragment>
        );
      })}
    </h4>
  );
}

export function HostDevices() {
  const visible = useWindowVisible();
  const query = useQuery({
    queryKey: ['host-telemetry'],
    queryFn: ({ signal }) => loadHostDevices(signal),
    enabled: visible,
    refetchInterval: (query) => (query.state.data?.available === false && query.state.data.reason === 'Collecting host readings.' ? 2000 : 10_000),
    refetchIntervalInBackground: false,
  });
  const data = query.data;
  const ready = data?.available ? data : null;
  const stale = query.isError || ready?.stale;
  const heading = useRef<HTMLHeadingElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const retryFocus = useRef(false);
  useEffect(() => {
    if (query.isFetching || !retryFocus.current) return;
    retryFocus.current = false;
    const active = document.activeElement;
    if (active !== document.body && active !== retry.current) return;
    (ready && !query.isError ? heading.current : retry.current)?.focus({ preventScroll: true });
  }, [query.isFetching, query.isError, ready]);
  return (
    <section className="desktop-host-devices" aria-labelledby="host-devices-title">
      <header className="host-devices-heading">
        <h2 id="host-devices-title" ref={heading} tabIndex={-1}>
          Host devices
        </h2>
        <span className="host-devices-state" data-stale={Boolean(stale)}>
          {ready ? (stale ? 'Readings delayed' : 'Updates every 10 seconds') : 'Storage, interfaces and disk activity'}
        </span>
      </header>
      {query.isPending ? <output>Loading host devices…</output> : null}
      {query.isError || data?.available === false ? (
        <div className="host-devices-notice" role={query.isError ? 'alert' : 'status'}>
          <p>
            {query.isError ? 'Host readings could not be refreshed. Previous values may be stale.' : data?.available === false ? data.reason : ''}
          </p>
          <button
            type="button"
            className="btn btn-secondary"
            ref={retry}
            onClick={() => {
              retryFocus.current = document.activeElement === retry.current;
              void query.refetch();
            }}
            disabled={query.isFetching}
          >
            {query.isFetching ? 'Checking…' : 'Retry'}
          </button>
        </div>
      ) : null}
      {ready ? (
        <>
          {stale ? (
            <output className="host-devices-stale">
              Last host sample: <time dateTime={ready.sampledAt}>{new Date(ready.sampledAt).toLocaleString()}</time>. Values may be stale.
            </output>
          ) : null}
          <div className="host-device-sections">
            <section aria-labelledby="host-storage-title">
              <h3 id="host-storage-title">Mounted filesystems</h3>
              <div className="host-device-list">
                {ready.filesystems.map((disk) => {
                  const used = disk.sizeBytes ? (disk.usedBytes / disk.sizeBytes) * 100 : null;
                  return (
                    <article className="host-device" key={disk.mount}>
                      <MountPath mount={disk.mount} />
                      <p className="host-device-kind">
                        {disk.filesystem}
                        {disk.readOnly ? ' · Read only' : ''}
                      </p>
                      <Facts
                        values={[
                          ['Used', bytes(disk.usedBytes)],
                          ['Capacity', bytes(disk.sizeBytes)],
                          ['Available', bytes(disk.availableBytes)],
                        ]}
                      />
                      {used !== null ? (
                        <div className="workspace-meter" aria-hidden="true">
                          <span style={{ width: `${used}%` }} />
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
              {ready.filesystems.length ? null : <p>No mounted filesystem readings available.</p>}
              <Coverage omitted={ready.omitted.filesystems} unavailable={ready.unavailable.includes('filesystems')} />
            </section>
            <section aria-labelledby="host-network-title">
              <h3 id="host-network-title">Network interfaces</h3>
              <div className="host-device-list">
                {ready.network.map((item) => (
                  <article className="host-device" key={item.interface}>
                    <div className="host-device-heading">
                      <h4 className="host-device-identifier" title={item.interface}>
                        {item.interface}
                      </h4>
                      <span className="host-device-link" data-state={item.state}>
                        {item.state === 'up' ? 'Link up' : item.state === 'down' ? 'Link down' : 'Link unknown'}
                      </span>
                    </div>
                    {item.speedMbps !== null ? <p className="host-device-kind">Link speed {item.speedMbps.toLocaleString()} Mb/s</p> : null}
                    <Facts
                      values={[
                        ['Download', rate(item.rxBytesPerSecond)],
                        ['Upload', rate(item.txBytesPerSecond)],
                        ['Received', bytes(item.receivedBytes)],
                        ['Sent', bytes(item.transmittedBytes)],
                      ]}
                    />
                    <HistoryLink kind="network" name={item.interface} />
                  </article>
                ))}
              </div>
              {ready.network.length ? null : <p>No network interface readings available.</p>}
              <Coverage omitted={ready.omitted.network} unavailable={ready.unavailable.includes('network')} />
            </section>
            <section aria-labelledby="host-disk-activity-title">
              <h3 id="host-disk-activity-title">Disk activity</h3>
              <div className="host-device-list">
                {ready.disks.map((disk) => (
                  <article className="host-device" key={disk.device}>
                    <h4 className="host-device-identifier" title={disk.device}>
                      {disk.device}
                    </h4>
                    <Facts
                      values={[
                        ['Read', rate(disk.readBytesPerSecond)],
                        ['Write', rate(disk.writeBytesPerSecond)],
                        ['Active time', disk.busyPercent === null ? 'Unavailable' : `${disk.busyPercent.toFixed(1)}%`],
                        ['In progress', disk.inFlight === null ? 'Unavailable' : disk.inFlight.toLocaleString()],
                      ]}
                    />
                    <HistoryLink kind="disk" name={disk.device} />
                  </article>
                ))}
              </div>
              {ready.disks.length ? null : <p>No disk activity readings available.</p>}
              <p className="host-device-footnote">Rates need two recent samples. Partitions are excluded; layered devices can share the same I/O.</p>
              <Coverage omitted={ready.omitted.disks} unavailable={ready.unavailable.includes('disks')} />
            </section>
          </div>
        </>
      ) : null}
    </section>
  );
}
