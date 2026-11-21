import type { HostTelemetry } from '@runtipi/common/schemas';
import { useServerPath } from '@/desktop/cluster-data';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { IconArrowLeft } from '@tabler/icons-react';
import { Tooltip } from 'react-tooltip';
import { createPortal } from 'react-dom';
import { metricHistoryRanges, type MetricHistoryRange } from '@runtipi/common/schemas/metric-history';
import type { HostDeviceHistory, HostHistorySelection } from '@runtipi/common/schemas/host-device-history';
import { MetricPlot, formatPlotValue, type MetricPlotHistory } from '@/components/metric-chart/metric-plot';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select/Select';
import { SelectionGroup } from '@/components/ui/SelectionGroup/SelectionGroup';
import { useWindowVisible } from '@/desktop/window-visibility';
import { LiveMetricChart, useLiveSamples } from './live-metric-chart';
import { percentReading, rateReading } from './logical-processor-history';
import './host-device-history.css';

const keyOf = (device: HostHistorySelection) => `${device.kind}:${device.name}`;
const historyQueryKey = (basePath: string, range: MetricHistoryRange, device: string | null) =>
  ['host-device-history', basePath, range, device] as const;
const kindLabel = (kind: HostHistorySelection['kind']) => (kind === 'network' ? 'Network' : 'Disk');
const ranges = [
  ['5m', '5 min'],
  ['1h', '1 hour'],
  ['24h', '24 hours'],
  ['7d', '7 days'],
] as const;

function HostDeviceLiveCharts({ host, selected }: { host?: HostTelemetry; selected: HostHistorySelection }) {
  const current = host?.available && !host.stale ? host : undefined;
  const network = selected.kind === 'network' ? current?.network.find((item) => item.interface === selected.name) : undefined;
  const disk = selected.kind === 'disk' ? current?.disks.find((item) => item.device === selected.name) : undefined;
  const samples = useLiveSamples(current?.sampledAt, JSON.stringify([selected.kind, selected.name, network?.historyId ?? disk?.historyId]), [
    rateReading(network?.rxBytesPerSecond ?? disk?.readBytesPerSecond ?? null),
    rateReading(network?.txBytesPerSecond ?? disk?.writeBytesPerSecond ?? null),
    percentReading(disk?.busyPercent ?? null),
  ]);

  return (
    <section className="host-history-live" aria-label="Device activity">
      <h3 className="monitor-chart-subtitle">Device activity</h3>
      <p className="monitor-processor-caption">Last 60 seconds · gaps mean missing readings.</p>
      <div className="monitor-live-chart-grid">
        <LiveMetricChart label={selected.kind === 'disk' ? 'Read' : 'Download'} samples={samples} unit="rate" />
        <LiveMetricChart label={selected.kind === 'disk' ? 'Write' : 'Upload'} samples={samples} index={1} unit="rate" />
        {selected.kind === 'disk' ? <LiveMetricChart label="Active time" samples={samples} index={2} /> : null}
      </div>
    </section>
  );
}

export type OpenDeviceHistory = (device: HostHistorySelection, opener: HTMLButtonElement) => void;

