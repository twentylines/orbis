import { useServerPath } from '@/desktop/cluster-data';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { metricHistoryRanges, type HostDeviceHistory, type HostHistorySelection, type MetricHistoryRange } from '@runtipi/common/schemas';
import { MetricPlot, formatPlotValue, type MetricPlotHistory } from '@/components/metric-chart/metric-plot';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select/Select';
import { useWindowVisible } from '@/desktop/window-visibility';
import './host-device-history.css';

const keyOf = (device: HostHistorySelection) => `${device.kind}:${device.name}`;
const kindLabel = (kind: HostHistorySelection['kind']) => (kind === 'network' ? 'Network' : 'Disk');
const ranges = [
  ['5m', '5 min'],
  ['1h', '1 hour'],
  ['24h', '24 hours'],
  ['7d', '7 days'],
] as const;

export function HostDeviceHistoryView() {
  const visible = useWindowVisible();
  const serverPath = useServerPath();
  const queryClient = useQueryClient();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedRange = searchParams.get('range');
  const range: MetricHistoryRange = selectedRange && Object.hasOwn(metricHistoryRanges, selectedRange) ? (selectedRange as MetricHistoryRange) : '1h';
  const requested = searchParams.get('hostDevice');
  const device =
    requested &&
    requested.length <= 136 &&
    /^(network|disk):[a-zA-Z0-9_.:@+!-]{1,128}$/.test(requested) &&
    !/^(network|disk):\.{1,2}$/.test(requested)
      ? requested
      : null;
  const path = serverPath(`/api/system/host-history?range=${range}${device ? `&device=${encodeURIComponent(device)}` : ''}`);
  const query = useQuery<HostDeviceHistory>({
    queryKey: ['host-device-history', range, device, path],
    queryFn: async ({ signal }) => {
      const response = await fetch(path, {
        credentials: 'include',
        signal,
      });
      if (!response.ok) throw new Error('Host history is unavailable');
      return response.json();
    },
    enabled: visible,
    placeholderData: keepPreviousData,
    staleTime: 9000,
    refetchInterval: range === '5m' ? 10000 : 30000,
    refetchIntervalInBackground: false,
  });
  const data = query.isPlaceholderData ? undefined : query.data;
  const loading = query.isPending || query.isPlaceholderData;
  const selected: HostHistorySelection | null | undefined = device
    ? { kind: device.startsWith('network:') ? 'network' : 'disk', name: device.slice(device.indexOf(':') + 1) }
    : query.data?.selected;
  const selectedKey = selected ? keyOf(selected) : '';
  const devices = query.data?.devices ?? [];
  const selectedDevice = devices.find((item) => keyOf(item) === selectedKey);
  const choices = selected && !selectedDevice ? [...devices, { ...selected, lastSeenAt: '', present: false }] : devices;
  useEffect(() => {
    if (device || !data?.selected) return;
    const resolved = keyOf(data.selected);
    queryClient.setQueryData(['host-device-history', range, resolved], data);
    const next = new URLSearchParams(searchParams);
    next.set('hostDevice', resolved);
    next.set('range', range);
    setSearchParams(next, { replace: true, preventScrollReset: true, state: null });
  }, [device, data, range, queryClient, searchParams, setSearchParams]);
  const plots = useMemo(() => {
    if (!data) return null;
    const plot = (field: 'inbound' | 'outbound' | 'busy'): MetricPlotHistory => ({
      from: data.from,
      to: data.to,
      points: data.points.map((point) => ({
        at: point.at,
        until: point.until,
        intervalSeconds: point.intervalSeconds,
        samples: point.samples,
        identity: point.sourceId,
        value: point[field],
      })),
    });
    return { inbound: plot('inbound'), outbound: plot('outbound'), busy: plot('busy') };
  }, [data]);
  const heading = useRef<HTMLHeadingElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const previousHash = useRef<string | null>(null);
  const focusedRequest = useRef<string | null>(null);
  useEffect(() => {
    if (!visible) return;
    const explicit = location.state?.focusHostHistory === true && focusedRequest.current !== location.key;
    if (location.hash === '#device-history' && (previousHash.current !== location.hash || explicit)) {
      heading.current?.focus();
      focusedRequest.current = location.key;
    }
    previousHash.current = location.hash;
  }, [visible, location.hash, location.key, location.state]);
  useEffect(() => {
    if (query.isFetching || !restoreFocus.current) return;
    restoreFocus.current = false;
    if (document.activeElement !== document.body && document.activeElement !== retry.current) return;
    (data && !query.isError ? heading.current : retry.current)?.focus({ preventScroll: true });
  }, [query.isFetching, query.isError, data]);

  const setParam = (name: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (selected && name === 'range') next.set('hostDevice', keyOf(selected));
    next.set(name, value);
    setSearchParams(next, { replace: true, preventScrollReset: true, state: null });
  };
  const fields =
    selected?.kind === 'disk'
      ? ([
          ['inbound', 'Read', 'bytesPerSecond', '#9fc0ad'],
          ['outbound', 'Write', 'bytesPerSecond', '#d1a172'],
          ['busy', 'Active time', 'percent', '#92b9cb'],
        ] as const)
      : ([
          ['inbound', 'Download', 'bytesPerSecond', '#9fc0ad'],
          ['outbound', 'Upload', 'bytesPerSecond', '#d1a172'],
        ] as const);

  return (
    <section className="host-device-history" id="device-history" aria-labelledby="host-device-history-title" aria-busy={loading}>
      <header className="host-history-heading">
        <h2 id="host-device-history-title" tabIndex={-1} ref={heading}>
          Device history
        </h2>
        <span className="host-history-state">Recorded every 10 seconds</span>
      </header>
      <div className="host-history-controls">
        <div className="host-history-device">
          <Select value={selectedKey} onValueChange={(value) => setParam('hostDevice', value)} disabled={!choices.length}>
            <SelectTrigger label="Host device" value={selectedKey} title={selected ? `${kindLabel(selected.kind)}: ${selected.name}` : undefined}>
              <SelectValue placeholder={loading ? 'Loading devices…' : 'No recorded devices'} />
            </SelectTrigger>
            <SelectContent className="host-history-device-menu">
              {choices.map((item) => (
                <SelectItem
                  key={keyOf(item)}
                  value={keyOf(item)}
                  textValue={`${kindLabel(item.kind)} ${item.name}`}
                  aria-label={`${kindLabel(item.kind)} ${item.name}`}
                >
                  <span className="host-history-choice" title={`${kindLabel(item.kind)}: ${item.name}`}>
                    <span>{kindLabel(item.kind)}</span>
                    <bdi>{item.name}</bdi>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <fieldset className="monitor-history-ranges host-history-ranges">
          <legend className="visually-hidden">Device history time range</legend>
          {ranges.map(([value, label]) => (
            <button type="button" key={value} aria-pressed={range === value} onClick={() => setParam('range', value)}>
              {label}
            </button>
          ))}
        </fieldset>
      </div>
      {query.isError ? (
        <div className="host-history-notice" role="alert">
          <p>Device history could not be refreshed. Previous samples may be stale.</p>
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
      {loading && !selected ? <output>Loading device history…</output> : null}
      {data || selected ? (
        <>
          {data?.reason ? (
            <output className="host-history-notice" data-stale={!data.collectorAvailable}>
              {data.reason}
            </output>
          ) : null}
          {data?.storage === 'unavailable' ? (
            <p className="host-history-notice" role="alert">
              Device history storage is unavailable. Unsaved readings may be lost on restart.
            </p>
          ) : null}
          {data && data.unidentifiedDevices > 0 ? (
            <p className="host-history-coverage">
              {data.unidentifiedDevices} {data.unidentifiedDevices === 1 ? 'device lacks' : 'devices lack'} a stable history identity. Update the
              Orbis host service to record those devices.
            </p>
          ) : null}
          {data && (data.omittedDevices > 0 || data.evictedDevices > 0) ? (
            <p className="host-history-coverage">
              {data.omittedDevices > 0 ? `${data.omittedDevices} additional devices were not collected. ` : ''}
              {data.evictedDevices > 0 ? `${data.evictedDevices} older device records were removed to keep history within its 64-device limit.` : ''}
            </p>
          ) : null}
          {selected ? (
            <>
              <p className="host-history-device-state" role={loading ? 'status' : undefined}>
                {loading
                  ? 'Loading selected history…'
                  : data
                    ? selectedDevice?.present
                      ? 'Current device'
                      : 'Not currently reported'
                    : 'History unavailable'}
                {data && selectedDevice?.lastSeenAt && !selectedDevice.present
                  ? ` · Last seen ${new Date(selectedDevice.lastSeenAt).toLocaleString()}`
                  : ''}
                {' · '}
                {range === '5m' ? 'Recent samples' : range === '1h' ? '1 min averages' : range === '24h' ? '5 min averages' : '30 min averages'}
              </p>
              <div className="host-history-charts" key={selectedKey}>
                {fields.map(([field, label, unit, color]) => {
                  const chart = plots?.[field];
                  const latest = chart?.points.at(-1)?.value.average ?? null;
                  return (
                    <section className="host-history-chart" key={field} aria-label={`${label} history`}>
                      <header>
                        <h3>{label}</h3>
                        <output>{loading ? 'Loading…' : formatPlotValue(latest, unit)}</output>
                      </header>
                      <MetricPlot
                        history={chart}
                        metricKey={`host-${field}`}
                        unit={unit}
                        label={`${selected.name} ${label.toLowerCase()}`}
                        color={color}
                        loading={loading}
                        emptyMessage={!data && query.isError ? 'History unavailable' : undefined}
                      />
                    </section>
                  );
                })}
              </div>
            </>
          ) : (
            <p>No device samples have been recorded yet.</p>
          )}
          {data ? (
            <details className="host-history-about">
              <summary>About device history</summary>
              <p>
                Collection continues when this page is closed. History is retained for seven days. Longer ranges show sample averages and peaks; use
                the pointer or arrow keys to inspect each chart.
              </p>
              <p>
                Gaps indicate missing readings or a device change. A reboot starts a new series. Disk active time is approximate; layered disks and
                virtual interfaces can share the same traffic.
              </p>
              <p>
                {data.persistedThrough ? (
                  <>
                    Saved through <time dateTime={data.persistedThrough}>{new Date(data.persistedThrough).toLocaleString()}</time>.
                  </>
                ) : (
                  'The first minute has not been saved yet.'
                )}{' '}
                Recent samples stay in memory. Saved summaries survive a restart.
              </p>
            </details>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
