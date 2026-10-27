import { useServerPath } from '@/desktop/cluster-data';
import { useQuery } from '@tanstack/react-query';
import { Fragment, memo, useEffect, useRef, useState } from 'react';
import type { HostTelemetry } from '@runtipi/common/schemas';
import { Link, useSearchParams } from 'react-router';
import { useWindowVisible } from '@/desktop/window-visibility';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
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

async function loadHostDevices(signal: AbortSignal, path: string): Promise<HostTelemetry> {
  const response = await fetch(path, { credentials: 'include', signal });
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

export function useHostReadings() {
  const visible = useWindowVisible();
  const path = useServerPath()('/api/system/host-telemetry');
  return useQuery({
    queryKey: ['host-telemetry', path],
    queryFn: ({ signal }) => loadHostDevices(signal, path),
    enabled: visible,
    refetchInterval: (query) => (query.state.data?.available === false && query.state.data.reason === 'Collecting host readings.' ? 2000 : 10_000),
    refetchIntervalInBackground: false,
  });
}

export const HostDevices = memo(function HostDevices() {
  const query = useHostReadings();
  const data = query.data;
  const ready = data?.available ? data : null;
  const stale = query.isError || ready?.stale;
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<'all' | 'filesystems' | 'network' | 'disks'>('all');
  const term = search.trim().toLocaleLowerCase();
  const filesystems = ready?.filesystems.filter((disk) => `${disk.mount} ${disk.filesystem}`.toLocaleLowerCase().includes(term)) ?? [];
  const network = ready?.network.filter((item) => item.interface.toLocaleLowerCase().includes(term)) ?? [];
  const disks = ready?.disks.filter((disk) => disk.device.toLocaleLowerCase().includes(term)) ?? [];
  const matching =
    (kind === 'all' || kind === 'filesystems' ? filesystems.length : 0) +
    (kind === 'all' || kind === 'network' ? network.length : 0) +
    (kind === 'all' || kind === 'disks' ? disks.length : 0);
  const returned = ready ? (kind === 'all' ? ready.filesystems.length + ready.network.length + ready.disks.length : ready[kind].length) : 0;
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
          <div className="host-device-controls">
            <input
              type="search"
              className="form-control"
              aria-label="Find a device"
              placeholder="Find a device"
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
            />
            <Select
              value={kind}
              onValueChange={(value) => {
                if (value === 'all' || value === 'filesystems' || value === 'network' || value === 'disks') setKind(value);
              }}
            >
              <SelectTrigger fitContent className="host-device-select" aria-label="Device type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All devices</SelectItem>
                <SelectItem value="filesystems">Filesystems</SelectItem>
                <SelectItem value="network">Network interfaces</SelectItem>
                <SelectItem value="disks">Disks</SelectItem>
              </SelectContent>
            </Select>
            <span className="host-device-count">
              {matching} of {returned} returned devices
            </span>
          </div>
          {term && !matching ? <p className="host-device-empty">No matching devices. Try another name or device type.</p> : null}
          <div className="host-device-sections">
            {(kind === 'all' || kind === 'filesystems') && (!term || filesystems.length > 0) ? (
              <section aria-labelledby="host-storage-title">
                <h3 id="host-storage-title">
                  Mounted filesystems <span>({filesystems.length})</span>
                </h3>
                <div className="host-device-list">
                  {filesystems.map((disk) => {
                    const used = disk.sizeBytes ? (disk.usedBytes / disk.sizeBytes) * 100 : null;
                    return (
                      <article className="host-device" data-kind="filesystem" key={disk.mount}>
                        <div className="host-device-identity">
                          <MountPath mount={disk.mount} />
                          <p className="host-device-kind">
                            {disk.filesystem}
                            {disk.readOnly ? ' · Read only' : ''}
                          </p>
                        </div>
                        <Facts
                          values={[
                            ['Used', bytes(disk.usedBytes)],
                            ['Capacity', bytes(disk.sizeBytes)],
                            ['Available', bytes(disk.availableBytes)],
                          ]}
                        />
                        {used !== null ? (
                          <div className="workspace-meter" aria-hidden="true">
                            <span style={{ width: `${Math.min(100, Math.max(0, used))}%` }} />
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
                {ready.filesystems.length ? null : <p>No mounted filesystem readings available.</p>}
                <Coverage omitted={ready.omitted.filesystems} unavailable={ready.unavailable.includes('filesystems')} />
              </section>
            ) : null}
            {(kind === 'all' || kind === 'network') && (!term || network.length > 0) ? (
              <section aria-labelledby="host-network-title">
                <h3 id="host-network-title">
                  Network interfaces <span>({network.length})</span>
                </h3>
                <div className="host-device-list">
                  {network.map((item) => (
                    <article className="host-device" data-kind="network" key={item.interface}>
                      <div className="host-device-identity">
                        <div className="host-device-heading">
                          <h4 className="host-device-identifier" title={item.interface}>
                            {item.interface}
                          </h4>
                          <span className="host-device-link" data-state={item.state}>
                            {item.state === 'up' ? 'Link up' : item.state === 'down' ? 'Link down' : 'Link unknown'}
                          </span>
                        </div>
                        {item.speedMbps !== null ? <p className="host-device-kind">Link speed {item.speedMbps.toLocaleString()} Mb/s</p> : null}
                      </div>
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
            ) : null}
            {(kind === 'all' || kind === 'disks') && (!term || disks.length > 0) ? (
              <section aria-labelledby="host-disk-activity-title">
                <h3 id="host-disk-activity-title">
                  Disk activity <span>({disks.length})</span>
                </h3>
                <div className="host-device-list">
                  {disks.map((disk) => (
                    <article className="host-device" data-kind="disk" key={disk.device}>
                      <div className="host-device-identity">
                        <h4 className="host-device-identifier" title={disk.device}>
                          {disk.device}
                        </h4>
                      </div>
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
                <p className="host-device-footnote">
                  Rates need two recent samples. Partitions are excluded; layered devices can share the same I/O.
                </p>
                <Coverage omitted={ready.omitted.disks} unavailable={ready.unavailable.includes('disks')} />
              </section>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
});
