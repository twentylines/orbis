import { useEffect, useState } from 'react';
import { appendLiveSample, percentReading, processorChartSegments, rateReading, type ProcessorSample } from './logical-processor-history';
import { statusBytes } from './system-readings';

export function useLiveSamples(sampledAt: string | undefined, identity: string, values: (number | null)[]): ProcessorSample[] {
  const [samples, setSamples] = useState<ProcessorSample[]>([]);
  useEffect(() => {
    if (sampledAt) setSamples((previous) => appendLiveSample(previous, sampledAt, identity, values));
  }, [sampledAt, identity, values]);
  return sampledAt ? appendLiveSample(samples, sampledAt, identity, values) : [];
}

export function LiveMetricChart({
  label,
  samples,
  index = 0,
  unit = 'percent',
  gapMs,
}: {
  label: string;
  samples: ProcessorSample[];
  index?: number;
  unit?: 'percent' | 'rate';
  gapMs?: number;
}) {
  const latest = samples.at(-1);
  const value = latest?.values[index] ?? null;
  const maximum = unit === 'percent' ? 100 : samples.reduce((largest, point) => Math.max(largest, rateReading(point.values[index] ?? null) ?? 0), 1);
  const segments = latest ? processorChartSegments(samples, index, latest.at, maximum, gapMs) : [];
  const reading = unit === 'percent' ? percentReading(value) : rateReading(value);
  const display = reading === null ? 'Unavailable' : unit === 'percent' ? `${reading.toFixed(1)}%` : `${statusBytes(reading)}/s`;
  const scale = unit === 'percent' ? '100%' : `${statusBytes(maximum)}/s`;
  return (
    <div className="monitor-processor-chart">
      <div className="monitor-processor-label">
        <span>{label}</span>
        <strong>{display}</strong>
      </div>
      <svg viewBox="0 0 200 80" preserveAspectRatio="none" role="img" aria-label={`${label}: ${display}; 60-second chart scaled to ${scale}`}>
        <path className="monitor-processor-gridlines" d="M0 4H200M0 40H200M0 76H200M50 4V76M100 4V76M150 4V76" />
        {segments.map((points) => {
          if (!points.includes(' ')) {
            const [x, y] = points.split(',');
            return <rect key={points} x={Number(x) - 1} y={Number(y) - 1.5} width={2} height={3} fill="var(--desktop-accent)" />;
          }
          return (
            <polyline key={points} points={points} fill="none" stroke="var(--desktop-accent)" strokeWidth="1.75" vectorEffect="non-scaling-stroke" />
          );
        })}
      </svg>
      {unit === 'rate' && segments.length ? <div className="monitor-live-scale">0–{scale}</div> : null}
    </div>
  );
}