export function HistoryHelp({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const [pointer, setPointer] = useState<{ x: number; y: number }>();
  const trackPointer = (event: PointerEvent<HTMLButtonElement>) => {
    setPointer(event.pointerType === 'mouse' ? { x: event.clientX, y: event.clientY } : undefined);
  };
  return (
    <>
      <button
        className="monitor-history-help"
        type="button"
        aria-label={label}
        data-tooltip-id={id}
        onPointerEnter={trackPointer}
        onPointerMove={trackPointer}
        onFocus={() => setPointer(undefined)}
      >
        <span className="form-help" aria-hidden="true">
          ?
        </span>
      </button>
      {typeof document === 'undefined'
        ? null
        : createPortal(
            <Tooltip
              id={id}
              className="tooltip monitor-history-tooltip"
              positionStrategy="fixed"
              position={pointer}
              openEvents={{ mouseenter: true, focus: true, click: true }}
              closeEvents={{ mouseleave: true, blur: true }}
              globalCloseEvents={{ escape: true, clickOutsideAnchor: true, scroll: true, resize: true }}
              clickable
            >
              {children}
            </Tooltip>,
            document.body,
          )}
    </>
  );
}

export function DeviceHistoryWorkspace({
  initiallyOpen,
  searchParams,
  host,
  children,
}: {
  initiallyOpen: boolean;
  searchParams: URLSearchParams;
  host?: HostTelemetry;
  children: (open: OpenDeviceHistory) => ReactNode;
}) {
  const [page, setPage] = useState<'devices' | 'history' | 'return'>(initiallyOpen ? 'history' : 'devices');
  const open = page === 'history';
  const [range, setRange] = useState<MetricHistoryRange>(() => {
    const requested = searchParams.get('range');
    return requested && Object.hasOwn(metricHistoryRanges, requested) ? (requested as MetricHistoryRange) : '1h';
  });
  const [device, setDevice] = useState<string | null>(() => {
    const requested = searchParams.get('hostDevice');
    return requested && /^(network|disk):[a-zA-Z0-9_.:@+!-]{1,128}$/.test(requested) && !/^(network|disk):\.{1,2}$/.test(requested)
      ? requested
      : null;
  });
  const list = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const origin = useRef<{ opener: HTMLButtonElement; positions: [Element, number][] } | null>(null);

  const show = useCallback<OpenDeviceHistory>((selection, opener) => {
    const positions: [Element, number][] = [];
    for (let parent = list.current?.parentElement; parent; parent = parent.parentElement) {
      if (parent === document.scrollingElement || /^(auto|scroll)$/.test(getComputedStyle(parent).overflowY)) {
        positions.push([parent, parent.scrollTop]);
      }
    }
    origin.current = { opener, positions };
    setDevice(keyOf(selection));
    setPage('history');
  }, []);

  useLayoutEffect(() => {
    if (open) {
      back.current?.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' });
      (origin.current ? back.current : heading.current)?.focus({ preventScroll: true });
    } else if (page === 'return') {
      const saved = origin.current;
      const fallback =
        list.current?.querySelector<HTMLElement>('input[type="search"]') ?? list.current?.querySelector<HTMLElement>('#host-devices-title');
      const target = saved?.opener.isConnected ? saved.opener : fallback;
      target?.focus({ preventScroll: true });
      for (const [element, top] of saved?.positions ?? []) element.scrollTo({ top, behavior: 'instant' });
      if (target === fallback) fallback?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      origin.current = null;
    }
  }, [open, page]);

  return (
    <div className="monitor-device-pages">
      <div ref={list} hidden={open} data-device-page={page === 'return' ? 'back' : undefined}>
        {children(show)}
      </div>
      {open ? (
        <div data-device-page="forward">
          <button type="button" className="btn btn-secondary monitor-device-back" ref={back} onClick={() => setPage('return')}>
            <IconArrowLeft size={18} aria-hidden="true" />
            Back to devices
          </button>
          <HostDeviceHistoryView device={device} range={range} onDevice={setDevice} onRange={setRange} heading={heading} host={host} />
        </div>
      ) : null}
    </div>
  );
}

function HostDeviceHistoryView({
  device,
  range,
  onDevice,
  onRange,
  heading,
  host,
}: {
  device: string | null;
  range: MetricHistoryRange;
  onDevice: (device: string) => void;
  onRange: (range: MetricHistoryRange) => void;
  heading: RefObject<HTMLHeadingElement | null>;
  host?: HostTelemetry;
}) {
  const visible = useWindowVisible();
  const serverPath = useServerPath();
  const queryClient = useQueryClient();
  const basePath = serverPath('/api/system/host-history');
  const path = `${basePath}?range=${range}${device ? `&device=${encodeURIComponent(device)}` : ''}`;
  const query = useQuery<HostDeviceHistory>({
    queryKey: historyQueryKey(basePath, range, device),
    queryFn: async ({ signal }) => {
      const response = await fetch(path, {
        credentials: 'include',
        signal,
      });
      if (!response.ok) throw new Error('Host history is unavailable');
      return response.json();
    },
    enabled: visible,
    placeholderData: (previousData, previousQuery) => (previousQuery?.queryKey[1] === basePath ? previousData : undefined),
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
    queryClient.setQueryData(historyQueryKey(basePath, range, resolved), data, { updatedAt: query.dataUpdatedAt });
    onDevice(resolved);
  }, [basePath, device, data, range, query.dataUpdatedAt, queryClient, onDevice]);
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
  const retry = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (query.isFetching || !restoreFocus.current) return;
    restoreFocus.current = false;
    if (document.activeElement !== document.body && document.activeElement !== retry.current) return;
    (data && !query.isError ? heading.current : retry.current)?.focus({ preventScroll: true });
  }, [query.isFetching, query.isError, data, heading]);

  const fields =
    selected?.kind === 'disk'
      ? ([
          ['inbound', 'Read', 'bytesPerSecond', 'color-mix(in srgb, var(--desktop-accent) 60%, var(--desktop-positive))'],
          ['outbound', 'Write', 'bytesPerSecond', 'var(--desktop-accent)'],
          ['busy', 'Active time', 'percent', 'color-mix(in srgb, var(--desktop-accent) 70%, var(--desktop-ink))'],
        ] as const)
      : ([
          ['inbound', 'Download', 'bytesPerSecond', 'color-mix(in srgb, var(--desktop-accent) 60%, var(--desktop-positive))'],
          ['outbound', 'Upload', 'bytesPerSecond', 'var(--desktop-accent)'],
        ] as const);

  return (
    <section className="host-device-history" id="device-history" aria-labelledby="host-device-history-title" aria-busy={loading}>
      <header className="host-history-heading">
        <h2 id="host-device-history-title" tabIndex={-1} ref={heading} data-page-focus-align="managed">
          Device history
        </h2>
        <HistoryHelp label="About device history">
          <p>Orbis records readings every ten seconds while in use and keeps history for seven days. Longer ranges show averages and peaks.</p>
          <p>
            Gaps indicate missing readings or a device change. A reboot starts a new series. Disk active time is approximate and devices may share
            traffic.
          </p>
          {data ? (
            <p>
              {data.persistedThrough
                ? `Saved through ${new Date(data.persistedThrough).toLocaleString()}.`
                : 'The first minute has not been saved yet.'}{' '}
              Recent samples stay in memory. Saved summaries survive a restart.
            </p>
          ) : null}
        </HistoryHelp>
      </header>
      <div className="host-history-controls">
        <div className="host-history-device">
          <Select value={selectedKey} onValueChange={onDevice} disabled={!choices.length}>
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
      </div>
      {selected ? <HostDeviceLiveCharts key={`${basePath}:${selectedKey}`} host={host} selected={selected} /> : null}
      <div className="host-history-controls host-history-recorded">
        <h3 className="monitor-chart-subtitle">Recorded history</h3>
        <SelectionGroup as="fieldset" className="monitor-history-ranges host-history-ranges">
          <legend className="visually-hidden">Device history time range</legend>
          {ranges.map(([value, label]) => (
            <button type="button" key={value} aria-pressed={range === value} onClick={() => onRange(value)}>
              {label}
            </button>
          ))}
        </SelectionGroup>
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
        </>
      ) : null}
    </section>
  );
}
