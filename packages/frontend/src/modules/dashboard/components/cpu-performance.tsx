import { useEffect, useMemo, useState } from 'react';
import type { MetricHistory } from '@runtipi/common/schemas';
import type { Telemetry } from '@/desktop/telemetry';
import { MetricChart } from '@/components/metric-chart/metric-chart';
import { highUsage } from './system-health';
import { Switch } from '@/components/ui/Switch/Switch';
import { appendProcessorSample, processorChartSegments, type ProcessorSample } from './logical-processor-history';
import './cpu-performance.css';

const validPercent = (value: number | null) => (value !== null && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null);
const percent = (value: number | null) => (validPercent(value) !== null ? `${value?.toFixed(1)}%` : 'Unavailable');

export function CpuPerformance({
  sample,
  history,
  loading,
  delayed,
  logicalProcessors = true,
  onLogicalProcessorsChange,
  savingLogicalProcessors,
}: {
  sample: Telemetry;
  history?: MetricHistory;
  loading: boolean;
  delayed: boolean;
  logicalProcessors?: boolean;
  onLogicalProcessorsChange?: (checked: boolean) => void;
  savingLogicalProcessors?: boolean;
}) {
  const systemSource = sample.cpu.scope === 'host-proc';
  const logicalAvailable = systemSource && sample.cpu.perCorePercent.length > 0;
  const showLogical = logicalAvailable && logicalProcessors;
  const totalPercent = systemSource ? validPercent(sample.cpu.totalPercent) : null;
  const systemHistory = useMemo(
    () =>
      history && {
        ...history,
        points: history.points.map((point) =>
          point.cpuScope === 'host-proc' ? point : { ...point, cpu: { average: null, peak: null, samples: 0 } },
        ),
      },
    [history],
  );
  const [samples, setSamples] = useState<ProcessorSample[]>(() => appendProcessorSample([], sample));
  useEffect(() => setSamples((previous) => appendProcessorSample(previous, sample)), [sample]);
  const current = appendProcessorSample(samples, sample);
  const latest = current.at(-1);
  return (
    <section className="desktop-telemetry-cpu" data-cpu-view={showLogical ? 'logical' : 'total'} aria-labelledby="telemetry-cpu-title">
      <header className="monitor-cpu-heading">
        <div>
          <h2 id="telemetry-cpu-title">CPU</h2>
          <p className="monitor-hardware-name">{sample.cpu.model || 'CPU model not reported'}</p>
        </div>
        <Switch
          className="monitor-logical-switch"
          label="Logical processors"
          checked={showLogical}
          onCheckedChange={onLogicalProcessorsChange}
          aria-busy={savingLogicalProcessors || undefined}
          aria-disabled={savingLogicalProcessors || undefined}
          disabled={!logicalAvailable}
          aria-describedby={logicalAvailable ? undefined : 'monitor-logical-unavailable'}
        />
      </header>
      <div className="desktop-telemetry-lead" data-high={highUsage(totalPercent)}>
        <strong>{percent(totalPercent)}</strong>
        <span>Total system CPU utilisation</span>
        {logicalAvailable ? <span>{sample.cpu.perCorePercent.length} logical processors</span> : null}
      </div>
      {logicalAvailable ? null : (
        <p id="monitor-logical-unavailable" className="monitor-cpu-source-note">
          {systemSource
            ? 'Per-processor readings are unavailable.'
            : 'Host CPU counters are unavailable. Connect host readings to see total system CPU utilisation.'}
        </p>
      )}
      {showLogical ? (
        <>
          <p className="monitor-processor-caption">
            Last 60 seconds · 0–100% per logical processor. Collected while Performance is open; gaps mean missing readings.
          </p>
          {delayed ? <output>Readings delayed. Charts show the last received samples.</output> : null}
          <section className="monitor-processor-grid" aria-label="Logical processor utilisation charts">
            {sample.cpu.perCorePercent.map((value, index) => {
              const label = `Logical processor ${index + 1}`;
              const segments = processorChartSegments(current, index, latest?.at ?? Date.parse(sample.sampledAt));
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: Position is the logical processor order supplied by telemetry, not a physical core ID.
                <div className="monitor-processor-chart" key={index}>
                  <div className="monitor-processor-label">
                    <span>{label}</span>
                    <strong>{percent(value)}</strong>
                  </div>
                  <svg
                    viewBox="0 0 200 80"
                    preserveAspectRatio="none"
                    role="img"
                    aria-label={`${label}: ${percent(value)}; 60 second utilisation chart`}
                  >
                    <title>{`${label} utilisation, 0 to 100 percent`}</title>
                    <path className="monitor-processor-gridlines" d="M0 4H200M0 40H200M0 76H200M50 4V76M100 4V76M150 4V76" />
                    {segments.map((points) => (
                      <polyline
                        key={points}
                        points={points}
                        fill="none"
                        stroke="var(--desktop-accent)"
                        strokeWidth="1.75"
                        vectorEffect="non-scaling-stroke"
                      />
                    ))}
                  </svg>
                </div>
              );
            })}
          </section>
        </>
      ) : (
        <MetricChart history={systemHistory} field="cpu" label="System CPU utilisation" color="var(--desktop-accent)" loading={loading} />
      )}
    </section>
  );
}
