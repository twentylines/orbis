import { useId, useMemo, useRef, useState } from 'react';
import type { MetricSummary } from '@runtipi/common/schemas';
import './metric-chart.css';

export type MetricPlotPoint = {
  at: string;
  until: string;
  intervalSeconds: number;
  samples: number;
  value: MetricSummary;
  identity?: string | null;
  source?: string;
};
export type MetricPlotHistory = { from: string; to: string; points: MetricPlotPoint[] };
export type MetricPlotUnit = 'percent' | 'bytesPerSecond';
const emptyPoints: MetricPlotPoint[] = [];
const chartWidth = 600;
const chartHeight = 140;
const nearestPoint = (times: number[], time: number) =>
  times.reduce((nearest, at, index) => (Math.abs(at - time) < Math.abs((times[nearest] ?? 0) - time) ? index : nearest), 0);
export const formatPlotValue = (value: number | null, unit: MetricPlotUnit) => {
  if (value === null) return 'Unavailable';
  if (unit === 'percent') return `${value.toFixed(1)}%`;
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'];
  const index = Math.min(units.length - 1, Math.floor(Math.log2(Math.max(1, value)) / 10));
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
};

export function MetricPlot({
  history,
  unit,
  metricKey,
  label,
  color,
  loading = false,
  emptyMessage,
}: {
  history?: MetricPlotHistory;
  unit: MetricPlotUnit;
  metricKey?: string;
  label: string;
  color: string;
  loading?: boolean;
  emptyMessage?: string;
}) {
  const id = useId();
  const svg = useRef<SVGSVGElement>(null);
  const [selectedTime, setSelectedTime] = useState<number | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const points = history?.points ?? emptyPoints;
  const { from, to, max, times, x, y, segments, axisTimes } = useMemo(() => {
    const from = history ? Date.parse(history.from) : 0;
    const to = history ? Date.parse(history.to) : 1;
    const max = unit === 'percent' ? 100 : Math.max(1024, ...points.map((point) => point.value.peak ?? 0)) * 1.1;
    const times = points.map((point) => Date.parse(point.at));
    const x = (at: number) => Math.max(0, Math.min(chartWidth, ((at - from) / Math.max(1, to - from)) * chartWidth));
    const y = (value: number) => chartHeight - 8 - (Math.min(max, Math.max(0, value)) / max) * (chartHeight - 16);
    const lines: string[][] = [];
    let previous: MetricPlotPoint | undefined;
    for (const [index, point] of points.entries()) {
      const value = point.value.average;
      const gap = previous && ((times[index] ?? 0) - Date.parse(previous.until) > 25000 || previous.identity !== point.identity);
      if (value === null || point.identity === null) {
        previous = undefined;
        continue;
      }
      if (!previous || gap) lines.push([]);
      lines.at(-1)?.push(`${x(times[index] ?? 0).toFixed(1)},${y(value).toFixed(1)}`);
      previous = point;
    }
    const segments = lines.map((line) => {
      const first = line[0] ?? '';
      const last = line.at(-1) ?? '';
      return {
        first,
        length: line.length,
        points: line.join(' '),
        fill: `M ${first.split(',')[0]},${chartHeight} L ${line.join(' L ')} L ${last.split(',')[0]},${chartHeight} Z`,
      };
    });
    const axisTimes = [from, from + (to - from) / 2, to].map((time) =>
      history
        ? new Date(time).toLocaleString(
            undefined,
            to - from > 86400000 ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' },
          )
        : '—',
    );
    return { from, to, max, times, x, y, segments, axisTimes };
  }, [history, points, unit]);
  const selectedIndex = selectedTime === null ? Math.max(0, points.length - 1) : nearestPoint(times, selectedTime);
  const selected = points[selectedIndex];
  const summary = selected?.value;
  const sampleText = selected
    ? `${new Date(selected.at).toLocaleString()}, ${selected.source ?? label} ${formatPlotValue(selected.value.average, unit)}, ${selected.value.samples > 1 ? `peak ${formatPlotValue(selected.value.peak, unit)}, ` : ''}${selected.value.samples} sample${selected.value.samples === 1 ? '' : 's'}`
    : 'No recorded samples';

  return (
    <div className="metric-chart" data-metric={metricKey ?? unit}>
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
          setSelectedTime(times[nearestPoint(times, time)] ?? null);
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
          setSelectedTime(times[next] ?? null);
          setInspecting(true);
        }}
      >
        <div className="metric-chart-scale" aria-hidden="true">
          <span>{formatPlotValue(max, unit)}</span>
          <span>{formatPlotValue(max / 2, unit)}</span>
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
            const { first } = segment;
            if (!first) return null;
            const key = `${metricKey ?? label}-${first}`;
            if (segment.length === 1) return <circle key={key} cx={first.split(',')[0]} cy={first.split(',')[1]} r="3" fill={color} />;
            return (
              <g key={key} data-history-segment="true">
                <path d={segment.fill} fill={`url(#${id})`} />
                <polyline points={segment.points} stroke={color} fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
              </g>
            );
          })}
          {inspecting && selected ? (
            <g>
              <line className="metric-chart-cursor" x1={x(times[selectedIndex] ?? 0)} x2={x(times[selectedIndex] ?? 0)} y1="0" y2={chartHeight} />
              {summary?.average !== null && summary?.average !== undefined ? (
                <circle cx={x(times[selectedIndex] ?? 0)} cy={y(summary.average)} r="4" fill={color} />
              ) : null}
            </g>
          ) : null}
        </svg>
        {!points.length || !segments.length ? (
          <span className="metric-chart-empty">
            {loading
              ? 'Loading history…'
              : (emptyMessage ?? (points.length ? 'Readings unavailable in this range' : 'No samples recorded in this range'))}
          </span>
        ) : null}
        <div className="metric-chart-times" aria-hidden="true">
          <span>{axisTimes[0]}</span>
          <span>{axisTimes[1]}</span>
          <span>{axisTimes[2]}</span>
        </div>
      </div>
      {inspecting && selected && summary ? (
        <output className="metric-chart-tooltip" aria-live="off">
          <time dateTime={selected.at}>
            {new Date(selected.at).toLocaleString()}
            {selected.until !== selected.at ? ` – ${new Date(selected.until).toLocaleTimeString()}` : ''}
          </time>
          {summary.average === null ? (
            <span>Unavailable</span>
          ) : (
            <strong>
              {formatPlotValue(summary.average, unit)}
              {summary.samples > 1 ? ' average' : ''}
            </strong>
          )}
          {summary.samples > 1 ? (
            <span>
              Peak {formatPlotValue(summary.peak, unit)} · {summary.samples} samples
            </span>
          ) : null}
          {selected.source ? <span>{selected.source}</span> : null}
          <small>← → inspect samples</small>
        </output>
      ) : null}
    </div>
  );
}
