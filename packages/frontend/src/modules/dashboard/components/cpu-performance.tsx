import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { MetricHistory } from '@runtipi/common/schemas';
import type { Telemetry } from '@/desktop/telemetry';
import { MetricChart } from '@/components/metric-chart/metric-chart';
import { highUsage } from './system-health';
import { Switch } from '@/components/ui/Switch/Switch';
import { appendProcessorSample, percentReading, type ProcessorSample } from './logical-processor-history';
import { LiveMetricChart, useLiveSamples } from './live-metric-chart';
import './cpu-performance.css';

const percent = (value: number | null) => (percentReading(value) !== null ? `${value?.toFixed(1)}%` : 'Unavailable');

export function CpuPerformance({
  sample,
  history,
  loading,
  historyControls,
  logicalProcessors = true,
  onLogicalProcessorsChange,
  savingLogicalProcessors,
}: {
  sample: Telemetry;
  history?: MetricHistory;
  loading: boolean;
  historyControls?: ReactNode;
  logicalProcessors?: boolean;
  onLogicalProcessorsChange?: (checked: boolean) => void;
  savingLogicalProcessors?: boolean;
}) {
  const systemSource = sample.cpu.scope === 'host-proc';
  const logicalAvailable = systemSource && sample.cpu.perCorePercent.length > 0;
  const showLogical = logicalAvailable && logicalProcessors;
  const totalPercent = systemSource ? percentReading(sample.cpu.totalPercent) : null;
  const [samples, setSamples] = useState<ProcessorSample[]>(() => appendProcessorSample([], sample));
  useEffect(() => setSamples((previous) => appendProcessorSample(previous, sample)), [sample]);
  const current = appendProcessorSample(samples, sample);
  const totals = useLiveSamples(sample.sampledAt, JSON.stringify([sample.cpu.scope, sample.cpu.model]), [totalPercent]);
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
      <p className="monitor-processor-caption">Last 60 seconds · 0–100%. Collected while Performance is open; gaps mean missing readings.</p>
      {showLogical ? (
        <section className="monitor-processor-grid" aria-label="Logical processor utilisation charts">
          {sample.cpu.perCorePercent.map((_, index) => (
            <LiveMetricChart
              // biome-ignore lint/suspicious/noArrayIndexKey: Position is the logical processor order supplied by telemetry.
              key={index}
              label={`Logical processor ${index + 1}`}
              samples={current}
              index={index}
            />
          ))}
        </section>
      ) : (
        <LiveMetricChart label="Live total CPU utilisation" samples={totals} />
      )}
      {historyControls}
      <CpuRecordedChart history={history} loading={loading} />
    </section>
  );
}

export function CpuRecordedChart({ history, loading }: { history?: MetricHistory; loading: boolean }) {
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
  return <MetricChart history={systemHistory} field="cpu" label="System CPU utilisation" color="var(--desktop-accent)" loading={loading} />;
}
