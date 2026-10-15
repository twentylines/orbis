import { useId, useRef, useState } from 'react';
import type { MetricHistory, MetricHistoryPoint } from '@runtipi/common/schemas';
import './metric-chart.css';

type Field = 'cpu' | 'memory' | 'download' | 'upload';
const emptyPoints: MetricHistoryPoint[] = [];
const chartWidth = 600;
const chartHeight = 140;
export const formatMetricValue = (value: number | null, field: Field) => {
  if (value === null) return 'Unavailable';
  if (field === 'cpu' || field === 'memory') return `${value.toFixed(1)}%`;
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'];
  const index = Math.min(units.length - 1, Math.floor(Math.log2(Math.max(1, value)) / 10));
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
};

export function MetricChart({
  history,
  field,
  label,
  color,
  loading = false,
}: {
  history?: MetricHistory;
  field: Field;
  label: string;
  color: string;
  loading?: boolean;
}) {
  const id = useId();
  const svg = useRef<SVGSVGElement>(null);
  const [selectedTime, setSelectedTime] = useState<number | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const points = history?.points ?? emptyPoints;
  const from = history ? Date.parse(history.from) : 0;
  const to = history ? Date.parse(history.to) : 1;
  const max = field === 'cpu' || field === 'memory' ? 100 : Math.max(1024, ...points.map((point) => point[field].peak ?? 0)) * 1.1;
  const x = (point: MetricHistoryPoint) => Math.max(0, Math.min(chartWidth, ((Date.parse(point.at) - from) / Math.max(1, to - from)) * chartWidth));
  const y = (value: number) => chartHeight - 8 - (Math.min(max, Math.max(0, value)) / max) * (chartHeight - 16);
  const selectedIndex =
    selectedTime === null
      ? Math.max(0, points.length - 1)
      : points.reduce(
          (nearest, point, index) =>
            Math.abs(Date.parse(point.at) - selectedTime) < Math.abs(Date.parse(points[nearest]?.at ?? '') - selectedTime) ? index : nearest,
          0,
        );
  const selected = points[selectedIndex];
  const summary = selected?.[field];
  const segments: string[][] = [];
  let previous: MetricHistoryPoint | undefined;
  for (const point of points) {
    const value = point[field].average;
    const gap = previous && (Date.parse(point.at) - Date.parse(previous.until) > 25000 || (field === 'cpu' && previous.cpuScope !== point.cpuScope));
    if (value === null) {
      previous = undefined;
      continue;
    }
    if (!previous || gap) segments.push([]);
    segments.at(-1)?.push(`${x(point).toFixed(1)},${y(value).toFixed(1)}`);
    previous = point;
  }
  const source = selected?.cpuScope === 'host-proc' ? 'Host CPU' : selected?.cpuScope === 'runtime' ? 'Core CPU' : 'CPU source changed';
  const sampleText = selected
    ? `${new Date(selected.at).toLocaleString()}, ${field === 'cpu' ? source : label} ${formatMetricValue(selected[field].average, field)}, ${selected[field].samples > 1 ? `peak ${formatMetricValue(selected[field].peak, field)}, ` : ''}${selected[field].samples} sample${selected[field].samples === 1 ? '' : 's'}`
    : 'No recorded samples';
  const axisTime = (time: number) =>
    new Date(time).toLocaleString(
      undefined,
      to - from > 86400000 ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' },
    );

  return (
    <div className="metric-chart" data-metric={field}>
      <div
        className="metric-chart-plot"
        role="slider"
        tabIndex={points.length ? 0 : -1}
        aria-label={`Inspect ${label} history`}
        aria-valuemin={0}
        aria-valuemax={Math.max(0, points.length - 1)}
        aria-valuenow={selectedIndex}
        aria-valuetext={sampleText}
        aria-orientation="horizontal"
        onFocus={() => setInspecting(true)}
        onBlur={() => setInspecting(false)}
        onPointerMove={(event) => {
          const box = svg.current?.getBoundingClientRect();
          if (!box || !points.length) return;
          const time = from + Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * (to - from);
          setSelectedTime(time);
          setInspecting(true);
        }}
        onPointerLeave={(event) => {
          if (document.activeElement !== event.currentTarget) setInspecting(false);
        }}
        onKeyDown={(event) => {
          if (!points.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? points.length - 1
                : Math.max(0, Math.min(points.length - 1, selectedIndex + (event.key === 'ArrowLeft' ? -1 : 1)));
          setSelectedTime(Date.parse(points[next]?.at ?? ''));
          setInspecting(true);
        }}
      >
        <div className="metric-chart-scale" aria-hidden="true">
          <span>{formatMetricValue(max, field)}</span>
          <span>{formatMetricValue(max / 2, field)}</span>
          <span>0</span>
        </div>
        <svg ref={svg} viewBox={`0 0 ${chartWidth} ${chartHeight}`} preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity="0.2" />
              <stop offset="1" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {[8, chartHeight / 2, chartHeight - 8].map((line) => (
            <line key={line} className="metric-chart-gridline" x1="0" x2={chartWidth} y1={line} y2={line} />
          ))}
          {segments.map((segment) => {
            const first = segment[0];
            const last = segment.at(-1);
            if (!first || !last) return null;
            const key = `${field}-${first}`;
            if (segment.length === 1) return <circle key={key} cx={first.split(',')[0]} cy={first.split(',')[1]} r="3" fill={color} />;
            return (
              <g key={key} data-history-segment="true">
                <path
                  d={`M ${first.split(',')[0]},${chartHeight} L ${segment.join(' L ')} L ${last.split(',')[0]},${chartHeight} Z`}
                  fill={`url(#${id})`}
                />
                <polyline points={segment.join(' ')} stroke={color} fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
              </g>
            );
          })}
          {inspecting && selected ? (
            <g>
              <line className="metric-chart-cursor" x1={x(selected)} x2={x(selected)} y1="0" y2={chartHeight} />
              {summary?.average !== null && summary?.average !== undefined ? (
                <circle cx={x(selected)} cy={y(summary.average)} r="4" fill={color} />
              ) : null}
            </g>
          ) : null}
        </svg>
        {!points.length || !segments.length ? (
          <span className="metric-chart-empty">
            {loading ? 'Loading history…' : points.length ? 'Readings unavailable in this range' : 'No samples recorded in this range'}
          </span>
        ) : null}
        {inspecting && selected && summary ? (
          <output className="metric-chart-tooltip">
            <time dateTime={selected.at}>
              {new Date(selected.at).toLocaleString()}
              {selected.until !== selected.at ? ` – ${new Date(selected.until).toLocaleTimeString()}` : ''}
            </time>
            <strong>
              {formatMetricValue(summary.average, field)}
              {summary.samples > 1 ? ' average' : ''}
            </strong>
            {summary.samples > 1 ? (
              <span>
                Peak {formatMetricValue(summary.peak, field)} · {summary.samples} samples
              </span>
            ) : null}
            {field === 'cpu' ? <span>{source}</span> : null}
            <small>← → inspect samples</small>
          </output>
        ) : null}
      </div>
      <div className="metric-chart-times" aria-hidden="true">
        <span>{history ? axisTime(from) : '—'}</span>
        <span>{history ? axisTime(from + (to - from) / 2) : '—'}</span>
        <span>{history ? axisTime(to) : '—'}</span>
      </div>
    </div>
  );
}
